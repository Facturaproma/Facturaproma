-- ============================================================
-- 23 — admin_set_license : pas de changement de formule sur un abonnement payant actif vers une formule non plus longue
--
-- Complète 22 : la fenêtre « Licence du compte » (admin.html) propose déjà de PROGRAMMER la nouvelle formule à la suite ;
-- ce script applique la même règle côté base, donc aussi pour un appel direct à la fonction.
-- Refusé (reason = 'already_subscribed') : p_type différent du type actuel quand le compte a un abonnement payant ACTIF
-- (monthly, semestrial, annual, business, non expiré, non suspendu) et que la formule demandée n'est pas strictement plus
-- longue (ou est « trial »). Autorisé : formule plus longue, prolongation (p_type NULL ou identique + p_days), suspension /
-- réactivation, tout changement sur un abonnement expiré, un essai ou un accès « à vie » (offert : l'admin peut le corriger).
--
-- Compatibilité : redéfinition de admin_set_license à l'identique du script 08 + ce contrôle. Aucune donnée modifiée.
-- Idempotent. Dépend de 08 et 22 (plan_days).
-- Retour arrière : réexécuter la définition de admin_set_license du script 08.
-- ============================================================

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

    -- Abonnement payant ACTIF (hors « à vie », offert) : pas de changement de formule vers une formule non plus longue
    -- (prolonger la même formule ou en ajouter des jours reste possible ; l'admin programme alors à la suite, voir admin.html)
    IF p_type IS NOT NULL AND p_type <> v_cur.type
       AND v_cur.type IN ('monthly','semestrial','annual','business')
       AND v_cur.status = 'active'
       AND v_cur.expires_at IS NOT NULL AND v_cur.expires_at > NOW()
       AND (p_type = 'trial' OR public.plan_days(p_type) <=
            GREATEST(public.plan_days(v_cur.type),
                     COALESCE(public.plan_days((SELECT c.type FROM public.admin_codes c WHERE c.code = v_cur.code LIMIT 1)), 0))) THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'already_subscribed');
    END IF;

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

SELECT 'admin_set_license' AS check, count(*)::text AS result FROM pg_proc WHERE proname = 'admin_set_license';
