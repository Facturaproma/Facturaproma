-- ============================================================================================================
-- 47 — Relevé des déductions de TVA : mode de paiement des règlements fournisseurs + lecture des règlements par période
-- ============================================================================================================
-- Dépend de : sql/37 (achats, fin_audit), sql/39 (trésorerie), sql/40 (clôture). À coller APRÈS sql/44.
--
-- PRINCIPE
--  * Le droit à déduction de la TVA sur achats naît le mois du paiement (total ou partiel) de la facture.
--    Le relevé des déductions liste donc les RÈGLEMENTS fournisseurs de la période, avec leur mode de paiement.
--  * Le mode de paiement est rangé dans une table à part (payment_modes), une ligne par règlement :
--    les mouvements de trésorerie restent non modifiables (trg_cash_guard intact).
--  * supplier_settle accepte un champ facultatif « mode » ; payment_mode_set complète ou corrige le mode
--    d'un règlement déjà saisi (le montant et la date ne changent jamais), avec trace dans fin_audit.
--  * vat_deduction_payments(du, au) : règlements fournisseurs de la période (montant positif) et annulations
--    de règlements (montant négatif, au mois de l'annulation), avec le mode du règlement d'origine.
-- Sécurité : table FERMÉE (RLS sans politique, aucun droit direct) ; fonctions SECURITY DEFINER limitées au compte connecté.
-- Réexécutable. Ne modifie aucune donnée existante.
-- RETOUR ARRIÈRE (après accord, retirer d'abord l'application) : recoller supplier_settle de sql/39 (le champ « mode » est
--   alors ignoré), puis supprimer payment_mode_set, vat_deduction_payments et la table payment_modes.
-- ============================================================================================================

DO $$ BEGIN
    IF to_regclass('public.cash_movements') IS NULL OR to_regprocedure('public.fin_assert_open(uuid,date)') IS NULL THEN
        RAISE EXCEPTION 'PREREQUIS_MANQUANT: sql/39 et sql/40 doivent être appliqués avant sql/47';
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.payment_modes (
    movement_id UUID PRIMARY KEY REFERENCES public.cash_movements(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    mode        TEXT NOT NULL CHECK (mode IN ('especes', 'cheque', 'prelevement', 'virement', 'effet', 'compensation', 'autre')),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_modes_user_idx ON public.payment_modes (user_id);
ALTER TABLE public.payment_modes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payment_modes FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fin_pay_mode(p_mode TEXT) RETURNS TEXT LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
BEGIN
    IF p_mode IS NULL OR btrim(p_mode) = '' THEN RETURN NULL; END IF;
    IF btrim(p_mode) NOT IN ('especes', 'cheque', 'prelevement', 'virement', 'effet', 'compensation', 'autre') THEN RAISE EXCEPTION 'MODE_PAIEMENT_INVALIDE'; END IF;
    RETURN btrim(p_mode);
END; $$;
REVOKE ALL ON FUNCTION public.fin_pay_mode(TEXT) FROM PUBLIC, anon, authenticated;

-- Règlement fournisseur : identique à sql/39, plus le mode de paiement facultatif (contrôlé AVANT toute écriture)
CREATE OR REPLACE FUNCTION public.supplier_settle(p JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fin_uid(); m public.cash_movements%ROWTYPE; pu public.purchases%ROWTYPE; v_key TEXT; v_date DATE; v_amt NUMERIC; v_acc UUID; v_paid NUMERIC; v_id UUID; v_mode TEXT;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    IF NOT public.has_active_license(v) THEN RAISE EXCEPTION 'LICENCE_INACTIVE'; END IF;
    v_key := left(NULLIF(btrim(p->>'key'), ''), 200);
    -- Même clé envoyée deux fois en même temps (nouvel essai réseau) : la 2e attend la 1re puis renvoie la même pièce, sans erreur
    IF v_key IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('fp_idem:' || v::text || ':' || v_key, 0)); END IF;
    IF v_key IS NOT NULL THEN SELECT * INTO m FROM public.cash_movements WHERE user_id = v AND idem_key = v_key; IF FOUND THEN RETURN jsonb_build_object('id', m.id, 'duplicate', true); END IF; END IF;
    BEGIN v_date := (p->>'date')::date; v_amt := round((p->>'amount')::numeric, 2); v_acc := (p->>'account_id')::uuid;
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'REGLEMENT_INVALIDE'; END;
    v_mode := public.fin_pay_mode(p->>'mode');
    SELECT * INTO pu FROM public.purchases WHERE id = (p->>'purchase_id')::uuid AND user_id = v FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACHAT_INTROUVABLE'; END IF;
    IF pu.status <> 'active' THEN RAISE EXCEPTION 'ACHAT_ANNULE'; END IF;
    IF v_date IS NULL OR v_date < DATE '2000-01-01' OR v_date > current_date + 31 THEN RAISE EXCEPTION 'DATE_INVALIDE'; END IF;
    IF v_amt IS NULL OR v_amt <= 0 THEN RAISE EXCEPTION 'MONTANT_INVALIDE'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.cash_accounts WHERE id = v_acc AND user_id = v AND NOT archived) THEN RAISE EXCEPTION 'COMPTE_INTROUVABLE'; END IF;
    PERFORM public.fin_assert_open(v, v_date);
    v_paid := public.fin_purchase_paid(v, pu.id);
    v_paid := v_paid + public.fin_purchase_credited(v, pu.id, NULL);      -- les avoirs fournisseurs (sql/44) réduisent la dette
    IF v_paid + v_amt > pu.total_ttc + 0.005 THEN RAISE EXCEPTION 'REGLEMENT_SUPERIEUR_A_LA_DETTE: reste %', pu.total_ttc - v_paid; END IF;
    INSERT INTO public.cash_movements (user_id, account_id, move_date, direction, amount, kind, purchase_id, label, idem_key)
    VALUES (v, v_acc, v_date, 'out', v_amt, 'supplier_payment', pu.id, left(COALESCE(NULLIF(btrim(p->>'label'), ''), pu.number || ' · ' || pu.supplier_name), 200), v_key)
    RETURNING id INTO v_id;
    IF v_mode IS NOT NULL THEN INSERT INTO public.payment_modes (movement_id, user_id, mode) VALUES (v_id, v, v_mode); END IF;
    RETURN jsonb_build_object('id', v_id, 'duplicate', false, 'remaining', pu.total_ttc - v_paid - v_amt);
END; $$;
REVOKE ALL ON FUNCTION public.supplier_settle(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.supplier_settle(JSONB) TO authenticated;

-- Compléter / corriger le mode d'un règlement fournisseur (métadonnée : ni montant ni date ne changent)
CREATE OR REPLACE FUNCTION public.payment_mode_set(p_movement UUID, p_mode TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fin_uid(); m public.cash_movements%ROWTYPE; v_mode TEXT; v_old TEXT;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    IF NOT public.has_active_license(v) THEN RAISE EXCEPTION 'LICENCE_INACTIVE'; END IF;
    v_mode := public.fin_pay_mode(p_mode);
    IF v_mode IS NULL THEN RAISE EXCEPTION 'MODE_PAIEMENT_INVALIDE'; END IF;
    SELECT * INTO m FROM public.cash_movements WHERE id = p_movement AND user_id = v;
    IF NOT FOUND OR m.kind <> 'supplier_payment' THEN RAISE EXCEPTION 'REGLEMENT_INTROUVABLE'; END IF;
    SELECT mode INTO v_old FROM public.payment_modes WHERE movement_id = m.id;
    INSERT INTO public.payment_modes (movement_id, user_id, mode) VALUES (m.id, v, v_mode)
    ON CONFLICT (movement_id) DO UPDATE SET mode = EXCLUDED.mode, updated_at = now();
    IF v_old IS DISTINCT FROM v_mode THEN
        INSERT INTO public.fin_audit (user_id, action, entity, entity_id, detail) VALUES (v, 'mode_paiement', 'cash_movement', m.id::text, jsonb_build_object('avant', v_old, 'apres', v_mode));
    END IF;
    RETURN jsonb_build_object('id', m.id, 'mode', v_mode);
END; $$;
REVOKE ALL ON FUNCTION public.payment_mode_set(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.payment_mode_set(UUID, TEXT) TO authenticated;

-- Règlements fournisseurs d'une période (NULL = sans borne). Annulation d'un règlement : montant négatif, à sa date.
CREATE OR REPLACE FUNCTION public.vat_deduction_payments(p_from DATE, p_to DATE)
RETURNS TABLE (movement_id UUID, purchase_id UUID, pay_date DATE, amount NUMERIC, mode TEXT, reversal BOOLEAN, original_id UUID)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fin_uid();
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    RETURN QUERY
    SELECT m.id, m.purchase_id, m.move_date,
           (CASE WHEN m.kind = 'reversal' THEN -m.amount ELSE m.amount END)::numeric(14,2),
           pm.mode, m.kind = 'reversal', COALESCE(o.id, m.id)
      FROM public.cash_movements m
      LEFT JOIN public.cash_movements o ON o.id = m.reverses_id
      LEFT JOIN public.payment_modes pm ON pm.movement_id = COALESCE(o.id, m.id)
     WHERE m.user_id = v AND m.purchase_id IS NOT NULL
       AND (m.kind = 'supplier_payment' OR (m.kind = 'reversal' AND o.kind = 'supplier_payment'))
       AND (p_from IS NULL OR m.move_date >= p_from) AND (p_to IS NULL OR m.move_date <= p_to)
     ORDER BY m.move_date, m.created_at;
END; $$;
REVOKE ALL ON FUNCTION public.vat_deduction_payments(DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vat_deduction_payments(DATE, DATE) TO authenticated;
