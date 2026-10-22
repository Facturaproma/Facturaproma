-- ============================================================
-- 18 — Coordonnées de contact (WhatsApp, e-mail) lisibles par les clients connectés
--
-- ÉTAT : PRÉPARÉ, NON APPLIQUÉ. Ce script n'est exécuté sur AUCUNE base (ni préproduction ni production)
--        et n'est PAS encore dans sql/MANIFEST.json. À valider d'abord en préproduction, sur autorisation.
--
-- Problème corrigé : Admin → Réglages enregistre le WhatsApp et l'e-mail de support dans admin_settings,
-- mais cette table est réservée aux administrateurs ; l'application client ne pouvait donc pas les afficher
-- (elle affichait des valeurs codées en dur).
--
-- Solution minimale : une fonction en LECTURE SEULE qui ne renvoie QUE le numéro WhatsApp et l'e-mail de
-- contact. Le RIB, la banque et le bénéficiaire ne sont JAMAIS renvoyés (ils sont communiqués au client après
-- sa demande d'abonnement). Réservée aux comptes connectés (aucun accès anonyme : l'audit test_droits.sql
-- interdit toute fonction SECURITY DEFINER exécutable par anon).
--
-- Aucune donnée existante n'est modifiée. Réexécutable.
-- Retour arrière :  DROP FUNCTION IF EXISTS public.get_contact_info();
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_contact_info()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'whatsapp', COALESCE((SELECT btrim(value) FROM public.admin_settings WHERE key = 'whatsapp_number'), ''),
    'email',    COALESCE((SELECT btrim(value) FROM public.admin_settings WHERE key = 'contact_email'), '')
  );
$$;

REVOKE ALL ON FUNCTION public.get_contact_info() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_contact_info() TO authenticated;
