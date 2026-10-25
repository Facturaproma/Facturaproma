-- ============================================================================================================
-- 28 — Administration : nom de société des comptes (lecture seule, additif)   *** BROUILLON : NON APPLIQUÉ ***
-- ============================================================================================================
-- Ce script N'EST PAS dans sql/MANIFEST.json. À n'exécuter qu'après autorisation explicite, d'abord en préproduction.
-- Pourquoi : repérer un client par sa société en plus de son e-mail (l'e-mail reste la clé). Le nom est celui que le client a
--            saisi dans « Mon Entreprise » (user_data, clé 'company', champ 'name').
-- Nouvelle fonction ADDITIVE : admin_account_companies() ; admin_list_accounts() n'est PAS modifiée. Réservée aux administrateurs
-- (is_admin()). Ne renvoie que user_id + nom (255 caractères max) ; aucune autre donnée de l'entreprise. Aucune donnée n'est modifiée.
-- Réexécutable. Dépend de 00, 05, 06 (is_admin) et 08.
-- RETOUR ARRIÈRE : DROP FUNCTION IF EXISTS public.admin_account_companies();   (admin.html masque alors la colonne tout seul)
-- ============================================================================================================
CREATE OR REPLACE FUNCTION public.admin_account_companies()
RETURNS TABLE (user_id UUID, company_name TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
    SELECT d.user_id,
           left(btrim(d.value->>'name'), 255)
      FROM public.user_data d
     WHERE d.key = 'company'
       AND jsonb_typeof(d.value) = 'object'
       AND jsonb_typeof(d.value->'name') = 'string'
       AND btrim(d.value->>'name') <> '';
END;
$$;
REVOKE ALL ON FUNCTION public.admin_account_companies() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_account_companies() TO authenticated;
