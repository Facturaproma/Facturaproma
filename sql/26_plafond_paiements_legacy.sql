-- ============================================================================================================
-- 26 — Plafond des paiements pour les comptes « legacy » (user_data, clé 'payments')   *** BROUILLON : NON APPLIQUÉ ***
-- ============================================================================================================
-- Ce script N'EST PAS dans sql/MANIFEST.json. À n'exécuter qu'après autorisation écrite explicite, en préproduction d'abord.
-- Pourquoi : sql/25 ne protège que les comptes en mode « documents » (record_payment). Les autres comptes écrivent le tableau
-- complet des paiements dans user_data (clé 'payments') : sans ce déclencheur, seul le navigateur empêche le trop-perçu.
-- Règle : à l'écriture de la clé 'payments', pour chaque facture touchée par un NOUVEAU paiement (identifiant absent de l'ancienne
-- valeur), le cumul des paiements de cette facture ne doit pas dépasser son TTC + 0,01 ; une facture de TTC <= 0 refuse tout
-- nouveau paiement. Les paiements déjà présents ne sont jamais réexaminés (un ancien trop-perçu ne bloque pas les autres écritures).
-- Limites assumées : si la facture n'est pas (encore) dans user_data, le paiement est accepté (rien à comparer) ; le cumul compte
-- les lignes de paiement, pas le champ paidAmount ; en cas de refus (SQLSTATE P0001, PAIEMENT_SUPERIEUR_AU_RESTE) l'application
-- doit afficher l'erreur : comportement de la file de réessai à valider en préproduction AVANT toute production.
-- Réexécutable (CREATE OR REPLACE / DROP TRIGGER IF EXISTS). Aucune donnée n'est modifiée.
--
-- RETOUR ARRIÈRE : DROP TRIGGER IF EXISTS trg_10_payments_cap ON public.user_data;
--                  DROP FUNCTION IF EXISTS public.guard_payments_cap_legacy();
-- ============================================================================================================

DO $$
BEGIN
    IF to_regclass('public.user_data') IS NULL OR to_regprocedure('public.fp_num(text)') IS NULL THEN
        RAISE EXCEPTION 'PREREQUIS_MANQUANT: sql/15 (fp_num) et la table user_data doivent exister avant sql/26';
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.guard_payments_cap_legacy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    old_ids TEXT[] := ARRAY[]::TEXT[];
    iid     TEXT;
    inv     JSONB;
    total   NUMERIC;
    cumul   NUMERIC;
BEGIN
    IF NEW.key <> 'payments' OR jsonb_typeof(NEW.value) <> 'array' THEN RETURN NEW; END IF;
    -- L'application écrit par « upsert » (INSERT … ON CONFLICT) : le déclencheur INSERT s'exécute donc aussi pour une mise à jour,
    -- et OLD n'existe pas. L'ancienne valeur est toujours relue dans la table.
    SELECT COALESCE(array_agg(e->>'id'), ARRAY[]::TEXT[]) INTO old_ids
      FROM public.user_data u, jsonb_array_elements(u.value) e
     WHERE u.user_id = NEW.user_id AND u.key = 'payments' AND jsonb_typeof(u.value) = 'array' AND jsonb_typeof(e) = 'object';
    FOR iid IN
        SELECT DISTINCT e->>'invoiceId' FROM jsonb_array_elements(NEW.value) e
        WHERE jsonb_typeof(e) = 'object' AND (e->>'invoiceId') IS NOT NULL AND (e->>'id') IS NOT NULL
          AND COALESCE(public.fp_num(e->>'amount'), 0) > 0 AND NOT ((e->>'id') = ANY (old_ids))
    LOOP
        SELECT elem INTO inv FROM public.user_data u, jsonb_array_elements(u.value) elem
         WHERE u.user_id = NEW.user_id AND u.key = 'invoices' AND jsonb_typeof(u.value) = 'array'
           AND jsonb_typeof(elem) = 'object' AND elem->>'id' = iid LIMIT 1;
        IF inv IS NULL THEN CONTINUE; END IF;                                     -- facture inconnue du serveur : rien à comparer
        total := COALESCE(public.fp_num(inv->>'totalTTC'), 0);
        IF total <= 0 THEN RAISE EXCEPTION 'PAIEMENT_FACTURE_NULLE: cette facture n''a pas de montant à payer'; END IF;
        SELECT COALESCE(sum(COALESCE(public.fp_num(e->>'amount'), 0)), 0) INTO cumul
          FROM jsonb_array_elements(NEW.value) e WHERE jsonb_typeof(e) = 'object' AND e->>'invoiceId' = iid;
        IF cumul > total + 0.01 THEN
            RAISE EXCEPTION 'PAIEMENT_SUPERIEUR_AU_RESTE: le cumul des paiements dépasse le total de la facture';
        END IF;
    END LOOP;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_payments_cap_legacy() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_10_payments_cap ON public.user_data;
CREATE TRIGGER trg_10_payments_cap BEFORE INSERT OR UPDATE ON public.user_data
    FOR EACH ROW WHEN (NEW.key = 'payments') EXECUTE FUNCTION public.guard_payments_cap_legacy();
