-- ============================================================================================================
-- 38 — Bons de livraison côté serveur : pièces immuables, numéro serveur, sortie de stock au CMUP, lien facture contrôlé
-- ============================================================================================================
-- FacturaPro 2.0 — PR 5. Dépend de : sql/36 (CMUP), sql/37 (fin_uid, fin_counters, fin_next_number, fin_audit, fin_assert_open).
-- À coller APRÈS sql/37.
--
-- PRINCIPE
--  * Un BL = deliveries + delivery_lines. Enregistré, il fait SORTIR du stock les lignes de produits suivis, au CMUP du moment
--    (sql/36), clé « bl:<BL>:<ligne> » (jamais de double sortie). La facture créée à partir de BL ne déduit pas une 2e fois
--    (lignes marquées fromDelivery dans l'application, inchangé).
--  * Immuable : seules transitions permises —
--      lien facture : invoice_id NULL → valeur (delivery_link_invoice), valeur → NULL (delivery_unlink_invoice, seulement si la facture
--      lue dans user_data est encore un brouillon ou n'existe plus), numéro officiel posé à l'émission (delivery_invoice_issued) ;
--      annulation : active → cancelled (delivery_cancel), refusée si le BL est rattaché à une facture ; le stock est remis au coût
--      de la sortie d'origine (return_of, sql/36).
--  * Numéro serveur BL-AAAA-NNN ; idempotence par idem_key ; clôture via fin_assert_open (sql/40) ; journal fin_audit.
--  * Les factures restent dans user_data (non modifiées par ce script) ; le contrôle « brouillon » les LIT seulement.
--  * Reprise : fin_import_legacy_deliveries() copie une fois les BL JSON (clé user_data 'deliveries'), sans recréer leur stock ;
--    l'annulation d'un BL repris retrouve ses sorties d'origine (clés de l'ancienne version). Production au 01/11/2026 : aucun BL.
-- Sécurité : tables FERMÉES ; fonctions SECURITY DEFINER limitées au compte connecté ; licence pour écrire. Réexécutable.
--
-- RETOUR ARRIÈRE (retirer d'abord l'application de la PR 5) :
--   DROP FUNCTION IF EXISTS public.delivery_record(JSONB), public.delivery_cancel(UUID, TEXT), public.delivery_link_invoice(UUID[], TEXT),
--     public.delivery_unlink_invoice(TEXT), public.delivery_invoice_issued(TEXT, TEXT), public.delivery_list(DATE, DATE, TEXT, INT, INT),
--     public.fin_import_legacy_deliveries(JSONB), public.fin_invoice_status(UUID, TEXT), public.fin_delivery_guard();
--   DROP TABLE IF EXISTS public.delivery_lines, public.deliveries;     -- supprime les BL saisis
-- ============================================================================================================

DO $$ BEGIN
    IF to_regprocedure('public.fin_next_number(uuid,text,date)') IS NULL THEN RAISE EXCEPTION 'PREREQUIS_MANQUANT: sql/37 doit être appliqué avant sql/38'; END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.deliveries (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    number              TEXT NOT NULL CHECK (char_length(number) BETWEEN 1 AND 40),
    client_id           TEXT NOT NULL CHECK (char_length(client_id) BETWEEN 1 AND 100),
    client_name         TEXT NOT NULL CHECK (char_length(client_name) BETWEEN 1 AND 150),
    client_ice          TEXT CHECK (client_ice IS NULL OR char_length(client_ice) <= 40),
    client_address      TEXT CHECK (client_address IS NULL OR char_length(client_address) <= 250),
    delivery_date       DATE NOT NULL,
    source_quote        TEXT CHECK (source_quote IS NULL OR char_length(source_quote) <= 100),
    source_quote_number TEXT CHECK (source_quote_number IS NULL OR char_length(source_quote_number) <= 40),
    notes               TEXT CHECK (notes IS NULL OR char_length(notes) <= 500),
    total_ht            NUMERIC(14,2) NOT NULL,
    total_tva           NUMERIC(14,2) NOT NULL,
    total_ttc           NUMERIC(14,2) NOT NULL,
    invoice_id          TEXT CHECK (invoice_id IS NULL OR char_length(invoice_id) BETWEEN 1 AND 100),
    invoice_number      TEXT CHECK (invoice_number IS NULL OR char_length(invoice_number) <= 40),
    status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
    cancelled_at        TIMESTAMPTZ,
    cancel_reason       TEXT CHECK (cancel_reason IS NULL OR char_length(cancel_reason) <= 200),
    legacy_id           TEXT CHECK (legacy_id IS NULL OR char_length(legacy_id) <= 100),
    idem_key            TEXT CHECK (idem_key IS NULL OR char_length(idem_key) BETWEEN 1 AND 200),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (total_ttc = total_ht + total_tva),
    CHECK (status = 'active' OR invoice_id IS NULL),
    UNIQUE (user_id, number),
    UNIQUE (user_id, idem_key),
    UNIQUE (user_id, legacy_id)
);
CREATE INDEX IF NOT EXISTS deliveries_user_date_idx ON public.deliveries (user_id, delivery_date DESC);
CREATE INDEX IF NOT EXISTS deliveries_invoice_idx ON public.deliveries (user_id, invoice_id) WHERE invoice_id IS NOT NULL;
ALTER TABLE public.deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.deliveries FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.delivery_lines (
    delivery_id  UUID NOT NULL REFERENCES public.deliveries(id) ON DELETE CASCADE,
    user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    line_no      INT  NOT NULL CHECK (line_no BETWEEN 0 AND 99),
    product_id   TEXT CHECK (product_id IS NULL OR char_length(product_id) BETWEEN 1 AND 100),
    product_name TEXT CHECK (product_name IS NULL OR char_length(product_name) <= 200),
    unit         TEXT CHECK (unit IS NULL OR char_length(unit) <= 30),
    track_stock  BOOLEAN NOT NULL DEFAULT false,
    description  TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 300),
    qty          NUMERIC(14,3) NOT NULL CHECK (qty > 0 AND qty <= 1000000000),
    unit_price   NUMERIC(14,4) NOT NULL CHECK (unit_price >= 0 AND unit_price <= 1000000000),
    discount     NUMERIC(5,2)  NOT NULL DEFAULT 0 CHECK (discount BETWEEN 0 AND 100),
    tva_rate     NUMERIC(5,2)  NOT NULL CHECK (tva_rate IN (0, 7, 10, 14, 20)),
    total_ht     NUMERIC(14,2) NOT NULL,
    total_tva    NUMERIC(14,2) NOT NULL,
    PRIMARY KEY (delivery_id, line_no),
    CHECK (track_stock = false OR product_id IS NOT NULL)
);
ALTER TABLE public.delivery_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.delivery_lines FROM PUBLIC, anon, authenticated;

-- Transitions permises uniquement (le reste du BL est figé)
CREATE OR REPLACE FUNCTION public.fin_delivery_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE fixed_old JSONB := to_jsonb(OLD) - 'invoice_id' - 'invoice_number' - 'status' - 'cancelled_at' - 'cancel_reason';
        fixed_new JSONB := to_jsonb(NEW) - 'invoice_id' - 'invoice_number' - 'status' - 'cancelled_at' - 'cancel_reason';
BEGIN
    IF fixed_old IS DISTINCT FROM fixed_new THEN RAISE EXCEPTION 'BL non modifiable' USING ERRCODE = '42501'; END IF;
    IF OLD.status = 'cancelled' THEN RAISE EXCEPTION 'BL annulé : non modifiable' USING ERRCODE = '42501'; END IF;
    IF NEW.status = 'cancelled' AND OLD.invoice_id IS NOT NULL THEN RAISE EXCEPTION 'BL rattaché à une facture : annulation impossible' USING ERRCODE = '42501'; END IF;
    RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.fin_delivery_guard() FROM PUBLIC, anon, authenticated;
CREATE OR REPLACE TRIGGER trg_delivery_guard BEFORE UPDATE ON public.deliveries FOR EACH ROW EXECUTE FUNCTION public.fin_delivery_guard();
CREATE OR REPLACE TRIGGER trg_delivery_lines_guard BEFORE UPDATE ON public.delivery_lines FOR EACH ROW EXECUTE FUNCTION public.fin_lines_guard();

-- Statut d'une facture du compte, LU dans user_data (clé 'invoices') : 'draft', 'issued' ou NULL si absente. Aucune écriture.
CREATE OR REPLACE FUNCTION public.fin_invoice_status(p_uid UUID, p_invoice_id TEXT) RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT CASE WHEN COALESCE(e->>'status', 'draft') = 'draft' THEN 'draft' ELSE 'issued' END
      FROM public.user_data d, LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(d.value) = 'array' THEN d.value ELSE '[]'::jsonb END) e
     WHERE d.user_id = p_uid AND d.key = 'invoices' AND e->>'id' = p_invoice_id
     LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.fin_invoice_status(UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- ---------- enregistrement ----------
-- p = { key, client_id, client_name, client_ice, client_address, date, notes, source_quote, source_quote_number,
--       lines: [ { product_id, product_name, unit, track_stock, description, qty, unit_price, discount, tva_rate } ] }
-- Retour : { id, number, total_ht, total_tva, total_ttc, duplicate }
CREATE OR REPLACE FUNCTION public.delivery_record(p JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    v UUID := public.fin_uid(); r public.deliveries%ROWTYPE; v_id UUID; v_key TEXT; v_date DATE; v_num TEXT; l JSONB; i INT := 0;
    v_qty NUMERIC; v_pu NUMERIC; v_disc NUMERIC; v_rate NUMERIC; v_ht NUMERIC; v_tva NUMERIC; t_ht NUMERIC := 0; t_tva NUMERIC := 0;
    v_pid TEXT; v_desc TEXT; v_track BOOLEAN; norm JSONB := '[]'::jsonb; moves JSONB := '[]'::jsonb;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    IF NOT public.has_active_license(v) THEN RAISE EXCEPTION 'LICENCE_INACTIVE'; END IF;
    IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'BL_INVALIDE'; END IF;
    v_key := left(NULLIF(btrim(p->>'key'), ''), 200);
    IF v_key IS NOT NULL THEN
        SELECT * INTO r FROM public.deliveries WHERE user_id = v AND idem_key = v_key;
        IF FOUND THEN RETURN jsonb_build_object('id', r.id, 'number', r.number, 'total_ht', r.total_ht, 'total_tva', r.total_tva, 'total_ttc', r.total_ttc, 'duplicate', true); END IF;
    END IF;
    IF COALESCE(btrim(p->>'client_id'), '') = '' OR COALESCE(btrim(p->>'client_name'), '') = '' THEN RAISE EXCEPTION 'CLIENT_INVALIDE'; END IF;
    BEGIN v_date := (p->>'date')::date; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'DATE_INVALIDE'; END;
    IF v_date IS NULL OR v_date < DATE '2000-01-01' OR v_date > current_date + 31 THEN RAISE EXCEPTION 'DATE_INVALIDE'; END IF;
    PERFORM public.fin_assert_open(v, v_date);
    IF jsonb_typeof(p->'lines') <> 'array' OR jsonb_array_length(p->'lines') = 0 THEN RAISE EXCEPTION 'LIGNES_INVALIDES'; END IF;
    IF jsonb_array_length(p->'lines') > 100 THEN RAISE EXCEPTION 'TROP_DE_LIGNES'; END IF;
    IF (SELECT count(*) FROM public.deliveries WHERE user_id = v) >= 50000 THEN RAISE EXCEPTION 'LIMITE_BL_ATTEINTE'; END IF;
    FOR l IN SELECT * FROM jsonb_array_elements(p->'lines') LOOP
        IF jsonb_typeof(l) <> 'object' THEN RAISE EXCEPTION 'LIGNES_INVALIDES'; END IF;
        BEGIN v_qty := round((l->>'qty')::numeric, 3); v_pu := round(COALESCE((l->>'unit_price')::numeric, 0), 4); v_rate := COALESCE((l->>'tva_rate')::numeric, 20);
              v_disc := COALESCE((l->>'discount')::numeric, 0);
        EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'LIGNE_INVALIDE'; END;
        IF v_qty IS NULL OR v_qty <= 0 OR v_qty > 1000000000 THEN RAISE EXCEPTION 'QUANTITE_INVALIDE'; END IF;
        IF v_pu < 0 OR v_pu > 1000000000 THEN RAISE EXCEPTION 'PRIX_INVALIDE'; END IF;
        IF v_rate NOT IN (0, 7, 10, 14, 20) THEN RAISE EXCEPTION 'TAUX_TVA_INVALIDE'; END IF;
        IF v_disc < 0 OR v_disc > 100 THEN RAISE EXCEPTION 'REMISE_INVALIDE'; END IF;
        v_desc := left(btrim(COALESCE(l->>'description', '')), 300);
        IF v_desc = '' THEN RAISE EXCEPTION 'DESIGNATION_INVALIDE'; END IF;
        v_pid := left(NULLIF(btrim(l->>'product_id'), ''), 100);
        v_track := v_pid IS NOT NULL AND COALESCE((l->>'track_stock')::boolean, false);
        v_ht := round(v_qty * v_pu * (1 - v_disc / 100), 2); v_tva := round(v_ht * v_rate / 100, 2);
        t_ht := t_ht + v_ht; t_tva := t_tva + v_tva;
        norm := norm || jsonb_build_array(jsonb_build_object('n', i, 'pid', v_pid, 'pname', left(NULLIF(btrim(l->>'product_name'), ''), 200), 'unit', left(NULLIF(btrim(l->>'unit'), ''), 30),
            'track', v_track, 'desc', v_desc, 'qty', v_qty, 'pu', v_pu, 'disc', v_disc, 'rate', v_rate, 'ht', v_ht, 'tva', v_tva));
        i := i + 1;
    END LOOP;
    v_id := gen_random_uuid();
    v_num := public.fin_next_number(v, 'delivery', v_date);
    INSERT INTO public.deliveries (id, user_id, number, client_id, client_name, client_ice, client_address, delivery_date, source_quote, source_quote_number, notes,
                                   total_ht, total_tva, total_ttc, idem_key)
    VALUES (v_id, v, v_num, left(btrim(p->>'client_id'), 100), left(btrim(p->>'client_name'), 150), left(NULLIF(btrim(p->>'client_ice'), ''), 40),
            left(NULLIF(btrim(p->>'client_address'), ''), 250), v_date, left(NULLIF(btrim(p->>'source_quote'), ''), 100), left(NULLIF(btrim(p->>'source_quote_number'), ''), 40),
            left(NULLIF(btrim(p->>'notes'), ''), 500), t_ht, t_tva, t_ht + t_tva, v_key);
    FOR l IN SELECT * FROM jsonb_array_elements(norm) LOOP
        INSERT INTO public.delivery_lines (delivery_id, user_id, line_no, product_id, product_name, unit, track_stock, description, qty, unit_price, discount, tva_rate, total_ht, total_tva)
        VALUES (v_id, v, (l->>'n')::int, l->>'pid', l->>'pname', l->>'unit', (l->>'track')::boolean, l->>'desc', (l->>'qty')::numeric, (l->>'pu')::numeric,
                (l->>'disc')::numeric, (l->>'rate')::numeric, (l->>'ht')::numeric, (l->>'tva')::numeric);
        IF (l->>'track')::boolean THEN
            moves := moves || jsonb_build_array(jsonb_build_object('product_id', l->>'pid', 'product_name', COALESCE(l->>'pname', l->>'desc'), 'unit', COALESCE(l->>'unit', 'unité'),
                'type', 'out', 'qty', (l->>'qty')::numeric, 'date', v_date, 'source', 'delivery', 'ref', v_num, 'ref_id', v_id::text,
                'note', left(btrim(p->>'client_name'), 200), 'key', 'bl:' || v_id || ':' || (l->>'n')));
        END IF;
    END LOOP;
    IF jsonb_array_length(moves) > 0 THEN PERFORM public.stock_record(moves); END IF;
    INSERT INTO public.fin_audit (user_id, action, entity, entity_id, detail) VALUES (v, 'creation', 'delivery', v_id::text, jsonb_build_object('number', v_num));
    RETURN jsonb_build_object('id', v_id, 'number', v_num, 'total_ht', t_ht, 'total_tva', t_tva, 'total_ttc', t_ht + t_tva, 'duplicate', false);
END; $$;
REVOKE ALL ON FUNCTION public.delivery_record(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delivery_record(JSONB) TO authenticated;

-- ---------- annulation (BL non facturé) : remise en stock au coût de la sortie d'origine ----------
CREATE OR REPLACE FUNCTION public.delivery_cancel(p_id UUID, p_reason TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fin_uid(); r public.deliveries%ROWTYPE; moves JSONB := '[]'::jsonb; m RECORD;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    IF NOT public.has_active_license(v) THEN RAISE EXCEPTION 'LICENCE_INACTIVE'; END IF;
    SELECT * INTO r FROM public.deliveries WHERE id = p_id AND user_id = v FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'BL_INTROUVABLE'; END IF;
    IF r.status = 'cancelled' THEN RETURN jsonb_build_object('id', r.id, 'number', r.number, 'already', true); END IF;
    IF r.invoice_id IS NOT NULL THEN RAISE EXCEPTION 'BL_FACTURE: ce BL est rattaché à une facture'; END IF;
    PERFORM public.fin_assert_open(v, r.delivery_date);
    FOR m IN SELECT s.product_id, s.product_name, s.unit, s.qty, s.idem_key FROM public.stock_movements s
              WHERE s.user_id = v AND s.move_type = 'out' AND s.source = 'delivery'
                AND (s.idem_key LIKE 'bl:' || r.id || ':%' OR (r.legacy_id IS NOT NULL AND s.idem_key LIKE 'bl:' || r.legacy_id || ':%')) LOOP
        moves := moves || jsonb_build_array(jsonb_build_object('product_id', m.product_id, 'product_name', m.product_name, 'unit', m.unit, 'type', 'in', 'qty', m.qty,
            'date', current_date, 'source', 'delivery', 'return_of', m.idem_key, 'ref', r.number, 'ref_id', r.id::text, 'note', 'Annulation ' || r.number,
            'key', 'bl-cancel:' || r.id || ':' || split_part(m.idem_key, ':', 3)));
    END LOOP;
    IF jsonb_array_length(moves) > 0 THEN PERFORM public.stock_record(moves); END IF;
    UPDATE public.deliveries SET status = 'cancelled', cancelled_at = now(), cancel_reason = left(NULLIF(btrim(p_reason), ''), 200) WHERE id = r.id;
    INSERT INTO public.fin_audit (user_id, action, entity, entity_id, detail) VALUES (v, 'annulation', 'delivery', r.id::text, jsonb_build_object('number', r.number, 'reason', left(p_reason, 200)));
    RETURN jsonb_build_object('id', r.id, 'number', r.number, 'already', false, 'stock_lines', jsonb_array_length(moves));
END; $$;
REVOKE ALL ON FUNCTION public.delivery_cancel(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delivery_cancel(UUID, TEXT) TO authenticated;

-- ---------- lien facture ----------
-- Rattache des BL actifs, non facturés, d'un MÊME client à une facture (brouillon créée par l'application). Tout ou rien.
CREATE OR REPLACE FUNCTION public.delivery_link_invoice(p_ids UUID[], p_invoice_id TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fin_uid(); r RECORD; v_client TEXT; n INT := 0; st TEXT;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    IF NOT public.has_active_license(v) THEN RAISE EXCEPTION 'LICENCE_INACTIVE'; END IF;
    IF p_ids IS NULL OR cardinality(p_ids) = 0 OR cardinality(p_ids) > 100 THEN RAISE EXCEPTION 'BL_INVALIDES'; END IF;
    IF COALESCE(btrim(p_invoice_id), '') = '' OR char_length(p_invoice_id) > 100 THEN RAISE EXCEPTION 'FACTURE_INVALIDE'; END IF;
    st := public.fin_invoice_status(v, p_invoice_id);
    IF st = 'issued' THEN RAISE EXCEPTION 'FACTURE_EMISE: une facture émise ne reçoit plus de BL'; END IF;
    FOR r IN SELECT * FROM public.deliveries WHERE user_id = v AND id = ANY(p_ids) ORDER BY id FOR UPDATE LOOP
        IF r.status <> 'active' THEN RAISE EXCEPTION 'BL_ANNULE: %', r.number; END IF;
        IF r.invoice_id IS NOT NULL AND r.invoice_id <> p_invoice_id THEN RAISE EXCEPTION 'BL_DEJA_FACTURE: %', r.number; END IF;
        IF v_client IS NULL THEN v_client := r.client_id; ELSIF v_client <> r.client_id THEN RAISE EXCEPTION 'BL_CLIENTS_DIFFERENTS'; END IF;
        n := n + 1;
    END LOOP;
    IF n <> cardinality(p_ids) THEN RAISE EXCEPTION 'BL_INTROUVABLE'; END IF;
    UPDATE public.deliveries SET invoice_id = p_invoice_id, invoice_number = NULL WHERE user_id = v AND id = ANY(p_ids) AND invoice_id IS NULL;
    INSERT INTO public.fin_audit (user_id, action, entity, entity_id, detail) VALUES (v, 'lien_facture', 'delivery', p_invoice_id, jsonb_build_object('count', n));
    RETURN jsonb_build_object('linked', n);
END; $$;
REVOKE ALL ON FUNCTION public.delivery_link_invoice(UUID[], TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delivery_link_invoice(UUID[], TEXT) TO authenticated;

-- Retire le lien (facture brouillon supprimée) : refusé si la facture, lue dans user_data, est émise.
CREATE OR REPLACE FUNCTION public.delivery_unlink_invoice(p_invoice_id TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fin_uid(); n INT;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    IF NOT public.has_active_license(v) THEN RAISE EXCEPTION 'LICENCE_INACTIVE'; END IF;
    IF public.fin_invoice_status(v, p_invoice_id) = 'issued' THEN RAISE EXCEPTION 'FACTURE_EMISE: le lien d''une facture émise est définitif'; END IF;
    UPDATE public.deliveries SET invoice_id = NULL, invoice_number = NULL WHERE user_id = v AND invoice_id = p_invoice_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN INSERT INTO public.fin_audit (user_id, action, entity, entity_id, detail) VALUES (v, 'retrait_lien_facture', 'delivery', p_invoice_id, jsonb_build_object('count', n)); END IF;
    RETURN jsonb_build_object('unlinked', n);
END; $$;
REVOKE ALL ON FUNCTION public.delivery_unlink_invoice(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delivery_unlink_invoice(TEXT) TO authenticated;

-- Numéro officiel de la facture reporté sur ses BL à l'émission (vérifié contre user_data quand la facture y est déjà).
CREATE OR REPLACE FUNCTION public.delivery_invoice_issued(p_invoice_id TEXT, p_number TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fin_uid(); n INT; v_num TEXT; v_st TEXT;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    IF COALESCE(btrim(p_number), '') = '' OR char_length(p_number) > 40 THEN RAISE EXCEPTION 'NUMERO_INVALIDE'; END IF;
    SELECT e->>'number', COALESCE(e->>'status', 'draft') INTO v_num, v_st FROM public.user_data d, LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(d.value) = 'array' THEN d.value ELSE '[]'::jsonb END) e
     WHERE d.user_id = v AND d.key = 'invoices' AND e->>'id' = p_invoice_id LIMIT 1;
    -- facture déjà synchronisée comme émise : son numéro fait foi ; encore brouillon (synchronisation en cours) : numéro accepté
    IF v_st IS NOT NULL AND v_st <> 'draft' AND v_num IS DISTINCT FROM p_number THEN RAISE EXCEPTION 'NUMERO_DIFFERENT'; END IF;
    UPDATE public.deliveries SET invoice_number = p_number WHERE user_id = v AND invoice_id = p_invoice_id AND status = 'active';
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN jsonb_build_object('updated', n);
END; $$;
REVOKE ALL ON FUNCTION public.delivery_invoice_issued(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delivery_invoice_issued(TEXT, TEXT) TO authenticated;

-- ---------- lecture ----------
CREATE OR REPLACE FUNCTION public.delivery_list(p_from DATE, p_to DATE, p_status TEXT DEFAULT NULL, p_limit INT DEFAULT 500, p_offset INT DEFAULT 0)
RETURNS TABLE (id UUID, number TEXT, delivery_date DATE, client_id TEXT, client_name TEXT, client_ice TEXT, client_address TEXT, source_quote TEXT,
               source_quote_number TEXT, notes TEXT, total_ht NUMERIC, total_tva NUMERIC, total_ttc NUMERIC, invoice_id TEXT, invoice_number TEXT,
               status TEXT, cancel_reason TEXT, legacy_id TEXT, created_at TIMESTAMPTZ, lines JSONB)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fin_uid();
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    RETURN QUERY
    SELECT d.id, d.number, d.delivery_date, d.client_id, d.client_name, d.client_ice, d.client_address, d.source_quote, d.source_quote_number, d.notes,
           d.total_ht, d.total_tva, d.total_ttc, d.invoice_id, d.invoice_number, d.status, d.cancel_reason, d.legacy_id, d.created_at,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('line_no', l.line_no, 'product_id', l.product_id, 'product_name', l.product_name, 'unit', l.unit,
                        'track_stock', l.track_stock, 'description', l.description, 'qty', l.qty, 'unit_price', l.unit_price, 'discount', l.discount,
                        'tva_rate', l.tva_rate, 'total_ht', l.total_ht, 'total_tva', l.total_tva) ORDER BY l.line_no)
                       FROM public.delivery_lines l WHERE l.delivery_id = d.id), '[]'::jsonb)
      FROM public.deliveries d
     WHERE d.user_id = v AND (p_from IS NULL OR d.delivery_date >= p_from) AND (p_to IS NULL OR d.delivery_date <= p_to) AND (p_status IS NULL OR d.status = p_status)
     ORDER BY d.delivery_date DESC, d.created_at DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 500), 1), 5000) OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END; $$;
REVOKE ALL ON FUNCTION public.delivery_list(DATE, DATE, TEXT, INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delivery_list(DATE, DATE, TEXT, INT, INT) TO authenticated;

-- ---------- reprise unique des BL JSON (clé user_data 'deliveries' de la version précédente) ----------
CREATE OR REPLACE FUNCTION public.fin_import_legacy_deliveries(p_items JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fin_uid(); it JSONB; l JSONB; v_id UUID; i INT; n_imp INT := 0; n_skip INT := 0; v_num TEXT; v_date DATE; y INT; k INT;
        v_ht NUMERIC; v_tva NUMERIC; t_ht NUMERIC; t_tva NUMERIC; v_rate NUMERIC; v_qty NUMERIC; v_pu NUMERIC; v_disc NUMERIC; norm JSONB;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    IF NOT public.has_active_license(v) THEN RAISE EXCEPTION 'LICENCE_INACTIVE'; END IF;
    IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN RAISE EXCEPTION 'REPRISE_INVALIDE'; END IF;
    IF jsonb_array_length(p_items) > 2000 THEN RAISE EXCEPTION 'TROP_DE_BL'; END IF;
    FOR it IN SELECT * FROM jsonb_array_elements(p_items) LOOP
        IF jsonb_typeof(it) <> 'object' OR COALESCE(btrim(it->>'id'), '') = '' OR COALESCE(btrim(it->>'clientId'), '') = '' OR jsonb_typeof(it->'items') <> 'array' THEN n_skip := n_skip + 1; CONTINUE; END IF;
        IF EXISTS (SELECT 1 FROM public.deliveries WHERE user_id = v AND legacy_id = left(it->>'id', 100)) THEN n_skip := n_skip + 1; CONTINUE; END IF;
        BEGIN v_date := (it->>'date')::date; EXCEPTION WHEN OTHERS THEN v_date := NULL; END;
        IF v_date IS NULL THEN n_skip := n_skip + 1; CONTINUE; END IF;
        i := 0; t_ht := 0; t_tva := 0; norm := '[]'::jsonb;
        FOR l IN SELECT * FROM jsonb_array_elements(it->'items') LOOP
            EXIT WHEN i > 99;
            BEGIN v_qty := round(abs((l->>'quantity')::numeric), 3); v_pu := round(COALESCE((l->>'price')::numeric, 0), 4); v_rate := COALESCE((l->>'tva')::numeric, 20);
                  v_disc := COALESCE((l->>'discount')::numeric, 0);
            EXCEPTION WHEN OTHERS THEN v_qty := NULL; END;
            IF v_qty IS NULL OR v_qty <= 0 OR v_pu < 0 OR v_rate NOT IN (0, 7, 10, 14, 20) OR v_disc < 0 OR v_disc > 100 THEN CONTINUE; END IF;
            v_ht := round(v_qty * v_pu * (1 - v_disc / 100), 2); v_tva := round(v_ht * v_rate / 100, 2); t_ht := t_ht + v_ht; t_tva := t_tva + v_tva;
            norm := norm || jsonb_build_array(jsonb_build_object('n', i, 'pid', left(NULLIF(btrim(l->>'productId'), ''), 100), 'unit', left(NULLIF(l->>'unit', ''), 30),
                'desc', left(COALESCE(NULLIF(btrim(l->>'description'), ''), 'Ligne'), 300), 'qty', v_qty, 'pu', v_pu, 'disc', v_disc, 'rate', v_rate, 'ht', v_ht, 'tva', v_tva));
            i := i + 1;
        END LOOP;
        IF i = 0 THEN n_skip := n_skip + 1; CONTINUE; END IF;
        v_num := left(NULLIF(btrim(it->>'number'), ''), 40);
        IF v_num IS NULL OR EXISTS (SELECT 1 FROM public.deliveries WHERE user_id = v AND number = v_num) THEN v_num := public.fin_next_number(v, 'delivery', v_date);
        ELSE
            y := EXTRACT(YEAR FROM v_date)::int; k := NULLIF(substring(v_num FROM '^BL-' || y || '-(\d+)$'), '')::int;
            IF k IS NOT NULL THEN INSERT INTO public.fin_counters (user_id, doc_type, year, last) VALUES (v, 'delivery', y, k)
                ON CONFLICT (user_id, doc_type, year) DO UPDATE SET last = GREATEST(public.fin_counters.last, k); END IF;
        END IF;
        v_id := gen_random_uuid();
        INSERT INTO public.deliveries (id, user_id, number, client_id, client_name, client_ice, client_address, delivery_date, source_quote, source_quote_number, notes,
                                       total_ht, total_tva, total_ttc, invoice_id, legacy_id)
        VALUES (v_id, v, v_num, left(it->>'clientId', 100), left(COALESCE(NULLIF(btrim(it->>'clientName'), ''), 'Client'), 150), left(NULLIF(it->>'clientICE', ''), 40),
                left(NULLIF(it->>'clientAddress', ''), 250), v_date, left(NULLIF(it->>'sourceQuote', ''), 100), left(NULLIF(it->>'sourceQuoteNumber', ''), 40),
                left(NULLIF(it->>'notes', ''), 500), t_ht, t_tva, t_ht + t_tva, left(NULLIF(it->>'invoiceId', ''), 100), left(it->>'id', 100));
        FOR l IN SELECT * FROM jsonb_array_elements(norm) LOOP
            INSERT INTO public.delivery_lines (delivery_id, user_id, line_no, product_id, unit, track_stock, description, qty, unit_price, discount, tva_rate, total_ht, total_tva)
            VALUES (v_id, v, (l->>'n')::int, l->>'pid', l->>'unit', false, l->>'desc', (l->>'qty')::numeric, (l->>'pu')::numeric, (l->>'disc')::numeric, (l->>'rate')::numeric,
                    (l->>'ht')::numeric, (l->>'tva')::numeric);
        END LOOP;
        n_imp := n_imp + 1;
    END LOOP;
    IF n_imp > 0 THEN INSERT INTO public.fin_audit (user_id, action, entity, detail) VALUES (v, 'reprise', 'delivery', jsonb_build_object('imported', n_imp, 'skipped', n_skip)); END IF;
    RETURN jsonb_build_object('imported', n_imp, 'skipped', n_skip);
END; $$;
REVOKE ALL ON FUNCTION public.fin_import_legacy_deliveries(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_import_legacy_deliveries(JSONB) TO authenticated;
