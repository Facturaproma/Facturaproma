-- ============================================================
-- 12 - ADMIN : supprimer un compte (de test) depuis le bouton « Supprimer »
-- ============================================================
-- À exécuter dans Supabase > SQL Editor (nouvelle requête), après 08 et 10. Idempotent.
-- Supprime DÉFINITIVEMENT le compte et ses données, licence, codes, paiements enregistrés
-- et demandes. Refuse les administrateurs et ton propre compte. Trace l'action dans le Journal.
-- ============================================================

CREATE OR REPLACE FUNCTION public.admin_delete_account(p_user UUID)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_admin_email  TEXT;
    v_email        TEXT;
    n_data INT; n_lic INT; n_codes INT; n_pay INT; n_req INT;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;

    IF p_user = auth.uid() THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'self');
    END IF;

    SELECT email INTO v_email FROM auth.users WHERE id = p_user;
    IF v_email IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'unknown_user');
    END IF;
    IF EXISTS (SELECT 1 FROM public.admins a WHERE lower(a.email) = lower(v_email)) THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'is_admin');
    END IF;

    SELECT email INTO v_admin_email FROM auth.users WHERE id = auth.uid();

    DELETE FROM public.user_data WHERE user_id = p_user;            GET DIAGNOSTICS n_data  = ROW_COUNT;
    DELETE FROM public.licenses  WHERE user_id = p_user;            GET DIAGNOSTICS n_lic   = ROW_COUNT;
    DELETE FROM public.code_attempts WHERE user_id = p_user;
    DELETE FROM public.admin_codes WHERE lower(client_email) = lower(v_email);             GET DIAGNOSTICS n_codes = ROW_COUNT;
    DELETE FROM public.admin_payments WHERE lower(client_email) = lower(v_email);          GET DIAGNOSTICS n_pay   = ROW_COUNT;
    DELETE FROM public.subscription_requests WHERE lower(client_email) = lower(v_email);   GET DIAGNOSTICS n_req   = ROW_COUNT;
    DELETE FROM auth.users WHERE id = p_user;

    INSERT INTO public.admin_audit (admin_email, action, target_email, details)
    VALUES (v_admin_email, 'delete_account', v_email,
            jsonb_build_object('data_rows', n_data, 'licenses', n_lic, 'codes', n_codes,
                               'payments', n_pay, 'requests', n_req));

    RETURN jsonb_build_object('ok', true, 'email', v_email,
                              'codes', n_codes, 'payments', n_pay, 'requests', n_req);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_delete_account(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_account(UUID) TO authenticated;

SELECT 'admin_delete_account' AS check, count(*)::text AS result
  FROM pg_proc WHERE proname = 'admin_delete_account';
