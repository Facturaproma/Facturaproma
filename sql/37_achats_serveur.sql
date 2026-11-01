-- ============================================================================================================
-- 37 — Achats et dépenses côté serveur : pièces immuables, nature par ligne, numéro serveur, annulation (jamais de suppression)
-- ============================================================================================================
-- FacturaPro 2.0 — PR 4. Dépend de : sql/07 (has_active_license), sql/34-36 (stock + CMUP). À coller APRÈS sql/36.
--
-- PRINCIPE
--  * Un achat (facture ou ticket fournisseur) = une ligne de purchases + ses lignes purchase_lines. Chaque ligne a une NATURE :
--      goods   = marchandise (produit) : entre en STOCK au coût d'achat si le produit est suivi ; JAMAIS en charges ;
--                une marchandise NON suivie est considérée consommée à l'achat (coût d'achat des marchandises de la période) ;
--      expense = charge (catégorie obligatoire) : entre dans les charges de la période (date de la pièce) ;
--      asset   = investissement : ni charge ni stock (montré à part ; amortissement hors V1).
--  * Totaux recalculés PAR LE SERVEUR (validation complète avant toute écriture) (ligne : HT = qté × PU arrondi au centime ; TVA = HT × taux arrondi au centime).
--  * Numéro attribué par le serveur (ACH-AAAA-NNN, compteur par compte et par année) : plus de numéro calculé dans le navigateur.
--  * Immuable : aucune modification ; la seule transition est active → cancelled (purchase_cancel), qui sort du stock
--    les quantités entrées, AU COÛT DE L'ACHAT (sql/36). Aucune suppression par l'application (table fermée).
--  * Idempotence : clé idem_key fournie par l'application ; un renvoi (réseau, double clic, deux appareils) renvoie l'achat existant.
--  * Clôture de période : fin_assert_open() est appelée par chaque écriture ; ici elle n'interdit rien, sql/40 la remplace.
--  * Règlements : fin_purchase_paid() renvoie 0 ici ; sql/39 la remplace (trésorerie).
--  * Reprise : fin_import_legacy_purchases() copie une fois les achats JSON (clé user_data 'purchases') d'un compte, sans recréer
--    leurs mouvements de stock (déjà enregistrés). Production au 01/11/2026 : aucun achat à reprendre.
-- Sécurité : tables FERMÉES (RLS active, aucune politique, aucun droit direct) ; fonctions SECURITY DEFINER limitées au compte
-- connecté (e-mail confirmé) ; licence active exigée pour écrire ; lecture toujours possible. ON DELETE CASCADE (suppression de compte).
-- Réexécutable.
--
-- RETOUR ARRIÈRE (retirer d'abord l'application de la PR 4) :
--   DROP FUNCTION IF EXISTS public.purchase_record(JSONB), public.purchase_cancel(UUID, TEXT), public.purchase_list(DATE, DATE, TEXT, INT, INT),
--     public.fin_import_legacy_purchases(JSONB), public.fin_next_number(UUID, TEXT, DATE), public.fin_purchase_paid(UUID, UUID),
--     public.fin_assert_open(UUID, DATE), public.fin_uid(), public.fin_purchase_guard(), public.fin_lines_guard();
--   DROP TABLE IF EXISTS public.purchase_lines, public.purchases, public.fin_counters, public.fin_audit;   -- supprime les achats saisis
-- ============================================================================================================

DO $$ BEGIN
    IF to_regclass('public.stock_cost_state') IS NULL THEN RAISE EXCEPTION 'PREREQUIS_MANQUANT: sql/36 doit être appliqué avant sql/37'; END IF;
END $$;

-- ---------- identité (même règle que stock_uid : compte connecté ET e-mail confirmé) ----------
CREATE OR REPLACE FUNCTION public.fin_uid() RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
    SELECT u.id FROM auth.users u WHERE u.id = auth.uid() AND u.email_confirmed_at IS NOT NULL
$$;
REVOKE ALL ON FUNCTION public.fin_uid() FROM PUBLIC, anon, authenticated;

-- ---------- numérotation ----------
CREATE TABLE IF NOT EXISTS public.fin_counters (
    user_id  UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    doc_type TEXT NOT NULL CHECK (doc_type IN ('purchase', 'delivery')),
    year     INT  NOT NULL CHECK (year BETWEEN 2000 AND 2200),
    last     INT  NOT NULL DEFAULT 0 CHECK (last >= 0),
    PRIMARY KEY (user_id, doc_type, year)
);
ALTER TABLE public.fin_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fin_counters FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fin_next_number(p_uid UUID, p_type TEXT, p_date DATE) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE y INT := EXTRACT(YEAR FROM p_date)::int; n INT;
BEGIN
    INSERT INTO public.fin_counters (user_id, doc_type, year, last) VALUES (p_uid, p_type, y, 1)
    ON CONFLICT (user_id, doc_type, year) DO UPDATE SET last = public.fin_counters.last + 1
    RETURNING last INTO n;
    RETURN (CASE p_type WHEN 'purchase' THEN 'ACH-' ELSE 'BL-' END) || y || '-' || lpad(n::text, 3, '0');
END; $$;
REVOKE ALL ON FUNCTION public.fin_next_number(UUID, TEXT, DATE) FROM PUBLIC, anon, authenticated;

-- ---------- journal des gestes sensibles ----------
CREATE TABLE IF NOT EXISTS public.fin_audit (
    id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    action    TEXT NOT NULL CHECK (char_length(action) BETWEEN 1 AND 60),
    entity    TEXT NOT NULL CHECK (char_length(entity) BETWEEN 1 AND 60),
    entity_id TEXT CHECK (entity_id IS NULL OR char_length(entity_id) <= 100),
    detail    JSONB
);
CREATE INDEX IF NOT EXISTS fin_audit_user_idx ON public.fin_audit (user_id, at DESC);
ALTER TABLE public.fin_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fin_audit FROM PUBLIC, anon, authenticated;

-- ---------- points d'extension remplacés par sql/39 (règlements) et sql/40 (clôture) ----------
-- Créées seulement si absentes : recoller sql/37 après sql/39 / sql/40 ne remet PAS les versions vides.
DO $$ BEGIN
    IF to_regprocedure('public.fin_assert_open(uuid,date)') IS NULL THEN
        EXECUTE 'CREATE FUNCTION public.fin_assert_open(p_uid UUID, p_date DATE) RETURNS VOID LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $f$ BEGIN RETURN; END; $f$';
    END IF;
    EXECUTE 'REVOKE ALL ON FUNCTION public.fin_assert_open(UUID, DATE) FROM PUBLIC, anon, authenticated';
    IF to_regprocedure('public.fin_purchase_paid(uuid,uuid)') IS NULL THEN
        EXECUTE 'CREATE FUNCTION public.fin_purchase_paid(p_uid UUID, p_purchase UUID) RETURNS NUMERIC LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$ SELECT 0::numeric $f$';
        EXECUTE 'REVOKE ALL ON FUNCTION public.fin_purchase_paid(UUID, UUID) FROM PUBLIC, anon, authenticated';
    END IF;
END $$;

-- ---------- tables ----------
CREATE TABLE IF NOT EXISTS public.purchases (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    number         TEXT NOT NULL CHECK (char_length(number) BETWEEN 1 AND 40),
    supplier_id    TEXT CHECK (supplier_id IS NULL OR char_length(supplier_id) <= 100),
    supplier_name  TEXT NOT NULL CHECK (char_length(supplier_name) BETWEEN 1 AND 120),
    supplier_ice   TEXT CHECK (supplier_ice IS NULL OR char_length(supplier_ice) <= 20),
    supplier_ref   TEXT CHECK (supplier_ref IS NULL OR char_length(supplier_ref) <= 60),
    doc_date       DATE NOT NULL,
    due_date       DATE,
    total_ht       NUMERIC(14,2) NOT NULL,
    total_tva      NUMERIC(14,2) NOT NULL,
    total_ttc      NUMERIC(14,2) NOT NULL,
    vat_deductible BOOLEAN NOT NULL DEFAULT true,
    note           TEXT CHECK (note IS NULL OR char_length(note) <= 300),
    status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
    cancelled_at   TIMESTAMPTZ,
    cancel_reason  TEXT CHECK (cancel_reason IS NULL OR char_length(cancel_reason) <= 200),
    legacy_id      TEXT CHECK (legacy_id IS NULL OR char_length(legacy_id) <= 100),
    idem_key       TEXT CHECK (idem_key IS NULL OR char_length(idem_key) BETWEEN 1 AND 200),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (total_ttc = total_ht + total_tva),
    UNIQUE (user_id, number),
    UNIQUE (user_id, idem_key),
    UNIQUE (user_id, legacy_id)
);
CREATE INDEX IF NOT EXISTS purchases_user_date_idx ON public.purchases (user_id, doc_date DESC);
ALTER TABLE public.purchases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.purchases FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.purchase_lines (
    purchase_id  UUID NOT NULL REFERENCES public.purchases(id) ON DELETE CASCADE,
    user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    line_no      INT  NOT NULL CHECK (line_no BETWEEN 0 AND 99),
    nature       TEXT NOT NULL CHECK (nature IN ('goods', 'expense', 'asset')),
    category     TEXT CHECK (category IS NULL OR char_length(category) BETWEEN 1 AND 60),
    product_id   TEXT CHECK (product_id IS NULL OR char_length(product_id) BETWEEN 1 AND 100),
    product_name TEXT CHECK (product_name IS NULL OR char_length(product_name) <= 200),
    unit         TEXT CHECK (unit IS NULL OR char_length(unit) <= 30),
    track_stock  BOOLEAN NOT NULL DEFAULT false,
    description  TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 200),
    qty          NUMERIC(14,3) NOT NULL CHECK (qty > 0 AND qty <= 1000000000),
    unit_price   NUMERIC(14,4) NOT NULL CHECK (unit_price >= 0 AND unit_price <= 1000000000),
    tva_rate     NUMERIC(5,2)  NOT NULL CHECK (tva_rate IN (0, 7, 10, 14, 20)),
    total_ht     NUMERIC(14,2) NOT NULL,
    total_tva    NUMERIC(14,2) NOT NULL,
    PRIMARY KEY (purchase_id, line_no),
    CHECK (nature <> 'goods' OR product_id IS NOT NULL),
    CHECK (nature <> 'expense' OR category IS NOT NULL),
    CHECK (track_stock = false OR nature = 'goods')
);
CREATE INDEX IF NOT EXISTS purchase_lines_user_idx ON public.purchase_lines (user_id, nature);
ALTER TABLE public.purchase_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.purchase_lines FROM PUBLIC, anon, authenticated;

-- Immuabilité : seule l'annulation est permise (et seulement par purchase_cancel)
CREATE OR REPLACE FUNCTION public.fin_purchase_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF OLD.status = 'active' AND NEW.status = 'cancelled'
       AND (to_jsonb(NEW) - 'status' - 'cancelled_at' - 'cancel_reason') = (to_jsonb(OLD) - 'status' - 'cancelled_at' - 'cancel_reason') THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'achat non modifiable (annulation uniquement)' USING ERRCODE = '42501';
END; $$;
REVOKE ALL ON FUNCTION public.fin_purchase_guard() FROM PUBLIC, anon, authenticated;
CREATE OR REPLACE TRIGGER trg_purchase_guard BEFORE UPDATE ON public.purchases FOR EACH ROW EXECUTE FUNCTION public.fin_purchase_guard();

CREATE OR REPLACE FUNCTION public.fin_lines_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'ligne non modifiable' USING ERRCODE = '42501'; END; $$;
REVOKE ALL ON FUNCTION public.fin_lines_guard() FROM PUBLIC, anon, authenticated;
CREATE OR REPLACE TRIGGER trg_purchase_lines_guard BEFORE UPDATE ON public.purchase_lines FOR EACH ROW EXECUTE FUNCTION public.fin_lines_guard();

-- ---------- enregistrement ----------
-- p = { key, supplier_id, supplier_name, supplier_ice, supplier_ref, date, due_date, vat_deductible, note,
--       lines: [ { nature, category, product_id, product_name, unit, track_stock, description, qty, unit_price, tva_rate } ] }
-- Retour : { id, number, total_ht, total_tva, total_ttc, duplicate }
CREATE OR REPLACE FUNCTION public.purchase_record(p JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    v UUID := public.fin_uid(); r public.purchases%ROWTYPE; v_id UUID; v_key TEXT; v_date DATE; v_due DATE; v_num TEXT;
    l JSONB; i INT := 0; v_nat TEXT; v_qty NUMERIC; v_pu NUMERIC; v_rate NUMERIC; v_ht NUMERIC; v_tva NUMERIC; t_ht NUMERIC := 0; t_tva NUMERIC := 0;
    v_ded BOOLEAN; v_track BOOLEAN; v_cat TEXT; v_pid TEXT; moves JSONB := '[]'::jsonb; v_desc TEXT; norm JSONB := '[]'::jsonb;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    IF NOT public.has_active_license(v) THEN RAISE EXCEPTION 'LICENCE_INACTIVE'; END IF;
    IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'ACHAT_INVALIDE'; END IF;
    v_key := left(NULLIF(btrim(p->>'key'), ''), 200);
    IF v_key IS NOT NULL THEN
        SELECT * INTO r FROM public.purchases WHERE user_id = v AND idem_key = v_key;
        IF FOUND THEN RETURN jsonb_build_object('id', r.id, 'number', r.number, 'total_ht', r.total_ht, 'total_tva', r.total_tva, 'total_ttc', r.total_ttc, 'duplicate', true); END IF;
    END IF;
    IF COALESCE(btrim(p->>'supplier_name'), '') = '' THEN RAISE EXCEPTION 'FOURNISSEUR_INVALIDE'; END IF;
    BEGIN v_date := (p->>'date')::date; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'DATE_INVALIDE'; END;
    IF v_date IS NULL OR v_date < DATE '2000-01-01' OR v_date > current_date + 31 THEN RAISE EXCEPTION 'DATE_INVALIDE'; END IF;
    BEGIN v_due := NULLIF(p->>'due_date', '')::date; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'ECHEANCE_INVALIDE'; END;
    IF v_due IS NOT NULL AND v_due < v_date THEN RAISE EXCEPTION 'ECHEANCE_INVALIDE'; END IF;
    PERFORM public.fin_assert_open(v, v_date);
    IF jsonb_typeof(p->'lines') <> 'array' OR jsonb_array_length(p->'lines') = 0 THEN RAISE EXCEPTION 'LIGNES_INVALIDES'; END IF;
    IF jsonb_array_length(p->'lines') > 100 THEN RAISE EXCEPTION 'TROP_DE_LIGNES'; END IF;
    IF (SELECT count(*) FROM public.purchases WHERE user_id = v) >= 50000 THEN RAISE EXCEPTION 'LIMITE_ACHATS_ATTEINTE'; END IF;
    v_ded := COALESCE((p->>'vat_deductible')::boolean, true);

    -- 1er passage : validation et calcul des lignes (rien n'est écrit tant qu'une ligne est invalide)
    FOR l IN SELECT * FROM jsonb_array_elements(p->'lines') LOOP
        IF jsonb_typeof(l) <> 'object' THEN RAISE EXCEPTION 'LIGNES_INVALIDES'; END IF;
        v_nat := l->>'nature';
        IF v_nat IS NULL OR v_nat NOT IN ('goods', 'expense', 'asset') THEN RAISE EXCEPTION 'NATURE_INVALIDE'; END IF;
        BEGIN v_qty := round((l->>'qty')::numeric, 3); v_pu := round((l->>'unit_price')::numeric, 4); v_rate := (l->>'tva_rate')::numeric;
        EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'LIGNE_INVALIDE'; END;
        IF v_qty IS NULL OR v_qty <= 0 OR v_qty > 1000000000 THEN RAISE EXCEPTION 'QUANTITE_INVALIDE'; END IF;
        IF v_pu IS NULL OR v_pu < 0 OR v_pu > 1000000000 THEN RAISE EXCEPTION 'PRIX_INVALIDE'; END IF;
        IF v_rate IS NULL OR v_rate NOT IN (0, 7, 10, 14, 20) THEN RAISE EXCEPTION 'TAUX_TVA_INVALIDE'; END IF;
        v_pid := left(NULLIF(btrim(l->>'product_id'), ''), 100);
        v_cat := left(NULLIF(btrim(l->>'category'), ''), 60);
        v_desc := left(btrim(COALESCE(l->>'description', '')), 200);
        IF v_desc = '' THEN RAISE EXCEPTION 'DESIGNATION_INVALIDE'; END IF;
        IF v_nat = 'goods' AND v_pid IS NULL THEN RAISE EXCEPTION 'MARCHANDISE_SANS_PRODUIT'; END IF;
        IF v_nat = 'expense' AND v_cat IS NULL THEN RAISE EXCEPTION 'CATEGORIE_OBLIGATOIRE'; END IF;
        v_track := v_nat = 'goods' AND COALESCE((l->>'track_stock')::boolean, false);
        v_ht := round(v_qty * v_pu, 2); v_tva := round(v_ht * v_rate / 100, 2);
        t_ht := t_ht + v_ht; t_tva := t_tva + v_tva;
        norm := norm || jsonb_build_array(jsonb_build_object('n', i, 'nature', v_nat, 'category', CASE WHEN v_nat = 'expense' THEN v_cat END,
            'product_id', CASE WHEN v_nat = 'goods' THEN v_pid END, 'product_name', left(NULLIF(btrim(l->>'product_name'), ''), 200),
            'unit', left(NULLIF(btrim(l->>'unit'), ''), 30), 'track', v_track, 'description', v_desc, 'qty', v_qty, 'pu', v_pu, 'rate', v_rate, 'ht', v_ht, 'tva', v_tva));
        i := i + 1;
    END LOOP;

    -- 2e passage : écriture (en-tête avec ses totaux définitifs, lignes, entrées de stock)
    v_id := gen_random_uuid();
    v_num := public.fin_next_number(v, 'purchase', v_date);
    INSERT INTO public.purchases (id, user_id, number, supplier_id, supplier_name, supplier_ice, supplier_ref, doc_date, due_date, total_ht, total_tva, total_ttc,
                                  vat_deductible, note, idem_key)
    VALUES (v_id, v, v_num, left(NULLIF(btrim(p->>'supplier_id'), ''), 100), left(btrim(p->>'supplier_name'), 120), left(NULLIF(btrim(p->>'supplier_ice'), ''), 20),
            left(NULLIF(btrim(p->>'supplier_ref'), ''), 60), v_date, v_due, t_ht, t_tva, t_ht + t_tva, v_ded, left(NULLIF(btrim(p->>'note'), ''), 300), v_key);
    FOR l IN SELECT * FROM jsonb_array_elements(norm) LOOP
        INSERT INTO public.purchase_lines (purchase_id, user_id, line_no, nature, category, product_id, product_name, unit, track_stock, description, qty, unit_price, tva_rate, total_ht, total_tva)
        VALUES (v_id, v, (l->>'n')::int, l->>'nature', l->>'category', l->>'product_id', l->>'product_name', l->>'unit', (l->>'track')::boolean, l->>'description',
                (l->>'qty')::numeric, (l->>'pu')::numeric, (l->>'rate')::numeric, (l->>'ht')::numeric, (l->>'tva')::numeric);
        IF (l->>'track')::boolean THEN
            moves := moves || jsonb_build_array(jsonb_build_object('product_id', l->>'product_id', 'product_name', COALESCE(l->>'product_name', l->>'description'),
                'unit', COALESCE(l->>'unit', 'unité'), 'type', 'in', 'qty', (l->>'qty')::numeric, 'date', v_date, 'source', 'purchase',
                'unit_cost', round((l->>'pu')::numeric * CASE WHEN v_ded THEN 1 ELSE 1 + (l->>'rate')::numeric / 100 END, 4),      -- TVA non déductible = partie du coût
                'ref', v_num, 'ref_id', v_id::text, 'note', left(btrim(p->>'supplier_name'), 200), 'key', 'pur:' || v_id || ':' || (l->>'n')));
        END IF;
    END LOOP;
    IF jsonb_array_length(moves) > 0 THEN PERFORM public.stock_record(moves); END IF;
    INSERT INTO public.fin_audit (user_id, action, entity, entity_id, detail) VALUES (v, 'creation', 'purchase', v_id::text, jsonb_build_object('number', v_num, 'total_ttc', t_ht + t_tva));
    RETURN jsonb_build_object('id', v_id, 'number', v_num, 'total_ht', t_ht, 'total_tva', t_tva, 'total_ttc', t_ht + t_tva, 'duplicate', false);
END; $$;
REVOKE ALL ON FUNCTION public.purchase_record(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.purchase_record(JSONB) TO authenticated;

-- ---------- annulation ----------
CREATE OR REPLACE FUNCTION public.purchase_cancel(p_id UUID, p_reason TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fin_uid(); r public.purchases%ROWTYPE; moves JSONB := '[]'::jsonb; m RECORD;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    IF NOT public.has_active_license(v) THEN RAISE EXCEPTION 'LICENCE_INACTIVE'; END IF;
    SELECT * INTO r FROM public.purchases WHERE id = p_id AND user_id = v FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACHAT_INTROUVABLE'; END IF;
    IF r.status = 'cancelled' THEN RETURN jsonb_build_object('id', r.id, 'number', r.number, 'already', true); END IF;
    PERFORM public.fin_assert_open(v, r.doc_date);
    IF public.fin_purchase_paid(v, r.id) > 0 THEN RAISE EXCEPTION 'ACHAT_REGLE: annulez d''abord ses règlements'; END IF;
    -- sorties inverses des entrées réellement enregistrées, au coût de l'achat
    FOR m IN SELECT s.product_id, s.product_name, s.unit, s.qty, s.unit_cost, s.idem_key FROM public.stock_movements s
              WHERE s.user_id = v AND s.move_type = 'in'
                AND (s.idem_key LIKE 'pur:' || r.id || ':%' OR (r.legacy_id IS NOT NULL AND s.idem_key LIKE 'pur:' || r.legacy_id || ':%')) LOOP   -- achat repris : clés de l'ancienne version
        moves := moves || jsonb_build_array(jsonb_build_object('product_id', m.product_id, 'product_name', m.product_name, 'unit', m.unit, 'type', 'out', 'qty', m.qty,
            'date', current_date, 'source', 'purchase', 'unit_cost', m.unit_cost, 'ref', r.number, 'ref_id', r.id::text,
            'note', 'Annulation ' || r.number, 'key', 'pur-cancel:' || r.id || ':' || substr(m.idem_key, length(split_part(m.idem_key, ':', 1) || ':' || split_part(m.idem_key, ':', 2)) + 2)));
    END LOOP;
    IF jsonb_array_length(moves) > 0 THEN PERFORM public.stock_record(moves); END IF;
    UPDATE public.purchases SET status = 'cancelled', cancelled_at = now(), cancel_reason = left(NULLIF(btrim(p_reason), ''), 200) WHERE id = r.id;
    INSERT INTO public.fin_audit (user_id, action, entity, entity_id, detail) VALUES (v, 'annulation', 'purchase', r.id::text, jsonb_build_object('number', r.number, 'reason', left(p_reason, 200)));
    RETURN jsonb_build_object('id', r.id, 'number', r.number, 'already', false, 'stock_lines', jsonb_array_length(moves));
END; $$;
REVOKE ALL ON FUNCTION public.purchase_cancel(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.purchase_cancel(UUID, TEXT) TO authenticated;

-- ---------- lecture ----------
-- p_status : 'active' | 'cancelled' | NULL (tous). Dates sur doc_date, bornes incluses, NULL = sans borne. 1 à 5000 lignes.
CREATE OR REPLACE FUNCTION public.purchase_list(p_from DATE, p_to DATE, p_status TEXT DEFAULT NULL, p_limit INT DEFAULT 500, p_offset INT DEFAULT 0)
RETURNS TABLE (id UUID, number TEXT, doc_date DATE, due_date DATE, supplier_id TEXT, supplier_name TEXT, supplier_ice TEXT, supplier_ref TEXT,
               total_ht NUMERIC, total_tva NUMERIC, total_ttc NUMERIC, vat_deductible BOOLEAN, note TEXT, status TEXT, cancel_reason TEXT,
               created_at TIMESTAMPTZ, paid NUMERIC, lines JSONB)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fin_uid();
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    RETURN QUERY
    SELECT pu.id, pu.number, pu.doc_date, pu.due_date, pu.supplier_id, pu.supplier_name, pu.supplier_ice, pu.supplier_ref,
           pu.total_ht, pu.total_tva, pu.total_ttc, pu.vat_deductible, pu.note, pu.status, pu.cancel_reason, pu.created_at,
           public.fin_purchase_paid(v, pu.id),
           COALESCE((SELECT jsonb_agg(jsonb_build_object('line_no', l.line_no, 'nature', l.nature, 'category', l.category, 'product_id', l.product_id,
                        'product_name', l.product_name, 'unit', l.unit, 'track_stock', l.track_stock, 'description', l.description, 'qty', l.qty,
                        'unit_price', l.unit_price, 'tva_rate', l.tva_rate, 'total_ht', l.total_ht, 'total_tva', l.total_tva) ORDER BY l.line_no)
                       FROM public.purchase_lines l WHERE l.purchase_id = pu.id), '[]'::jsonb)
      FROM public.purchases pu
     WHERE pu.user_id = v AND (p_from IS NULL OR pu.doc_date >= p_from) AND (p_to IS NULL OR pu.doc_date <= p_to)
       AND (p_status IS NULL OR pu.status = p_status)
     ORDER BY pu.doc_date DESC, pu.created_at DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 500), 1), 5000) OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END; $$;
REVOKE ALL ON FUNCTION public.purchase_list(DATE, DATE, TEXT, INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.purchase_list(DATE, DATE, TEXT, INT, INT) TO authenticated;

-- ---------- reprise unique des achats JSON (clé user_data 'purchases' de la version précédente) ----------
-- p_items = le tableau JSON tel que l'application le stockait. Chaque achat est repris une fois (legacy_id), avec son numéro
-- d'origine s'il est libre, SANS mouvement de stock (déjà enregistré par l'ancienne version). Lignes : produit → marchandise ;
-- sans produit → charge, catégorie « Autre ». Retour : { imported, skipped }.
CREATE OR REPLACE FUNCTION public.fin_import_legacy_purchases(p_items JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fin_uid(); it JSONB; l JSONB; v_id UUID; i INT; n_imp INT := 0; n_skip INT := 0; v_num TEXT; v_date DATE;
        v_ht NUMERIC; v_tva NUMERIC; t_ht NUMERIC; t_tva NUMERIC; v_rate NUMERIC; v_qty NUMERIC; v_pu NUMERIC; v_pid TEXT; y INT; k INT; norm JSONB;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    IF NOT public.has_active_license(v) THEN RAISE EXCEPTION 'LICENCE_INACTIVE'; END IF;
    IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN RAISE EXCEPTION 'REPRISE_INVALIDE'; END IF;
    IF jsonb_array_length(p_items) > 2000 THEN RAISE EXCEPTION 'TROP_D_ACHATS'; END IF;
    FOR it IN SELECT * FROM jsonb_array_elements(p_items) LOOP
        IF jsonb_typeof(it) <> 'object' OR COALESCE(btrim(it->>'id'), '') = '' OR jsonb_typeof(it->'lines') <> 'array' OR jsonb_array_length(it->'lines') = 0 THEN n_skip := n_skip + 1; CONTINUE; END IF;
        IF EXISTS (SELECT 1 FROM public.purchases WHERE user_id = v AND legacy_id = left(it->>'id', 100)) THEN n_skip := n_skip + 1; CONTINUE; END IF;
        BEGIN v_date := (it->>'date')::date; EXCEPTION WHEN OTHERS THEN v_date := NULL; END;
        IF v_date IS NULL THEN n_skip := n_skip + 1; CONTINUE; END IF;
        v_num := left(NULLIF(btrim(it->>'number'), ''), 40);
        IF v_num IS NULL OR EXISTS (SELECT 1 FROM public.purchases WHERE user_id = v AND number = v_num) THEN v_num := NULL;
        ELSE
            -- le compteur serveur ne redonnera jamais un numéro repris
            y := EXTRACT(YEAR FROM v_date)::int; k := NULLIF(substring(v_num FROM '^ACH-' || y || '-(\d+)$'), '')::int;
            IF k IS NOT NULL THEN INSERT INTO public.fin_counters (user_id, doc_type, year, last) VALUES (v, 'purchase', y, k)
                ON CONFLICT (user_id, doc_type, year) DO UPDATE SET last = GREATEST(public.fin_counters.last, k); END IF;
        END IF;
        i := 0; t_ht := 0; t_tva := 0; norm := '[]'::jsonb;
        FOR l IN SELECT * FROM jsonb_array_elements(it->'lines') LOOP
            EXIT WHEN i > 99;
            BEGIN v_qty := round((l->>'qty')::numeric, 3); v_pu := round(COALESCE((l->>'price')::numeric, 0), 4); v_rate := COALESCE((l->>'tva')::numeric, 0);
            EXCEPTION WHEN OTHERS THEN v_qty := NULL; END;
            IF v_qty IS NULL OR v_qty <= 0 OR v_pu < 0 OR v_rate NOT IN (0, 7, 10, 14, 20) THEN CONTINUE; END IF;
            v_pid := left(NULLIF(btrim(l->>'productId'), ''), 100);
            v_ht := round(v_qty * v_pu, 2); v_tva := round(v_ht * v_rate / 100, 2); t_ht := t_ht + v_ht; t_tva := t_tva + v_tva;
            norm := norm || jsonb_build_array(jsonb_build_object('n', i, 'pid', v_pid, 'unit', left(NULLIF(l->>'unit', ''), 30),
                'description', left(COALESCE(NULLIF(btrim(l->>'description'), ''), 'Ligne'), 200), 'qty', v_qty, 'pu', v_pu, 'rate', v_rate, 'ht', v_ht, 'tva', v_tva));
            i := i + 1;
        END LOOP;
        IF i = 0 THEN n_skip := n_skip + 1; CONTINUE; END IF;
        IF v_num IS NULL THEN v_num := public.fin_next_number(v, 'purchase', v_date); END IF;
        v_id := gen_random_uuid();
        INSERT INTO public.purchases (id, user_id, number, supplier_id, supplier_name, supplier_ice, supplier_ref, doc_date, total_ht, total_tva, total_ttc, vat_deductible, note, legacy_id)
        VALUES (v_id, v, v_num, left(NULLIF(it->>'supplierId', ''), 100), left(COALESCE(NULLIF(btrim(it->>'supplierName'), ''), 'Fournisseur'), 120), left(NULLIF(it->>'supplierICE', ''), 20),
                left(NULLIF(it->>'supplierRef', ''), 60), v_date, t_ht, t_tva, t_ht + t_tva, COALESCE((it->>'includeVat')::boolean, true), left(NULLIF(it->>'note', ''), 300), left(it->>'id', 100));
        FOR l IN SELECT * FROM jsonb_array_elements(norm) LOOP
            INSERT INTO public.purchase_lines (purchase_id, user_id, line_no, nature, category, product_id, unit, track_stock, description, qty, unit_price, tva_rate, total_ht, total_tva)
            VALUES (v_id, v, (l->>'n')::int, CASE WHEN l->>'pid' IS NULL THEN 'expense' ELSE 'goods' END, CASE WHEN l->>'pid' IS NULL THEN 'Autre' END, l->>'pid',
                    l->>'unit', false, l->>'description', (l->>'qty')::numeric, (l->>'pu')::numeric, (l->>'rate')::numeric, (l->>'ht')::numeric, (l->>'tva')::numeric);
        END LOOP;
        n_imp := n_imp + 1;
    END LOOP;
    IF n_imp > 0 THEN INSERT INTO public.fin_audit (user_id, action, entity, detail) VALUES (v, 'reprise', 'purchase', jsonb_build_object('imported', n_imp, 'skipped', n_skip)); END IF;
    RETURN jsonb_build_object('imported', n_imp, 'skipped', n_skip);
END; $$;
REVOKE ALL ON FUNCTION public.fin_import_legacy_purchases(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_import_legacy_purchases(JSONB) TO authenticated;
