-- ============================================================
-- 22 — Pas de second code / de seconde demande pour un client déjà abonné (sauf formule plus généreuse)
--
-- Règle : un compte qui a un abonnement payant ACTIF (non expiré) ne peut recevoir ni demander une formule dont la durée
-- n'est pas STRICTEMENT supérieure à celle de son abonnement actuel (Mensuel < Semestriel < Annuel < À vie ; une formule
-- configurée compte pour sa durée). Appliqué par la base, donc valable pour le client ET pour l'administration :
--   * subscription_requests : demande refusée (« already_subscribed ») ;
--   * admin_codes : création d'un code nominatif refusée (« already_subscribed »), quel que soit l'écran ou l'administrateur.
-- Non concerné : l'activation d'un code déjà émis (activate_license inchangée : un client qui a déjà payé n'est jamais bloqué),
-- les codes libres sans e-mail, les prolongations / suspensions faites par l'administrateur sur le compte (admin_set_license),
-- et un abonnement expiré (le client peut alors renouveler la même formule).
--
-- Compatibilité : AJOUT seul (2 fonctions d'aide + 2 déclencheurs). Aucune donnée modifiée. Idempotent. Dépend de 07, 20, 21.
-- Retour arrière : DROP TRIGGER trg_block_double_code ON public.admin_codes ; DROP TRIGGER trg_block_double_request ON public.subscription_requests ;
-- DROP FUNCTION public.block_double_subscription(), public.current_paid_days(TEXT), public.plan_days(TEXT).
-- ============================================================

-- Durée (en jours) d'une formule ; « à vie » = valeur très grande
CREATE OR REPLACE FUNCTION public.plan_days(p_type TEXT)
RETURNS INT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
    SELECT CASE p_type
             WHEN 'lifetime'   THEN 1000000
             WHEN 'monthly'    THEN 30
             WHEN 'business'   THEN 30
             WHEN 'semestrial' THEN 183
             WHEN 'annual'     THEN 365
             WHEN 'founder'    THEN 365
             ELSE COALESCE((SELECT p.duration_days FROM public.plans p WHERE p.key = p_type), 30)
           END;
$$;

-- Durée de l'abonnement payant ACTIF d'un e-mail (NULL = aucun abonnement actif : essai, expiré, suspendu ou inconnu)
CREATE OR REPLACE FUNCTION public.current_paid_days(p_email TEXT)
RETURNS INT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
    SELECT GREATEST(public.plan_days(l.type),
                    COALESCE(public.plan_days((SELECT c.type FROM public.admin_codes c WHERE c.code = l.code LIMIT 1)), 0))
      FROM public.licenses l
      JOIN auth.users u ON u.id = l.user_id
     WHERE lower(u.email) = lower(p_email)
       AND l.type IN ('monthly','semestrial','annual','business','lifetime')
       AND l.status = 'active'
       AND (l.expires_at IS NULL OR l.expires_at > NOW());
$$;

REVOKE ALL ON FUNCTION public.plan_days(TEXT), public.current_paid_days(TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.block_double_subscription()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_email TEXT;
    v_type  TEXT;
    v_cur   INT;
BEGIN
    IF TG_TABLE_NAME = 'admin_codes' THEN
        v_email := NEW.client_email; v_type := NEW.type;
        IF NEW.status = 'revoked' THEN RETURN NEW; END IF;
    ELSE
        v_email := NEW.client_email; v_type := NEW.tier;
    END IF;
    IF v_email IS NULL OR v_email = '' THEN RETURN NEW; END IF;

    v_cur := public.current_paid_days(v_email);
    IF v_cur IS NOT NULL AND public.plan_days(v_type) <= v_cur THEN
        RAISE EXCEPTION 'already_subscribed: abonnement actif, seule une formule plus longue est possible' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.block_double_subscription() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_block_double_code ON public.admin_codes;
CREATE TRIGGER trg_block_double_code BEFORE INSERT ON public.admin_codes
    FOR EACH ROW EXECUTE FUNCTION public.block_double_subscription();

DROP TRIGGER IF EXISTS trg_block_double_request ON public.subscription_requests;
CREATE TRIGGER trg_block_double_request BEFORE INSERT ON public.subscription_requests
    FOR EACH ROW EXECUTE FUNCTION public.block_double_subscription();

SELECT 'déclencheurs anti-doublon' AS check, string_agg(tgname, ', ') AS result
  FROM pg_trigger WHERE tgname IN ('trg_block_double_code', 'trg_block_double_request');
