-- ============================================================================================================
-- 36 — Stock : coût moyen unitaire pondéré (CMUP) FIGÉ sur chaque mouvement, valeur du stock, retours au coût d'origine
-- ============================================================================================================
-- FacturaPro 2.0 — PR 3. Dépend de : sql/34 (stock_movements, stock_record…) et sql/35 (origines purchase / delivery).
-- À coller APRÈS sql/35, en préproduction puis en production, AVANT de mettre en ligne l'application qui l'utilise.
--
-- PRINCIPE
--  * Chaque mouvement porte désormais son coût unitaire (unit_cost) et le CMUP du produit juste après lui (cmup_after),
--    calculés PAR LE SERVEUR au moment où le mouvement est écrit, puis jamais recalculés (la table reste non modifiable).
--  * Entrée avec coût fourni (achat) : CMUP = (qté en stock × CMUP + qté entrée × coût) ÷ (qté en stock + qté entrée) ;
--    si le stock était ≤ 0 ou sans coût connu : CMUP = coût de l'entrée.
--  * Entrée sans coût (entrée manuelle sans prix, ancien appareil) : coût = CMUP courant, cost_known = false, CMUP inchangé.
--  * Retour (entrée portant return_of = clé de la sortie d'origine) : coût = coût de cette sortie ; la somme des retours
--    d'une sortie ne peut pas dépasser sa quantité (RETOUR_SUPERIEUR_A_LA_SORTIE).
--  * Sortie : coût = CMUP courant (inconnu si aucun coût n'est connu : cost_known = false), CMUP inchangé.
--    Exception : annulation d'un achat (sortie d'origine « purchase » avec coût fourni) : la valeur retirée est celle de
--    l'achat, le CMUP des unités restantes est recalculé.
--  * L'ordre de calcul est l'ORDRE D'ENREGISTREMENT (colonne seq), pas l'ordre des dates : une saisie antidatée ne
--    réévalue jamais une sortie déjà faite. La clôture de période (sql/40) empêche de saisir dans une période arrêtée.
--  * Concurrence : l'état courant du produit (stock_cost_state) est verrouillé (FOR UPDATE) pendant le calcul : deux
--    écritures simultanées du même produit sont sérialisées ; la vérification d'idempotence a lieu APRÈS le verrou.
--  * Les mouvements déjà enregistrés (avant ce script) restent tels quels, coût inconnu (cost_known = false) ; leur
--    quantité est reprise dans stock_cost_state (invariant : qty = Σ entrées − Σ sorties). Aucune donnée n'est modifiée.
-- Sécurité : inchangée (table fermée, RLS sans politique, fonctions SECURITY DEFINER limitées au compte connecté,
-- licence active pour écrire). stock_cost_state est fermée de la même façon.
-- Réexécutable.
--
-- RETOUR ARRIÈRE (l'application de la PR 3 doit d'abord être retirée) :
--   1) recoller la fonction stock_record de sql/35 ; pour stock_list : supprimer la nouvelle version puis renommer stock_list_pre36 en stock_list
--      (+ GRANT EXECUTE ... TO authenticated) ;
--   2) DROP FUNCTION IF EXISTS public.stock_valuation(DATE);
--   3) DROP TABLE IF EXISTS public.stock_cost_state;
--   4) (facultatif, perd les coûts enregistrés) ALTER TABLE public.stock_movements DROP COLUMN IF EXISTS unit_cost,
--      DROP COLUMN IF EXISTS cmup_after, DROP COLUMN IF EXISTS cost_known, DROP COLUMN IF EXISTS return_of, DROP COLUMN IF EXISTS seq;
-- ============================================================================================================

DO $$ BEGIN
    IF to_regclass('public.stock_movements') IS NULL THEN RAISE EXCEPTION 'PREREQUIS_MANQUANT: sql/34 doit être appliqué avant sql/36'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_movements_source_check' AND pg_get_constraintdef(oid) LIKE '%delivery%') THEN
        RAISE EXCEPTION 'PREREQUIS_MANQUANT: sql/35 doit être appliqué avant sql/36';
    END IF;
END $$;

-- 1) Colonnes de coût (NULL pour l'historique existant)
ALTER TABLE public.stock_movements ADD COLUMN IF NOT EXISTS unit_cost  NUMERIC(14,4);
ALTER TABLE public.stock_movements ADD COLUMN IF NOT EXISTS cmup_after NUMERIC(14,4);
ALTER TABLE public.stock_movements ADD COLUMN IF NOT EXISTS cost_known BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.stock_movements ADD COLUMN IF NOT EXISTS return_of  TEXT;
ALTER TABLE public.stock_movements ADD COLUMN IF NOT EXISTS seq        BIGINT GENERATED ALWAYS AS IDENTITY;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_movements_unit_cost_check') THEN
        ALTER TABLE public.stock_movements ADD CONSTRAINT stock_movements_unit_cost_check CHECK (unit_cost IS NULL OR (unit_cost >= 0 AND unit_cost <= 1000000000));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_movements_return_of_check') THEN
        ALTER TABLE public.stock_movements ADD CONSTRAINT stock_movements_return_of_check CHECK (return_of IS NULL OR (char_length(return_of) BETWEEN 1 AND 200 AND move_type = 'in'));
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS stock_movements_return_idx ON public.stock_movements (user_id, return_of) WHERE return_of IS NOT NULL;
CREATE INDEX IF NOT EXISTS stock_movements_seq_idx ON public.stock_movements (user_id, product_id, seq);

-- 2) État courant par produit (quantité, CMUP), verrouillé pendant chaque calcul
CREATE TABLE IF NOT EXISTS public.stock_cost_state (
    user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL CHECK (char_length(product_id) BETWEEN 1 AND 100),
    qty        NUMERIC(16,3) NOT NULL DEFAULT 0,
    cmup       NUMERIC(14,4),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, product_id)
);
ALTER TABLE public.stock_cost_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stock_cost_state FROM PUBLIC, anon, authenticated;

-- Reprise des quantités existantes (le CMUP reste inconnu). Réexécutable : qty est toujours Σ entrées − Σ sorties.
INSERT INTO public.stock_cost_state (user_id, product_id, qty, cmup)
SELECT m.user_id, m.product_id, sum(CASE WHEN m.move_type = 'in' THEN m.qty ELSE -m.qty END), NULL
  FROM public.stock_movements m GROUP BY m.user_id, m.product_id
ON CONFLICT (user_id, product_id) DO UPDATE SET qty = EXCLUDED.qty;

-- 3) stock_record : mêmes entrées que sql/35 + champs facultatifs « unit_cost » (entrée, ou sortie d'annulation d'achat)
--    et « return_of » (entrée de retour). Retour inchangé : { inserted, skipped }.
CREATE OR REPLACE FUNCTION public.stock_record(p_moves JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    v UUID := public.stock_uid();
    e JSONB; n_in INT := 0; n_skip INT := 0; v_qty NUMERIC; v_date DATE; v_type TEXT; v_src TEXT; v_total BIGINT;
    v_pid TEXT; v_key TEXT; v_ret TEXT; v_cost NUMERIC; v_given NUMERIC; v_known BOOLEAN;
    st_qty NUMERIC; st_cmup NUMERIC; n_qty NUMERIC; n_cmup NUMERIC; o RECORD; v_done NUMERIC;
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
        v_pid := btrim(COALESCE(e->>'product_id', ''));
        IF v_pid = '' OR char_length(v_pid) > 100 THEN RAISE EXCEPTION 'PRODUIT_INVALIDE'; END IF;
        v_key := left(NULLIF(btrim(e->>'key'), ''), 200);
        v_ret := left(NULLIF(btrim(e->>'return_of'), ''), 200);
        IF v_ret IS NOT NULL AND v_type <> 'in' THEN RAISE EXCEPTION 'RETOUR_INVALIDE'; END IF;
        v_given := NULL;
        IF e ? 'unit_cost' AND jsonb_typeof(e->'unit_cost') <> 'null' THEN
            BEGIN v_given := round((e->>'unit_cost')::numeric, 4); EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'COUT_INVALIDE'; END;
            IF v_given IS NULL OR v_given < 0 OR v_given > 1000000000 THEN RAISE EXCEPTION 'COUT_INVALIDE'; END IF;
        END IF;

        -- Verrou de l'état du produit, PUIS contrôle d'idempotence (sérialise les écritures concurrentes du même produit)
        INSERT INTO public.stock_cost_state (user_id, product_id, qty, cmup) VALUES (v, v_pid, 0, NULL) ON CONFLICT (user_id, product_id) DO NOTHING;
        SELECT s.qty, s.cmup INTO st_qty, st_cmup FROM public.stock_cost_state s WHERE s.user_id = v AND s.product_id = v_pid FOR UPDATE;
        IF v_key IS NOT NULL AND EXISTS (SELECT 1 FROM public.stock_movements m WHERE m.user_id = v AND m.idem_key = v_key) THEN
            n_skip := n_skip + 1; CONTINUE;
        END IF;

        n_qty := st_qty; n_cmup := st_cmup; v_cost := NULL; v_known := false;
        IF v_type = 'in' THEN
            IF v_ret IS NOT NULL THEN
                SELECT m.qty, m.unit_cost, m.cost_known, m.product_id INTO o FROM public.stock_movements m
                 WHERE m.user_id = v AND m.idem_key = v_ret AND m.move_type = 'out';
                IF FOUND THEN
                    IF o.product_id <> v_pid THEN RAISE EXCEPTION 'RETOUR_PRODUIT_DIFFERENT'; END IF;
                    SELECT COALESCE(sum(m.qty), 0) INTO v_done FROM public.stock_movements m WHERE m.user_id = v AND m.return_of = v_ret;
                    IF v_done + v_qty > o.qty + 0.0005 THEN RAISE EXCEPTION 'RETOUR_SUPERIEUR_A_LA_SORTIE'; END IF;
                    v_cost := o.unit_cost; v_known := COALESCE(o.cost_known, false) AND o.unit_cost IS NOT NULL;
                END IF;
                IF v_cost IS NULL THEN v_cost := COALESCE(v_given, st_cmup); v_known := v_given IS NOT NULL; END IF;
            ELSIF v_given IS NOT NULL THEN
                v_cost := v_given; v_known := true;
            ELSE
                v_cost := st_cmup; v_known := false;      -- entrée sans prix : valorisée au CMUP courant, signalée
            END IF;
            n_qty := st_qty + v_qty;
            IF v_cost IS NOT NULL THEN
                IF st_qty <= 0 OR st_cmup IS NULL THEN n_cmup := v_cost;
                ELSE n_cmup := round((st_qty * st_cmup + v_qty * v_cost) / n_qty, 4); END IF;
            END IF;
        ELSE
            n_qty := st_qty - v_qty;
            IF v_src = 'purchase' AND v_given IS NOT NULL THEN
                -- annulation d'un achat : on retire la valeur de l'achat, le CMUP des unités restantes est recalculé
                v_cost := v_given; v_known := true;
                IF n_qty > 0 AND st_cmup IS NOT NULL THEN n_cmup := GREATEST(round((st_qty * st_cmup - v_qty * v_given) / n_qty, 4), 0); END IF;
            ELSE
                v_cost := st_cmup; v_known := st_cmup IS NOT NULL;
            END IF;
        END IF;

        INSERT INTO public.stock_movements (user_id, product_id, product_name, unit, move_type, qty, move_date, source, ref, ref_id, note, idem_key,
                                            unit_cost, cmup_after, cost_known, return_of)
        VALUES (v, v_pid, left(COALESCE(NULLIF(btrim(e->>'product_name'), ''), '—'), 200), left(COALESCE(NULLIF(btrim(e->>'unit'), ''), 'unité'), 30),
                v_type, v_qty, v_date, v_src, left(e->>'ref', 100), left(e->>'ref_id', 100), left(e->>'note', 200), v_key,
                v_cost, n_cmup, v_known, v_ret);
        UPDATE public.stock_cost_state SET qty = n_qty, cmup = n_cmup, updated_at = now() WHERE user_id = v AND product_id = v_pid;
        n_in := n_in + 1;
    END LOOP;
    RETURN jsonb_build_object('inserted', n_in, 'skipped', n_skip);
END; $$;
REVOKE ALL ON FUNCTION public.stock_record(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stock_record(JSONB) TO authenticated;

-- 4) Valeur du stock par produit. p_date NULL = maintenant (état courant). Une date passée : quantité = mouvements datés
--    jusqu'à cette date ; CMUP = celui du dernier mouvement ENREGISTRÉ parmi eux (ordre d'enregistrement, cf. principe).
--    unknown_moves = nombre de mouvements de ce produit dont le coût est inconnu ou estimé (jusqu'à la date).
CREATE OR REPLACE FUNCTION public.stock_valuation(p_date DATE DEFAULT NULL)
RETURNS TABLE (product_id TEXT, product_name TEXT, unit TEXT, qty NUMERIC, cmup NUMERIC, value NUMERIC, unknown_moves INT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.stock_uid();
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    RETURN QUERY
    WITH m AS (
        SELECT * FROM public.stock_movements x WHERE x.user_id = v AND (p_date IS NULL OR x.move_date <= p_date)
    ), g AS (
        SELECT m.product_id AS pid,
               (array_agg(m.product_name ORDER BY m.seq DESC))[1] AS pname,
               (array_agg(m.unit ORDER BY m.seq DESC))[1] AS punit,
               sum(CASE WHEN m.move_type = 'in' THEN m.qty ELSE -m.qty END) AS q,
               (array_agg(m.cmup_after ORDER BY m.seq DESC) FILTER (WHERE m.cmup_after IS NOT NULL))[1] AS c,
               count(*) FILTER (WHERE NOT m.cost_known)::int AS unk
          FROM m GROUP BY m.product_id)
    SELECT g.pid, g.pname, g.punit, g.q::numeric(16,3),
           CASE WHEN p_date IS NULL THEN COALESCE(s.cmup, g.c) ELSE g.c END::numeric(14,4),
           CASE WHEN g.q > 0 THEN round(g.q * COALESCE(CASE WHEN p_date IS NULL THEN COALESCE(s.cmup, g.c) ELSE g.c END, 0), 2) ELSE 0 END::numeric(16,2),
           g.unk
      FROM g LEFT JOIN public.stock_cost_state s ON s.user_id = v AND s.product_id = g.pid
     ORDER BY g.pname;
END; $$;
REVOKE ALL ON FUNCTION public.stock_valuation(DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stock_valuation(DATE) TO authenticated;

-- 5) stock_list : mêmes colonnes que sql/34 + coût unitaire, CMUP après, coût connu, clé, sortie d'origine d'un retour.
--    Le type de retour change : l'ancienne version (sql/34) est RENOMMÉE stock_list_pre36 (aucune suppression, droits retirés), puis recréée.
DO $$ BEGIN
    IF to_regprocedure('public.stock_list(date,date,integer,integer)') IS NOT NULL
       AND position('return_of' in pg_get_function_result('public.stock_list(date,date,integer,integer)'::regprocedure)) = 0 THEN
        IF to_regprocedure('public.stock_list_pre36(date,date,integer,integer)') IS NULL THEN
            ALTER FUNCTION public.stock_list(DATE, DATE, INT, INT) RENAME TO stock_list_pre36;
        ELSE
            ALTER FUNCTION public.stock_list(DATE, DATE, INT, INT) RENAME TO stock_list_pre36b;
        END IF;
    END IF;
    IF to_regprocedure('public.stock_list_pre36(date,date,integer,integer)') IS NOT NULL THEN
        EXECUTE 'REVOKE ALL ON FUNCTION public.stock_list_pre36(DATE, DATE, INT, INT) FROM PUBLIC, anon, authenticated';
    END IF;
END $$;
CREATE OR REPLACE FUNCTION public.stock_list(p_from DATE, p_to DATE, p_limit INT DEFAULT 200, p_offset INT DEFAULT 0)
RETURNS TABLE (id UUID, product_id TEXT, product_name TEXT, unit TEXT, move_type TEXT, qty NUMERIC, move_date DATE, source TEXT, ref TEXT, note TEXT,
               created_at TIMESTAMPTZ, unit_cost NUMERIC, cmup_after NUMERIC, cost_known BOOLEAN, idem_key TEXT, return_of TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.stock_uid();
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    RETURN QUERY
    SELECT m.id, m.product_id, m.product_name, m.unit, m.move_type, m.qty, m.move_date, m.source, m.ref, m.note, m.created_at,
           m.unit_cost, m.cmup_after, m.cost_known, m.idem_key, m.return_of
      FROM public.stock_movements m
     WHERE m.user_id = v AND (p_from IS NULL OR m.move_date >= p_from) AND (p_to IS NULL OR m.move_date <= p_to)
     ORDER BY m.move_date DESC, m.seq DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 5000) OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END; $$;
REVOKE ALL ON FUNCTION public.stock_list(DATE, DATE, INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stock_list(DATE, DATE, INT, INT) TO authenticated;
