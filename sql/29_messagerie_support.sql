-- ============================================================================================================
-- 29 — Messagerie support (société utilisatrice ↔ administration)   *** BROUILLON : NON APPLIQUÉ ***
-- ============================================================================================================
-- Ce script N'EST PAS dans sql/MANIFEST.json. À n'exécuter qu'après autorisation explicite, d'abord en préproduction.
-- Principe : UN fil de discussion par compte (société). Texte seulement (aucune pièce jointe), 1 à 2 000 caractères.
--  * La table support_messages n'est lisible ni modifiable directement par les clients (RLS active, aucun droit) : tout passe par des
--    fonctions SECURITY DEFINER qui vérifient l'identité (compte confirmé) et appliquent les limites.
--  * Société : voit et envoie uniquement dans SON fil. Limite anti-abus : 20 messages par heure et 1 000 messages par fil.
--  * Administration (is_admin()) : voit tous les fils, répond, marque comme lu. Aucune suppression côté client ni côté admin (traçabilité) ;
--    le fil disparaît avec le compte (ON DELETE CASCADE).
--  * Pas de notification instantanée : compteurs de non-lus à interroger (l'application rafraîchit à intervalle).
-- Données personnelles : les messages sont conservés tant que le compte existe. À mentionner dans la politique de confidentialité (à valider, CNDP).
-- Réexécutable. Dépend de 05, 06 (is_admin). N'altère aucune table existante.
-- RETOUR ARRIÈRE : DROP FUNCTION IF EXISTS public.support_my_messages(), public.support_send(TEXT), public.support_mark_read(), public.support_unread_count(),
--   public.admin_support_threads(), public.admin_support_messages(UUID), public.admin_support_reply(UUID, TEXT), public.admin_support_mark_read(UUID),
--   public.admin_support_unread_total();  DROP TABLE IF EXISTS public.support_messages;   (supprime les messages : à ne faire qu'en connaissance de cause)
-- ============================================================================================================
CREATE TABLE IF NOT EXISTS public.support_messages (
    id            BIGSERIAL PRIMARY KEY,
    user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,   -- le compte (société) propriétaire du fil
    sender        TEXT NOT NULL CHECK (sender IN ('client', 'admin')),
    sender_email  TEXT,
    body          TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_by_client_at TIMESTAMPTZ,
    read_by_admin_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS support_messages_user_idx ON public.support_messages (user_id, id);
CREATE INDEX IF NOT EXISTS support_messages_recent_idx ON public.support_messages (created_at DESC);
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.support_messages FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.support_messages_id_seq FROM PUBLIC, anon, authenticated;
-- (aucune politique : seules les fonctions ci-dessous, propriétaires de la table, y accèdent)

-- Identité : compte connecté dont l'e-mail est confirmé
CREATE OR REPLACE FUNCTION public.support_uid() RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
    SELECT u.id FROM auth.users u WHERE u.id = auth.uid() AND u.email_confirmed_at IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION public.support_uid() FROM PUBLIC, anon, authenticated;

-- ===== Côté société =====
CREATE OR REPLACE FUNCTION public.support_my_messages()
RETURNS TABLE (id BIGINT, sender TEXT, body TEXT, created_at TIMESTAMPTZ, is_read BOOLEAN)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.support_uid();
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    RETURN QUERY
    SELECT m.id, m.sender, m.body, m.created_at,
           (CASE WHEN m.sender = 'admin' THEN m.read_by_client_at IS NOT NULL ELSE TRUE END)
      FROM (SELECT * FROM public.support_messages WHERE user_id = v ORDER BY id DESC LIMIT 200) m
     ORDER BY m.id ASC;
END; $$;

CREATE OR REPLACE FUNCTION public.support_send(p_body TEXT) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.support_uid(); b TEXT := btrim(COALESCE(p_body, '')); n INT; v_email TEXT; v_id BIGINT;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    IF char_length(b) < 1 THEN RAISE EXCEPTION 'MESSAGE_VIDE'; END IF;
    IF char_length(b) > 2000 THEN RAISE EXCEPTION 'MESSAGE_TROP_LONG'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('fp_support_' || v::text, 0));
    SELECT count(*) INTO n FROM public.support_messages WHERE user_id = v AND sender = 'client' AND created_at > now() - interval '1 hour';
    IF n >= 20 THEN RAISE EXCEPTION 'TROP_DE_MESSAGES'; END IF;
    SELECT count(*) INTO n FROM public.support_messages WHERE user_id = v;
    IF n >= 1000 THEN RAISE EXCEPTION 'FIL_PLEIN'; END IF;
    SELECT email INTO v_email FROM auth.users WHERE id = v;
    INSERT INTO public.support_messages (user_id, sender, sender_email, body, read_by_client_at)
    VALUES (v, 'client', v_email, b, now()) RETURNING support_messages.id INTO v_id;
    RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION public.support_mark_read() RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.support_uid();
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    UPDATE public.support_messages SET read_by_client_at = now() WHERE user_id = v AND sender = 'admin' AND read_by_client_at IS NULL;
END; $$;

CREATE OR REPLACE FUNCTION public.support_unread_count() RETURNS INT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.support_uid(); n INT;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    SELECT count(*) INTO n FROM public.support_messages WHERE user_id = v AND sender = 'admin' AND read_by_client_at IS NULL;
    RETURN n;
END; $$;

-- ===== Côté administration =====
CREATE OR REPLACE FUNCTION public.admin_support_threads()
RETURNS TABLE (user_id UUID, email TEXT, company_name TEXT, last_at TIMESTAMPTZ, last_sender TEXT, last_body TEXT, unread INT, total INT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
BEGIN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
    RETURN QUERY
    SELECT t.user_id, u.email::TEXT,
           (SELECT left(btrim(d.value->>'name'), 255) FROM public.user_data d WHERE d.user_id = t.user_id AND d.key = 'company'
               AND jsonb_typeof(d.value) = 'object' AND jsonb_typeof(d.value->'name') = 'string' LIMIT 1),
           l.created_at, l.sender, left(l.body, 140), t.unread::INT, t.total::INT
      FROM (SELECT m.user_id, max(m.id) AS last_id, count(*) AS total,
                   count(*) FILTER (WHERE m.sender = 'client' AND m.read_by_admin_at IS NULL) AS unread
              FROM public.support_messages m GROUP BY m.user_id) t
      JOIN public.support_messages l ON l.id = t.last_id
      JOIN auth.users u ON u.id = t.user_id
     ORDER BY (t.unread > 0) DESC, l.created_at DESC
     LIMIT 200;
END; $$;

CREATE OR REPLACE FUNCTION public.admin_support_messages(p_user UUID)
RETURNS TABLE (id BIGINT, sender TEXT, sender_email TEXT, body TEXT, created_at TIMESTAMPTZ)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
BEGIN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
    RETURN QUERY
    SELECT m.id, m.sender, m.sender_email, m.body, m.created_at
      FROM (SELECT * FROM public.support_messages WHERE user_id = p_user ORDER BY id DESC LIMIT 200) m ORDER BY m.id ASC;
END; $$;

CREATE OR REPLACE FUNCTION public.admin_support_reply(p_user UUID, p_body TEXT) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE b TEXT := btrim(COALESCE(p_body, '')); v_admin TEXT; v_id BIGINT;
BEGIN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
    IF char_length(b) < 1 THEN RAISE EXCEPTION 'MESSAGE_VIDE'; END IF;
    IF char_length(b) > 2000 THEN RAISE EXCEPTION 'MESSAGE_TROP_LONG'; END IF;
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user) THEN RAISE EXCEPTION 'COMPTE_INTROUVABLE'; END IF;
    SELECT email INTO v_admin FROM auth.users WHERE id = auth.uid();
    INSERT INTO public.support_messages (user_id, sender, sender_email, body, read_by_admin_at)
    VALUES (p_user, 'admin', v_admin, b, now()) RETURNING support_messages.id INTO v_id;
    UPDATE public.support_messages SET read_by_admin_at = now() WHERE user_id = p_user AND sender = 'client' AND read_by_admin_at IS NULL;
    RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION public.admin_support_mark_read(p_user UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
BEGIN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
    UPDATE public.support_messages SET read_by_admin_at = now() WHERE user_id = p_user AND sender = 'client' AND read_by_admin_at IS NULL;
END; $$;

CREATE OR REPLACE FUNCTION public.admin_support_unread_total() RETURNS INT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE n INT;
BEGIN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
    SELECT count(*) INTO n FROM public.support_messages WHERE sender = 'client' AND read_by_admin_at IS NULL;
    RETURN n;
END; $$;

DO $$ DECLARE f TEXT; BEGIN
  FOREACH f IN ARRAY ARRAY['support_my_messages()', 'support_send(text)', 'support_mark_read()', 'support_unread_count()',
        'admin_support_threads()', 'admin_support_messages(uuid)', 'admin_support_reply(uuid,text)', 'admin_support_mark_read(uuid)', 'admin_support_unread_total()']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', f);
  END LOOP;
END $$;
