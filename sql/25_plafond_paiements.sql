-- ============================================================================================================
-- 25 — Plafond des paiements côté serveur (record_payment)                         *** BROUILLON : NON APPLIQUÉ ***
-- ============================================================================================================
-- Ce script N'EST PAS dans sql/MANIFEST.json et ne doit être exécuté qu'après autorisation écrite explicite :
--   1. préproduction (njjaomichdlnoscrnxlz) uniquement, via le circuit validé (docs/PLAN_VALIDATION_PREPROD_PAIEMENTS.md) ;
--   2. production : seulement après validation complète en préproduction et nouvelle autorisation.
-- Effet : un paiement qui ferait dépasser le TTC de la facture (tolérance 0,01) est refusé (PAIEMENT_SUPERIEUR_AU_RESTE) ;
-- une facture de total <= 0 refuse tout paiement (PAIEMENT_FACTURE_NULLE). Le reste de la fonction est identique à sql/15
-- (rejeu par identifiant de paiement, verrou de ligne, mise à jour atomique). Aucune table ni donnée n'est modifiée.
-- Portée : n'agit que pour les comptes en mode « documents » (sql/17) ; les comptes « legacy » n'appellent pas record_payment.
-- Réexécutable : CREATE OR REPLACE + droits ré-affirmés. Les lignes existantes ne sont jamais réécrites.
--
-- RETOUR ARRIÈRE : ré-exécuter le bloc « record_payment » de sql/15_documents.sql (CREATE OR REPLACE FUNCTION public.record_payment …
-- jusqu'à son END; $$;) puis les REVOKE/GRANT de la fin du bloc. Aucune donnée à restaurer.
-- ============================================================================================================

DO $$
BEGIN
    IF to_regclass('public.documents') IS NULL OR to_regclass('public.doc_payments') IS NULL
       OR to_regprocedure('public.record_payment(text,jsonb,text)') IS NULL
       OR to_regprocedure('public.has_active_license(uuid)') IS NULL OR to_regprocedure('public.fp_num(text)') IS NULL THEN
        RAISE EXCEPTION 'PREREQUIS_MANQUANT: sql/15 (documents, doc_payments, record_payment) doit être installé avant sql/25';
    END IF;
END $$;

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

REVOKE ALL ON FUNCTION public.record_payment(TEXT, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_payment(TEXT, JSONB, TEXT) TO authenticated;
