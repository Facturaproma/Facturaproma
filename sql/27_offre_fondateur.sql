-- ============================================================================================================
-- 27 — Offre Fondateur : plafond de 30 codes appliqué PAR LA BASE + interrupteur « ouverte / fermée » (Master)   *** BROUILLON : NON APPLIQUÉ ***
-- ============================================================================================================
-- Ce script N'EST PAS dans sql/MANIFEST.json. À n'exécuter qu'après autorisation écrite explicite, d'abord en préproduction.
-- Pourquoi : la limite de 30 codes fondateurs n'était contrôlée que par le navigateur de l'administration (admin.html) : un second onglet,
-- une version ancienne de la page ou un appel direct à l'API la contournait. Ici la base refuse le 31e code, et le Master peut fermer l'offre.
-- Règles :
--  * Un code est « fondateur » si sa note commence par FONDATEUR (convention déjà utilisée par admin.html). Les codes RÉVOQUÉS ne comptent pas.
--  * INSERT d'un code fondateur : refusé si l'offre est fermée (admin_settings.founder_open = 'false') ou si 30 codes non révoqués existent déjà.
--  * UPDATE : une révocation passe toujours ; la remise en vigueur d'un code révoqué compte comme une émission (plafond contrôlé).
--  * Fermer / rouvrir l'offre (écriture de admin_settings.founder_open) : Master uniquement. Les autres réglages ne sont pas touchés.
--  * Les codes déjà émis restent valables, même offre fermée. Aucune donnée existante n'est modifiée.
-- Réexécutable. Dépend de 00, 05, 06.
-- RETOUR ARRIÈRE : DROP TRIGGER IF EXISTS trg_founder_codes ON public.admin_codes; DROP TRIGGER IF EXISTS trg_founder_setting ON public.admin_settings;
--                  DROP FUNCTION IF EXISTS public.guard_founder_codes(); DROP FUNCTION IF EXISTS public.guard_founder_setting();
-- ============================================================================================================

CREATE OR REPLACE FUNCTION public.guard_founder_codes() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n INT;
BEGIN
    IF NEW.note IS NULL OR NEW.note !~ '^FONDATEUR' THEN RETURN NEW; END IF;
    IF COALESCE(NEW.status, '') = 'revoked' THEN RETURN NEW; END IF;                 -- une révocation ne consomme pas de place
    IF TG_OP = 'UPDATE' AND COALESCE(OLD.status, '') <> 'revoked' AND OLD.note IS NOT DISTINCT FROM NEW.note THEN RETURN NEW; END IF;   -- modification d'un code déjà compté (statut, date d'activation…)
    PERFORM pg_advisory_xact_lock(hashtextextended('fp_founder_codes', 0));
    IF EXISTS (SELECT 1 FROM public.admin_settings s WHERE s.key = 'founder_open' AND lower(btrim(s.value)) IN ('false', '0', 'non', 'fermee', 'fermée')) THEN
        RAISE EXCEPTION 'OFFRE_FONDATEUR_FERMEE: l''offre Fondateur est fermée' USING ERRCODE = 'P0001';
    END IF;
    SELECT count(*) INTO n FROM public.admin_codes c
     WHERE c.note ~ '^FONDATEUR' AND COALESCE(c.status, '') <> 'revoked' AND (TG_OP = 'INSERT' OR c.id <> NEW.id);
    IF n >= 30 THEN
        RAISE EXCEPTION 'LIMITE_FONDATEUR_ATTEINTE: 30 codes fondateurs sont déjà émis' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_founder_codes() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_founder_codes ON public.admin_codes;
CREATE TRIGGER trg_founder_codes BEFORE INSERT OR UPDATE ON public.admin_codes
    FOR EACH ROW EXECUTE FUNCTION public.guard_founder_codes();

-- Seul le Master ferme ou rouvre l'offre
CREATE OR REPLACE FUNCTION public.guard_founder_setting() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
BEGIN
    IF NOT public.is_master() THEN
        RAISE EXCEPTION 'MASTER_REQUIS: seul le propriétaire peut ouvrir ou fermer l''offre Fondateur' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_founder_setting() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_founder_setting ON public.admin_settings;
CREATE TRIGGER trg_founder_setting BEFORE INSERT OR UPDATE ON public.admin_settings
    FOR EACH ROW WHEN (NEW.key = 'founder_open') EXECUTE FUNCTION public.guard_founder_setting();
