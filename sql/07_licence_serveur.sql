-- ============================================================
-- 07 - LICENCE CÔTÉ SERVEUR (essai / abonnement non contournables)
-- ============================================================
-- Avant : la licence vivait dans user_data (clé 'licenseInfo'), que le
-- client peut modifier lui-même. Un utilisateur expiré pouvait donc
-- continuer à travailler (modif localStorage / nouveau navigateur).
--
-- Après :
--  * table `licenses` : lecture seule pour le client, écrite uniquement
--    par les fonctions SECURITY DEFINER (activate_license, my_license)
--  * user_data : INSERT/UPDATE refusés par la base si la licence est
--    expirée (mode lecture seule : l'utilisateur garde l'accès à ses
--    données mais ne peut plus rien enregistrer)
--  * la clé 'licenseInfo' ne peut plus être écrite par le client
--
-- À exécuter dans Supabase > SQL Editor, APRÈS le déploiement de app.html.
-- Idempotent : peut être relancé sans risque.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Table des licences
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.licenses (
    user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    type       TEXT NOT NULL DEFAULT 'trial'
               CHECK (type IN ('trial','monthly','semestrial','annual','business','lifetime')),
    status     TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','suspended')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,            -- NULL = sans expiration (lifetime)
    code       TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.licenses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS licenses_select_own ON public.licenses;
CREATE POLICY licenses_select_own ON public.licenses
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS licenses_admin_all ON public.licenses;
CREATE POLICY licenses_admin_all ON public.licenses
    FOR ALL TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

-- Le client ne peut jamais écrire directement
REVOKE ALL ON public.licenses FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.licenses TO authenticated;
-- INSERT/UPDATE/DELETE n'aboutissent que si la policy admin ci-dessus le permet

-- ------------------------------------------------------------
-- 2. Licence active ? (source de vérité unique)
--    Sans ligne : essai de 14 jours depuis la création du compte.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.has_active_license(p_uid UUID DEFAULT auth.uid())
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
    SELECT COALESCE(
        (SELECT l.status = 'active'
                AND (l.expires_at IS NULL OR l.expires_at > NOW())
           FROM public.licenses l
          WHERE l.user_id = p_uid),
        (SELECT u.created_at + INTERVAL '14 days' > NOW()
                OR EXISTS (SELECT 1 FROM public.admins a WHERE lower(a.email) = lower(u.email))
           FROM auth.users u
          WHERE u.id = p_uid),
        FALSE
    );
$$;

REVOKE ALL ON FUNCTION public.has_active_license(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_active_license(UUID) TO authenticated;

-- ------------------------------------------------------------
-- 3. État de licence pour l'appli (crée l'essai au premier appel)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_license()
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_row public.licenses%ROWTYPE;
BEGIN
    IF v_uid IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
    END IF;

    INSERT INTO public.licenses (user_id, type, started_at, expires_at)
    SELECT u.id,
           CASE WHEN EXISTS (SELECT 1 FROM public.admins a WHERE lower(a.email) = lower(u.email))
                THEN 'lifetime' ELSE 'trial' END,
           u.created_at,
           CASE WHEN EXISTS (SELECT 1 FROM public.admins a WHERE lower(a.email) = lower(u.email))
                THEN NULL ELSE u.created_at + INTERVAL '14 days' END
      FROM auth.users u
     WHERE u.id = v_uid
    ON CONFLICT (user_id) DO NOTHING;

    SELECT * INTO v_row FROM public.licenses WHERE user_id = v_uid;

    RETURN jsonb_build_object(
        'ok',         true,
        'type',       v_row.type,
        'status',     v_row.status,
        'started_at', v_row.started_at,
        'expires_at', v_row.expires_at,
        'active',     public.has_active_license(v_uid),
        'server_now', NOW()
    );
END;
$$;

REVOKE ALL ON FUNCTION public.my_license() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_license() TO authenticated;

-- ------------------------------------------------------------
-- 4. activate_license : met à jour la licence côté serveur
--    (renouvellement = on prolonge à partir de la fin en cours)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.activate_license(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_email TEXT;
    v_row   public.admin_codes%ROWTYPE;
    v_days  INT;
    v_cur   public.licenses%ROWTYPE;
    v_base  TIMESTAMPTZ;
    v_exp   TIMESTAMPTZ;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
    END IF;

    SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();

    SELECT * INTO v_row
    FROM public.admin_codes
    WHERE code = upper(trim(p_code))
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
    END IF;
    IF v_row.status = 'used' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'used');
    END IF;
    IF v_row.status = 'revoked' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'revoked');
    END IF;
    IF v_row.client_email IS NOT NULL
       AND lower(v_row.client_email) <> lower(v_email) THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'wrong_email');
    END IF;

    v_days := CASE v_row.type
                WHEN 'monthly'    THEN 30
                WHEN 'semestrial' THEN 183
                WHEN 'annual'     THEN 365
                WHEN 'business'   THEN 30
                WHEN 'lifetime'   THEN NULL
                ELSE 30
              END;

    SELECT * INTO v_cur FROM public.licenses WHERE user_id = auth.uid() FOR UPDATE;

    -- Renouvellement : on part de la fin actuelle si elle est encore dans le futur
    v_base := GREATEST(NOW(), COALESCE(
                CASE WHEN v_cur.type <> 'trial' THEN v_cur.expires_at END, NOW()));
    v_exp  := CASE WHEN v_row.type = 'lifetime' THEN NULL
                   ELSE v_base + make_interval(days => v_days) END;

    INSERT INTO public.licenses (user_id, type, status, started_at, expires_at, code, updated_at)
    VALUES (auth.uid(),
            CASE WHEN v_row.type IN ('monthly','semestrial','annual','business','lifetime')
                 THEN v_row.type ELSE 'monthly' END,
            'active', NOW(), v_exp, v_row.code, NOW())
    ON CONFLICT (user_id) DO UPDATE
       SET type = EXCLUDED.type, status = 'active', started_at = NOW(),
           expires_at = EXCLUDED.expires_at, code = EXCLUDED.code, updated_at = NOW();

    UPDATE public.admin_codes
       SET status = 'used', activated_at = NOW()
     WHERE id = v_row.id;

    RETURN jsonb_build_object('ok', true, 'type', v_row.type, 'expires_at', v_exp);
END;
$$;

REVOKE ALL ON FUNCTION public.activate_license(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.activate_license(TEXT) TO authenticated;

-- ------------------------------------------------------------
-- 5. user_data : lecture toujours permise, écriture seulement si
--    licence active, et jamais sur la clé 'licenseInfo'
-- ------------------------------------------------------------
DROP POLICY IF EXISTS users_own_data        ON public.user_data;
DROP POLICY IF EXISTS user_data_select_own  ON public.user_data;
DROP POLICY IF EXISTS user_data_insert_own  ON public.user_data;
DROP POLICY IF EXISTS user_data_update_own  ON public.user_data;
DROP POLICY IF EXISTS user_data_delete_own  ON public.user_data;

CREATE POLICY user_data_select_own ON public.user_data
    FOR SELECT TO authenticated
    USING (auth.uid() = user_id);

CREATE POLICY user_data_insert_own ON public.user_data
    FOR INSERT TO authenticated
    WITH CHECK (auth.uid() = user_id
                AND key <> 'licenseInfo'
                AND public.has_active_license(auth.uid()));

CREATE POLICY user_data_update_own ON public.user_data
    FOR UPDATE TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id
                AND key <> 'licenseInfo'
                AND public.has_active_license(auth.uid()));

-- Suppression autorisée (droit à l'effacement), sauf la clé licence
CREATE POLICY user_data_delete_own ON public.user_data
    FOR DELETE TO authenticated
    USING (auth.uid() = user_id AND key <> 'licenseInfo');

-- Anciennes licences stockées côté client : on les retire (non fiables)
DELETE FROM public.user_data WHERE key = 'licenseInfo';

-- ------------------------------------------------------------
-- 6. Vérifications
-- ------------------------------------------------------------
SELECT 'licenses RLS' AS check, relrowsecurity::text AS result
  FROM pg_class WHERE oid = 'public.licenses'::regclass
UNION ALL
SELECT 'policies user_data', string_agg(policyname, ', ')
  FROM pg_policies WHERE tablename = 'user_data';
