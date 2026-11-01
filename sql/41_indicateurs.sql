-- ============================================================================================================
-- 41 — Indicateurs de pilotage : chiffre d'affaires, coût des ventes, marge, charges, résultat de gestion, encaissements,
--      créances, dettes fournisseurs, stock, trésorerie — calculés CÔTÉ SERVEUR, sans aucun calcul fiscal
-- ============================================================================================================
-- FacturaPro 2.0 — PR 8. Dépend de : sql/36 (stock valorisé), sql/37 (achats), sql/38 (BL), sql/39 (trésorerie). À coller APRÈS sql/40.
--
-- DÉFINITIONS (période [p_from ; p_to], dates incluses) — ce sont des indicateurs de GESTION, pas un résultat fiscal :
--  * Chiffre d'affaires HT = factures émises (non brouillon) datées dans la période − avoirs émis datés dans la période (date
--    d'émission ; même règle que le tableau de bord). Une facture au statut enregistré « cancelled » SANS avoir lié est exclue.
--  * Encaissements clients = paiements datés dans la période (date du paiement, pas celle de la facture).
--  * Coût des ventes (CMV) = sorties de stock « facture » et « bon de livraison » de la période × coût figé à la sortie (CMUP),
--    − retours (entrées liées à une sortie : avoir avec retour, annulation de BL) × coût de la sortie d'origine,
--    + achats de marchandises NON suivies en stock datés dans la période (HT + TVA non déductible).
--    Les achats de marchandises suivies n'y entrent PAS (ils sont en stock) : aucun double comptage achat / stock.
--  * Marge brute = CA HT − CMV.
--  * Charges = lignes « charge » des achats actifs datés dans la période (HT + TVA si non déductible).
--  * Investissements = lignes « investissement » : affichés à part, HORS résultat (amortissements non calculés).
--  * Résultat de gestion estimé = marge brute − charges. Ni impôt, ni amortissement, ni charges sociales : ce n'est ni le
--    résultat fiscal, ni le revenu net du dirigeant (règles CGI 2026 non automatisées, cf. plan FacturaPro 2.0).
--  * Règlements fournisseurs, apports, retraits, impôts payés : flux de TRÉSORERIE (date du mouvement), jamais des charges.
--  * À la date p_to : créances clients (reste à encaisser, par facture, avoirs liés déduits, jamais négatif), dettes fournisseurs
--    (TTC des achats actifs − règlements nets), valeur du stock (CMUP), trésorerie (soldes des comptes).
--  * Fiabilité : indicateurs de complétude (brouillons, sorties au coût inconnu/estimé, BL non facturés, aucun achat saisi,
--    aucun compte de trésorerie, encaissements sans compte).
-- Sécurité : lecture seule, SECURITY DEFINER limitée au compte connecté (fin_uid), aucune donnée d'un autre compte. Réexécutable.
--
-- RETOUR ARRIÈRE : DROP FUNCTION IF EXISTS public.fin_summary(DATE, DATE), public.fin_monthly(DATE, DATE), public.fin_figures(UUID, DATE, DATE),
--                  public.fin_num(TEXT), public.fin_sales_docs(UUID);
-- ============================================================================================================

DO $$ BEGIN
    IF to_regclass('public.cash_movements') IS NULL OR to_regclass('public.deliveries') IS NULL THEN
        RAISE EXCEPTION 'PREREQUIS_MANQUANT: sql/36 à sql/39 doivent être appliqués avant sql/41';
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fin_num(t TEXT) RETURNS NUMERIC
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
BEGIN RETURN round(t::numeric, 2); EXCEPTION WHEN others THEN RETURN 0; END $$;
REVOKE ALL ON FUNCTION public.fin_num(TEXT) FROM PUBLIC, anon, authenticated;

-- Documents de vente émis (factures et avoirs) d'un compte, lus dans user_data (source de vérité actuelle des ventes)
CREATE OR REPLACE FUNCTION public.fin_sales_docs(p_uid UUID)
RETURNS TABLE (id TEXT, doc_type TEXT, doc_date DATE, status TEXT, total_ht NUMERIC, total_ttc NUMERIC, related_id TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT e->>'id', COALESCE(NULLIF(e->>'type', ''), 'invoice'),
           CASE WHEN (e->>'date') ~ '^\d{4}-\d{2}-\d{2}' THEN left(e->>'date', 10)::date END,
           COALESCE(e->>'status', 'draft'),
           public.fin_num(e->>'totalHT'), public.fin_num(e->>'totalTTC'), NULLIF(e->>'relatedInvoiceId', '')
      FROM public.user_data d, LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(d.value) = 'array' THEN d.value ELSE '[]'::jsonb END) e
     WHERE d.user_id = p_uid AND d.key = 'invoices' AND jsonb_typeof(e) = 'object' AND COALESCE(NULLIF(e->>'type', ''), 'invoice') IN ('invoice', 'credit')
$$;
REVOKE ALL ON FUNCTION public.fin_sales_docs(UUID) FROM PUBLIC, anon, authenticated;

-- Chiffres de gestion d'une période (fonction interne)
CREATE OR REPLACE FUNCTION public.fin_figures(p_uid UUID, p_from DATE, p_to DATE) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_sales NUMERIC; v_inv NUMERIC; v_cred NUMERIC; v_coll NUMERIC; v_exits NUMERIC; v_returns NUMERIC; v_untracked NUMERIC;
    v_charges NUMERIC; v_assets NUMERIC; v_cmv NUMERIC; v_unknown INT; v_drafts INT;
BEGIN
    -- Ventes
    WITH s AS (SELECT * FROM public.fin_sales_docs(p_uid)),
         cred AS (SELECT DISTINCT related_id FROM s WHERE doc_type = 'credit' AND status <> 'draft' AND related_id IS NOT NULL)
    SELECT COALESCE(sum(CASE WHEN doc_type = 'invoice' THEN total_ht END), 0),
           COALESCE(sum(CASE WHEN doc_type = 'credit' THEN abs(total_ht) END), 0)
      INTO v_inv, v_cred
      FROM s
     WHERE status <> 'draft' AND doc_date BETWEEN p_from AND p_to
       AND NOT (doc_type = 'invoice' AND status = 'cancelled' AND id NOT IN (SELECT related_id FROM cred));
    v_sales := v_inv - v_cred;
    SELECT count(*) INTO v_drafts FROM public.fin_sales_docs(p_uid) WHERE status = 'draft' AND doc_type = 'invoice' AND doc_date BETWEEN p_from AND p_to;
    -- Encaissements clients (date de paiement)
    SELECT COALESCE(sum(amount), 0) INTO v_coll FROM public.fin_customer_payments(p_uid) WHERE pay_date BETWEEN p_from AND p_to;
    -- Coût des ventes : sorties au coût figé, retours au coût de la sortie d'origine
    SELECT COALESCE(sum(round(m.qty * COALESCE(m.unit_cost, 0), 2)), 0),
           count(*) FILTER (WHERE NOT COALESCE(m.cost_known, false) OR m.unit_cost IS NULL)
      INTO v_exits, v_unknown
      FROM public.stock_movements m
     WHERE m.user_id = p_uid AND m.move_type = 'out' AND m.source IN ('invoice', 'delivery') AND m.move_date BETWEEN p_from AND p_to;
    SELECT COALESCE(sum(round(m.qty * COALESCE(m.unit_cost, 0), 2)), 0)
      INTO v_returns
      FROM public.stock_movements m
     WHERE m.user_id = p_uid AND m.move_type = 'in' AND m.return_of IS NOT NULL AND m.source IN ('credit', 'delivery') AND m.move_date BETWEEN p_from AND p_to;
    -- Achats actifs de la période, par nature (HT + TVA si non déductible)
    SELECT COALESCE(sum(CASE WHEN l.nature = 'goods' AND NOT l.track_stock THEN l.total_ht + CASE WHEN p.vat_deductible THEN 0 ELSE l.total_tva END END), 0),
           COALESCE(sum(CASE WHEN l.nature = 'expense' THEN l.total_ht + CASE WHEN p.vat_deductible THEN 0 ELSE l.total_tva END END), 0),
           COALESCE(sum(CASE WHEN l.nature = 'asset' THEN l.total_ht + CASE WHEN p.vat_deductible THEN 0 ELSE l.total_tva END END), 0)
      INTO v_untracked, v_charges, v_assets
      FROM public.purchases p JOIN public.purchase_lines l ON l.purchase_id = p.id
     WHERE p.user_id = p_uid AND p.status = 'active' AND p.doc_date BETWEEN p_from AND p_to;
    v_cmv := v_exits - v_returns + v_untracked;
    RETURN jsonb_build_object(
        'from', p_from, 'to', p_to,
        'sales_ht', v_sales, 'invoices_ht', v_inv, 'credits_ht', v_cred, 'collections', v_coll,
        'cogs', v_cmv, 'cogs_stock_exits', v_exits, 'cogs_returns', v_returns, 'cogs_untracked_goods', v_untracked,
        'gross_margin', v_sales - v_cmv, 'gross_margin_rate', CASE WHEN v_sales > 0 THEN round((v_sales - v_cmv) / v_sales * 100, 1) END,
        'charges', v_charges, 'investments', v_assets, 'result', v_sales - v_cmv - v_charges,
        'exits_cost_unknown', v_unknown, 'draft_invoices', v_drafts);
END; $$;
REVOKE ALL ON FUNCTION public.fin_figures(UUID, DATE, DATE) FROM PUBLIC, anon, authenticated;

-- Synthèse d'une période + situation à la date de fin
CREATE OR REPLACE FUNCTION public.fin_summary(p_from DATE, p_to DATE) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    v UUID := public.fin_uid(); f JSONB; v_recv NUMERIC; v_pay NUMERIC; v_stock NUMERIC; v_stock_unknown INT; v_cash NUMERIC; v_noacc NUMERIC;
    v_has_acc BOOLEAN; v_nbpur INT; v_blni INT; flows JSONB;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 3700 THEN RAISE EXCEPTION 'PERIODE_INVALIDE'; END IF;
    f := public.fin_figures(v, p_from, p_to);
    -- Créances clients à p_to : par facture émise, TTC − paiements − avoirs liés (≤ p_to), jamais négatif
    WITH s AS (SELECT * FROM public.fin_sales_docs(v) WHERE status <> 'draft' AND doc_date <= p_to),
         pay AS (SELECT invoice_id, sum(amount) a FROM public.fin_customer_payments(v) WHERE pay_date <= p_to GROUP BY invoice_id),
         cr AS (SELECT related_id, sum(abs(total_ttc)) a FROM s WHERE doc_type = 'credit' GROUP BY related_id)
    SELECT COALESCE(sum(GREATEST(i.total_ttc - COALESCE(pay.a, 0) - COALESCE(cr.a, 0), 0)), 0) INTO v_recv
      FROM s i LEFT JOIN pay ON pay.invoice_id = i.id LEFT JOIN cr ON cr.related_id = i.id
     WHERE i.doc_type = 'invoice' AND i.status <> 'cancelled' AND i.total_ttc > 0;
    -- Dettes fournisseurs à p_to : TTC des achats actifs datés ≤ p_to − règlements nets (règlements − annulations) datés ≤ p_to
    SELECT COALESCE(sum(GREATEST(p.total_ttc - COALESCE((
               SELECT sum(CASE WHEN m.direction = 'out' THEN m.amount ELSE -m.amount END) FROM public.cash_movements m
                WHERE m.user_id = v AND m.purchase_id = p.id AND m.move_date <= p_to AND m.kind IN ('supplier_payment', 'reversal')), 0), 0)), 0)
      INTO v_pay
      FROM public.purchases p WHERE p.user_id = v AND p.status = 'active' AND p.doc_date <= p_to;
    SELECT COALESCE(sum(value), 0), COALESCE(sum(unknown_moves), 0) INTO v_stock, v_stock_unknown FROM public.stock_valuation(p_to);
    SELECT COALESCE(sum(balance) FILTER (WHERE account_id IS NOT NULL), 0), COALESCE(sum(customer_in) FILTER (WHERE account_id IS NULL), 0)
      INTO v_cash, v_noacc FROM public.cash_balances(p_to);
    v_has_acc := EXISTS (SELECT 1 FROM public.cash_accounts a WHERE a.user_id = v);
    SELECT count(*) INTO v_nbpur FROM public.purchases p WHERE p.user_id = v AND p.status = 'active' AND p.doc_date BETWEEN p_from AND p_to;
    SELECT count(*) INTO v_blni FROM public.deliveries d WHERE d.user_id = v AND d.status = 'active' AND d.invoice_id IS NULL AND d.delivery_date <= p_to;
    -- Flux de trésorerie de la période (hors virements internes ; une annulation est rattachée au type du mouvement annulé)
    SELECT jsonb_build_object(
             'supplier_payments', COALESCE(sum(-sg) FILTER (WHERE k = 'supplier_payment'), 0),
             'owner_net', COALESCE(sum(sg) FILTER (WHERE k IN ('owner_in', 'owner_out')), 0),
             'tax_payments', COALESCE(sum(-sg) FILTER (WHERE k = 'tax_payment'), 0),
             'other_net', COALESCE(sum(sg) FILTER (WHERE k IN ('other_in', 'other_out', 'adjustment_in', 'adjustment_out')), 0))
      INTO flows
      FROM (SELECT COALESCE(o.kind, m.kind) k, CASE WHEN m.direction = 'in' THEN m.amount ELSE -m.amount END sg
              FROM public.cash_movements m LEFT JOIN public.cash_movements o ON o.id = m.reverses_id
             WHERE m.user_id = v AND m.move_date BETWEEN p_from AND p_to) x
     WHERE k NOT IN ('transfer_in', 'transfer_out');
    RETURN f || jsonb_build_object(
        'receivables', v_recv, 'payables', v_pay, 'stock_value', v_stock, 'treasury', v_cash, 'cash_flows', flows,
        'completeness', jsonb_build_object(
            'draft_invoices', f->'draft_invoices', 'exits_cost_unknown', f->'exits_cost_unknown', 'stock_moves_cost_unknown', v_stock_unknown,
            'purchases_recorded', v_nbpur, 'deliveries_not_invoiced', v_blni, 'has_cash_accounts', v_has_acc, 'payments_without_account', v_noacc),
        'notice', 'Indicateurs de gestion : pas un résultat fiscal (ni IS/IR, ni amortissements, ni charges sociales).');
END; $$;
REVOKE ALL ON FUNCTION public.fin_summary(DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_summary(DATE, DATE) TO authenticated;

-- Série mensuelle (au plus 24 mois) : CA, encaissements, CMV, marge, charges, résultat
CREATE OR REPLACE FUNCTION public.fin_monthly(p_from DATE, p_to DATE)
RETURNS TABLE (month TEXT, sales_ht NUMERIC, collections NUMERIC, cogs NUMERIC, gross_margin NUMERIC, charges NUMERIC, result NUMERIC)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fin_uid(); m DATE; e DATE; f JSONB;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN RAISE EXCEPTION 'PERIODE_INVALIDE'; END IF;
    m := date_trunc('month', p_from)::date;
    IF (EXTRACT(YEAR FROM age(date_trunc('month', p_to), m)) * 12 + EXTRACT(MONTH FROM age(date_trunc('month', p_to), m))) >= 24 THEN RAISE EXCEPTION 'PERIODE_TROP_LONGUE'; END IF;
    WHILE m <= p_to LOOP
        e := (m + INTERVAL '1 month - 1 day')::date;
        f := public.fin_figures(v, m, e);
        month := to_char(m, 'YYYY-MM'); sales_ht := (f->>'sales_ht')::numeric; collections := (f->>'collections')::numeric; cogs := (f->>'cogs')::numeric;
        gross_margin := (f->>'gross_margin')::numeric; charges := (f->>'charges')::numeric; result := (f->>'result')::numeric;
        RETURN NEXT;
        m := (m + INTERVAL '1 month')::date;
    END LOOP;
END; $$;
REVOKE ALL ON FUNCTION public.fin_monthly(DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_monthly(DATE, DATE) TO authenticated;
