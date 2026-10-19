-- ============================================================
-- 06 - SECURITE : RLS sur les tables admin + fonctions serveur
-- ============================================================
-- À exécuter dans Supabase > SQL Editor APRÈS avoir déployé
-- la version de admin.html / app.html de cette branche.
--
-- Avant : RLS désactivé sur admins, admin_codes, admin_payments,
-- admin_settings, subscription_requests -> tout détenteur de la clé
-- publique (visible dans le code) pouvait lire/modifier ces tables.
--
-- Après :
--  * admin = utilisateur Supabase Auth (e-mail confirmé) listé dans `admins`
--  * les clients n'accèdent plus à admin_codes : activation via RPC
--  * les clients ne voient que leurs propres demandes d'abonnement
-- ============================================================

-- ------------------------------------------------------------
-- 0. admins : plus de mot de passe stocké dans cette table
-- ------------------------------------------------------------
ALTER TABLE admins ALTER COLUMN password_hash DROP NOT NULL;
UPDATE admins SET password_hash = NULL;

-- Le compte Master existe toujours (sans mot de passe en base)
INSERT INTO admins (email, is_master)
VALUES ('webnour@gmail.com', TRUE)
ON CONFLICT (email) DO UPDATE SET is_master = TRUE;

-- ------------------------------------------------------------
-- 1. Fonctions d'identité (SECURITY DEFINER)
--    Exigent un compte Auth dont l'e-mail est confirmé.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM auth.users u
        JOIN public.admins a ON lower(a.email) = lower(u.email)
        WHERE u.id = auth.uid()
          AND u.email_confirmed_at IS NOT NULL
    );
$$;

CREATE OR REPLACE FUNCTION public.is_master()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM auth.users u
        JOIN public.admins a ON lower(a.email) = lower(u.email)
        WHERE u.id = auth.uid()
          AND u.email_confirmed_at IS NOT NULL
          AND a.is_master = TRUE
    );
$$;

-- Utilisée par admin.html après connexion
CREATE OR REPLACE FUNCTION public.admin_whoami()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
    SELECT jsonb_build_object(
        'is_admin',  public.is_admin(),
        'is_master', public.is_master(),
        'email',     (SELECT email FROM auth.users WHERE id = auth.uid())
    );
$$;

-- ------------------------------------------------------------
-- 2. Activation d'une licence par un client (remplace la lecture
--    directe de admin_codes depuis le navigateur)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.activate_license(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_email TEXT;
    v_row   public.admin_codes%ROWTYPE;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
    END IF;

    SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();

    SELECT * INTO v_row
    FROM public.admin_codes
    WHERE code = upper(trim(p_code))
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
    END IF;
    IF v_row.status = 'used' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'used');
    END IF;
    IF v_row.status = 'revoked' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'revoked');
    END IF;
    IF v_row.client_email IS NOT NULL
       AND lower(v_row.client_email) <> lower(v_email) THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'wrong_email');
    END IF;

    UPDATE public.admin_codes
       SET status = 'used', activated_at = NOW()
     WHERE id = v_row.id;

    RETURN jsonb_build_object('ok', true, 'type', v_row.type);
END;
$$;

REVOKE ALL ON FUNCTION public.is_admin()        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_master()       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_whoami()    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.activate_license(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin()     TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_master()    TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_whoami() TO authenticated;
GRANT EXECUTE ON FUNCTION public.activate_license(TEXT) TO authenticated;

-- ------------------------------------------------------------
-- 3. Activer RLS + nettoyer d'anciennes policies éventuelles
-- ------------------------------------------------------------
DO $$
DECLARE t TEXT; p RECORD;
BEGIN
    FOREACH t IN ARRAY ARRAY['admins','admin_codes','admin_payments',
                             'admin_settings','subscription_requests']
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        FOR p IN SELECT policyname FROM pg_policies
                 WHERE schemaname = 'public' AND tablename = t
        LOOP
            EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, t);
        END LOOP;
    END LOOP;
END $$;

-- ------------------------------------------------------------
-- 4. Policies
-- ------------------------------------------------------------
-- admins : lecture par tout admin, écriture par le Master seulement
CREATE POLICY admins_select ON public.admins
    FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY admins_write_master ON public.admins
    FOR ALL TO authenticated
    USING (public.is_master()) WITH CHECK (public.is_master());

-- admin_codes / admin_payments / admin_settings : admins uniquement
CREATE POLICY admin_codes_admin ON public.admin_codes
    FOR ALL TO authenticated
    USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY admin_payments_admin ON public.admin_payments
    FOR ALL TO authenticated
    USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY admin_settings_admin ON public.admin_settings
    FOR ALL TO authenticated
    USING (public.is_admin()) WITH CHECK (public.is_admin());

-- subscription_requests : le client crée/voit SES demandes, l'admin gère tout
CREATE POLICY subreq_admin ON public.subscription_requests
    FOR ALL TO authenticated
    USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY subreq_insert_own ON public.subscription_requests
    FOR INSERT TO authenticated
    WITH CHECK (
        lower(client_email) = lower(auth.jwt() ->> 'email')
        AND status = 'pending'
        AND license_code IS NULL
        AND processed_at IS NULL
    );
CREATE POLICY subreq_select_own ON public.subscription_requests
    FOR SELECT TO authenticated
    USING (lower(client_email) = lower(auth.jwt() ->> 'email'));

-- Aucun accès anonyme aux tables admin
REVOKE ALL ON public.admins, public.admin_codes, public.admin_payments,
              public.admin_settings, public.subscription_requests FROM anon;

-- ------------------------------------------------------------
-- 5. À FAIRE APRÈS EXÉCUTION (vérifications manuelles)
-- ------------------------------------------------------------
-- a) Les tables étaient ouvertes jusqu'ici : vérifie qu'aucun admin
--    inconnu n'a été ajouté, et que les codes/paiements sont cohérents :
--      SELECT email, is_master, created_at FROM admins;
--      SELECT code, type, status, client_email FROM admin_codes ORDER BY created_at DESC;
-- b) Dans Authentication > Providers > Email : activer
--    « Confirm email » pour que is_admin() ne soit pas contournable.
-- c) Vérifier que RLS est actif :
--      SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public'
--      AND tablename IN ('admins','admin_codes','admin_payments','admin_settings','subscription_requests');
SELECT '✓ Migration 06 (sécurité) appliquée' AS message;
