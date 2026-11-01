-- ============================================================================================================
-- 35 — Stock : nouvelles origines de mouvement « purchase » (achat fournisseur) et « delivery » (bon de livraison)
-- ============================================================================================================
-- Dépend de : sql/34 (table stock_movements, fonction stock_record). À coller APRÈS sql/34, en preprod puis en prod.
-- Ne modifie AUCUN mouvement existant : élargit seulement la liste des origines acceptées (contrainte + validation).
-- Les droits sur stock_record sont conservés (CREATE OR REPLACE garde les GRANT existants).
-- Réexécutable.
-- RETOUR ARRIÈRE (seulement s'il n'existe encore aucun mouvement « purchase » ou « delivery ») :
--   ALTER TABLE public.stock_movements DROP CONSTRAINT IF EXISTS stock_movements_source_check;
--   ALTER TABLE public.stock_movements ADD CONSTRAINT stock_movements_source_check CHECK (source IN ('manual', 'invoice', 'credit'));
--   puis recoller la fonction stock_record de sql/34.
-- ============================================================================================================
ALTER TABLE public.stock_movements DROP CONSTRAINT IF EXISTS stock_movements_source_check;
ALTER TABLE public.stock_movements ADD CONSTRAINT stock_movements_source_check
    CHECK (source IN ('manual', 'invoice', 'credit', 'purchase', 'delivery'));

-- Même fonction que sql/34, avec les deux nouvelles origines acceptées.
CREATE OR REPLACE FUNCTION public.stock_record(p_moves JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    v UUID := public.stock_uid();
    e JSONB; n_in INT := 0; n_skip INT := 0; k INT; v_qty NUMERIC; v_date DATE; v_type TEXT; v_src TEXT; v_total BIGINT;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    IF NOT public.has_active_license(v) THEN RAISE EXCEPTION 'LICENCE_INACTIVE'; END IF;
    IF p_moves IS NULL OR jsonb_typeof(p_moves) <> 'array' THEN RAISE EXCEPTION 'MOUVEMENTS_INVALIDES'; END IF;
    IF jsonb_array_length(p_moves) = 0 THEN RETURN jsonb_build_object('inserted', 0, 'skipped', 0); END IF;
    IF jsonb_array_length(p_moves) > 200 THEN RAISE EXCEPTION 'TROP_DE_MOUVEMENTS'; END IF;
    SELECT count(*) INTO v_total FROM public.stock_movements WHERE user_id = v;
    IF v_total + jsonb_array_length(p_moves) > 100000 THEN RAISE EXCEPTION 'LIMITE_STOCK_ATTEINTE'; END IF;
    FOR e IN SELECT * FROM jsonb_array_elements(p_moves) LOOP
        IF jsonb_typeof(e) <> 'object' THEN RAISE EXCEPTION 'MOUVEMENT_INVALIDE'; END IF;
        v_type := e->>'type'; v_src := COALESCE(e->>'source', 'manual');
        IF v_type NOT IN ('in', 'out') THEN RAISE EXCEPTION 'TYPE_INVALIDE'; END IF;
        IF v_src NOT IN ('manual', 'invoice', 'credit', 'purchase', 'delivery') THEN RAISE EXCEPTION 'SOURCE_INVALIDE'; END IF;
        BEGIN v_qty := round((e->>'qty')::numeric, 3); EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'QUANTITE_INVALIDE'; END;
        IF v_qty IS NULL OR v_qty < 0.001 OR v_qty > 1000000000 THEN RAISE EXCEPTION 'QUANTITE_INVALIDE'; END IF;
        BEGIN v_date := (e->>'date')::date; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'DATE_INVALIDE'; END;
        IF v_date IS NULL OR v_date < DATE '2000-01-01' OR v_date > (current_date + 366) THEN RAISE EXCEPTION 'DATE_INVALIDE'; END IF;
        IF COALESCE(btrim(e->>'product_id'), '') = '' OR char_length(e->>'product_id') > 100 THEN RAISE EXCEPTION 'PRODUIT_INVALIDE'; END IF;
        INSERT INTO public.stock_movements (user_id, product_id, product_name, unit, move_type, qty, move_date, source, ref, ref_id, note, idem_key)
        VALUES (v, e->>'product_id', left(COALESCE(NULLIF(btrim(e->>'product_name'), ''), '—'), 200), left(COALESCE(NULLIF(btrim(e->>'unit'), ''), 'unité'), 30),
                v_type, v_qty, v_date, v_src, left(e->>'ref', 100), left(e->>'ref_id', 100), left(e->>'note', 200), left(NULLIF(btrim(e->>'key'), ''), 200))
        ON CONFLICT (user_id, idem_key) DO NOTHING;
        GET DIAGNOSTICS k = ROW_COUNT;
        IF k = 1 THEN n_in := n_in + 1; ELSE n_skip := n_skip + 1; END IF;
    END LOOP;
    RETURN jsonb_build_object('inserted', n_in, 'skipped', n_skip);
END; $$;

REVOKE ALL ON FUNCTION public.stock_record(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stock_record(JSONB) TO authenticated;
