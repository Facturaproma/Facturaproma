-- ============================================================
-- 19 — Journal serveur sans doublons lors des sauvegardes par « upsert »
--
-- Constat (production, 22/10/2026) : l'application enregistre ses données par INSERT ... ON CONFLICT DO UPDATE.
-- PostgreSQL exécute alors d'abord le déclencheur BEFORE INSERT, où l'ancien contenu est inconnu (old_arr = []) :
-- chaque facture déjà émise était donc reprise comme « nouvellement émise » et journalisée de nouveau dans
-- doc_events à chaque sauvegarde (ex. FAC-2026-002 enregistrée 5 fois).
--
-- Correctif minimal : dans le chemin INSERT, si la ligne 'invoices' du compte existe déjà, on ne journalise pas
-- (le déclencheur UPDATE qui suit voit l'ancien contenu et journalise une seule fois, y compris les changements de statut).
-- Inchangés : tous les contrôles (numéro attribué par le serveur, unicité, champs figés, suppression interdite),
-- la numérotation, les montants, les statuts, les droits.
--
-- Ne modifie AUCUNE donnée : les doublons déjà présents dans doc_events restent (journal en ajout seul).
-- Idempotent (CREATE OR REPLACE). Dépend de 14.
-- Retour arrière : réexécuter la définition de guard_issued_invoices() du script 14.
-- ============================================================

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
    -- Sauvegarde par upsert (INSERT ... ON CONFLICT DO UPDATE) : PostgreSQL exécute d'abord le déclencheur d'INSERT, qui ne connaît pas l'ancien contenu.
    -- Si la ligne existe déjà, le déclencheur UPDATE qui suit voit l'ancien contenu et journalise ; on ne journalise donc pas ici une 2e fois.
    skip_log BOOLEAN := (TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM public.user_data x WHERE x.user_id = NEW.user_id AND x.key = 'invoices'));
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
        IF (o->>'status') IS DISTINCT FROM (n->>'status') AND NOT skip_log THEN
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
        IF NOT skip_log THEN
            INSERT INTO public.doc_events(user_id, action, doc_id, number, detail)
            VALUES (NEW.user_id, CASE WHEN ctype = 'credit' THEN 'avoir' ELSE 'emission' END,
                    n->>'id', n->>'number', 'total TTC ' || COALESCE(n->>'totalTTC', '?'));
        END IF;
    END LOOP;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_issued_invoices() FROM PUBLIC, anon, authenticated;
