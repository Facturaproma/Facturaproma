-- ============================================================
-- 20 — Formules d'abonnement configurables par l'owner (Master)
--
-- Besoin : l'owner crée d'autres formules (libellé, prix, durée) ; elles sont proposées automatiquement à la vente
-- (page Abonnement de l'appli, génération de codes, paiements, rapports) avec EXACTEMENT les mêmes fonctionnalités
-- que les formules existantes : une licence issue d'une formule configurée est une licence payante standard
-- (type 'monthly' côté licences), seule la durée et le libellé changent.
--
-- Compatibilité : AJOUT seul. Table plans (vide au départ). Aucune colonne ni contrainte existante modifiée,
-- aucune donnée modifiée. Les formules historiques (monthly, annual, founder, lifetime…) restent codées comme avant.
-- activate_license et my_license sont redéfinies à l'identique (scripts 10 et 09) + lecture de la table plans.
-- Écriture : uniquement via owner_save_plan(), réservée au Master (is_master()), journalisée dans admin_audit.
--
-- Idempotent. Dépend de 05, 06, 08, 09, 10.
-- Retour arrière : réexécuter les définitions de activate_license (script 10) et my_license (script 09),
-- puis DROP FUNCTION owner_save_plan ; DROP TABLE plans (sans effet sur les licences déjà activées,
-- qui restent des licences 'monthly' avec leur date d'expiration).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.plans (
    key           TEXT PRIMARY KEY CHECK (key ~ '^p_[a-z0-9_]{2,28}$'),
    label         TEXT NOT NULL CHECK (char_length(label) BETWEEN 2 AND 40),
    price_dh      NUMERIC(10,2) NOT NULL CHECK (price_dh > 0 AND price_dh <= 100000),
    duration_days INT NOT NULL CHECK (duration_days BETWEEN 1 AND 3660),
    tagline       TEXT CHECK (tagline IS NULL OR char_length(tagline) <= 80),
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order    INT NOT NULL DEFAULT 100,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.plans FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.plans TO authenticated;
DROP POLICY IF EXISTS plans_select ON public.plans;
CREATE POLICY plans_select ON public.plans FOR SELECT TO authenticated
    USING (active OR public.is_admin());

-- Création / modification / (dés)activation : Master uniquement. La clé (p_...) est fixée à la création, jamais réutilisée.
CREATE OR REPLACE FUNCTION public.owner_save_plan(
    p_key TEXT, p_label TEXT, p_price NUMERIC, p_days INT, p_tagline TEXT DEFAULT NULL,
    p_active BOOLEAN DEFAULT TRUE, p_sort INT DEFAULT 100)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_email TEXT;
    v_before public.plans%ROWTYPE;
BEGIN
    IF NOT public.is_master() THEN
        RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;
    IF p_key IS NULL OR p_key !~ '^p_[a-z0-9_]{2,28}$' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'bad_key');
    END IF;
    IF p_label IS NULL OR char_length(trim(p_label)) NOT BETWEEN 2 AND 40 THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'bad_label');
    END IF;
    IF p_price IS NULL OR p_price <= 0 OR p_price > 100000 THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'bad_price');
    END IF;
    IF p_days IS NULL OR p_days < 1 OR p_days > 3660 THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'bad_days');
    END IF;

    SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();
    SELECT * INTO v_before FROM public.plans WHERE key = p_key FOR UPDATE;

    INSERT INTO public.plans (key, label, price_dh, duration_days, tagline, active, sort_order)
    VALUES (p_key, trim(p_label), p_price, p_days, NULLIF(trim(COALESCE(p_tagline, '')), ''), COALESCE(p_active, TRUE), COALESCE(p_sort, 100))
    ON CONFLICT (key) DO UPDATE
       SET label = EXCLUDED.label, price_dh = EXCLUDED.price_dh, duration_days = EXCLUDED.duration_days,
           tagline = EXCLUDED.tagline, active = EXCLUDED.active, sort_order = EXCLUDED.sort_order, updated_at = NOW();

    INSERT INTO public.admin_audit (admin_email, action, target_email, details)
    VALUES (v_email, 'plan_save', NULL, jsonb_build_object('key', p_key,
            'before', CASE WHEN v_before.key IS NULL THEN NULL ELSE to_jsonb(v_before) END,
            'after', jsonb_build_object('label', trim(p_label), 'price_dh', p_price, 'duration_days', p_days, 'active', COALESCE(p_active, TRUE))));

    RETURN jsonb_build_object('ok', true, 'key', p_key);
END;
$$;

REVOKE ALL ON FUNCTION public.owner_save_plan(TEXT, TEXT, NUMERIC, INT, TEXT, BOOLEAN, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.owner_save_plan(TEXT, TEXT, NUMERIC, INT, TEXT, BOOLEAN, INT) TO authenticated;

-- activate_license : identique au script 10, durée prise dans plans pour une formule configurée
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
    v_plan_days INT;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
    END IF;

    -- Nettoyage léger des anciennes tentatives
    DELETE FROM public.code_attempts WHERE at < NOW() - INTERVAL '2 days';

    IF (SELECT count(*) FROM public.code_attempts
         WHERE user_id = auth.uid() AND at > NOW() - INTERVAL '1 hour') >= 10 THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'too_many_attempts');
    END IF;

    SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();

    SELECT * INTO v_row
    FROM public.admin_codes
    WHERE code = upper(trim(p_code))
    FOR UPDATE;

    IF NOT FOUND THEN
        INSERT INTO public.code_attempts (user_id) VALUES (auth.uid());
        RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
    END IF;
    IF v_row.status = 'used' THEN
        INSERT INTO public.code_attempts (user_id) VALUES (auth.uid());
        RETURN jsonb_build_object('ok', false, 'reason', 'used');
    END IF;
    IF v_row.status = 'revoked' THEN
        INSERT INTO public.code_attempts (user_id) VALUES (auth.uid());
        RETURN jsonb_build_object('ok', false, 'reason', 'revoked');
    END IF;
    IF v_row.client_email IS NOT NULL
       AND lower(v_row.client_email) <> lower(v_email) THEN
        INSERT INTO public.code_attempts (user_id) VALUES (auth.uid());
        RETURN jsonb_build_object('ok', false, 'reason', 'wrong_email');
    END IF;

    -- Formule configurée par l'owner (table plans) : sa durée prime ; sinon les formules historiques
    SELECT p.duration_days INTO v_plan_days FROM public.plans p WHERE p.key = v_row.type;
    v_days := COALESCE(v_plan_days, CASE v_row.type
                WHEN 'monthly'    THEN 30
                WHEN 'semestrial' THEN 183
                WHEN 'annual'     THEN 365
                WHEN 'business'   THEN 30
                WHEN 'lifetime'   THEN NULL
                ELSE 30
              END);

    SELECT * INTO v_cur FROM public.licenses WHERE user_id = auth.uid() FOR UPDATE;

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

-- my_license : identique au script 09 + formule configurée (plan_key / plan_label)
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
    v_grace TIMESTAMPTZ;
    v_plan_key   TEXT;
    v_plan_label TEXT;
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

    -- Formule configurée (si la licence vient d'un code de cette formule et n'a pas été changée à la main depuis)
    IF v_row.type = 'monthly' AND v_row.code IS NOT NULL THEN
        SELECT p.key, p.label INTO v_plan_key, v_plan_label
          FROM public.admin_codes c JOIN public.plans p ON p.key = c.type
         WHERE c.code = v_row.code LIMIT 1;
    END IF;

    v_grace := CASE WHEN v_row.status = 'active'
                         AND v_row.type <> 'trial'
                         AND v_row.expires_at IS NOT NULL
                    THEN v_row.expires_at + make_interval(days => public.license_grace_days())
               END;

    RETURN jsonb_build_object(
        'ok',          true,
        'type',        v_row.type,
        'status',      v_row.status,
        'started_at',  v_row.started_at,
        'expires_at',  v_row.expires_at,
        'grace_until', v_grace,
        'plan_key',    v_plan_key,
        'plan_label',  v_plan_label,
        'active',      public.has_active_license(v_uid),
        'server_now',  NOW()
    );
END;
$$;

REVOKE ALL ON FUNCTION public.my_license() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_license() TO authenticated;

SELECT 'formules' AS check, count(*)::text AS result FROM public.plans;
