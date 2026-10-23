-- ============================================================
-- 21 — Traçabilité et verrouillage des codes de licence générés par l'administration
--
-- Constat : un code créé depuis « Nouvelles demandes » (ou depuis n'importe quel écran admin) était inséré directement
-- dans admin_codes SANS auteur ni entrée de journal : impossible de savoir quel administrateur l'avait généré, et un
-- administrateur pouvait en modifier le type, le client ou le code sans trace.
--
-- Correctif (côté base, donc non contournable depuis le navigateur) :
--   * colonne admin_codes.created_by : login de l'auteur, renseigné par la base (une valeur fournie par le client est écrasée) ;
--   * chaque création, révocation et suppression d'un code est journalisée dans admin_audit (login de l'auteur, client,
--     formule, origine « demande » ou « manuel », 4 derniers caractères du code : le code complet n'est JAMAIS recopié dans le journal) ;
--   * verrouillage : code, formule, e-mail du client, auteur et date de création ne peuvent plus être modifiés après création.
--     Restent modifiables : status et activated_at (activation par le client, révocation, paiement saisi).
--
-- Compatibilité : AJOUT seul (1 colonne nullable + 1 fonction + 3 déclencheurs). Aucune donnée existante modifiée :
-- les codes déjà créés gardent created_by = NULL (auteur inconnu, affiché « inconnu »). Idempotent. Dépend de 05, 06, 08.
-- Retour arrière : DROP TRIGGER trg_admin_codes_* ON public.admin_codes ; DROP FUNCTION public.admin_codes_trace() ;
-- (la colonne created_by peut rester).
-- ============================================================

ALTER TABLE public.admin_codes ADD COLUMN IF NOT EXISTS created_by TEXT;

CREATE OR REPLACE FUNCTION public.admin_codes_trace()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_email TEXT;
BEGIN
    SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();

    IF TG_OP = 'INSERT' THEN
        -- Auteur imposé par la base ; hors session utilisateur (éditeur SQL) : marqué « sql »
        NEW.created_by := COALESCE(lower(v_email), 'sql');
        RETURN NEW;

    ELSIF TG_OP = 'UPDATE' THEN
        IF NEW.code IS DISTINCT FROM OLD.code
           OR NEW.type IS DISTINCT FROM OLD.type
           OR NEW.client_email IS DISTINCT FROM OLD.client_email
           OR NEW.created_by IS DISTINCT FROM OLD.created_by
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION 'code verrouillé : seuls le statut et la date d''activation peuvent changer' USING ERRCODE = '42501';
        END IF;
        RETURN NEW;

    ELSE -- DELETE
        RETURN OLD;
    END IF;
END;
$$;

-- Journal (après coup) : un déclencheur distinct, pour voir la ligne définitive
CREATE OR REPLACE FUNCTION public.admin_codes_log()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_email TEXT;
    r public.admin_codes%ROWTYPE;
BEGIN
    SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();
    IF TG_OP = 'INSERT' THEN
        r := NEW;
        INSERT INTO public.admin_audit (admin_email, action, target_email, details)
        VALUES (COALESCE(v_email, 'sql'), 'code_generated', r.client_email,
                jsonb_build_object('type', r.type, 'code_end', right(r.code, 4),
                                   'source', CASE WHEN COALESCE(r.note, '') ILIKE 'Auto-généré depuis demande%' THEN 'demande' ELSE 'manuel' END));
    ELSIF TG_OP = 'UPDATE' THEN
        IF NEW.status = 'revoked' AND OLD.status IS DISTINCT FROM 'revoked' THEN
            INSERT INTO public.admin_audit (admin_email, action, target_email, details)
            VALUES (COALESCE(v_email, 'sql'), 'code_revoked', NEW.client_email,
                    jsonb_build_object('type', NEW.type, 'code_end', right(NEW.code, 4), 'was', OLD.status));
        END IF;
    ELSE
        INSERT INTO public.admin_audit (admin_email, action, target_email, details)
        VALUES (COALESCE(v_email, 'sql'), 'code_deleted', OLD.client_email,
                jsonb_build_object('type', OLD.type, 'code_end', right(OLD.code, 4), 'status', OLD.status));
    END IF;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_codes_trace() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_codes_log()   FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_admin_codes_trace ON public.admin_codes;
CREATE TRIGGER trg_admin_codes_trace BEFORE INSERT OR UPDATE ON public.admin_codes
    FOR EACH ROW EXECUTE FUNCTION public.admin_codes_trace();

DROP TRIGGER IF EXISTS trg_admin_codes_log ON public.admin_codes;
CREATE TRIGGER trg_admin_codes_log AFTER INSERT OR UPDATE OR DELETE ON public.admin_codes
    FOR EACH ROW EXECUTE FUNCTION public.admin_codes_log();

SELECT 'déclencheurs codes' AS check, string_agg(tgname, ', ') AS result
  FROM pg_trigger WHERE tgname IN ('trg_admin_codes_trace', 'trg_admin_codes_log');
