-- ============================================================================================================
-- 30 — Lien client public d'une facture (consultation sans compte)   *** NON APPLIQUÉ EN PRODUCTION ***
-- ============================================================================================================
-- Ce script N'EST PAS dans sql/MANIFEST.json. Ordre : préproduction d'abord, production ensuite sur autorisation explicite du propriétaire.
-- Dépend de : sql/00 (schéma), auth.users (Supabase). Indépendant des scripts 14 à 29 : applicable sur la production actuelle (stockage « legacy »).
--
-- PRINCIPE
--  * La société partage UNE facture : l'application envoie une COPIE (« instantané ») des seules informations déjà présentes sur le PDF
--    (société, client, lignes, totaux, reste dû, RIB). Le serveur ne lit jamais les données de la société : il stocke ce qu'on lui donne.
--  * Le lien contient un jeton aléatoire de 64 caractères hexadécimaux (2 × 122 bits issus de gen_random_uuid(), source cryptographique).
--  * La table invoice_shares est FERMÉE (RLS active, aucun droit pour anon/authenticated) : tout passe par 4 fonctions SECURITY DEFINER.
--  * UNE SEULE fonction est exécutable sans connexion : get_shared_invoice(jeton). Elle ne renvoie que l'instantané d'un lien valide ;
--    jeton inconnu, expiré, révoqué ou mal formé => même réponse (NULL) : aucune énumération possible. Elle compte les consultations.
--  * Société : crée / actualise / révoque ses liens, voit combien de fois chaque lien a été ouvert. Isolation stricte entre comptes.
--  * Limites : instantané <= 64 Ko, clés autorisées seulement (liste blanche), durée 1 à 365 jours (60 par défaut), 500 liens actifs par compte.
--  * Le lien disparaît avec le compte (ON DELETE CASCADE). Aucune donnée existante n'est modifiée.
-- Données personnelles : l'instantané contient le nom/ICE/adresse du client final. À mentionner dans la politique de confidentialité (CNDP, à valider).
-- Réexécutable.
-- RETOUR ARRIÈRE :
--   DROP FUNCTION IF EXISTS public.get_shared_invoice(TEXT), public.share_invoice(TEXT, JSONB, INT), public.revoke_invoice_share(TEXT), public.my_invoice_shares(), public.share_uid();
--   DROP TABLE IF EXISTS public.invoice_shares;      -- supprime tous les liens : à ne faire qu'en connaissance de cause
-- ============================================================================================================
CREATE TABLE IF NOT EXISTS public.invoice_shares (
    id              BIGSERIAL PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    invoice_id      TEXT NOT NULL CHECK (char_length(invoice_id) BETWEEN 1 AND 100),
    token           TEXT NOT NULL UNIQUE CHECK (token ~ '^[0-9a-f]{64}$'),
    snapshot        JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object' AND pg_column_size(snapshot) <= 65536),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ,
    views           INTEGER NOT NULL DEFAULT 0,
    first_viewed_at TIMESTAMPTZ,
    last_viewed_at  TIMESTAMPTZ,
    UNIQUE (user_id, invoice_id)
);
CREATE INDEX IF NOT EXISTS invoice_shares_user_idx ON public.invoice_shares (user_id);
ALTER TABLE public.invoice_shares ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.invoice_shares FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.invoice_shares_id_seq FROM PUBLIC, anon, authenticated;
-- (aucune politique : seules les fonctions ci-dessous, propriétaires de la table, y accèdent)

-- Identité : compte connecté dont l'e-mail est confirmé
CREATE OR REPLACE FUNCTION public.share_uid() RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
    SELECT u.id FROM auth.users u WHERE u.id = auth.uid() AND u.email_confirmed_at IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION public.share_uid() FROM PUBLIC, anon, authenticated;

-- Crée ou actualise le lien d'une facture. Lien encore valide : même jeton, instantané remplacé, validité prolongée.
-- Lien révoqué ou expiré : NOUVEAU jeton (l'ancien reste mort). Retourne {token, expires_at}.
CREATE OR REPLACE FUNCTION public.share_invoice(p_invoice_id TEXT, p_snapshot JSONB, p_days INT DEFAULT 60) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    v UUID := public.share_uid();
    s JSONB; r public.invoice_shares%ROWTYPE; n INT; v_exp TIMESTAMPTZ; tok TEXT;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    IF p_invoice_id IS NULL OR char_length(btrim(p_invoice_id)) < 1 OR char_length(p_invoice_id) > 100 THEN RAISE EXCEPTION 'FACTURE_INVALIDE'; END IF;
    IF p_snapshot IS NULL OR jsonb_typeof(p_snapshot) <> 'object' THEN RAISE EXCEPTION 'INSTANTANE_INVALIDE'; END IF;
    IF p_days IS NULL OR p_days < 1 OR p_days > 365 THEN RAISE EXCEPTION 'DUREE_INVALIDE'; END IF;
    -- liste blanche des clés : le serveur ne stocke rien d'autre que ce que la page publique sait afficher
    SELECT COALESCE(jsonb_object_agg(k, val), '{}'::jsonb) INTO s
      FROM jsonb_each(p_snapshot) AS e(k, val)
     WHERE k = ANY (ARRAY['v', 'company', 'doc', 'client', 'items', 'totals', 'payment', 'asOf']);
    IF s = '{}'::jsonb THEN RAISE EXCEPTION 'INSTANTANE_INVALIDE'; END IF;
    IF pg_column_size(s) > 65536 THEN RAISE EXCEPTION 'INSTANTANE_TROP_GROS'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('fp_share_' || v::text, 0));
    v_exp := now() + make_interval(days => p_days);
    SELECT * INTO r FROM public.invoice_shares WHERE user_id = v AND invoice_id = p_invoice_id FOR UPDATE;
    IF FOUND THEN
        IF r.revoked_at IS NULL AND r.expires_at > now() THEN
            UPDATE public.invoice_shares SET snapshot = s, updated_at = now(), expires_at = v_exp WHERE id = r.id;
            RETURN jsonb_build_object('token', r.token, 'expires_at', v_exp);
        END IF;
        tok := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
        UPDATE public.invoice_shares SET token = tok, snapshot = s, created_at = now(), updated_at = now(), expires_at = v_exp,
               revoked_at = NULL, views = 0, first_viewed_at = NULL, last_viewed_at = NULL WHERE id = r.id;
        RETURN jsonb_build_object('token', tok, 'expires_at', v_exp);
    END IF;
    SELECT count(*) INTO n FROM public.invoice_shares WHERE user_id = v AND revoked_at IS NULL AND expires_at > now();
    IF n >= 500 THEN RAISE EXCEPTION 'TROP_DE_LIENS'; END IF;
    tok := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
    INSERT INTO public.invoice_shares (user_id, invoice_id, token, snapshot, expires_at) VALUES (v, p_invoice_id, tok, s, v_exp);
    RETURN jsonb_build_object('token', tok, 'expires_at', v_exp);
END; $$;

-- Révoque le lien d'une facture : le lien cesse de fonctionner immédiatement. Retourne vrai si un lien actif a été révoqué.
CREATE OR REPLACE FUNCTION public.revoke_invoice_share(p_invoice_id TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.share_uid(); k INT;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    UPDATE public.invoice_shares SET revoked_at = now() WHERE user_id = v AND invoice_id = p_invoice_id AND revoked_at IS NULL;
    GET DIAGNOSTICS k = ROW_COUNT;
    RETURN k > 0;
END; $$;

-- Liens de la société (sans l'instantané) : pour afficher « consulté N fois » et l'état
CREATE OR REPLACE FUNCTION public.my_invoice_shares()
RETURNS TABLE (invoice_id TEXT, token TEXT, expires_at TIMESTAMPTZ, revoked BOOLEAN, views INT, last_viewed_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.share_uid();
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    RETURN QUERY
    SELECT s.invoice_id, s.token, s.expires_at, (s.revoked_at IS NOT NULL), s.views, s.last_viewed_at, s.updated_at
      FROM public.invoice_shares s WHERE s.user_id = v ORDER BY s.updated_at DESC LIMIT 1000;
END; $$;

-- PUBLIC (sans connexion) : instantané d'un lien valide, sinon NULL (jeton inconnu / expiré / révoqué / mal formé : même réponse).
CREATE OR REPLACE FUNCTION public.get_shared_invoice(p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.invoice_shares%ROWTYPE;
BEGIN
    IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
    SELECT * INTO r FROM public.invoice_shares WHERE token = p_token AND revoked_at IS NULL AND expires_at > now();
    IF NOT FOUND THEN RETURN NULL; END IF;
    UPDATE public.invoice_shares SET views = views + 1, last_viewed_at = now(), first_viewed_at = COALESCE(first_viewed_at, now()) WHERE id = r.id;
    RETURN jsonb_build_object('snapshot', r.snapshot, 'updated_at', r.updated_at, 'expires_at', r.expires_at);
END; $$;

REVOKE ALL ON FUNCTION public.share_invoice(TEXT, JSONB, INT), public.revoke_invoice_share(TEXT), public.my_invoice_shares(), public.get_shared_invoice(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.share_invoice(TEXT, JSONB, INT), public.revoke_invoice_share(TEXT), public.my_invoice_shares() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_shared_invoice(TEXT) TO anon, authenticated;   -- SEULE fonction publique (liste blanche dans tests/sql/test_droits.sql)
