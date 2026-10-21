-- ============================================================
-- 08 - ADMIN : vue des vrais comptes + gestion des licences + journal
-- ============================================================
-- À exécuter dans Supabase > SQL Editor APRÈS sql/07_licence_serveur.sql.
-- Idempotent : peut être relancé sans risque.
--
-- Fournit à admin.html :
--  * admin_list_accounts()  : tous les comptes avec offre, expiration,
--                             dernière activité et usage (factures, clients)
--  * admin_set_license()    : prolonger / changer d'offre / suspendre / réactiver
--  * admin_audit            : journal de toutes les actions admin
-- Seuls les administrateurs (table admins, e-mail confirmé) peuvent les appeler.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Journal d'audit
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_audit (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    admin_email  TEXT,
    action       TEXT NOT NULL,
    target_email TEXT,
    details      JSONB
);

ALTER TABLE public.admin_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_audit_select ON public.admin_audit;
CREATE POLICY admin_audit_select ON public.admin_audit
    FOR SELECT TO authenticated
    USING (public.is_admin());

-- Aucune écriture directe : uniquement via les fonctions SECURITY DEFINER
REVOKE ALL ON public.admin_audit FROM PUBLIC, anon;
GRANT SELECT ON public.admin_audit TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.admin_audit FROM authenticated;

CREATE INDEX IF NOT EXISTS idx_admin_audit_at ON public.admin_audit (at DESC);

-- ------------------------------------------------------------
-- 2. Liste des comptes (vraies données)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_list_accounts()
RETURNS TABLE (
    user_id        UUID,
    email          TEXT,
    created_at     TIMESTAMPTZ,
    last_sign_in   TIMESTAMPTZ,
    type           TEXT,
    status         TEXT,
    expires_at     TIMESTAMPTZ,
    active         BOOLEAN,
    code           TEXT,
    is_staff       BOOLEAN,
    last_activity  TIMESTAMPTZ,
    invoices_count INT,
    clients_count  INT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT
        u.id,
        u.email::TEXT,
        u.created_at,
        u.last_sign_in_at,
        COALESCE(l.type,
                 CASE WHEN st.is_staff THEN 'lifetime' ELSE 'trial' END),
        COALESCE(l.status, 'active'),
        CASE WHEN l.user_id IS NOT NULL THEN l.expires_at
             WHEN st.is_staff THEN NULL
             ELSE u.created_at + INTERVAL '14 days' END,
        public.has_active_license(u.id),
        l.code,
        st.is_staff,
        (SELECT MAX(d.updated_at) FROM public.user_data d WHERE d.user_id = u.id),
        COALESCE((SELECT CASE WHEN jsonb_typeof(d.value) = 'array'
                              THEN jsonb_array_length(d.value) ELSE 0 END
                    FROM public.user_data d
                   WHERE d.user_id = u.id AND d.key = 'invoices'), 0),
        COALESCE((SELECT CASE WHEN jsonb_typeof(d.value) = 'array'
                              THEN jsonb_array_length(d.value) ELSE 0 END
                    FROM public.user_data d
                   WHERE d.user_id = u.id AND d.key = 'clients'), 0)
    FROM auth.users u
    LEFT JOIN public.licenses l ON l.user_id = u.id
    CROSS JOIN LATERAL (
        SELECT EXISTS (SELECT 1 FROM public.admins a
                        WHERE lower(a.email) = lower(u.email)) AS is_staff
    ) st
    ORDER BY u.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_accounts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_accounts() TO authenticated;

-- ------------------------------------------------------------
-- 3. Modifier la licence d'un compte
--    p_type   : NULL (inchangé) ou trial|monthly|semestrial|annual|business|lifetime
--    p_days   : NULL ou nombre de jours à AJOUTER (à partir de la fin en cours,
--               ou d'aujourd'hui si déjà expirée) ; ignoré pour 'lifetime'
--    p_status : NULL (inchangé) ou active|suspended
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_license(
    p_user   UUID,
    p_type   TEXT DEFAULT NULL,
    p_days   INT  DEFAULT NULL,
    p_status TEXT DEFAULT NULL,
    p_note   TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_admin_email  TEXT;
    v_target_email TEXT;
    v_cur          public.licenses%ROWTYPE;
    v_base         TIMESTAMPTZ;
    v_new_type     TEXT;
    v_new_exp      TIMESTAMPTZ;
    v_new_status   TEXT;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;

    IF p_type IS NOT NULL AND p_type NOT IN
       ('trial','monthly','semestrial','annual','business','lifetime') THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'bad_type');
    END IF;
    IF p_status IS NOT NULL AND p_status NOT IN ('active','suspended') THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'bad_status');
    END IF;
    IF p_days IS NOT NULL AND (p_days < -365 OR p_days > 3660) THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'bad_days');
    END IF;

    SELECT email INTO v_admin_email  FROM auth.users WHERE id = auth.uid();
    SELECT email INTO v_target_email FROM auth.users WHERE id = p_user;
    IF v_target_email IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'unknown_user');
    END IF;

    -- S'assurer qu'une ligne existe (essai de 14 jours depuis la création du compte)
    INSERT INTO public.licenses (user_id, type, started_at, expires_at)
    SELECT u.id, 'trial', u.created_at, u.created_at + INTERVAL '14 days'
      FROM auth.users u WHERE u.id = p_user
    ON CONFLICT (user_id) DO NOTHING;

    SELECT * INTO v_cur FROM public.licenses WHERE user_id = p_user FOR UPDATE;

    v_new_type   := COALESCE(p_type, v_cur.type);
    v_new_status := COALESCE(p_status, v_cur.status);
    v_new_exp    := v_cur.expires_at;

    IF v_new_type = 'lifetime' THEN
        v_new_exp := NULL;
    ELSIF p_days IS NOT NULL THEN
        v_base    := GREATEST(NOW(), COALESCE(v_cur.expires_at, NOW()));
        v_new_exp := v_base + make_interval(days => p_days);
    ELSIF v_cur.type = 'lifetime' AND p_type IS NOT NULL THEN
        -- passage de « à vie » à une offre datée sans durée : on repart d'aujourd'hui
        v_new_exp := NOW();
    END IF;

    UPDATE public.licenses
       SET type = v_new_type,
           status = v_new_status,
           expires_at = v_new_exp,
           updated_at = NOW()
     WHERE user_id = p_user;

    INSERT INTO public.admin_audit (admin_email, action, target_email, details)
    VALUES (v_admin_email, 'set_license', v_target_email,
            jsonb_build_object(
                'before', jsonb_build_object('type', v_cur.type, 'status', v_cur.status, 'expires_at', v_cur.expires_at),
                'after',  jsonb_build_object('type', v_new_type, 'status', v_new_status, 'expires_at', v_new_exp),
                'note',   p_note));

    RETURN jsonb_build_object('ok', true, 'type', v_new_type, 'status', v_new_status,
                              'expires_at', v_new_exp);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_license(UUID, TEXT, INT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_license(UUID, TEXT, INT, TEXT, TEXT) TO authenticated;

-- ------------------------------------------------------------
-- 4. Vérification
-- ------------------------------------------------------------
SELECT 'admin_audit RLS' AS check, relrowsecurity::text AS result
  FROM pg_class WHERE oid = 'public.admin_audit'::regclass
UNION ALL
SELECT 'fonctions', string_agg(proname, ', ')
  FROM pg_proc WHERE proname IN ('admin_list_accounts', 'admin_set_license');
