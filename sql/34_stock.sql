-- ============================================================================================================
-- 34 — Stock côté serveur : mouvements d'entrée / sortie par compte, non modifiables   *** NON APPLIQUÉ ***
-- ============================================================================================================
-- Ce script N'EST PAS dans sql/MANIFEST.json tant qu'il n'est pas appliqué (même règle que sql/30).
-- Dépend de : sql/00 (schéma), sql/07 (has_active_license), auth.users. Indépendant des scripts 15 à 33.
--
-- PRINCIPE
--  * Un mouvement = une ligne de stock_movements (entrée « in » ou sortie « out », quantité > 0, jamais modifiée ni supprimée par le client).
--    Une correction se fait par un mouvement inverse (comme une écriture comptable), jamais en éditant l'historique.
--  * Table FERMÉE : RLS active, aucun droit direct pour anon/authenticated. Tout passe par des fonctions SECURITY DEFINER qui
--    n'agissent que sur le compte connecté (e-mail confirmé) : isolation stricte entre comptes.
--  * Idempotence : chaque mouvement automatique porte une clé (facture + ligne). Rejouer la même clé ne crée RIEN (pas de double
--    déduction, même si l'application renvoie deux fois la même facture, ou depuis deux appareils).
--  * Le stock (niveau, entrées, sorties, ouverture d'une période) est CALCULÉ PAR LA BASE, pas par le navigateur.
--  * Écriture : exige une licence active (comme la numérotation) ; lecture : toujours possible pour le compte.
--  * Limites : 200 mouvements par appel, 100 000 par compte, quantité 0,001 à 1 000 000 000, textes bornés.
--  * Les mouvements disparaissent avec le compte (ON DELETE CASCADE). Aucune donnée existante n'est modifiée.
-- Réexécutable.
-- RETOUR ARRIÈRE :
--   DROP FUNCTION IF EXISTS public.stock_record(JSONB), public.stock_levels(), public.stock_period(DATE, DATE), public.stock_list(DATE, DATE, INT, INT), public.stock_uid(), public.stock_guard();
--   DROP TABLE IF EXISTS public.stock_movements;      -- supprime tout l'historique de stock : à ne faire qu'en connaissance de cause
-- ============================================================================================================
CREATE TABLE IF NOT EXISTS public.stock_movements (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    product_id   TEXT NOT NULL CHECK (char_length(product_id) BETWEEN 1 AND 100),
    product_name TEXT NOT NULL CHECK (char_length(product_name) BETWEEN 1 AND 200),
    unit         TEXT NOT NULL DEFAULT 'unité' CHECK (char_length(unit) BETWEEN 1 AND 30),
    move_type    TEXT NOT NULL CHECK (move_type IN ('in', 'out')),
    qty          NUMERIC(14,3) NOT NULL CHECK (qty >= 0.001 AND qty <= 1000000000),
    move_date    DATE NOT NULL,
    source       TEXT NOT NULL CHECK (source IN ('manual', 'invoice', 'credit')),
    ref          TEXT CHECK (ref IS NULL OR char_length(ref) <= 100),
    ref_id       TEXT CHECK (ref_id IS NULL OR char_length(ref_id) <= 100),
    note         TEXT CHECK (note IS NULL OR char_length(note) <= 200),
    idem_key     TEXT CHECK (idem_key IS NULL OR char_length(idem_key) BETWEEN 1 AND 200),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, idem_key)
);
CREATE INDEX IF NOT EXISTS stock_movements_user_prod_idx ON public.stock_movements (user_id, product_id, move_date);
CREATE INDEX IF NOT EXISTS stock_movements_user_date_idx ON public.stock_movements (user_id, move_date DESC, created_at DESC);
ALTER TABLE public.stock_movements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stock_movements FROM PUBLIC, anon, authenticated;
-- (aucune politique : seules les fonctions ci-dessous, propriétaires de la table, y accèdent)

-- Un mouvement ne se modifie jamais (la suppression n'est possible qu'avec le compte : ON DELETE CASCADE)
CREATE OR REPLACE FUNCTION public.stock_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    RAISE EXCEPTION 'mouvement de stock non modifiable : créez un mouvement inverse' USING ERRCODE = '42501';
END $$;
REVOKE ALL ON FUNCTION public.stock_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_stock_guard ON public.stock_movements;
CREATE TRIGGER trg_stock_guard BEFORE UPDATE ON public.stock_movements FOR EACH ROW EXECUTE FUNCTION public.stock_guard();

-- Identité : compte connecté dont l'e-mail est confirmé
CREATE OR REPLACE FUNCTION public.stock_uid() RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
    SELECT u.id FROM auth.users u WHERE u.id = auth.uid() AND u.email_confirmed_at IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION public.stock_uid() FROM PUBLIC, anon, authenticated;

-- Enregistre des mouvements (tableau JSON). Chaque élément :
--   { "product_id", "product_name", "unit", "type": "in"|"out", "qty", "date": "AAAA-MM-JJ", "source": "manual"|"invoice"|"credit", "ref", "ref_id", "note", "key" }
-- Retourne { "inserted": n, "skipped": m } ; « skipped » = clé déjà enregistrée (rejeu sans effet). Tout ou rien : un élément invalide annule l'appel.
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
        IF v_src NOT IN ('manual', 'invoice', 'credit') THEN RAISE EXCEPTION 'SOURCE_INVALIDE'; END IF;
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

-- Niveau de stock actuel par produit (calculé ici). Le nom et l'unité sont ceux du mouvement le plus récent.
CREATE OR REPLACE FUNCTION public.stock_levels()
RETURNS TABLE (product_id TEXT, product_name TEXT, unit TEXT, level NUMERIC, entries NUMERIC, exits NUMERIC, last_move DATE)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.stock_uid();
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    RETURN QUERY
    SELECT m.product_id,
           (array_agg(m.product_name ORDER BY m.move_date DESC, m.created_at DESC))[1],
           (array_agg(m.unit ORDER BY m.move_date DESC, m.created_at DESC))[1],
           COALESCE(sum(CASE WHEN m.move_type = 'in' THEN m.qty ELSE -m.qty END), 0)::numeric(14,3),
           COALESCE(sum(m.qty) FILTER (WHERE m.move_type = 'in'), 0)::numeric(14,3),
           COALESCE(sum(m.qty) FILTER (WHERE m.move_type = 'out'), 0)::numeric(14,3),
           max(m.move_date)
      FROM public.stock_movements m WHERE m.user_id = v GROUP BY m.product_id ORDER BY 2;
END; $$;

-- Période [p_from, p_to] (bornes incluses, NULL = sans borne) : ouverture (avant p_from), entrées, sorties, clôture, par produit
CREATE OR REPLACE FUNCTION public.stock_period(p_from DATE, p_to DATE)
RETURNS TABLE (product_id TEXT, product_name TEXT, unit TEXT, opening NUMERIC, entries NUMERIC, exits NUMERIC, closing NUMERIC)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.stock_uid();
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    RETURN QUERY
    WITH s AS (
        SELECT m.product_id AS pid,
               (array_agg(m.product_name ORDER BY m.move_date DESC, m.created_at DESC))[1] AS pname,
               (array_agg(m.unit ORDER BY m.move_date DESC, m.created_at DESC))[1] AS punit,
               COALESCE(sum(CASE WHEN m.move_type = 'in' THEN m.qty ELSE -m.qty END) FILTER (WHERE p_from IS NOT NULL AND m.move_date < p_from), 0) AS op,
               COALESCE(sum(m.qty) FILTER (WHERE m.move_type = 'in'  AND (p_from IS NULL OR m.move_date >= p_from) AND (p_to IS NULL OR m.move_date <= p_to)), 0) AS en,
               COALESCE(sum(m.qty) FILTER (WHERE m.move_type = 'out' AND (p_from IS NULL OR m.move_date >= p_from) AND (p_to IS NULL OR m.move_date <= p_to)), 0) AS ex
          FROM public.stock_movements m WHERE m.user_id = v GROUP BY m.product_id)
    SELECT s.pid, s.pname, s.punit, s.op::numeric(14,3), s.en::numeric(14,3), s.ex::numeric(14,3), (s.op + s.en - s.ex)::numeric(14,3)
      FROM s WHERE s.op <> 0 OR s.en <> 0 OR s.ex <> 0 OR (s.op + s.en - s.ex) <> 0 ORDER BY s.pname;
END; $$;

-- Détail des mouvements d'une période, du plus récent au plus ancien (1 à 5000 lignes par appel)
CREATE OR REPLACE FUNCTION public.stock_list(p_from DATE, p_to DATE, p_limit INT DEFAULT 200, p_offset INT DEFAULT 0)
RETURNS TABLE (id UUID, product_id TEXT, product_name TEXT, unit TEXT, move_type TEXT, qty NUMERIC, move_date DATE, source TEXT, ref TEXT, note TEXT, created_at TIMESTAMPTZ)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.stock_uid();
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    RETURN QUERY
    SELECT m.id, m.product_id, m.product_name, m.unit, m.move_type, m.qty, m.move_date, m.source, m.ref, m.note, m.created_at
      FROM public.stock_movements m
     WHERE m.user_id = v AND (p_from IS NULL OR m.move_date >= p_from) AND (p_to IS NULL OR m.move_date <= p_to)
     ORDER BY m.move_date DESC, m.created_at DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 5000) OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END; $$;

REVOKE ALL ON FUNCTION public.stock_record(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.stock_levels() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.stock_period(DATE, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.stock_list(DATE, DATE, INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stock_record(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.stock_levels() TO authenticated;
GRANT EXECUTE ON FUNCTION public.stock_period(DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.stock_list(DATE, DATE, INT, INT) TO authenticated;
