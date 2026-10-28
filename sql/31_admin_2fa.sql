-- ============================================================
-- 31 — Double authentification (TOTP) des comptes admin / master / assistant
-- Règle : si le compte a un facteur TOTP VÉRIFIÉ, la session doit être de niveau « aal2 »
-- (code saisi) pour être reconnue admin/master/assistant. Sans facteur vérifié : comportement inchangé,
-- donc aucun verrouillage tant que le compte n'a pas activé la 2FA (l'écran admin.html l'impose à la connexion).
-- Applique la règle aux trois fonctions d'identité : toutes les fonctions admin passent par elles.
-- Réexécutable. Retour arrière : réexécuter les définitions de sql/06 (is_admin, is_master) et sql/13 (is_staff).
-- ============================================================
CREATE OR REPLACE FUNCTION public.fp_mfa_ok(p_uid UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
    SELECT COALESCE(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
        OR NOT EXISTS (SELECT 1 FROM auth.mfa_factors f WHERE f.user_id = p_uid AND f.status = 'verified');
$$;
REVOKE ALL ON FUNCTION public.fp_mfa_ok(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
    SELECT EXISTS (
        SELECT 1 FROM auth.users u
        JOIN public.admins a ON lower(a.email) = lower(u.email)
        WHERE u.id = auth.uid() AND u.email_confirmed_at IS NOT NULL AND public.fp_mfa_ok(u.id)
    );
$$;

CREATE OR REPLACE FUNCTION public.is_master()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
    SELECT EXISTS (
        SELECT 1 FROM auth.users u
        JOIN public.admins a ON lower(a.email) = lower(u.email)
        WHERE u.id = auth.uid() AND u.email_confirmed_at IS NOT NULL AND a.is_master = TRUE AND public.fp_mfa_ok(u.id)
    );
$$;

CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
    SELECT EXISTS (
        SELECT 1 FROM auth.users u
        JOIN public.staff s ON lower(s.email) = lower(u.email)
        WHERE u.id = auth.uid() AND u.email_confirmed_at IS NOT NULL AND public.fp_mfa_ok(u.id)
    );
$$;

REVOKE ALL ON FUNCTION public.is_admin()  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_master() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_staff()  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin()  TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_master() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_staff()  TO authenticated;
