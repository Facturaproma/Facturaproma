-- ============================================================================================================
-- 26 — Plafond des paiements pour les comptes « legacy » (user_data, clé 'payments')   *** APPLIQUÉ EN PRODUCTION le 24/10/2026 ***
-- ============================================================================================================
-- Validé en préproduction (essais 30/30, retour arrière réel validé) puis appliqué en production le 24/10/2026 (éditeur SQL Supabase, par le propriétaire).
-- Sur la production, sql/15-17 sont ABSENTS : seul ce script s'y applique (sql/25 exige sql/15). Contrôle post-application : déclencheur actif, droits anon/authenticated retirés, 5 lignes de paiement intactes.
-- Pourquoi : sql/25 ne protège que les comptes en mode « documents » (record_payment). Les autres comptes écrivent le tableau
-- complet des paiements dans user_data (clé 'payments') : sans ce déclencheur, seul le navigateur empêche le trop-perçu.
-- Règle : à l'écriture de la clé 'payments', pour chaque facture dont le CUMUL de paiements AUGMENTE par rapport à la dernière valeur
-- validée (nouveau paiement, montant relevé, paiement rattaché à une autre facture), le cumul ne doit pas dépasser son TTC + 0,01 ;
-- une facture de TTC <= 0 refuse toute augmentation. Une baisse ou une suppression est toujours acceptée ; un ancien trop-perçu ne
-- bloque rien rétroactivement. L'ancienne valeur est lue FOR UPDATE (sérialisation des écritures concurrentes de la même ligne).
-- Limites assumées : si la facture n'est pas (encore) dans user_data, le paiement est accepté (rien à comparer) ; le cumul compte
-- les lignes de paiement, pas le champ paidAmount ; en cas de refus (SQLSTATE P0001, PAIEMENT_SUPERIEUR_AU_RESTE) l'application
-- doit afficher l'erreur : comportement de la file de réessai à valider en préproduction AVANT toute production.
-- FUSION (ajout 24/10/2026, cause racine du cas « paiement refusé alors que la facture est mise à jour » et des paiements perdus) :
-- l'application ne fait QU'AJOUTER des paiements (aucune modification ni suppression dans l'interface) mais écrit le tableau COMPLET :
-- un appareil qui ne connaît pas un paiement saisi ailleurs l'effaçait (dernier écrivain gagne). Le déclencheur fusionne donc par
-- identifiant : les paiements déjà enregistrés sont conservés tels quels (immuables), seuls les NOUVEAUX identifiants sont ajoutés, puis le
-- plafond est contrôlé sur le tableau fusionné. Conséquence assumée : un paiement ne peut plus être supprimé ni modifié par l'API legacy.
-- Réexécutable (CREATE OR REPLACE / DROP TRIGGER IF EXISTS). Aucune donnée n'est modifiée.
--
-- RETOUR ARRIÈRE : DROP TRIGGER IF EXISTS trg_10_payments_cap ON public.user_data;
--                  DROP FUNCTION IF EXISTS public.guard_payments_cap_legacy(); DROP FUNCTION IF EXISTS public.fp_num_p26(text);
-- ============================================================================================================

DO $$
BEGIN
    IF to_regclass('public.user_data') IS NULL THEN
        RAISE EXCEPTION 'PREREQUIS_MANQUANT: la table user_data doit exister avant sql/26';
    END IF;
END $$;

-- Utilitaire PRIVÉ à sql/26 (la production n'a pas sql/15 et donc pas public.fp_num) : conversion tolérante texte -> numérique.
-- Nom distinct de fp_num pour ne jamais entrer en conflit avec sql/15 ; retiré avec le reste en cas de retour arrière.
CREATE OR REPLACE FUNCTION public.fp_num_p26(t text) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
BEGIN RETURN t::numeric; EXCEPTION WHEN others THEN RETURN NULL; END $$;
REVOKE ALL ON FUNCTION public.fp_num_p26(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.guard_payments_cap_legacy() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    old_val JSONB;
    merged  JSONB;
    inv_val JSONB;
    iid     TEXT;
    inv     JSONB;
    total   NUMERIC;
    c_new   NUMERIC;
    c_old   NUMERIC;
BEGIN
    IF NEW.key <> 'payments' OR jsonb_typeof(NEW.value) <> 'array' THEN RETURN NEW; END IF;
    -- L'application écrit par « upsert » (INSERT … ON CONFLICT) : le déclencheur INSERT s'exécute aussi pour une mise à jour et OLD n'existe
    -- pas. L'ancienne valeur est donc relue dans la table, VERROUILLÉE (FOR UPDATE) : deux écritures concurrentes de la même ligne sont
    -- sérialisées et la seconde est comparée à la valeur réellement validée par la première (lecture du dernier état validé).
    -- Verrou par compte : couvre aussi le cas où la ligne n'existe pas encore (deux premiers paiements simultanés), que FOR UPDATE ne verrouille pas.
    PERFORM pg_advisory_xact_lock(hashtextextended('fp_legacy_payments:' || NEW.user_id::text, 0));
    SELECT u.value INTO old_val FROM public.user_data u WHERE u.user_id = NEW.user_id AND u.key = 'payments' FOR UPDATE;
    -- Fusion par identifiant : l'ancien tableau fait foi pour les paiements qu'il contient (immuables) ; on y ajoute les paiements nouveaux.
    IF old_val IS NOT NULL AND jsonb_typeof(old_val) = 'array' THEN
        SELECT old_val || COALESCE(jsonb_agg(e), '[]'::jsonb) INTO merged
          FROM jsonb_array_elements(NEW.value) e
         WHERE CASE WHEN jsonb_typeof(e) = 'object' AND (e->>'id') IS NOT NULL
                    THEN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(old_val) o WHERE jsonb_typeof(o) = 'object' AND o->>'id' = e->>'id')
                    ELSE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(old_val) o WHERE o = e) END;
        NEW.value := merged;
    END IF;
    -- Factures du même compte, verrouillées en lecture (FOR SHARE) : le total ne change pas pendant la vérification.
    SELECT u.value INTO inv_val FROM public.user_data u WHERE u.user_id = NEW.user_id AND u.key = 'invoices' FOR SHARE;
    IF inv_val IS NULL OR jsonb_typeof(inv_val) <> 'array' THEN RETURN NEW; END IF;      -- aucune facture connue du serveur : rien à comparer
    FOR iid IN SELECT DISTINCT e->>'invoiceId' FROM jsonb_array_elements(NEW.value) e WHERE jsonb_typeof(e) = 'object' AND (e->>'invoiceId') IS NOT NULL
    LOOP
        SELECT COALESCE(sum(COALESCE(public.fp_num_p26(e->>'amount'), 0)), 0) INTO c_new
          FROM jsonb_array_elements(NEW.value) e WHERE jsonb_typeof(e) = 'object' AND e->>'invoiceId' = iid;
        c_old := 0;
        IF old_val IS NOT NULL AND jsonb_typeof(old_val) = 'array' THEN
            SELECT COALESCE(sum(COALESCE(public.fp_num_p26(e->>'amount'), 0)), 0) INTO c_old
              FROM jsonb_array_elements(old_val) e WHERE jsonb_typeof(e) = 'object' AND e->>'invoiceId' = iid;
        END IF;
        -- Seule une AUGMENTATION du cumul (par rapport à la valeur déjà enregistrée) est contrôlée ; un ancien trop-perçu ne bloque rien rétroactivement.
        IF c_new <= c_old + 0.0001 THEN CONTINUE; END IF;
        SELECT elem INTO inv FROM jsonb_array_elements(inv_val) elem WHERE jsonb_typeof(elem) = 'object' AND elem->>'id' = iid LIMIT 1;
        IF inv IS NULL THEN CONTINUE; END IF;                                   -- facture inconnue du serveur
        total := COALESCE(public.fp_num_p26(inv->>'totalTTC'), 0);
        IF total <= 0 THEN RAISE EXCEPTION 'PAIEMENT_FACTURE_NULLE: cette facture n''a pas de montant à payer'; END IF;
        IF c_new > total + 0.01 THEN
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
