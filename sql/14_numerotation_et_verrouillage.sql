-- ============================================================
-- 14 — Numérotation attribuée par le serveur + verrouillage des factures émises
--      + journal serveur infalsifiable
--
-- À exécuter dans Supabase > SQL Editor (nouvelle requête), APRÈS sauvegarde et
-- AVANT de mettre en ligne la version de l'application qui en dépend.
-- Aucune donnée existante n'est supprimée ni modifiée.
--
-- 1) next_doc_number(type, plancher) : numéro séquentiel unique par compte et par
--    type (invoice / quote / credit). Le plancher (compteur déjà utilisé dans le
--    navigateur) n'est lu QU'À LA PREMIÈRE ATTRIBUTION d'un compte : ensuite seul
--    le serveur décide, ce qui empêche de gonfler ou de rejouer un compteur.
-- 2) Déclencheur sur user_data (clé 'invoices'), à l'insertion, à la mise à jour
--    et à la suppression :
--      - une facture émise (statut autre que « draft ») ne peut être ni supprimée
--        ni modifiée (numéro, date, client, lignes, montants figés) ;
--      - toute facture nouvellement émise doit porter un numéro déjà attribué par
--        le serveur et unique ; sinon l'écriture est refusée ;
--      - la ligne 'invoices' ne peut pas être supprimée tant qu'elle contient une
--        facture émise (sauf suppression du compte lui-même).
-- 3) doc_events : journal serveur en ajout seul (aucun droit d'écriture pour les
--    utilisateurs) alimenté automatiquement par le déclencheur.
--
-- Retour arrière (si besoin) :
--   DROP TRIGGER IF EXISTS trg_guard_issued_invoices_ins ON public.user_data;
--   DROP TRIGGER IF EXISTS trg_guard_issued_invoices ON public.user_data;
--   DROP TRIGGER IF EXISTS trg_guard_issued_invoices_del ON public.user_data;
--   DROP FUNCTION IF EXISTS public.guard_issued_invoices();
--   DROP FUNCTION IF EXISTS public.guard_issued_invoices_del();
--   DROP FUNCTION IF EXISTS public.next_doc_number(text, int);
--   DROP TABLE IF EXISTS public.doc_events;
--   DROP TABLE IF EXISTS public.doc_counters;
-- ============================================================

CREATE TABLE IF NOT EXISTS public.doc_counters (
    user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    doc_type   TEXT NOT NULL CHECK (doc_type IN ('invoice', 'quote', 'credit')),
    last_value INT  NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, doc_type)
);

ALTER TABLE public.doc_counters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS doc_counters_select_own ON public.doc_counters;
CREATE POLICY doc_counters_select_own ON public.doc_counters
    FOR SELECT USING (auth.uid() = user_id);
-- Aucune politique d'écriture : seul next_doc_number() (SECURITY DEFINER) incrémente.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.doc_counters FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.next_doc_number(p_type TEXT, p_floor INT DEFAULT 0)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_val INT;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'NON_AUTHENTIFIE';
    END IF;
    IF p_type NOT IN ('invoice', 'quote', 'credit') THEN
        RAISE EXCEPTION 'TYPE_INVALIDE';
    END IF;
    IF NOT public.has_active_license(v_uid) THEN
        RAISE EXCEPTION 'LICENCE_INACTIVE';
    END IF;
    -- Première attribution : on part du compteur local (migration). Ensuite : +1 serveur.
    -- L'instruction est atomique : deux appels simultanés reçoivent deux numéros distincts.
    INSERT INTO public.doc_counters AS c (user_id, doc_type, last_value)
    VALUES (v_uid, p_type, LEAST(GREATEST(COALESCE(p_floor, 0), 0), 1000000) + 1)
    ON CONFLICT (user_id, doc_type)
    DO UPDATE SET last_value = c.last_value + 1
    RETURNING last_value INTO v_val;
    RETURN v_val;
END;
$$;

REVOKE ALL ON FUNCTION public.next_doc_number(TEXT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.next_doc_number(TEXT, INT) TO authenticated;

-- ------------------------------------------------------------
-- Journal serveur en ajout seul
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.doc_events (
    id      BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    action  TEXT NOT NULL,
    doc_id  TEXT,
    number  TEXT,
    detail  TEXT
);
ALTER TABLE public.doc_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS doc_events_select_own ON public.doc_events;
CREATE POLICY doc_events_select_own ON public.doc_events
    FOR SELECT USING (auth.uid() = user_id);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.doc_events FROM anon, authenticated;
CREATE INDEX IF NOT EXISTS doc_events_user_ts ON public.doc_events (user_id, ts DESC);

-- ------------------------------------------------------------
-- Verrouillage des factures émises (clé 'invoices' de user_data)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_issued_invoices()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    o        JSONB;
    n        JSONB;
    f        TEXT;
    old_arr  JSONB := CASE WHEN TG_OP = 'UPDATE' AND OLD.key = 'invoices' AND jsonb_typeof(OLD.value) = 'array' THEN OLD.value ELSE '[]'::jsonb END;
    seq      INT;
    ctype    TEXT;
    last_v   INT;
    was      JSONB;
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.key = 'invoices' AND NEW.key <> 'invoices'
       AND jsonb_typeof(OLD.value) = 'array'
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(OLD.value) e WHERE COALESCE(e->>'status', 'draft') <> 'draft') THEN
        RAISE EXCEPTION 'FACTURE_VERROUILLEE: déplacement interdit (factures émises)';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.user_id <> OLD.user_id THEN
        RAISE EXCEPTION 'FACTURE_VERROUILLEE: changement de propriétaire interdit';
    END IF;
    IF NEW.key <> 'invoices' THEN
        RETURN NEW;
    END IF;
    IF jsonb_typeof(NEW.value) <> 'array' THEN
        RAISE EXCEPTION 'FACTURE_VERROUILLEE: format invalide';
    END IF;

    -- 1) Les factures déjà émises restent intactes
    FOR o IN SELECT e FROM jsonb_array_elements(old_arr) AS e LOOP
        IF COALESCE(o->>'status', 'draft') = 'draft' THEN
            CONTINUE;
        END IF;
        SELECT e INTO n FROM jsonb_array_elements(NEW.value) AS e
        WHERE e->>'id' = o->>'id' LIMIT 1;
        IF n IS NULL THEN
            RAISE EXCEPTION 'FACTURE_VERROUILLEE: suppression interdite (%)', o->>'number';
        END IF;
        IF COALESCE(n->>'status', 'draft') = 'draft' THEN
            RAISE EXCEPTION 'FACTURE_VERROUILLEE: retour au brouillon interdit (%)', o->>'number';
        END IF;
        FOREACH f IN ARRAY ARRAY['number', 'type', 'date', 'clientId', 'clientName', 'clientICE',
                                 'items', 'totalHT', 'totalTVA', 'totalTTC', 'relatedInvoiceId']
        LOOP
            IF (o -> f) IS DISTINCT FROM (n -> f) THEN
                RAISE EXCEPTION 'FACTURE_VERROUILLEE: modification interdite (% / %)', o->>'number', f;
            END IF;
        END LOOP;
        IF (o->>'status') IS DISTINCT FROM (n->>'status') THEN
            INSERT INTO public.doc_events(user_id, action, doc_id, number, detail)
            VALUES (NEW.user_id, 'statut', o->>'id', o->>'number', (o->>'status') || ' -> ' || (n->>'status'));
        END IF;
    END LOOP;

    -- 2) Toute facture nouvellement émise porte un numéro attribué par le serveur, unique
    FOR n IN SELECT e FROM jsonb_array_elements(NEW.value) AS e LOOP
        IF COALESCE(n->>'status', 'draft') = 'draft' THEN
            CONTINUE;
        END IF;
        SELECT e INTO was FROM jsonb_array_elements(old_arr) AS e WHERE e->>'id' = n->>'id' LIMIT 1;
        IF was IS NOT NULL AND COALESCE(was->>'status', 'draft') <> 'draft' THEN
            CONTINUE;   -- déjà émise avant : contrôlée au point 1
        END IF;

        ctype := CASE WHEN n->>'type' = 'credit' THEN 'credit' ELSE 'invoice' END;
        IF (n->>'number') !~ '-[0-9]+$' THEN
            RAISE EXCEPTION 'NUMERO_NON_ATTRIBUE: numéro invalide (%)', n->>'number';
        END IF;
        seq := ((regexp_match(n->>'number', '-([0-9]+)$'))[1])::INT;
        SELECT last_value INTO last_v FROM public.doc_counters
        WHERE user_id = NEW.user_id AND doc_type = ctype;
        IF last_v IS NULL OR seq > last_v THEN
            RAISE EXCEPTION 'NUMERO_NON_ATTRIBUE: numéro % non attribué par le serveur', n->>'number';
        END IF;
        IF (SELECT count(*) FROM jsonb_array_elements(NEW.value) AS e
            WHERE e->>'number' = n->>'number') > 1 THEN
            RAISE EXCEPTION 'NUMERO_EN_DOUBLE: %', n->>'number';
        END IF;
        INSERT INTO public.doc_events(user_id, action, doc_id, number, detail)
        VALUES (NEW.user_id, CASE WHEN ctype = 'credit' THEN 'avoir' ELSE 'emission' END,
                n->>'id', n->>'number', 'total TTC ' || COALESCE(n->>'totalTTC', '?'));
    END LOOP;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_issued_invoices_del()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
    IF OLD.key = 'invoices' AND jsonb_typeof(OLD.value) = 'array'
       AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = OLD.user_id)      -- pas une suppression de compte
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(OLD.value) e
                   WHERE COALESCE(e->>'status', 'draft') <> 'draft') THEN
        RAISE EXCEPTION 'FACTURE_VERROUILLEE: suppression interdite (factures émises)';
    END IF;
    RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_issued_invoices() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_issued_invoices_del() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_issued_invoices_ins ON public.user_data;
CREATE TRIGGER trg_guard_issued_invoices_ins
    BEFORE INSERT ON public.user_data
    FOR EACH ROW
    WHEN (NEW.key = 'invoices')
    EXECUTE FUNCTION public.guard_issued_invoices();

DROP TRIGGER IF EXISTS trg_guard_issued_invoices ON public.user_data;
CREATE TRIGGER trg_guard_issued_invoices
    BEFORE UPDATE ON public.user_data
    FOR EACH ROW
    WHEN (OLD.key = 'invoices' OR NEW.key = 'invoices')
    EXECUTE FUNCTION public.guard_issued_invoices();

DROP TRIGGER IF EXISTS trg_guard_issued_invoices_del ON public.user_data;
CREATE TRIGGER trg_guard_issued_invoices_del
    BEFORE DELETE ON public.user_data
    FOR EACH ROW
    WHEN (OLD.key = 'invoices')
    EXECUTE FUNCTION public.guard_issued_invoices_del();

-- ------------------------------------------------------------
-- Durcissement : les fonctions de déclencheur des scripts 10 et 13 n'ont pas à être
-- exécutables par les utilisateurs (appel direct impossible de toute façon, mais
-- inutile de les exposer). Les déclencheurs continuent de fonctionner.
-- ------------------------------------------------------------
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT p.oid::regprocedure AS sig
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.prorettype = 'trigger'::regtype
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    END LOOP;
END $$;
