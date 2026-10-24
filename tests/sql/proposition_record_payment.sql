-- PROPOSITION (NON APPLIQUÉE EN PRODUCTION) : record_payment avec contrôle du cumul. Chargée uniquement par
-- tests/integration/paiements.sql-concurrence.test.js, dans une base PostgreSQL locale jetable.
-- Différences avec sql/15 : (1) montant > reste refusé, (2) facture de total <= 0 refusée. Le reste est inchangé.
CREATE OR REPLACE FUNCTION public.record_payment(p_invoice_id TEXT, p_payment JSONB, p_op_id TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    v_uid UUID := auth.uid(); r public.documents%ROWTYPE; v_pid TEXT := p_payment->>'id'; v_total NUMERIC; v_before NUMERIC; v_amt NUMERIC; b JSONB; n INT;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE'; END IF;
    IF NOT COALESCE(public.has_active_license(v_uid), FALSE) THEN RAISE EXCEPTION 'LICENCE_INACTIVE'; END IF;
    v_amt := COALESCE(public.fp_num(p_payment->>'amount'), 0);
    IF v_pid IS NULL OR length(v_pid) = 0 OR v_amt <= 0 THEN RAISE EXCEPTION 'PAIEMENT_INVALIDE'; END IF;
    SELECT * INTO r FROM public.documents WHERE user_id = v_uid AND doc_type = 'invoice' AND id = p_invoice_id FOR UPDATE;   -- verrou de ligne : sérialise les paiements d'une même facture
    IF NOT FOUND THEN RAISE EXCEPTION 'FACTURE_INTROUVABLE'; END IF;
    IF r.status = 'draft' THEN RAISE EXCEPTION 'PAIEMENT_SUR_BROUILLON: émettez la facture avant d''enregistrer un paiement'; END IF;
    IF EXISTS (SELECT 1 FROM public.doc_payments WHERE user_id = v_uid AND id = v_pid) THEN
        RETURN jsonb_build_object('ok', true, 'replay', true, 'version', r.version);              -- rejeu : réponse identique, aucun contrôle de montant
    END IF;
    IF r.total_ttc <= 0 THEN RAISE EXCEPTION 'PAIEMENT_FACTURE_NULLE'; END IF;
    SELECT COALESCE(SUM(amount), 0) INTO v_before FROM public.doc_payments WHERE user_id = v_uid AND invoice_id = p_invoice_id;   -- lu APRÈS le verrou
    IF v_before + v_amt > r.total_ttc + 0.01 THEN RAISE EXCEPTION 'PAIEMENT_SUPERIEUR_AU_RESTE'; END IF;
    INSERT INTO public.doc_payments(user_id, id, body, body_sha, source)
    VALUES (v_uid, v_pid, p_payment || jsonb_build_object('invoiceId', p_invoice_id), '', 'app');
    SELECT COALESCE(SUM(amount), 0) INTO v_total FROM public.doc_payments WHERE user_id = v_uid AND invoice_id = p_invoice_id;
    b := r.body || jsonb_build_object('paidAmount', v_total);
    IF v_total + 0.01 >= r.total_ttc THEN
        b := b || jsonb_build_object('status', 'paid', 'paidAt', COALESCE(p_payment->>'date', to_char(NOW(), 'YYYY-MM-DD')));
    END IF;
    UPDATE public.documents SET body = b, version = r.version + 1, last_op_id = p_op_id, source = 'app'
     WHERE user_id = v_uid AND doc_type = 'invoice' AND id = p_invoice_id RETURNING version INTO n;
    RETURN jsonb_build_object('ok', true, 'version', n, 'paid_amount', v_total);
END;
$$;
