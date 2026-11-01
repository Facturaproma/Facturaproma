-- ============================================================================================================
-- 44 — Avoir fournisseur : réduction d'un achat (retour de marchandise, erreur de prix, remise) sans modifier l'achat
-- ============================================================================================================
-- Dépend de : sql/37 (achats), sql/39 (trésorerie), sql/40 (clôture), sql/41 (indicateurs). À coller APRÈS sql/43.
--
-- PRINCIPE
--  * Un avoir fournisseur = une ligne de purchase_credits + ses lignes purchase_credit_lines, rattachée à UN achat actif.
--    Montants POSITIFS (ils viennent en déduction de l'achat). Numéro : AVF-<numéro de l'achat>-<n>. Immuable, jamais supprimé.
--  * Par ligne de l'achat : quantité ≤ quantité achetée, prix unitaire ≤ prix d'achat, cumul HT des avoirs ≤ HT de la ligne.
--    Cumul TTC des avoirs ≤ TTC de l'achat.
--  * Marchandise SUIVIE en stock : l'avoir est un RETOUR au fournisseur, au prix d'achat (quantité ≤ quantité achetée) ;
--    il sort la quantité du stock au coût de l'achat (comme l'annulation). Remise de prix sur marchandise suivie : non gérée (V1).
--  * Effets : dette fournisseur = TTC − règlements − avoirs (jamais négative) ; charges, investissements et achats de marchandises
--    non suivies de la période de l'avoir diminuent de son HT (+ TVA si non déductible) ; un règlement ne peut pas dépasser
--    TTC − avoirs ; un achat avec avoir ne peut plus être annulé.
--  * Idempotence (clé), clôture (fin_assert_open), licence active, compte connecté : comme les achats.
-- Sécurité : tables FERMÉES (RLS sans politique, aucun droit direct) ; fonctions SECURITY DEFINER limitées au compte connecté.
-- Réexécutable. Ne modifie aucune donnée existante.
-- RETOUR ARRIÈRE (après accord, retirer d'abord l'application) : recoller les versions « 0 » de fin_purchase_credited et
--   fin_purchase_credit_figures (sql/37, sql/41), puis supprimer les fonctions et tables de ce fichier.
-- ============================================================================================================

DO $$ BEGIN
    IF to_regclass('public.cash_movements') IS NULL OR to_regprocedure('public.fin_figures(uuid,date,date)') IS NULL THEN
        RAISE EXCEPTION 'PREREQUIS_MANQUANT: sql/39 et sql/41 doivent être appliqués avant sql/44';
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.purchase_credits (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    purchase_id  UUID NOT NULL REFERENCES public.purchases(id) ON DELETE CASCADE,
    number       TEXT NOT NULL CHECK (char_length(number) BETWEEN 1 AND 60),
    doc_date     DATE NOT NULL,
    supplier_ref TEXT CHECK (supplier_ref IS NULL OR char_length(supplier_ref) <= 60),
    reason       TEXT NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 200),
    total_ht     NUMERIC(14,2) NOT NULL CHECK (total_ht >= 0),
    total_tva    NUMERIC(14,2) NOT NULL CHECK (total_tva >= 0),
    total_ttc    NUMERIC(14,2) NOT NULL CHECK (total_ttc > 0),
    idem_key     TEXT CHECK (idem_key IS NULL OR char_length(idem_key) BETWEEN 1 AND 200),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (total_ttc = total_ht + total_tva),
    UNIQUE (user_id, number),
    UNIQUE (user_id, idem_key)
);
CREATE INDEX IF NOT EXISTS purchase_credits_purchase_idx ON public.purchase_credits (purchase_id);
CREATE INDEX IF NOT EXISTS purchase_credits_user_date_idx ON public.purchase_credits (user_id, doc_date);
ALTER TABLE public.purchase_credits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.purchase_credits FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.purchase_credit_lines (
    credit_id    UUID NOT NULL REFERENCES public.purchase_credits(id) ON DELETE CASCADE,
    user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    src_line_no  INT  NOT NULL CHECK (src_line_no BETWEEN 0 AND 99),
    qty          NUMERIC(14,3) NOT NULL CHECK (qty > 0),
    unit_price   NUMERIC(14,4) NOT NULL CHECK (unit_price >= 0),
    total_ht     NUMERIC(14,2) NOT NULL CHECK (total_ht >= 0),
    total_tva    NUMERIC(14,2) NOT NULL CHECK (total_tva >= 0),
    returned_qty NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (returned_qty >= 0 AND returned_qty <= qty),
    PRIMARY KEY (credit_id, src_line_no)
);
CREATE INDEX IF NOT EXISTS purchase_credit_lines_user_idx ON public.purchase_credit_lines (user_id);
ALTER TABLE public.purchase_credit_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.purchase_credit_lines FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fin_credit_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'avoir fournisseur non modifiable' USING ERRCODE = '42501'; END; $$;
REVOKE ALL ON FUNCTION public.fin_credit_guard() FROM PUBLIC, anon, authenticated;
CREATE OR REPLACE TRIGGER trg_purchase_credit_guard BEFORE UPDATE ON public.purchase_credits FOR EACH ROW EXECUTE FUNCTION public.fin_credit_guard();
CREATE OR REPLACE TRIGGER trg_purchase_credit_lines_guard BEFORE UPDATE ON public.purchase_credit_lines FOR EACH ROW EXECUTE FUNCTION public.fin_credit_guard();

-- TTC crédité d'un achat (avoirs datés ≤ p_to ; p_to NULL = tous). Remplace la version « 0 » de sql/37.
CREATE OR REPLACE FUNCTION public.fin_purchase_credited(p_uid UUID, p_purchase UUID, p_to DATE DEFAULT NULL) RETURNS NUMERIC
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT COALESCE(sum(c.total_ttc), 0) FROM public.purchase_credits c
     WHERE c.user_id = p_uid AND c.purchase_id = p_purchase AND (p_to IS NULL OR c.doc_date <= p_to)
$$;
REVOKE ALL ON FUNCTION public.fin_purchase_credited(UUID, UUID, DATE) FROM PUBLIC, anon, authenticated;

-- Avoirs fournisseurs de la période par nature : { untracked, charges, assets } (HT + TVA si non déductible). Remplace la version « 0 » de sql/41.
CREATE OR REPLACE FUNCTION public.fin_purchase_credit_figures(p_uid UUID, p_from DATE, p_to DATE) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT jsonb_build_object(
        'untracked', COALESCE(sum(CASE WHEN l.nature = 'goods' AND NOT l.track_stock THEN cl.total_ht + CASE WHEN p.vat_deductible THEN 0 ELSE cl.total_tva END END), 0),
        'charges',   COALESCE(sum(CASE WHEN l.nature = 'expense' THEN cl.total_ht + CASE WHEN p.vat_deductible THEN 0 ELSE cl.total_tva END END), 0),
        'assets',    COALESCE(sum(CASE WHEN l.nature = 'asset' THEN cl.total_ht + CASE WHEN p.vat_deductible THEN 0 ELSE cl.total_tva END END), 0))
      FROM public.purchase_credits c
      JOIN public.purchase_credit_lines cl ON cl.credit_id = c.id
      JOIN public.purchases p ON p.id = c.purchase_id
      JOIN public.purchase_lines l ON l.purchase_id = c.purchase_id AND l.line_no = cl.src_line_no
     WHERE c.user_id = p_uid AND p.status = 'active' AND c.doc_date BETWEEN p_from AND p_to
$$;
REVOKE ALL ON FUNCTION public.fin_purchase_credit_figures(UUID, DATE, DATE) FROM PUBLIC, anon, authenticated;

-- ---------- enregistrement ----------
-- p = { key, purchase_id, date, supplier_ref, reason, lines: [ { line_no, qty, unit_price } ] }
-- Retour : { id, number, total_ht, total_tva, total_ttc, duplicate, stock_lines }
CREATE OR REPLACE FUNCTION public.purchase_credit_record(p JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    v UUID := public.fin_uid(); pu public.purchases%ROWTYPE; c public.purchase_credits%ROWTYPE; pl public.purchase_lines%ROWTYPE;
    v_key TEXT; v_date DATE; v_reason TEXT; v_id UUID; v_num TEXT; l JSONB; v_no INT; v_qty NUMERIC; v_pu NUMERIC; v_ht NUMERIC; v_tva NUMERIC;
    t_ht NUMERIC := 0; t_tva NUMERIC := 0; v_done NUMERIC; v_paid NUMERIC; norm JSONB := '[]'::jsonb; moves JSONB := '[]'::jsonb; v_cost NUMERIC; seen INT[] := '{}';
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    IF NOT public.has_active_license(v) THEN RAISE EXCEPTION 'LICENCE_INACTIVE'; END IF;
    IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN RAISE EXCEPTION 'AVOIR_INVALIDE'; END IF;
    v_key := left(NULLIF(btrim(p->>'key'), ''), 200);
    IF v_key IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('fp_idem:' || v::text || ':' || v_key, 0)); END IF;
    IF v_key IS NOT NULL THEN
        SELECT * INTO c FROM public.purchase_credits WHERE user_id = v AND idem_key = v_key;
        IF FOUND THEN RETURN jsonb_build_object('id', c.id, 'number', c.number, 'total_ht', c.total_ht, 'total_tva', c.total_tva, 'total_ttc', c.total_ttc, 'duplicate', true); END IF;
    END IF;
    BEGIN SELECT * INTO pu FROM public.purchases WHERE id = (p->>'purchase_id')::uuid AND user_id = v FOR UPDATE;
    EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'ACHAT_INTROUVABLE'; END;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACHAT_INTROUVABLE'; END IF;
    IF pu.status <> 'active' THEN RAISE EXCEPTION 'ACHAT_ANNULE'; END IF;
    BEGIN v_date := (p->>'date')::date; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'DATE_INVALIDE'; END;
    IF v_date IS NULL OR v_date < pu.doc_date OR v_date > current_date + 31 THEN RAISE EXCEPTION 'DATE_INVALIDE: pas avant la date de l''achat'; END IF;
    v_reason := left(btrim(COALESCE(p->>'reason', '')), 200);
    IF char_length(v_reason) < 3 THEN RAISE EXCEPTION 'MOTIF_OBLIGATOIRE'; END IF;
    PERFORM public.fin_assert_open(v, v_date);
    IF jsonb_typeof(p->'lines') <> 'array' OR jsonb_array_length(p->'lines') = 0 OR jsonb_array_length(p->'lines') > 100 THEN RAISE EXCEPTION 'LIGNES_INVALIDES'; END IF;
    IF (SELECT count(*) FROM public.purchase_credits WHERE purchase_id = pu.id) >= 50 THEN RAISE EXCEPTION 'TROP_D_AVOIRS'; END IF;

    FOR l IN SELECT * FROM jsonb_array_elements(p->'lines') LOOP
        IF jsonb_typeof(l) <> 'object' THEN RAISE EXCEPTION 'LIGNES_INVALIDES'; END IF;
        BEGIN v_no := (l->>'line_no')::int; v_qty := round((l->>'qty')::numeric, 3); v_pu := round((l->>'unit_price')::numeric, 4);
        EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'LIGNE_INVALIDE'; END;
        IF v_no IS NULL OR v_no = ANY(seen) THEN RAISE EXCEPTION 'LIGNE_INVALIDE'; END IF;
        seen := seen || v_no;
        SELECT * INTO pl FROM public.purchase_lines WHERE purchase_id = pu.id AND line_no = v_no;
        IF NOT FOUND THEN RAISE EXCEPTION 'LIGNE_INTROUVABLE'; END IF;
        IF v_qty IS NULL OR v_qty <= 0 OR v_qty > pl.qty THEN RAISE EXCEPTION 'QUANTITE_INVALIDE: au plus % (quantité achetée)', pl.qty; END IF;
        IF v_pu IS NULL OR v_pu < 0 OR v_pu > pl.unit_price THEN RAISE EXCEPTION 'PRIX_INVALIDE: au plus le prix d''achat'; END IF;
        IF pl.track_stock THEN
            IF v_pu <> pl.unit_price THEN RAISE EXCEPTION 'REMISE_STOCK_NON_GEREE: marchandise suivie en stock : retour au prix d''achat uniquement'; END IF;
            SELECT COALESCE(sum(cl.returned_qty), 0) INTO v_done FROM public.purchase_credit_lines cl JOIN public.purchase_credits x ON x.id = cl.credit_id
             WHERE x.purchase_id = pu.id AND cl.src_line_no = v_no;
            IF v_done + v_qty > pl.qty + 0.0005 THEN RAISE EXCEPTION 'RETOUR_SUPERIEUR_A_L_ACHAT'; END IF;
        END IF;
        v_ht := round(v_qty * v_pu, 2); v_tva := round(v_ht * pl.tva_rate / 100, 2);
        IF v_ht <= 0 THEN CONTINUE; END IF;
        SELECT COALESCE(sum(cl.total_ht), 0) INTO v_done FROM public.purchase_credit_lines cl JOIN public.purchase_credits x ON x.id = cl.credit_id
         WHERE x.purchase_id = pu.id AND cl.src_line_no = v_no;
        IF v_done + v_ht > pl.total_ht + 0.01 THEN RAISE EXCEPTION 'AVOIR_SUPERIEUR_A_LA_LIGNE: reste % HT', pl.total_ht - v_done; END IF;
        t_ht := t_ht + v_ht; t_tva := t_tva + v_tva;
        norm := norm || jsonb_build_array(jsonb_build_object('n', v_no, 'qty', v_qty, 'pu', v_pu, 'ht', v_ht, 'tva', v_tva, 'ret', CASE WHEN pl.track_stock THEN v_qty ELSE 0 END));
        IF pl.track_stock THEN
            -- sortie au coût de l'entrée d'origine (achat) ; à défaut, au coût calculé comme à l'achat
            SELECT s.unit_cost INTO v_cost FROM public.stock_movements s WHERE s.user_id = v AND s.idem_key = 'pur:' || pu.id || ':' || v_no;
            IF v_cost IS NULL THEN v_cost := round(pl.unit_price * CASE WHEN pu.vat_deductible THEN 1 ELSE 1 + pl.tva_rate / 100 END, 4); END IF;
            moves := moves || jsonb_build_array(jsonb_build_object('product_id', pl.product_id, 'product_name', COALESCE(pl.product_name, pl.description),
                'unit', COALESCE(pl.unit, 'unité'), 'type', 'out', 'qty', v_qty, 'date', v_date, 'source', 'purchase', 'unit_cost', v_cost,
                'ref', pu.number, 'ref_id', pu.id::text, 'note', 'Avoir fournisseur ' || pu.number, 'key', 'pcr:' || COALESCE(v_key, gen_random_uuid()::text) || ':' || v_no));
        END IF;
    END LOOP;
    IF t_ht + t_tva <= 0 THEN RAISE EXCEPTION 'AVOIR_NUL'; END IF;
    IF public.fin_purchase_credited(v, pu.id, NULL) + t_ht + t_tva > pu.total_ttc + 0.01 THEN RAISE EXCEPTION 'AVOIR_SUPERIEUR_A_L_ACHAT'; END IF;

    v_id := gen_random_uuid();
    v_num := 'AVF-' || pu.number || '-' || ((SELECT count(*) FROM public.purchase_credits WHERE purchase_id = pu.id) + 1);
    INSERT INTO public.purchase_credits (id, user_id, purchase_id, number, doc_date, supplier_ref, reason, total_ht, total_tva, total_ttc, idem_key)
    VALUES (v_id, v, pu.id, v_num, v_date, left(NULLIF(btrim(p->>'supplier_ref'), ''), 60), v_reason, t_ht, t_tva, t_ht + t_tva, v_key);
    FOR l IN SELECT * FROM jsonb_array_elements(norm) LOOP
        INSERT INTO public.purchase_credit_lines (credit_id, user_id, src_line_no, qty, unit_price, total_ht, total_tva, returned_qty)
        VALUES (v_id, v, (l->>'n')::int, (l->>'qty')::numeric, (l->>'pu')::numeric, (l->>'ht')::numeric, (l->>'tva')::numeric, (l->>'ret')::numeric);
    END LOOP;
    IF jsonb_array_length(moves) > 0 THEN PERFORM public.stock_record(moves); END IF;
    INSERT INTO public.fin_audit (user_id, action, entity, entity_id, detail)
    VALUES (v, 'avoir_fournisseur', 'purchase', pu.id::text, jsonb_build_object('number', v_num, 'total_ttc', t_ht + t_tva, 'reason', v_reason));
    v_paid := public.fin_purchase_paid(v, pu.id);
    RETURN jsonb_build_object('id', v_id, 'number', v_num, 'total_ht', t_ht, 'total_tva', t_tva, 'total_ttc', t_ht + t_tva, 'duplicate', false,
                              'stock_lines', jsonb_array_length(moves), 'overpaid', GREATEST(v_paid - (pu.total_ttc - public.fin_purchase_credited(v, pu.id, NULL)), 0));
END; $$;
REVOKE ALL ON FUNCTION public.purchase_credit_record(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.purchase_credit_record(JSONB) TO authenticated;

-- ---------- lecture ----------
-- Avoirs fournisseurs du compte (p_purchase NULL = tous), avec leurs lignes
CREATE OR REPLACE FUNCTION public.purchase_credit_list(p_purchase UUID DEFAULT NULL)
RETURNS TABLE (id UUID, purchase_id UUID, purchase_number TEXT, supplier_name TEXT, number TEXT, doc_date DATE, supplier_ref TEXT, reason TEXT,
               total_ht NUMERIC, total_tva NUMERIC, total_ttc NUMERIC, created_at TIMESTAMPTZ, lines JSONB)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fin_uid();
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    RETURN QUERY
    SELECT c.id, c.purchase_id, pu.number, pu.supplier_name, c.number, c.doc_date, c.supplier_ref, c.reason, c.total_ht, c.total_tva, c.total_ttc, c.created_at,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('line_no', cl.src_line_no, 'qty', cl.qty, 'unit_price', cl.unit_price, 'total_ht', cl.total_ht,
                        'total_tva', cl.total_tva, 'returned_qty', cl.returned_qty, 'description', l.description, 'nature', l.nature, 'category', l.category,
                        'tva_rate', l.tva_rate) ORDER BY cl.src_line_no)
                       FROM public.purchase_credit_lines cl JOIN public.purchase_lines l ON l.purchase_id = c.purchase_id AND l.line_no = cl.src_line_no
                      WHERE cl.credit_id = c.id), '[]'::jsonb)
      FROM public.purchase_credits c JOIN public.purchases pu ON pu.id = c.purchase_id
     WHERE c.user_id = v AND (p_purchase IS NULL OR c.purchase_id = p_purchase)
     ORDER BY c.doc_date DESC, c.created_at DESC
     LIMIT 5000;
END; $$;
REVOKE ALL ON FUNCTION public.purchase_credit_list(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.purchase_credit_list(UUID) TO authenticated;
