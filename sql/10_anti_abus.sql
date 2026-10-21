-- ============================================================
-- 10 - ANTI-ABUS : limites côté base de données
-- ============================================================
-- À exécuter dans Supabase > SQL Editor (nouvelle requête). Idempotent.
--
-- Protège la base (et ton quota gratuit) contre :
--  * le spam de demandes d'abonnement (une personne qui en envoie en boucle)
--  * le remplissage de la base par un compte malveillant (données énormes)
--  * l'essai de codes d'activation au hasard
-- Les administrateurs ne sont jamais limités.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Demandes d'abonnement : 1 en attente par client, 5 par 24 h,
--    et un plafond global de 100 par heure (coupe-circuit anti-inondation)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.limit_subscription_requests()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
    IF public.is_admin() THEN
        RETURN NEW;
    END IF;

    IF EXISTS (SELECT 1 FROM public.subscription_requests r
                WHERE lower(r.client_email) = lower(NEW.client_email)
                  AND r.status = 'pending') THEN
        RAISE EXCEPTION 'rate_limited: demande déjà en attente' USING ERRCODE = 'P0001';
    END IF;

    IF (SELECT count(*) FROM public.subscription_requests r
         WHERE lower(r.client_email) = lower(NEW.client_email)
           AND r.created_at > NOW() - INTERVAL '24 hours') >= 5 THEN
        RAISE EXCEPTION 'rate_limited: trop de demandes aujourd''hui' USING ERRCODE = 'P0001';
    END IF;

    IF (SELECT count(*) FROM public.subscription_requests r
         WHERE r.created_at > NOW() - INTERVAL '1 hour') >= 100 THEN
        RAISE EXCEPTION 'rate_limited: service momentanément saturé' USING ERRCODE = 'P0001';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_limit_subscription_requests ON public.subscription_requests;
CREATE TRIGGER trg_limit_subscription_requests
    BEFORE INSERT ON public.subscription_requests
    FOR EACH ROW EXECUTE FUNCTION public.limit_subscription_requests();

-- ------------------------------------------------------------
-- 2. Données utilisateur : au plus 100 clés par compte, 5 Mo par clé
--    (les vraies données d'un client sont très en dessous)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.limit_user_data()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
    IF public.is_admin() THEN
        RETURN NEW;
    END IF;

    IF octet_length(NEW.value::text) > 5 * 1024 * 1024 THEN
        RAISE EXCEPTION 'quota: donnée trop volumineuse' USING ERRCODE = 'P0001';
    END IF;

    IF TG_OP = 'INSERT' AND
       (SELECT count(*) FROM public.user_data d WHERE d.user_id = NEW.user_id) >= 100 THEN
        RAISE EXCEPTION 'quota: trop de clés' USING ERRCODE = 'P0001';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_limit_user_data ON public.user_data;
CREATE TRIGGER trg_limit_user_data
    BEFORE INSERT OR UPDATE ON public.user_data
    FOR EACH ROW EXECUTE FUNCTION public.limit_user_data();

-- ------------------------------------------------------------
-- 3. Codes d'activation : 10 échecs par heure et par compte
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.code_attempts (
    id      BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL,
    at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_code_attempts_user_at ON public.code_attempts (user_id, at DESC);
ALTER TABLE public.code_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.code_attempts FROM PUBLIC, anon, authenticated;

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

    v_days := CASE v_row.type
                WHEN 'monthly'    THEN 30
                WHEN 'semestrial' THEN 183
                WHEN 'annual'     THEN 365
                WHEN 'business'   THEN 30
                WHEN 'lifetime'   THEN NULL
                ELSE 30
              END;

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

SELECT 'triggers' AS check, string_agg(tgname, ', ') AS result
  FROM pg_trigger
 WHERE tgname IN ('trg_limit_subscription_requests', 'trg_limit_user_data');
