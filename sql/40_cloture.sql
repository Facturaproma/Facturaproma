-- ============================================================================================================
-- 40 — Clôture de période (mois) : plus aucune écriture datée dans une période clôturée
-- ============================================================================================================
-- FacturaPro 2.0 — PR 7. Dépend de : sql/37 (fin_uid, fin_audit, fin_assert_open), sql/38, sql/39. À coller APRÈS sql/39.
--
-- PRINCIPE
--  * Clôturer un mois = fixer une « date de verrouillage » : le dernier jour du mois. Tout ce qui est daté au plus tard à cette date
--    devient intouchable : achats, dépenses, bons de livraison, mouvements de stock, mouvements de trésorerie, comptes ouverts à
--    cette date, et aussi les FACTURES nouvellement émises et les PAIEMENTS nouveaux (données user_data, contrôle par déclencheur).
--  * Clôturer un mois clôture de fait tous les mois précédents (date de verrouillage unique = la plus récente clôture active).
--  * Seul un mois terminé peut être clôturé. Réouverture possible, UNIQUEMENT de la dernière clôture, avec un motif obligatoire,
--    journalisée (fin_audit) : la clôture reste une décision de gestion, pas un scellé fiscal.
--  * fin_assert_open() (point d'extension de sql/37, appelé par chaque fonction d'écriture) est remplacée par la vraie vérification.
--    En plus, des déclencheurs BEFORE INSERT sur les tables financières bloquent toute écriture datée dans une période clôturée,
--    quel que soit le chemin (défense en profondeur).
--  * user_data : déclencheur trg_20_fin_closure (après trg_10_payments_cap, qui fusionne d'abord les paiements). Il ne fait RIEN
--    tant que le compte n'a aucune clôture : aucun effet sur les comptes existants à l'installation.
-- Sécurité : table FERMÉE (RLS sans politique, aucun droit direct), fonctions SECURITY DEFINER limitées au compte connecté,
-- licence active pour clôturer / rouvrir, lecture toujours possible. Réexécutable.
--
-- RETOUR ARRIÈRE (retirer d'abord l'application de la PR 7) :
--   DROP TRIGGER IF EXISTS trg_20_fin_closure ON public.user_data;
--   DROP TRIGGER IF EXISTS trg_fin_closure_stock ON public.stock_movements;  DROP TRIGGER IF EXISTS trg_fin_closure_purchase ON public.purchases;
--   DROP TRIGGER IF EXISTS trg_fin_closure_delivery ON public.deliveries;    DROP TRIGGER IF EXISTS trg_fin_closure_cash ON public.cash_movements;
--   DROP TRIGGER IF EXISTS trg_fin_closure_account ON public.cash_accounts;
--   DROP FUNCTION IF EXISTS public.period_close(TEXT, TEXT), public.period_reopen(TEXT, TEXT), public.period_status(), public.period_check(TEXT),
--     public.fin_lock_date(UUID), public.fin_closure_row_guard(), public.fin_closure_userdata_guard(), public.fin_month_end(TEXT);
--   DROP TRIGGER IF EXISTS trg_closure_guard ON public.period_closures;  DROP FUNCTION IF EXISTS public.fin_closure_guard();
--   recoller la version « vide » de fin_assert_open de sql/37 ;  DROP TABLE IF EXISTS public.period_closures;
-- ============================================================================================================

DO $$ BEGIN
    IF to_regclass('public.cash_movements') IS NULL THEN RAISE EXCEPTION 'PREREQUIS_MANQUANT: sql/39 doit être appliqué avant sql/40'; END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.period_closures (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    period_end    DATE NOT NULL,
    closed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    note          TEXT CHECK (note IS NULL OR char_length(note) <= 300),
    reopened_at   TIMESTAMPTZ,
    reopen_reason TEXT CHECK (reopen_reason IS NULL OR char_length(reopen_reason) BETWEEN 3 AND 300),
    CHECK (period_end = (date_trunc('month', period_end) + INTERVAL '1 month - 1 day')::date),
    CHECK ((reopened_at IS NULL) = (reopen_reason IS NULL))
);
-- une seule clôture ACTIVE par mois
CREATE UNIQUE INDEX IF NOT EXISTS period_closures_active_uq ON public.period_closures (user_id, period_end) WHERE reopened_at IS NULL;
CREATE INDEX IF NOT EXISTS period_closures_user_idx ON public.period_closures (user_id, period_end DESC);
ALTER TABLE public.period_closures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.period_closures FROM PUBLIC, anon, authenticated;

-- Seule modification admise : la réouverture (reopened_at / reopen_reason, une fois).
CREATE OR REPLACE FUNCTION public.fin_closure_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF OLD.reopened_at IS NOT NULL OR NEW.reopened_at IS NULL
       OR (NEW.id, NEW.user_id, NEW.period_end, NEW.closed_at, NEW.note) IS DISTINCT FROM (OLD.id, OLD.user_id, OLD.period_end, OLD.closed_at, OLD.note) THEN
        RAISE EXCEPTION 'CLOTURE_IMMUABLE';
    END IF;
    RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.fin_closure_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_closure_guard ON public.period_closures;
CREATE TRIGGER trg_closure_guard BEFORE UPDATE ON public.period_closures FOR EACH ROW EXECUTE FUNCTION public.fin_closure_guard();

-- ---------- date de verrouillage et vérification ----------
CREATE OR REPLACE FUNCTION public.fin_lock_date(p_uid UUID) RETURNS DATE
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT max(c.period_end) FROM public.period_closures c WHERE c.user_id = p_uid AND c.reopened_at IS NULL
$$;
REVOKE ALL ON FUNCTION public.fin_lock_date(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fin_assert_open(p_uid UUID, p_date DATE) RETURNS VOID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE l DATE;
BEGIN
    IF p_uid IS NULL OR p_date IS NULL THEN RETURN; END IF;
    l := public.fin_lock_date(p_uid);
    IF l IS NOT NULL AND p_date <= l THEN
        RAISE EXCEPTION 'PERIODE_CLOTUREE: période clôturée jusqu''au %', to_char(l, 'DD/MM/YYYY') USING ERRCODE = 'P0001';
    END IF;
END; $$;
REVOKE ALL ON FUNCTION public.fin_assert_open(UUID, DATE) FROM PUBLIC, anon, authenticated;

-- ---------- déclencheurs des tables financières (toute insertion datée) ----------
CREATE OR REPLACE FUNCTION public.fin_closure_row_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d DATE;
BEGIN
    -- (branches séparées : PL/pgSQL résout NEW.<colonne> à l'exécution, une colonne absente de la table ferait échouer un CASE unique)
    IF TG_TABLE_NAME IN ('stock_movements', 'cash_movements') THEN d := NEW.move_date;
    ELSIF TG_TABLE_NAME = 'purchases' THEN d := NEW.doc_date;
    ELSIF TG_TABLE_NAME = 'deliveries' THEN d := NEW.delivery_date;
    ELSIF TG_TABLE_NAME = 'cash_accounts' THEN d := NEW.opening_date;
    ELSE RAISE EXCEPTION 'TABLE_NON_PRISE_EN_CHARGE';
    END IF;
    PERFORM public.fin_assert_open(NEW.user_id, d);
    RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.fin_closure_row_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_fin_closure_stock ON public.stock_movements;
CREATE TRIGGER trg_fin_closure_stock BEFORE INSERT ON public.stock_movements FOR EACH ROW EXECUTE FUNCTION public.fin_closure_row_guard();
DROP TRIGGER IF EXISTS trg_fin_closure_purchase ON public.purchases;
CREATE TRIGGER trg_fin_closure_purchase BEFORE INSERT ON public.purchases FOR EACH ROW EXECUTE FUNCTION public.fin_closure_row_guard();
DROP TRIGGER IF EXISTS trg_fin_closure_delivery ON public.deliveries;
CREATE TRIGGER trg_fin_closure_delivery BEFORE INSERT ON public.deliveries FOR EACH ROW EXECUTE FUNCTION public.fin_closure_row_guard();
DROP TRIGGER IF EXISTS trg_fin_closure_cash ON public.cash_movements;
CREATE TRIGGER trg_fin_closure_cash BEFORE INSERT ON public.cash_movements FOR EACH ROW EXECUTE FUNCTION public.fin_closure_row_guard();
DROP TRIGGER IF EXISTS trg_fin_closure_account ON public.cash_accounts;
CREATE TRIGGER trg_fin_closure_account BEFORE INSERT ON public.cash_accounts FOR EACH ROW EXECUTE FUNCTION public.fin_closure_row_guard();

-- ---------- user_data : factures nouvellement émises et paiements nouveaux ----------
-- Factures : refusé = une facture/avoir NON brouillon, datée dans la période clôturée, qui n'était pas déjà émise côté serveur.
--            (les factures déjà émises sont de toute façon immuables, sql/14/19 ; les brouillons restent libres.)
-- Paiements : refusé = un paiement d'identifiant nouveau daté dans la période clôturée (les anciens sont immuables, sql/26).
CREATE OR REPLACE FUNCTION public.fin_closure_userdata_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE l DATE; old_val JSONB; bad TEXT;
BEGIN
    IF jsonb_typeof(NEW.value) <> 'array' THEN RETURN NEW; END IF;
    l := public.fin_lock_date(NEW.user_id);
    IF l IS NULL THEN RETURN NEW; END IF;                                     -- aucune clôture : aucun contrôle
    SELECT u.value INTO old_val FROM public.user_data u WHERE u.user_id = NEW.user_id AND u.key = NEW.key;
    IF old_val IS NULL OR jsonb_typeof(old_val) <> 'array' THEN old_val := '[]'::jsonb; END IF;
    IF NEW.key = 'invoices' THEN
        SELECT COALESCE(e->>'number', e->>'id') INTO bad FROM jsonb_array_elements(NEW.value) e
         WHERE jsonb_typeof(e) = 'object' AND COALESCE(e->>'status', 'draft') <> 'draft'
           AND (e->>'date') ~ '^\d{4}-\d{2}-\d{2}' AND left(e->>'date', 10)::date <= l
           AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(old_val) o
                            WHERE jsonb_typeof(o) = 'object' AND o->>'id' = e->>'id' AND COALESCE(o->>'status', 'draft') <> 'draft')
         LIMIT 1;
        IF bad IS NOT NULL THEN
            RAISE EXCEPTION 'PERIODE_CLOTUREE: facture % datée dans une période clôturée (jusqu''au %)', bad, to_char(l, 'DD/MM/YYYY');
        END IF;
    ELSIF NEW.key = 'payments' THEN
        SELECT COALESCE(e->>'id', '?') INTO bad FROM jsonb_array_elements(NEW.value) e
         WHERE jsonb_typeof(e) = 'object' AND (e->>'date') ~ '^\d{4}-\d{2}-\d{2}' AND left(e->>'date', 10)::date <= l
           AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(old_val) o WHERE jsonb_typeof(o) = 'object' AND o->>'id' = e->>'id')
         LIMIT 1;
        IF bad IS NOT NULL THEN
            RAISE EXCEPTION 'PERIODE_CLOTUREE: paiement daté dans une période clôturée (jusqu''au %)', to_char(l, 'DD/MM/YYYY');
        END IF;
    END IF;
    RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.fin_closure_userdata_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_20_fin_closure ON public.user_data;
CREATE TRIGGER trg_20_fin_closure BEFORE INSERT OR UPDATE ON public.user_data
    FOR EACH ROW WHEN (NEW.key IN ('invoices', 'payments')) EXECUTE FUNCTION public.fin_closure_userdata_guard();

-- ---------- API ----------
CREATE OR REPLACE FUNCTION public.fin_month_end(p_month TEXT) RETURNS DATE
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
BEGIN
    IF p_month IS NULL OR p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN RAISE EXCEPTION 'MOIS_INVALIDE'; END IF;
    RETURN (to_date(p_month || '-01', 'YYYY-MM-DD') + INTERVAL '1 month - 1 day')::date;
END; $$;
REVOKE ALL ON FUNCTION public.fin_month_end(TEXT) FROM PUBLIC, anon, authenticated;

-- État : date de verrouillage + historique (clôtures et réouvertures)
CREATE OR REPLACE FUNCTION public.period_status() RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fin_uid();
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    RETURN jsonb_build_object(
        'lock_date', public.fin_lock_date(v),
        'history', COALESCE((SELECT jsonb_agg(jsonb_build_object('period_end', c.period_end, 'closed_at', c.closed_at, 'note', c.note,
                                                                 'reopened_at', c.reopened_at, 'reopen_reason', c.reopen_reason)
                                              ORDER BY c.closed_at DESC)
                               FROM (SELECT * FROM public.period_closures WHERE user_id = v ORDER BY closed_at DESC LIMIT 50) c), '[]'::jsonb));
END; $$;
REVOKE ALL ON FUNCTION public.period_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.period_status() TO authenticated;

-- Contrôles avant clôture d'un mois (avertissements, rien n'est bloquant sauf les règles de period_close)
CREATE OR REPLACE FUNCTION public.period_check(p_month TEXT) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fin_uid(); e DATE := public.fin_month_end(p_month); inv JSONB; pay JSONB;
        n_draft INT := 0; n_nopay INT := 0; n_cost INT := 0; n_pur INT := 0; n_bl INT := 0; n_cash INT := 0;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    SELECT u.value INTO inv FROM public.user_data u WHERE u.user_id = v AND u.key = 'invoices';
    SELECT u.value INTO pay FROM public.user_data u WHERE u.user_id = v AND u.key = 'payments';
    IF jsonb_typeof(inv) = 'array' THEN
        SELECT count(*) INTO n_draft FROM jsonb_array_elements(inv) x
         WHERE jsonb_typeof(x) = 'object' AND COALESCE(x->>'status', 'draft') = 'draft' AND (x->>'date') ~ '^\d{4}-\d{2}-\d{2}' AND left(x->>'date', 10)::date <= e;
    END IF;
    IF jsonb_typeof(pay) = 'array' AND EXISTS (SELECT 1 FROM public.cash_accounts a WHERE a.user_id = v) THEN
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

-- Clôturer un mois terminé (et, de fait, tous les précédents)
CREATE OR REPLACE FUNCTION public.period_close(p_month TEXT, p_note TEXT DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fin_uid(); e DATE := public.fin_month_end(p_month); l DATE;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    IF NOT public.has_active_license(v) THEN RAISE EXCEPTION 'LICENCE_INACTIVE'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('fp_closure:' || v::text, 0));
    IF e >= current_date THEN RAISE EXCEPTION 'MOIS_NON_TERMINE'; END IF;
    IF e < DATE '2000-01-31' THEN RAISE EXCEPTION 'MOIS_INVALIDE'; END IF;
    l := public.fin_lock_date(v);
    IF l IS NOT NULL AND e <= l THEN RAISE EXCEPTION 'DEJA_CLOTURE'; END IF;
    INSERT INTO public.period_closures (user_id, period_end, note) VALUES (v, e, left(NULLIF(btrim(p_note), ''), 300));
    INSERT INTO public.fin_audit (user_id, action, entity, entity_id, detail)
    VALUES (v, 'period_close', 'period', to_char(e, 'YYYY-MM'), jsonb_build_object('previous_lock', l));
    RETURN jsonb_build_object('lock_date', e);
END; $$;
REVOKE ALL ON FUNCTION public.period_close(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.period_close(TEXT, TEXT) TO authenticated;

-- Rouvrir la DERNIÈRE clôture active, motif obligatoire, journalisé
CREATE OR REPLACE FUNCTION public.period_reopen(p_month TEXT, p_reason TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fin_uid(); e DATE := public.fin_month_end(p_month); l DATE; r TEXT := btrim(COALESCE(p_reason, ''));
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    IF NOT public.has_active_license(v) THEN RAISE EXCEPTION 'LICENCE_INACTIVE'; END IF;
    IF char_length(r) < 3 THEN RAISE EXCEPTION 'MOTIF_OBLIGATOIRE'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('fp_closure:' || v::text, 0));
    l := public.fin_lock_date(v);
    IF l IS NULL OR l <> e THEN RAISE EXCEPTION 'SEULE_LA_DERNIERE_CLOTURE'; END IF;
    UPDATE public.period_closures SET reopened_at = now(), reopen_reason = left(r, 300)
     WHERE user_id = v AND period_end = e AND reopened_at IS NULL;
    INSERT INTO public.fin_audit (user_id, action, entity, entity_id, detail)
    VALUES (v, 'period_reopen', 'period', to_char(e, 'YYYY-MM'), jsonb_build_object('reason', left(r, 300)));
    RETURN jsonb_build_object('lock_date', public.fin_lock_date(v));
END; $$;
REVOKE ALL ON FUNCTION public.period_reopen(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.period_reopen(TEXT, TEXT) TO authenticated;
