-- ============================================================================================================
-- 45 — Ventes et paiements dans de vraies tables (mode « documents ») : FacturaPro 2.0 compatible
-- ============================================================================================================
-- Dépend de : sql/15, 16, 17 (documents, doc_payments, doc_history, migration par compte, mode par compte),
--             sql/37–44 (achats, livraisons, trésorerie, clôture, indicateurs, avoirs). À coller APRÈS sql/44.
--
-- POURQUOI
--  Les fonctions de FacturaPro 2.0 (Pilotage, journaux, clôture, livraisons, trésorerie) lisaient les ventes et paiements dans
--  user_data. Un compte passé en mode « documents » (sql/17) a ses ventes dans documents / doc_payments : sans ce script, ses
--  indicateurs seraient faux et ses garde-fous (clôture, plafonds, avoirs partiels, annulation de paiement) absents.
--
-- CONTENU
--  1) Sources uniques : fp_sales_array(uid) et fp_payments_array(uid) renvoient les factures/avoirs et les paiements du compte,
--     lus dans la bonne source selon son mode (user_data en mode legacy, documents/doc_payments en mode documents).
--  2) Lecteurs FacturaPro 2.0 réécrits sur ces sources (même signature, même résultat en mode legacy) : fin_sales_docs (sql/41),
--     fin_customer_payments (sql/39), fin_invoice_status et delivery_invoice_issued (sql/38), period_check (sql/40).
--     Ces définitions REMPLACENT celles des scripts d'origine : ne pas recoller 38–41 après ce script sans recoller 45.
--  3) record_payment (remplace sql/15 et sql/25) : plafond = TTC − avoirs émis − paiements, annulation d'un paiement par une ligne
--     inverse (montant négatif, reversesId, motif côté application), période clôturée refusée, statut recalculé (payée ↔ envoyée),
--     compte de trésorerie (accountId) conservé dans le paiement.
--  4) Déclencheur trg_10_fin_documents sur documents : émission d'une facture/avoir dans une période clôturée refusée ;
--     cumul des avoirs d'une facture plafonné à son TTC (même règle que sql/43 pour user_data).
--  Aucune donnée n'est modifiée par ce script. Les comptes restent en mode legacy tant que l'opérateur ne les bascule pas
--  (fp_doc_mode_set, sql/17, qui copie, vérifie et peut revenir en arrière).
-- Sécurité : fonctions internes non exposées (REVOKE) ; seules les fonctions déjà publiques gardent leurs droits.
-- Réexécutable.
-- ============================================================================================================

DO $$ BEGIN
    IF to_regclass('public.documents') IS NULL OR to_regprocedure('public.fp_doc_mode(uuid)') IS NULL OR to_regclass('public.purchase_credits') IS NULL THEN
        RAISE EXCEPTION 'PREREQUIS_MANQUANT: sql/15, 16, 17 et 44 doivent être appliqués avant sql/45';
    END IF;
END $$;

-- ---------- 1) sources uniques ----------
CREATE OR REPLACE FUNCTION public.fp_sales_array(p_uid UUID) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v JSONB;
BEGIN
    IF public.fp_doc_mode(p_uid) = 'documents' THEN
        SELECT COALESCE(jsonb_agg(d.body ORDER BY d.created_at, d.id), '[]'::jsonb) INTO v
          FROM public.documents d WHERE d.user_id = p_uid AND d.doc_type IN ('invoice', 'credit');
    ELSE
        SELECT CASE WHEN jsonb_typeof(u.value) = 'array' THEN u.value END INTO v FROM public.user_data u WHERE u.user_id = p_uid AND u.key = 'invoices';
    END IF;
    RETURN COALESCE(v, '[]'::jsonb);
END; $$;
REVOKE ALL ON FUNCTION public.fp_sales_array(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fp_payments_array(p_uid UUID) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v JSONB;
BEGIN
    IF public.fp_doc_mode(p_uid) = 'documents' THEN
        SELECT COALESCE(jsonb_agg(p.body ORDER BY p.created_at, p.id), '[]'::jsonb) INTO v FROM public.doc_payments p WHERE p.user_id = p_uid;
    ELSE
        SELECT CASE WHEN jsonb_typeof(u.value) = 'array' THEN u.value END INTO v FROM public.user_data u WHERE u.user_id = p_uid AND u.key = 'payments';
    END IF;
    RETURN COALESCE(v, '[]'::jsonb);
END; $$;
REVOKE ALL ON FUNCTION public.fp_payments_array(UUID) FROM PUBLIC, anon, authenticated;

-- ---------- 2) lecteurs FacturaPro 2.0 ----------
CREATE OR REPLACE FUNCTION public.fin_sales_docs(p_uid UUID)
RETURNS TABLE (id TEXT, doc_type TEXT, doc_date DATE, status TEXT, total_ht NUMERIC, total_ttc NUMERIC, related_id TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT e->>'id', COALESCE(NULLIF(e->>'type', ''), 'invoice'),
           CASE WHEN (e->>'date') ~ '^\d{4}-\d{2}-\d{2}' THEN left(e->>'date', 10)::date END,
           COALESCE(e->>'status', 'draft'),
           public.fin_num(e->>'totalHT'), public.fin_num(e->>'totalTTC'), NULLIF(e->>'relatedInvoiceId', '')
      FROM jsonb_array_elements(public.fp_sales_array(p_uid)) e
     WHERE jsonb_typeof(e) = 'object' AND COALESCE(NULLIF(e->>'type', ''), 'invoice') IN ('invoice', 'credit')
$$;
REVOKE ALL ON FUNCTION public.fin_sales_docs(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fin_customer_payments(p_uid UUID)
RETURNS TABLE (payment_id TEXT, invoice_id TEXT, pay_date DATE, amount NUMERIC, account_id TEXT, method TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT e->>'id', e->>'invoiceId',
           CASE WHEN (e->>'date') ~ '^\d{4}-\d{2}-\d{2}' THEN left(e->>'date', 10)::date END,
           CASE WHEN (e->>'amount') ~ '^-?\d+(\.\d+)?$' THEN round((e->>'amount')::numeric, 2) ELSE 0 END,
           NULLIF(e->>'accountId', ''), e->>'method'
      FROM jsonb_array_elements(public.fp_payments_array(p_uid)) e
     WHERE jsonb_typeof(e) = 'object'
$$;
REVOKE ALL ON FUNCTION public.fin_customer_payments(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fin_invoice_status(p_uid UUID, p_invoice_id TEXT) RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT CASE WHEN COALESCE(e->>'status', 'draft') = 'draft' THEN 'draft' ELSE 'issued' END
      FROM jsonb_array_elements(public.fp_sales_array(p_uid)) e
     WHERE e->>'id' = p_invoice_id
     LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.fin_invoice_status(UUID, TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.delivery_invoice_issued(p_invoice_id TEXT, p_number TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fin_uid(); n INT; v_num TEXT; v_st TEXT;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    IF COALESCE(btrim(p_number), '') = '' OR char_length(p_number) > 40 THEN RAISE EXCEPTION 'NUMERO_INVALIDE'; END IF;
    SELECT e->>'number', COALESCE(e->>'status', 'draft') INTO v_num, v_st FROM jsonb_array_elements(public.fp_sales_array(v)) e
     WHERE e->>'id' = p_invoice_id LIMIT 1;
    -- facture déjà synchronisée comme émise : son numéro fait foi ; encore brouillon (synchronisation en cours) : numéro accepté
    IF v_st IS NOT NULL AND v_st <> 'draft' AND v_num IS DISTINCT FROM p_number THEN RAISE EXCEPTION 'NUMERO_DIFFERENT'; END IF;
    UPDATE public.deliveries SET invoice_number = p_number WHERE user_id = v AND invoice_id = p_invoice_id AND status = 'active';
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN jsonb_build_object('updated', n);
END; $$;
REVOKE ALL ON FUNCTION public.delivery_invoice_issued(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delivery_invoice_issued(TEXT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.period_check(p_month TEXT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fin_uid(); e DATE := public.fin_month_end(p_month); inv JSONB; pay JSONB;
        n_draft INT := 0; n_nopay INT := 0; n_cost INT := 0; n_pur INT := 0; n_bl INT := 0; n_cash INT := 0;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    inv := public.fp_sales_array(v);
    pay := public.fp_payments_array(v);
    SELECT count(*) INTO n_draft FROM jsonb_array_elements(inv) x
     WHERE jsonb_typeof(x) = 'object' AND COALESCE(x->>'status', 'draft') = 'draft' AND (x->>'date') ~ '^\d{4}-\d{2}-\d{2}' AND left(x->>'date', 10)::date <= e;
    IF EXISTS (SELECT 1 FROM public.cash_accounts a WHERE a.user_id = v) THEN
        SELECT count(*) INTO n_nopay FROM jsonb_array_elements(pay) x
         WHERE jsonb_typeof(x) = 'object' AND NULLIF(x->>'accountId', '') IS NULL AND (x->>'date') ~ '^\d{4}-\d{2}-\d{2}' AND left(x->>'date', 10)::date <= e
           AND left(x->>'date', 10)::date >= (SELECT min(a.opening_date) FROM public.cash_accounts a WHERE a.user_id = v);
    END IF;
    SELECT count(*) INTO n_cost FROM public.stock_movements m WHERE m.user_id = v AND m.move_date <= e AND NOT COALESCE(m.cost_known, false);
    SELECT count(*) INTO n_pur FROM public.purchases p WHERE p.user_id = v AND p.status = 'active' AND date_trunc('month', p.doc_date) = date_trunc('month', e);
    SELECT count(*) INTO n_bl FROM public.deliveries d WHERE d.user_id = v AND d.status = 'active' AND d.invoice_id IS NULL AND d.delivery_date <= e;
    SELECT count(*) INTO n_cash FROM public.cash_movements c WHERE c.user_id = v AND date_trunc('month', c.move_date) = date_trunc('month', e);
    RETURN jsonb_build_object('period_end', e, 'lock_date', public.fin_lock_date(v), 'month_finished', e < current_date,
        'draft_invoices', n_draft, 'payments_without_account', n_nopay, 'stock_moves_cost_unknown', n_cost,
        'purchases', n_pur, 'deliveries_not_invoiced', n_bl, 'cash_movements', n_cash);
END; $$;
REVOKE ALL ON FUNCTION public.period_check(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.period_check(TEXT) TO authenticated;

-- ---------- 3) paiements (mode documents) ----------
-- p_payment = { id, date, amount, method, reference, notes, accountId?, reversesId? }
--   amount > 0 : encaissement, plafonné à TTC − avoirs émis − encaissements nets déjà enregistrés ;
--   amount < 0 : annulation d'un encaissement existant de la même facture (reversesId), du même montant, une seule fois.
CREATE OR REPLACE FUNCTION public.record_payment(p_invoice_id TEXT, p_payment JSONB, p_op_id TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    v_uid UUID := auth.uid(); r public.documents%ROWTYPE; o public.doc_payments%ROWTYPE; v_pid TEXT := p_payment->>'id';
    v_amt NUMERIC; v_date DATE; v_before NUMERIC; v_total NUMERIC; v_cred NUMERIC; v_rev TEXT; b JSONB; n INT;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE'; END IF;
    IF NOT COALESCE(public.has_active_license(v_uid), FALSE) THEN RAISE EXCEPTION 'LICENCE_INACTIVE'; END IF;
    v_amt := round(COALESCE(public.fp_num(p_payment->>'amount'), 0), 2);
    IF v_pid IS NULL OR length(v_pid) = 0 OR length(v_pid) > 100 OR v_amt = 0 OR abs(v_amt) > 1000000000 THEN RAISE EXCEPTION 'PAIEMENT_INVALIDE'; END IF;
    v_date := COALESCE(public.fp_date(p_payment->>'date'), current_date);
    SELECT * INTO r FROM public.documents WHERE user_id = v_uid AND doc_type = 'invoice' AND id = p_invoice_id FOR UPDATE;   -- sérialise les paiements d'une facture
    IF NOT FOUND THEN RAISE EXCEPTION 'FACTURE_INTROUVABLE'; END IF;
    IF r.status = 'draft' THEN RAISE EXCEPTION 'PAIEMENT_SUR_BROUILLON: émettez la facture avant d''enregistrer un paiement'; END IF;
    IF EXISTS (SELECT 1 FROM public.doc_payments WHERE user_id = v_uid AND id = v_pid) THEN
        RETURN jsonb_build_object('ok', true, 'replay', true, 'version', r.version);               -- rejeu : réponse identique
    END IF;
    PERFORM public.fin_assert_open(v_uid, v_date);                                                 -- période clôturée (sql/40)
    SELECT COALESCE(SUM(amount), 0) INTO v_before FROM public.doc_payments WHERE user_id = v_uid AND invoice_id = p_invoice_id;
    SELECT COALESCE(SUM(abs(d.total_ttc)), 0) INTO v_cred FROM public.documents d
     WHERE d.user_id = v_uid AND d.doc_type = 'credit' AND d.status <> 'draft' AND d.related_id = p_invoice_id;
    IF v_amt > 0 THEN
        IF NULLIF(p_payment->>'reversesId', '') IS NOT NULL THEN RAISE EXCEPTION 'PAIEMENT_INVALIDE'; END IF;
        IF r.total_ttc <= 0 THEN RAISE EXCEPTION 'PAIEMENT_FACTURE_NULLE'; END IF;
        IF v_before + v_cred + v_amt > r.total_ttc + 0.01 THEN RAISE EXCEPTION 'PAIEMENT_SUPERIEUR_AU_RESTE'; END IF;
    ELSE
        v_rev := NULLIF(p_payment->>'reversesId', '');
        IF v_rev IS NULL THEN RAISE EXCEPTION 'ANNULATION_INVALIDE: paiement d''origine manquant'; END IF;
        SELECT * INTO o FROM public.doc_payments WHERE user_id = v_uid AND id = v_rev;
        IF NOT FOUND OR o.invoice_id IS DISTINCT FROM p_invoice_id OR o.amount <= 0 THEN RAISE EXCEPTION 'ANNULATION_INVALIDE: paiement d''origine introuvable'; END IF;
        IF abs(o.amount + v_amt) > 0.005 THEN RAISE EXCEPTION 'ANNULATION_INVALIDE: montant différent du paiement d''origine'; END IF;
        IF EXISTS (SELECT 1 FROM public.doc_payments WHERE user_id = v_uid AND body->>'reversesId' = v_rev) THEN RAISE EXCEPTION 'PAIEMENT_DEJA_ANNULE'; END IF;
    END IF;
    INSERT INTO public.doc_payments(user_id, id, body, body_sha, source)
    VALUES (v_uid, v_pid, p_payment || jsonb_build_object('invoiceId', p_invoice_id, 'amount', v_amt), '', 'app');
    v_total := v_before + v_amt;
    b := r.body || jsonb_build_object('paidAmount', v_total);
    IF v_total > 0.005 AND v_total + v_cred + 0.01 >= r.total_ttc THEN
        b := b || jsonb_build_object('status', 'paid', 'paidAt', COALESCE(p_payment->>'date', to_char(NOW(), 'YYYY-MM-DD')));
    ELSIF r.status = 'paid' THEN
        b := (b - 'paidAt') || jsonb_build_object('status', 'sent');                               -- annulation : la facture redevient à payer
    END IF;
    UPDATE public.documents SET body = b, version = r.version + 1, last_op_id = p_op_id, source = 'app'
     WHERE user_id = v_uid AND doc_type = 'invoice' AND id = p_invoice_id RETURNING version INTO n;
    RETURN jsonb_build_object('ok', true, 'version', n, 'paid_amount', v_total);
END;
$$;
REVOKE ALL ON FUNCTION public.record_payment(TEXT, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_payment(TEXT, JSONB, TEXT) TO authenticated;

-- ---------- 4) documents : clôture et plafond des avoirs ----------
-- « trg_10_ » s'exécute avant trg_guard_documents (sql/15) : les valeurs sont lues dans le corps (body), seule source de vérité.
CREATE OR REPLACE FUNCTION public.fin_documents_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v_st TEXT := COALESCE(NEW.body->>'status', 'draft'); v_rel TEXT; v_inv NUMERIC; v_cum NUMERIC;
BEGIN
    IF public.fp_mig_active() OR NEW.doc_type = 'quote' OR v_st = 'draft' THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND COALESCE(OLD.body->>'status', 'draft') <> 'draft' THEN RETURN NEW; END IF;   -- déjà émis (immuable, sql/15)
    -- émission : date de la pièce hors période clôturée
    PERFORM public.fin_assert_open(NEW.user_id, COALESCE(public.fp_date(NEW.body->>'date'), current_date));
    IF NEW.doc_type = 'credit' THEN
        v_rel := NULLIF(NEW.body->>'relatedInvoiceId', '');
        IF v_rel IS NOT NULL THEN
            PERFORM pg_advisory_xact_lock(hashtextextended('fp_credit_cap:' || NEW.user_id::text, 0));
            SELECT abs(d.total_ttc) INTO v_inv FROM public.documents d WHERE d.user_id = NEW.user_id AND d.doc_type = 'invoice' AND d.id = v_rel;
            IF v_inv IS NOT NULL THEN
                SELECT COALESCE(SUM(abs(d.total_ttc)), 0) INTO v_cum FROM public.documents d
                 WHERE d.user_id = NEW.user_id AND d.doc_type = 'credit' AND d.status <> 'draft' AND d.related_id = v_rel AND d.id <> NEW.id;
                IF v_cum + abs(COALESCE(public.fp_num(NEW.body->>'totalTTC'), 0)) > v_inv + 0.01 THEN
                    RAISE EXCEPTION 'AVOIR_SUPERIEUR_FACTURE: le cumul des avoirs dépasse le total de la facture' USING ERRCODE = '23514';
                END IF;
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.fin_documents_guard() FROM PUBLIC, anon, authenticated;
CREATE OR REPLACE TRIGGER trg_10_fin_documents BEFORE INSERT OR UPDATE ON public.documents
    FOR EACH ROW EXECUTE FUNCTION public.fin_documents_guard();

-- ---------- 5) administration : nombre de factures et dernière activité, quelle que soit la source ----------
-- Remplace admin_list_accounts (sql/08) : même signature, mêmes droits ; seules les colonnes invoices_count et last_activity
-- lisent aussi les nouvelles tables (sinon un compte basculé paraîtrait figé côté administration).
CREATE OR REPLACE FUNCTION public.admin_list_accounts()
RETURNS TABLE (
    user_id UUID, email TEXT, created_at TIMESTAMPTZ, last_sign_in TIMESTAMPTZ, type TEXT, status TEXT, expires_at TIMESTAMPTZ,
    active BOOLEAN, code TEXT, is_staff BOOLEAN, last_activity TIMESTAMPTZ, invoices_count INT, clients_count INT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
    SELECT
        u.id, u.email::TEXT, u.created_at, u.last_sign_in_at,
        COALESCE(l.type, CASE WHEN st.is_staff THEN 'lifetime' ELSE 'trial' END),
        COALESCE(l.status, 'active'),
        CASE WHEN l.user_id IS NOT NULL THEN l.expires_at WHEN st.is_staff THEN NULL ELSE public.fp_trial_end(u.created_at) END,
        public.has_active_license(u.id), l.code, st.is_staff,
        GREATEST((SELECT MAX(d.updated_at) FROM public.user_data d WHERE d.user_id = u.id),
                 (SELECT MAX(x.updated_at) FROM public.documents x WHERE x.user_id = u.id),
                 (SELECT MAX(y.created_at) FROM public.doc_payments y WHERE y.user_id = u.id)),
        jsonb_array_length(public.fp_sales_array(u.id)),
        COALESCE((SELECT CASE WHEN jsonb_typeof(d.value) = 'array' THEN jsonb_array_length(d.value) ELSE 0 END
                    FROM public.user_data d WHERE d.user_id = u.id AND d.key = 'clients'), 0)
    FROM auth.users u
    LEFT JOIN public.licenses l ON l.user_id = u.id
    CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM public.admins a WHERE lower(a.email) = lower(u.email)) AS is_staff) st
    ORDER BY u.created_at DESC;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_list_accounts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_accounts() TO authenticated;
