-- ============================================================
-- 14 — Numérotation attribuée par le serveur + verrouillage des factures émises
--
-- À exécuter dans Supabase > SQL Editor (nouvelle requête).
-- Sans danger pour les données existantes : rien n'est supprimé ni modifié.
--
-- 1) next_doc_number(type, plancher) : numéro séquentiel unique par utilisateur
--    et par type (invoice / quote / credit). Le plancher reprend le compteur déjà
--    utilisé par le navigateur, donc aucune rupture de numérotation.
-- 2) Un déclencheur refuse toute écriture qui supprimerait ou modifierait une
--    facture déjà émise (statut autre que « draft ») : numéro, date, client,
--    lignes et montants sont figés. Le statut, les paiements et la date de
--    règlement restent modifiables. Correction d'une erreur = avoir.
--
-- Retour arrière (si besoin) :
--   DROP TRIGGER IF EXISTS trg_guard_issued_invoices ON public.user_data;
--   DROP FUNCTION IF EXISTS public.guard_issued_invoices();
--   DROP FUNCTION IF EXISTS public.next_doc_number(text, int);
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
    INSERT INTO public.doc_counters AS c (user_id, doc_type, last_value)
    VALUES (v_uid, p_type, GREATEST(COALESCE(p_floor, 0), 0) + 1)
    ON CONFLICT (user_id, doc_type)
    DO UPDATE SET last_value = GREATEST(c.last_value, GREATEST(COALESCE(p_floor, 0), 0)) + 1
    RETURNING last_value INTO v_val;
    RETURN v_val;
END;
$$;

REVOKE ALL ON FUNCTION public.next_doc_number(TEXT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.next_doc_number(TEXT, INT) TO authenticated;

-- ------------------------------------------------------------
-- Verrouillage des factures émises (clé 'invoices' de user_data)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_issued_invoices()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    o JSONB;
    n JSONB;
    f TEXT;
BEGIN
    IF OLD.key <> 'invoices' OR jsonb_typeof(OLD.value) <> 'array' THEN
        RETURN NEW;
    END IF;
    IF jsonb_typeof(NEW.value) <> 'array' THEN
        RAISE EXCEPTION 'FACTURE_VERROUILLEE: format invalide';
    END IF;

    FOR o IN SELECT e FROM jsonb_array_elements(OLD.value) AS e LOOP
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
    END LOOP;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_issued_invoices ON public.user_data;
CREATE TRIGGER trg_guard_issued_invoices
    BEFORE UPDATE ON public.user_data
    FOR EACH ROW
    WHEN (OLD.key = 'invoices')
    EXECUTE FUNCTION public.guard_issued_invoices();
