-- ============================================================
-- INSTALLATION COMPLÈTE POUR LA PRÉPRODUCTION UNIQUEMENT
-- Projet autorisé : facturapro-preprod (ref njjaomichdlnoscrnxlz)
-- Assemblage automatique des scripts sql/00,05,06,07,08,09,10,12,13,14 (ne pas modifier à la main).
-- NE JAMAIS LANCER SUR LA PRODUCTION : le garde-fou ci-dessous refuse si la base contient déjà le schéma FacturaPro.
-- ============================================================
DO $guard$
BEGIN
  IF to_regclass('public.user_data') IS NOT NULL OR to_regclass('public.admins') IS NOT NULL THEN
    RAISE EXCEPTION 'REFUS : cette base contient déjà le schéma FacturaPro (production ou préproduction déjà installée). Rien n''a été modifié.';
  END IF;
  IF (SELECT count(*) FROM auth.users) > 0 THEN
    RAISE EXCEPTION 'REFUS : cette base contient déjà des comptes utilisateurs. Rien n''a été modifié.';
  END IF;
END
$guard$;

-- ######## sql/00_setup_complet.sql ########
-- ============================================
-- FACTURAPRO - SETUP COMPLET (Tout-en-un)
-- À exécuter dans Supabase SQL Editor
-- https://supabase.com/dashboard/project/_/sql/new
-- ============================================

-- ═══════════════════════════════════════════
-- 1. TABLE PRINCIPALE : user_data
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS user_data (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_user_data_lookup ON user_data(user_id, key);
CREATE INDEX IF NOT EXISTS idx_user_data_updated ON user_data(updated_at);

ALTER TABLE user_data ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "users_own_data" ON user_data;
CREATE POLICY "users_own_data" ON user_data 
    FOR ALL USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS user_data_updated_at ON user_data;
CREATE TRIGGER user_data_updated_at
    BEFORE UPDATE ON user_data
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- ═══════════════════════════════════════════
-- 2. TABLES ADMIN : codes & payments
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS admin_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL,
    client_email TEXT,
    note TEXT,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    activated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS admin_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_email TEXT NOT NULL,
    payment_date DATE NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    type TEXT NOT NULL,
    payment_mode TEXT NOT NULL,
    note TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_codes_email ON admin_codes(client_email);
CREATE INDEX IF NOT EXISTS idx_admin_codes_status ON admin_codes(status);
CREATE INDEX IF NOT EXISTS idx_admin_payments_email ON admin_payments(client_email);
CREATE INDEX IF NOT EXISTS idx_admin_payments_date ON admin_payments(payment_date);

ALTER TABLE admin_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_payments ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════
-- 3. DEMANDES D'ABONNEMENT
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS subscription_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_email TEXT NOT NULL,
    company_name TEXT,
    company_status TEXT,
    tier TEXT NOT NULL,
    base_price DECIMAL(10,2) NOT NULL,
    final_price DECIMAL(10,2) NOT NULL,
    promo_code TEXT,
    status TEXT DEFAULT 'pending',
    license_code TEXT,
    note TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_subscription_requests_status ON subscription_requests(status);
CREATE INDEX IF NOT EXISTS idx_subscription_requests_email ON subscription_requests(client_email);
CREATE INDEX IF NOT EXISTS idx_subscription_requests_created ON subscription_requests(created_at DESC);

ALTER TABLE subscription_requests ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════
-- 4. PARAMÈTRES ADMIN (mot de passe)
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS admin_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE admin_settings ENABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════
-- ✅ VÉRIFICATION FINALE
-- ═══════════════════════════════════════════
SELECT 
    tablename, 
    rowsecurity,
    CASE 
        WHEN tablename = 'user_data' AND rowsecurity = true THEN '✅ OK (sécurisé)'
        WHEN tablename != 'user_data' AND rowsecurity = true THEN '✅ OK (admin, voir 06)'
        ELSE '⚠️ À vérifier'
    END AS status
FROM pg_tables 
WHERE tablename IN ('user_data', 'admin_codes', 'admin_payments', 'subscription_requests', 'admin_settings')
ORDER BY tablename;


-- ######## sql/05_admins.sql ########
-- ============================================
-- MIGRATION : Table admins (multi-admins + Master)
-- ============================================
-- Cette table remplace l'ancien système admin_settings.admin_password_hash
-- pour supporter plusieurs admins avec un compte Master.

CREATE TABLE IF NOT EXISTS admins (
    email TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    is_master BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    last_login TIMESTAMPTZ
);

-- Index pour performance
CREATE INDEX IF NOT EXISTS idx_admins_email ON admins(email);
CREATE INDEX IF NOT EXISTS idx_admins_is_master ON admins(is_master);

-- RLS activé (les policies sont dans sql/06_securite_rls.sql)
ALTER TABLE admins ENABLE ROW LEVEL SECURITY;

-- Trigger pour updated_at
CREATE OR REPLACE FUNCTION update_admin_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS admin_updated_at ON admins;
CREATE TRIGGER admin_updated_at
    BEFORE UPDATE ON admins
    FOR EACH ROW
    EXECUTE FUNCTION update_admin_updated_at();

SELECT '✓ Table admins créée avec succès' AS message;

-- ============================================
-- IMPORTANT :
-- L'authentification admin passe désormais par Supabase Auth
-- (voir sql/06_securite_rls.sql). Aucun mot de passe n'est stocké
-- ici. Le Master est webnour@gmail.com : utilise le mot de passe
-- de ton compte FacturaPro (réinitialisable par e-mail).
-- ============================================


-- ######## sql/06_securite_rls.sql ########
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


-- ######## sql/07_licence_serveur.sql ########
-- ============================================================
-- 07 - LICENCE CÔTÉ SERVEUR (essai / abonnement non contournables)
-- ============================================================
-- Avant : la licence vivait dans user_data (clé 'licenseInfo'), que le
-- client peut modifier lui-même. Un utilisateur expiré pouvait donc
-- continuer à travailler (modif localStorage / nouveau navigateur).
--
-- Après :
--  * table `licenses` : lecture seule pour le client, écrite uniquement
--    par les fonctions SECURITY DEFINER (activate_license, my_license)
--  * user_data : INSERT/UPDATE refusés par la base si la licence est
--    expirée (mode lecture seule : l'utilisateur garde l'accès à ses
--    données mais ne peut plus rien enregistrer)
--  * la clé 'licenseInfo' ne peut plus être écrite par le client
--
-- À exécuter dans Supabase > SQL Editor, APRÈS le déploiement de app.html.
-- Idempotent : peut être relancé sans risque.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Table des licences
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.licenses (
    user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    type       TEXT NOT NULL DEFAULT 'trial'
               CHECK (type IN ('trial','monthly','semestrial','annual','business','lifetime')),
    status     TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','suspended')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,            -- NULL = sans expiration (lifetime)
    code       TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.licenses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS licenses_select_own ON public.licenses;
CREATE POLICY licenses_select_own ON public.licenses
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());

DROP POLICY IF EXISTS licenses_admin_all ON public.licenses;
CREATE POLICY licenses_admin_all ON public.licenses
    FOR ALL TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

-- Le client ne peut jamais écrire directement
REVOKE ALL ON public.licenses FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.licenses TO authenticated;
-- INSERT/UPDATE/DELETE n'aboutissent que si la policy admin ci-dessus le permet

-- ------------------------------------------------------------
-- 2. Licence active ? (source de vérité unique)
--    Sans ligne : essai de 14 jours depuis la création du compte.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.has_active_license(p_uid UUID DEFAULT auth.uid())
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
    SELECT COALESCE(
        (SELECT l.status = 'active'
                AND (l.expires_at IS NULL OR l.expires_at > NOW())
           FROM public.licenses l
          WHERE l.user_id = p_uid),
        (SELECT u.created_at + INTERVAL '14 days' > NOW()
                OR EXISTS (SELECT 1 FROM public.admins a WHERE lower(a.email) = lower(u.email))
           FROM auth.users u
          WHERE u.id = p_uid),
        FALSE
    );
$$;

REVOKE ALL ON FUNCTION public.has_active_license(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_active_license(UUID) TO authenticated;

-- ------------------------------------------------------------
-- 3. État de licence pour l'appli (crée l'essai au premier appel)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_license()
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_row public.licenses%ROWTYPE;
BEGIN
    IF v_uid IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
    END IF;

    INSERT INTO public.licenses (user_id, type, started_at, expires_at)
    SELECT u.id,
           CASE WHEN EXISTS (SELECT 1 FROM public.admins a WHERE lower(a.email) = lower(u.email))
                THEN 'lifetime' ELSE 'trial' END,
           u.created_at,
           CASE WHEN EXISTS (SELECT 1 FROM public.admins a WHERE lower(a.email) = lower(u.email))
                THEN NULL ELSE u.created_at + INTERVAL '14 days' END
      FROM auth.users u
     WHERE u.id = v_uid
    ON CONFLICT (user_id) DO NOTHING;

    SELECT * INTO v_row FROM public.licenses WHERE user_id = v_uid;

    RETURN jsonb_build_object(
        'ok',         true,
        'type',       v_row.type,
        'status',     v_row.status,
        'started_at', v_row.started_at,
        'expires_at', v_row.expires_at,
        'active',     public.has_active_license(v_uid),
        'server_now', NOW()
    );
END;
$$;

REVOKE ALL ON FUNCTION public.my_license() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_license() TO authenticated;

-- ------------------------------------------------------------
-- 4. activate_license : met à jour la licence côté serveur
--    (renouvellement = on prolonge à partir de la fin en cours)
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
    v_days  INT;
    v_cur   public.licenses%ROWTYPE;
    v_base  TIMESTAMPTZ;
    v_exp   TIMESTAMPTZ;
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

    v_days := CASE v_row.type
                WHEN 'monthly'    THEN 30
                WHEN 'semestrial' THEN 183
                WHEN 'annual'     THEN 365
                WHEN 'business'   THEN 30
                WHEN 'lifetime'   THEN NULL
                ELSE 30
              END;

    SELECT * INTO v_cur FROM public.licenses WHERE user_id = auth.uid() FOR UPDATE;

    -- Renouvellement : on part de la fin actuelle si elle est encore dans le futur
    v_base := GREATEST(NOW(), COALESCE(
                CASE WHEN v_cur.type <> 'trial' THEN v_cur.expires_at END, NOW()));
    v_exp  := CASE WHEN v_row.type = 'lifetime' THEN NULL
                   ELSE v_base + make_interval(days => v_days) END;

    INSERT INTO public.licenses (user_id, type, status, started_at, expires_at, code, updated_at)
    VALUES (auth.uid(),
            CASE WHEN v_row.type IN ('monthly','semestrial','annual','business','lifetime')
                 THEN v_row.type ELSE 'monthly' END,
            'active', NOW(), v_exp, v_row.code, NOW())
    ON CONFLICT (user_id) DO UPDATE
       SET type = EXCLUDED.type, status = 'active', started_at = NOW(),
           expires_at = EXCLUDED.expires_at, code = EXCLUDED.code, updated_at = NOW();

    UPDATE public.admin_codes
       SET status = 'used', activated_at = NOW()
     WHERE id = v_row.id;

    RETURN jsonb_build_object('ok', true, 'type', v_row.type, 'expires_at', v_exp);
END;
$$;

REVOKE ALL ON FUNCTION public.activate_license(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.activate_license(TEXT) TO authenticated;

-- ------------------------------------------------------------
-- 5. user_data : lecture toujours permise, écriture seulement si
--    licence active, et jamais sur la clé 'licenseInfo'
-- ------------------------------------------------------------
DROP POLICY IF EXISTS users_own_data        ON public.user_data;
DROP POLICY IF EXISTS user_data_select_own  ON public.user_data;
DROP POLICY IF EXISTS user_data_insert_own  ON public.user_data;
DROP POLICY IF EXISTS user_data_update_own  ON public.user_data;
DROP POLICY IF EXISTS user_data_delete_own  ON public.user_data;

CREATE POLICY user_data_select_own ON public.user_data
    FOR SELECT TO authenticated
    USING (auth.uid() = user_id);

CREATE POLICY user_data_insert_own ON public.user_data
    FOR INSERT TO authenticated
    WITH CHECK (auth.uid() = user_id
                AND key <> 'licenseInfo'
                AND public.has_active_license(auth.uid()));

CREATE POLICY user_data_update_own ON public.user_data
    FOR UPDATE TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id
                AND key <> 'licenseInfo'
                AND public.has_active_license(auth.uid()));

-- Suppression autorisée (droit à l'effacement), sauf la clé licence
CREATE POLICY user_data_delete_own ON public.user_data
    FOR DELETE TO authenticated
    USING (auth.uid() = user_id AND key <> 'licenseInfo');

-- Anciennes licences stockées côté client : on les retire (non fiables)
DELETE FROM public.user_data WHERE key = 'licenseInfo';

-- ------------------------------------------------------------
-- 6. Vérifications
-- ------------------------------------------------------------
SELECT 'licenses RLS' AS check, relrowsecurity::text AS result
  FROM pg_class WHERE oid = 'public.licenses'::regclass
UNION ALL
SELECT 'policies user_data', string_agg(policyname, ', ')
  FROM pg_policies WHERE tablename = 'user_data';


-- ######## sql/08_admin_comptes.sql ########
-- ============================================================
-- 08 - ADMIN : vue des vrais comptes + gestion des licences + journal
-- ============================================================
-- À exécuter dans Supabase > SQL Editor APRÈS sql/07_licence_serveur.sql.
-- Idempotent : peut être relancé sans risque.
--
-- Fournit à admin.html :
--  * admin_list_accounts()  : tous les comptes avec offre, expiration,
--                             dernière activité et usage (factures, clients)
--  * admin_set_license()    : prolonger / changer d'offre / suspendre / réactiver
--  * admin_audit            : journal de toutes les actions admin
-- Seuls les administrateurs (table admins, e-mail confirmé) peuvent les appeler.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Journal d'audit
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_audit (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    admin_email  TEXT,
    action       TEXT NOT NULL,
    target_email TEXT,
    details      JSONB
);

ALTER TABLE public.admin_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_audit_select ON public.admin_audit;
CREATE POLICY admin_audit_select ON public.admin_audit
    FOR SELECT TO authenticated
    USING (public.is_admin());

-- Aucune écriture directe : uniquement via les fonctions SECURITY DEFINER
REVOKE ALL ON public.admin_audit FROM PUBLIC, anon;
GRANT SELECT ON public.admin_audit TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.admin_audit FROM authenticated;

CREATE INDEX IF NOT EXISTS idx_admin_audit_at ON public.admin_audit (at DESC);

-- ------------------------------------------------------------
-- 2. Liste des comptes (vraies données)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_list_accounts()
RETURNS TABLE (
    user_id        UUID,
    email          TEXT,
    created_at     TIMESTAMPTZ,
    last_sign_in   TIMESTAMPTZ,
    type           TEXT,
    status         TEXT,
    expires_at     TIMESTAMPTZ,
    active         BOOLEAN,
    code           TEXT,
    is_staff       BOOLEAN,
    last_activity  TIMESTAMPTZ,
    invoices_count INT,
    clients_count  INT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT
        u.id,
        u.email::TEXT,
        u.created_at,
        u.last_sign_in_at,
        COALESCE(l.type,
                 CASE WHEN st.is_staff THEN 'lifetime' ELSE 'trial' END),
        COALESCE(l.status, 'active'),
        CASE WHEN l.user_id IS NOT NULL THEN l.expires_at
             WHEN st.is_staff THEN NULL
             ELSE u.created_at + INTERVAL '14 days' END,
        public.has_active_license(u.id),
        l.code,
        st.is_staff,
        (SELECT MAX(d.updated_at) FROM public.user_data d WHERE d.user_id = u.id),
        COALESCE((SELECT CASE WHEN jsonb_typeof(d.value) = 'array'
                              THEN jsonb_array_length(d.value) ELSE 0 END
                    FROM public.user_data d
                   WHERE d.user_id = u.id AND d.key = 'invoices'), 0),
        COALESCE((SELECT CASE WHEN jsonb_typeof(d.value) = 'array'
                              THEN jsonb_array_length(d.value) ELSE 0 END
                    FROM public.user_data d
                   WHERE d.user_id = u.id AND d.key = 'clients'), 0)
    FROM auth.users u
    LEFT JOIN public.licenses l ON l.user_id = u.id
    CROSS JOIN LATERAL (
        SELECT EXISTS (SELECT 1 FROM public.admins a
                        WHERE lower(a.email) = lower(u.email)) AS is_staff
    ) st
    ORDER BY u.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_accounts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_accounts() TO authenticated;

-- ------------------------------------------------------------
-- 3. Modifier la licence d'un compte
--    p_type   : NULL (inchangé) ou trial|monthly|semestrial|annual|business|lifetime
--    p_days   : NULL ou nombre de jours à AJOUTER (à partir de la fin en cours,
--               ou d'aujourd'hui si déjà expirée) ; ignoré pour 'lifetime'
--    p_status : NULL (inchangé) ou active|suspended
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_license(
    p_user   UUID,
    p_type   TEXT DEFAULT NULL,
    p_days   INT  DEFAULT NULL,
    p_status TEXT DEFAULT NULL,
    p_note   TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_admin_email  TEXT;
    v_target_email TEXT;
    v_cur          public.licenses%ROWTYPE;
    v_base         TIMESTAMPTZ;
    v_new_type     TEXT;
    v_new_exp      TIMESTAMPTZ;
    v_new_status   TEXT;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;

    IF p_type IS NOT NULL AND p_type NOT IN
       ('trial','monthly','semestrial','annual','business','lifetime') THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'bad_type');
    END IF;
    IF p_status IS NOT NULL AND p_status NOT IN ('active','suspended') THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'bad_status');
    END IF;
    IF p_days IS NOT NULL AND (p_days < -365 OR p_days > 3660) THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'bad_days');
    END IF;

    SELECT email INTO v_admin_email  FROM auth.users WHERE id = auth.uid();
    SELECT email INTO v_target_email FROM auth.users WHERE id = p_user;
    IF v_target_email IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'unknown_user');
    END IF;

    -- S'assurer qu'une ligne existe (essai de 14 jours depuis la création du compte)
    INSERT INTO public.licenses (user_id, type, started_at, expires_at)
    SELECT u.id, 'trial', u.created_at, u.created_at + INTERVAL '14 days'
      FROM auth.users u WHERE u.id = p_user
    ON CONFLICT (user_id) DO NOTHING;

    SELECT * INTO v_cur FROM public.licenses WHERE user_id = p_user FOR UPDATE;

    v_new_type   := COALESCE(p_type, v_cur.type);
    v_new_status := COALESCE(p_status, v_cur.status);
    v_new_exp    := v_cur.expires_at;

    IF v_new_type = 'lifetime' THEN
        v_new_exp := NULL;
    ELSIF p_days IS NOT NULL THEN
        v_base    := GREATEST(NOW(), COALESCE(v_cur.expires_at, NOW()));
        v_new_exp := v_base + make_interval(days => p_days);
    ELSIF v_cur.type = 'lifetime' AND p_type IS NOT NULL THEN
        -- passage de « à vie » à une offre datée sans durée : on repart d'aujourd'hui
        v_new_exp := NOW();
    END IF;

    UPDATE public.licenses
       SET type = v_new_type,
           status = v_new_status,
           expires_at = v_new_exp,
           updated_at = NOW()
     WHERE user_id = p_user;

    INSERT INTO public.admin_audit (admin_email, action, target_email, details)
    VALUES (v_admin_email, 'set_license', v_target_email,
            jsonb_build_object(
                'before', jsonb_build_object('type', v_cur.type, 'status', v_cur.status, 'expires_at', v_cur.expires_at),
                'after',  jsonb_build_object('type', v_new_type, 'status', v_new_status, 'expires_at', v_new_exp),
                'note',   p_note));

    RETURN jsonb_build_object('ok', true, 'type', v_new_type, 'status', v_new_status,
                              'expires_at', v_new_exp);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_license(UUID, TEXT, INT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_license(UUID, TEXT, INT, TEXT, TEXT) TO authenticated;

-- ------------------------------------------------------------
-- 4. Vérification
-- ------------------------------------------------------------
SELECT 'admin_audit RLS' AS check, relrowsecurity::text AS result
  FROM pg_class WHERE oid = 'public.admin_audit'::regclass
UNION ALL
SELECT 'fonctions', string_agg(proname, ', ')
  FROM pg_proc WHERE proname IN ('admin_list_accounts', 'admin_set_license');


-- ######## sql/09_periode_de_grace.sql ########
-- ============================================================
-- 09 - PÉRIODE DE GRÂCE (3 jours après la fin d'un abonnement payant)
-- ============================================================
-- À exécuter dans Supabase > SQL Editor (nouvelle requête), APRÈS 07 et 08.
-- Idempotent. Pour changer la durée : modifier license_grace_days() ci-dessous.
--
--  * Abonnement payant (mensuel / annuel / fondateur...) : le compte reste
--    pleinement utilisable pendant 3 jours après la date de fin, puis passe
--    en lecture seule.
--  * Essai gratuit : pas de grâce (fin stricte au 14e jour).
--  * Compte suspendu : aucune grâce.
-- ============================================================

CREATE OR REPLACE FUNCTION public.license_grace_days()
RETURNS INT
LANGUAGE sql IMMUTABLE
AS $$ SELECT 3 $$;

REVOKE ALL ON FUNCTION public.license_grace_days() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.license_grace_days() TO authenticated;

CREATE OR REPLACE FUNCTION public.has_active_license(p_uid UUID DEFAULT auth.uid())
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
    SELECT COALESCE(
        (SELECT l.status = 'active'
                AND (l.expires_at IS NULL
                     OR l.expires_at
                        + CASE WHEN l.type = 'trial' THEN INTERVAL '0'
                               ELSE make_interval(days => public.license_grace_days()) END
                        > NOW())
           FROM public.licenses l
          WHERE l.user_id = p_uid),
        (SELECT u.created_at + INTERVAL '14 days' > NOW()
                OR EXISTS (SELECT 1 FROM public.admins a WHERE lower(a.email) = lower(u.email))
           FROM auth.users u
          WHERE u.id = p_uid),
        FALSE
    );
$$;

REVOKE ALL ON FUNCTION public.has_active_license(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_active_license(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.my_license()
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_row public.licenses%ROWTYPE;
    v_grace TIMESTAMPTZ;
BEGIN
    IF v_uid IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
    END IF;

    INSERT INTO public.licenses (user_id, type, started_at, expires_at)
    SELECT u.id,
           CASE WHEN EXISTS (SELECT 1 FROM public.admins a WHERE lower(a.email) = lower(u.email))
                THEN 'lifetime' ELSE 'trial' END,
           u.created_at,
           CASE WHEN EXISTS (SELECT 1 FROM public.admins a WHERE lower(a.email) = lower(u.email))
                THEN NULL ELSE u.created_at + INTERVAL '14 days' END
      FROM auth.users u
     WHERE u.id = v_uid
    ON CONFLICT (user_id) DO NOTHING;

    SELECT * INTO v_row FROM public.licenses WHERE user_id = v_uid;

    v_grace := CASE WHEN v_row.status = 'active'
                         AND v_row.type <> 'trial'
                         AND v_row.expires_at IS NOT NULL
                    THEN v_row.expires_at + make_interval(days => public.license_grace_days())
               END;

    RETURN jsonb_build_object(
        'ok',          true,
        'type',        v_row.type,
        'status',      v_row.status,
        'started_at',  v_row.started_at,
        'expires_at',  v_row.expires_at,
        'grace_until', v_grace,
        'active',      public.has_active_license(v_uid),
        'server_now',  NOW()
    );
END;
$$;

REVOKE ALL ON FUNCTION public.my_license() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_license() TO authenticated;

SELECT 'grâce (jours)' AS check, public.license_grace_days()::text AS result;


-- ######## sql/10_anti_abus.sql ########
-- ============================================================
-- 10 - ANTI-ABUS : limites côté base de données
-- ============================================================
-- À exécuter dans Supabase > SQL Editor (nouvelle requête). Idempotent.
--
-- Protège la base (et ton quota gratuit) contre :
--  * le spam de demandes d'abonnement (une personne qui en envoie en boucle)
--  * le remplissage de la base par un compte malveillant (données énormes)
--  * l'essai de codes d'activation au hasard
-- Les administrateurs ne sont jamais limités.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Demandes d'abonnement : 1 en attente par client, 5 par 24 h,
--    et un plafond global de 100 par heure (coupe-circuit anti-inondation)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.limit_subscription_requests()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
    IF public.is_admin() THEN
        RETURN NEW;
    END IF;

    IF EXISTS (SELECT 1 FROM public.subscription_requests r
                WHERE lower(r.client_email) = lower(NEW.client_email)
                  AND r.status = 'pending') THEN
        RAISE EXCEPTION 'rate_limited: demande déjà en attente' USING ERRCODE = 'P0001';
    END IF;

    IF (SELECT count(*) FROM public.subscription_requests r
         WHERE lower(r.client_email) = lower(NEW.client_email)
           AND r.created_at > NOW() - INTERVAL '24 hours') >= 5 THEN
        RAISE EXCEPTION 'rate_limited: trop de demandes aujourd''hui' USING ERRCODE = 'P0001';
    END IF;

    IF (SELECT count(*) FROM public.subscription_requests r
         WHERE r.created_at > NOW() - INTERVAL '1 hour') >= 100 THEN
        RAISE EXCEPTION 'rate_limited: service momentanément saturé' USING ERRCODE = 'P0001';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_limit_subscription_requests ON public.subscription_requests;
CREATE TRIGGER trg_limit_subscription_requests
    BEFORE INSERT ON public.subscription_requests
    FOR EACH ROW EXECUTE FUNCTION public.limit_subscription_requests();

-- ------------------------------------------------------------
-- 2. Données utilisateur : au plus 100 clés par compte, 5 Mo par clé
--    (les vraies données d'un client sont très en dessous)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.limit_user_data()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
    IF public.is_admin() THEN
        RETURN NEW;
    END IF;

    IF octet_length(NEW.value::text) > 5 * 1024 * 1024 THEN
        RAISE EXCEPTION 'quota: donnée trop volumineuse' USING ERRCODE = 'P0001';
    END IF;

    IF TG_OP = 'INSERT' AND
       (SELECT count(*) FROM public.user_data d WHERE d.user_id = NEW.user_id) >= 100 THEN
        RAISE EXCEPTION 'quota: trop de clés' USING ERRCODE = 'P0001';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_limit_user_data ON public.user_data;
CREATE TRIGGER trg_limit_user_data
    BEFORE INSERT OR UPDATE ON public.user_data
    FOR EACH ROW EXECUTE FUNCTION public.limit_user_data();

-- ------------------------------------------------------------
-- 3. Codes d'activation : 10 échecs par heure et par compte
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.code_attempts (
    id      BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL,
    at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_code_attempts_user_at ON public.code_attempts (user_id, at DESC);
ALTER TABLE public.code_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.code_attempts FROM PUBLIC, anon, authenticated;

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
    v_days  INT;
    v_cur   public.licenses%ROWTYPE;
    v_base  TIMESTAMPTZ;
    v_exp   TIMESTAMPTZ;
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
    END IF;

    -- Nettoyage léger des anciennes tentatives
    DELETE FROM public.code_attempts WHERE at < NOW() - INTERVAL '2 days';

    IF (SELECT count(*) FROM public.code_attempts
         WHERE user_id = auth.uid() AND at > NOW() - INTERVAL '1 hour') >= 10 THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'too_many_attempts');
    END IF;

    SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();

    SELECT * INTO v_row
    FROM public.admin_codes
    WHERE code = upper(trim(p_code))
    FOR UPDATE;

    IF NOT FOUND THEN
        INSERT INTO public.code_attempts (user_id) VALUES (auth.uid());
        RETURN jsonb_build_object('ok', false, 'reason', 'invalid');
    END IF;
    IF v_row.status = 'used' THEN
        INSERT INTO public.code_attempts (user_id) VALUES (auth.uid());
        RETURN jsonb_build_object('ok', false, 'reason', 'used');
    END IF;
    IF v_row.status = 'revoked' THEN
        INSERT INTO public.code_attempts (user_id) VALUES (auth.uid());
        RETURN jsonb_build_object('ok', false, 'reason', 'revoked');
    END IF;
    IF v_row.client_email IS NOT NULL
       AND lower(v_row.client_email) <> lower(v_email) THEN
        INSERT INTO public.code_attempts (user_id) VALUES (auth.uid());
        RETURN jsonb_build_object('ok', false, 'reason', 'wrong_email');
    END IF;

    v_days := CASE v_row.type
                WHEN 'monthly'    THEN 30
                WHEN 'semestrial' THEN 183
                WHEN 'annual'     THEN 365
                WHEN 'business'   THEN 30
                WHEN 'lifetime'   THEN NULL
                ELSE 30
              END;

    SELECT * INTO v_cur FROM public.licenses WHERE user_id = auth.uid() FOR UPDATE;

    v_base := GREATEST(NOW(), COALESCE(
                CASE WHEN v_cur.type <> 'trial' THEN v_cur.expires_at END, NOW()));
    v_exp  := CASE WHEN v_row.type = 'lifetime' THEN NULL
                   ELSE v_base + make_interval(days => v_days) END;

    INSERT INTO public.licenses (user_id, type, status, started_at, expires_at, code, updated_at)
    VALUES (auth.uid(),
            CASE WHEN v_row.type IN ('monthly','semestrial','annual','business','lifetime')
                 THEN v_row.type ELSE 'monthly' END,
            'active', NOW(), v_exp, v_row.code, NOW())
    ON CONFLICT (user_id) DO UPDATE
       SET type = EXCLUDED.type, status = 'active', started_at = NOW(),
           expires_at = EXCLUDED.expires_at, code = EXCLUDED.code, updated_at = NOW();

    UPDATE public.admin_codes
       SET status = 'used', activated_at = NOW()
     WHERE id = v_row.id;

    RETURN jsonb_build_object('ok', true, 'type', v_row.type, 'expires_at', v_exp);
END;
$$;

REVOKE ALL ON FUNCTION public.activate_license(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.activate_license(TEXT) TO authenticated;

SELECT 'triggers' AS check, string_agg(tgname, ', ') AS result
  FROM pg_trigger
 WHERE tgname IN ('trg_limit_subscription_requests', 'trg_limit_user_data');


-- ######## sql/12_admin_supprimer_compte.sql ########
-- ============================================================
-- 12 - ADMIN : supprimer un compte (de test) depuis le bouton « Supprimer »
-- ============================================================
-- À exécuter dans Supabase > SQL Editor (nouvelle requête), après 08 et 10. Idempotent.
-- Supprime DÉFINITIVEMENT le compte et ses données, licence, codes, paiements enregistrés
-- et demandes. Refuse les administrateurs et ton propre compte. Trace l'action dans le Journal.
-- ============================================================

CREATE OR REPLACE FUNCTION public.admin_delete_account(p_user UUID)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_admin_email  TEXT;
    v_email        TEXT;
    n_data INT; n_lic INT; n_codes INT; n_pay INT; n_req INT;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;

    IF p_user = auth.uid() THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'self');
    END IF;

    SELECT email INTO v_email FROM auth.users WHERE id = p_user;
    IF v_email IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'unknown_user');
    END IF;
    IF EXISTS (SELECT 1 FROM public.admins a WHERE lower(a.email) = lower(v_email)) THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'is_admin');
    END IF;

    SELECT email INTO v_admin_email FROM auth.users WHERE id = auth.uid();

    DELETE FROM public.user_data WHERE user_id = p_user;            GET DIAGNOSTICS n_data  = ROW_COUNT;
    DELETE FROM public.licenses  WHERE user_id = p_user;            GET DIAGNOSTICS n_lic   = ROW_COUNT;
    DELETE FROM public.code_attempts WHERE user_id = p_user;
    DELETE FROM public.admin_codes WHERE lower(client_email) = lower(v_email);             GET DIAGNOSTICS n_codes = ROW_COUNT;
    DELETE FROM public.admin_payments WHERE lower(client_email) = lower(v_email);          GET DIAGNOSTICS n_pay   = ROW_COUNT;
    DELETE FROM public.subscription_requests WHERE lower(client_email) = lower(v_email);   GET DIAGNOSTICS n_req   = ROW_COUNT;
    DELETE FROM auth.users WHERE id = p_user;

    INSERT INTO public.admin_audit (admin_email, action, target_email, details)
    VALUES (v_admin_email, 'delete_account', v_email,
            jsonb_build_object('data_rows', n_data, 'licenses', n_lic, 'codes', n_codes,
                               'payments', n_pay, 'requests', n_req));

    RETURN jsonb_build_object('ok', true, 'email', v_email,
                              'codes', n_codes, 'payments', n_pay, 'requests', n_req);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_delete_account(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_account(UUID) TO authenticated;

SELECT 'admin_delete_account' AS check, count(*)::text AS result
  FROM pg_proc WHERE proname = 'admin_delete_account';


-- ######## sql/13_profil_assistant.sql ########
-- ============================================================
-- 13 - PROFIL « ASSISTANT » (saisie des paiements reçus, sans droits de licence)
-- ============================================================
-- À exécuter dans Supabase > SQL Editor (nouvelle requête), après 08 et 12. Idempotent.
--
-- L'assistant peut :
--   * voir la liste des paiements et les demandes d'abonnement en attente
--   * enregistrer un paiement reçu en banque (offres Mensuel / Annuel / Fondateur)
--   * annuler SA propre saisie pendant 24 h (erreur de frappe)
-- L'assistant ne peut PAS : voir ou créer des codes, activer/prolonger/suspendre une licence,
-- voir les comptes clients, supprimer quoi que ce soit d'autre, ni gérer les admins.
-- Chaque saisie est journalisée (Journal admin) avec le nom de la personne.
-- ============================================================

-- 1. Table des assistants (gérée uniquement par les admins)
CREATE TABLE IF NOT EXISTS public.staff (
    email      TEXT PRIMARY KEY,
    role       TEXT NOT NULL DEFAULT 'assistant' CHECK (role IN ('assistant')),
    added_by   TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.staff ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff FROM PUBLIC, anon;
GRANT SELECT ON public.staff TO authenticated;
DROP POLICY IF EXISTS staff_admin_select ON public.staff;
CREATE POLICY staff_admin_select ON public.staff
    FOR SELECT TO authenticated USING (public.is_admin());
-- Aucune écriture directe : uniquement via admin_add_staff / admin_remove_staff

-- 2. Identité
CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM auth.users u
          JOIN public.staff s ON lower(s.email) = lower(u.email)
         WHERE u.id = auth.uid()
           AND u.email_confirmed_at IS NOT NULL
    );
$$;
REVOKE ALL ON FUNCTION public.is_staff() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_staff() TO authenticated;

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
        'is_staff',  public.is_staff(),
        'email',     (SELECT email FROM auth.users WHERE id = auth.uid())
    );
$$;

-- 3. Paiements : colonne « saisi par » + droits de l'assistant
ALTER TABLE public.admin_payments ADD COLUMN IF NOT EXISTS entered_by TEXT;

DROP POLICY IF EXISTS pay_staff_select ON public.admin_payments;
CREATE POLICY pay_staff_select ON public.admin_payments
    FOR SELECT TO authenticated USING (public.is_staff());

DROP POLICY IF EXISTS pay_staff_insert ON public.admin_payments;
CREATE POLICY pay_staff_insert ON public.admin_payments
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_staff()
        AND amount > 0 AND amount <= 20000
        AND type IN ('monthly', 'annual', 'founder')
        AND payment_mode IN ('virement', 'cmi', 'cash', 'cheque')
        AND payment_date BETWEEN CURRENT_DATE - 400 AND CURRENT_DATE + 1
    );

GRANT SELECT, INSERT ON public.admin_payments TO authenticated;

-- Qui a saisi quoi : renseigné par le serveur (non falsifiable) + journal
CREATE OR REPLACE FUNCTION public.admin_payments_stamp()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE v_email TEXT;
BEGIN
    SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();
    NEW.entered_by := v_email;
    IF v_email IS NOT NULL AND NOT public.is_admin() THEN
        INSERT INTO public.admin_audit (admin_email, action, target_email, details)
        VALUES (v_email, 'staff_payment', NEW.client_email,
                jsonb_build_object('amount', NEW.amount, 'type', NEW.type,
                                   'mode', NEW.payment_mode, 'note', NEW.note));
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_admin_payments_stamp ON public.admin_payments;
CREATE TRIGGER trg_admin_payments_stamp
    BEFORE INSERT ON public.admin_payments
    FOR EACH ROW EXECUTE FUNCTION public.admin_payments_stamp();

-- 4. Annuler sa propre saisie (24 h)
CREATE OR REPLACE FUNCTION public.staff_cancel_payment(p_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_email TEXT;
    v_row   public.admin_payments%ROWTYPE;
BEGIN
    IF NOT public.is_staff() THEN
        RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;
    SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();
    SELECT * INTO v_row FROM public.admin_payments WHERE id = p_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'unknown');
    END IF;
    IF lower(coalesce(v_row.entered_by, '')) <> lower(v_email)
       OR v_row.created_at < NOW() - INTERVAL '24 hours' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'not_allowed');
    END IF;
    DELETE FROM public.admin_payments WHERE id = p_id;
    INSERT INTO public.admin_audit (admin_email, action, target_email, details)
    VALUES (v_email, 'staff_payment_cancel', v_row.client_email,
            jsonb_build_object('amount', v_row.amount, 'type', v_row.type, 'note', v_row.note));
    RETURN jsonb_build_object('ok', true);
END;
$$;
REVOKE ALL ON FUNCTION public.staff_cancel_payment(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_cancel_payment(UUID) TO authenticated;

-- 5. Demandes en attente, SANS le code de licence
CREATE OR REPLACE FUNCTION public.staff_open_requests()
RETURNS TABLE (
    id           UUID,
    created_at   TIMESTAMPTZ,
    client_email TEXT,
    tier         TEXT,
    final_price  NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
    IF NOT (public.is_staff() OR public.is_admin()) THEN
        RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
    SELECT r.id, r.created_at, r.client_email::TEXT, r.tier::TEXT, r.final_price::NUMERIC
      FROM public.subscription_requests r
     WHERE r.status = 'pending'
     ORDER BY r.created_at DESC
     LIMIT 200;
END;
$$;
REVOKE ALL ON FUNCTION public.staff_open_requests() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_open_requests() TO authenticated;

-- 6. Gestion des assistants (Master uniquement, journalisée)
CREATE OR REPLACE FUNCTION public.admin_add_staff(p_email TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE v_me TEXT; v_target TEXT := lower(trim(p_email));
BEGIN
    IF NOT public.is_master() THEN
        RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;
    IF v_target IS NULL OR v_target = '' OR v_target NOT LIKE '%@%' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'bad_email');
    END IF;
    IF EXISTS (SELECT 1 FROM public.admins a WHERE lower(a.email) = v_target) THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'is_admin');
    END IF;
    SELECT email INTO v_me FROM auth.users WHERE id = auth.uid();
    INSERT INTO public.staff (email, added_by) VALUES (v_target, v_me)
    ON CONFLICT (email) DO NOTHING;
    INSERT INTO public.admin_audit (admin_email, action, target_email, details)
    VALUES (v_me, 'add_staff', v_target, '{}'::jsonb);
    RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_remove_staff(p_email TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE v_me TEXT; v_target TEXT := lower(trim(p_email));
BEGIN
    IF NOT public.is_master() THEN
        RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;
    SELECT email INTO v_me FROM auth.users WHERE id = auth.uid();
    DELETE FROM public.staff WHERE lower(email) = v_target;
    INSERT INTO public.admin_audit (admin_email, action, target_email, details)
    VALUES (v_me, 'remove_staff', v_target, '{}'::jsonb);
    RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_add_staff(TEXT), public.admin_remove_staff(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_add_staff(TEXT), public.admin_remove_staff(TEXT) TO authenticated;

SELECT 'profil assistant' AS check,
       string_agg(proname, ', ' ORDER BY proname) AS result
  FROM pg_proc
 WHERE proname IN ('is_staff','staff_cancel_payment','staff_open_requests','admin_add_staff','admin_remove_staff');


-- ######## sql/14_numerotation_et_verrouillage.sql ########
-- ============================================================
-- 14 — Numérotation attribuée par le serveur + verrouillage des factures émises
--      + journal serveur infalsifiable
--
-- À exécuter dans Supabase > SQL Editor (nouvelle requête), APRÈS sauvegarde et
-- AVANT de mettre en ligne la version de l'application qui en dépend.
-- Aucune donnée existante n'est supprimée ni modifiée.
--
-- 1) next_doc_number(type, plancher) : numéro séquentiel unique par compte et par
--    type (invoice / quote / credit). Le plancher (compteur déjà utilisé dans le
--    navigateur) n'est lu QU'À LA PREMIÈRE ATTRIBUTION d'un compte : ensuite seul
--    le serveur décide, ce qui empêche de gonfler ou de rejouer un compteur.
-- 2) Déclencheur sur user_data (clé 'invoices'), à l'insertion, à la mise à jour
--    et à la suppression :
--      - une facture émise (statut autre que « draft ») ne peut être ni supprimée
--        ni modifiée (numéro, date, client, lignes, montants figés) ;
--      - toute facture nouvellement émise doit porter un numéro déjà attribué par
--        le serveur et unique ; sinon l'écriture est refusée ;
--      - la ligne 'invoices' ne peut pas être supprimée tant qu'elle contient une
--        facture émise (sauf suppression du compte lui-même).
-- 3) doc_events : journal serveur en ajout seul (aucun droit d'écriture pour les
--    utilisateurs) alimenté automatiquement par le déclencheur.
--
-- Retour arrière (si besoin) :
--   DROP TRIGGER IF EXISTS trg_guard_issued_invoices_ins ON public.user_data;
--   DROP TRIGGER IF EXISTS trg_guard_issued_invoices ON public.user_data;
--   DROP TRIGGER IF EXISTS trg_guard_issued_invoices_del ON public.user_data;
--   DROP FUNCTION IF EXISTS public.guard_issued_invoices();
--   DROP FUNCTION IF EXISTS public.guard_issued_invoices_del();
--   DROP FUNCTION IF EXISTS public.next_doc_number(text, int);
--   DROP TABLE IF EXISTS public.doc_events;
--   DROP TABLE IF EXISTS public.doc_counters;
-- ============================================================

CREATE TABLE IF NOT EXISTS public.doc_counters (
    user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    doc_type   TEXT NOT NULL CHECK (doc_type IN ('invoice', 'quote', 'credit')),
    last_value INT  NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, doc_type)
);

ALTER TABLE public.doc_counters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS doc_counters_select_own ON public.doc_counters;
CREATE POLICY doc_counters_select_own ON public.doc_counters
    FOR SELECT USING (auth.uid() = user_id);
-- Aucune politique d'écriture : seul next_doc_number() (SECURITY DEFINER) incrémente.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.doc_counters FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.next_doc_number(p_type TEXT, p_floor INT DEFAULT 0)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_val INT;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'NON_AUTHENTIFIE';
    END IF;
    IF p_type NOT IN ('invoice', 'quote', 'credit') THEN
        RAISE EXCEPTION 'TYPE_INVALIDE';
    END IF;
    IF NOT public.has_active_license(v_uid) THEN
        RAISE EXCEPTION 'LICENCE_INACTIVE';
    END IF;
    -- Première attribution : on part du compteur local (migration). Ensuite : +1 serveur.
    -- L'instruction est atomique : deux appels simultanés reçoivent deux numéros distincts.
    INSERT INTO public.doc_counters AS c (user_id, doc_type, last_value)
    VALUES (v_uid, p_type, LEAST(GREATEST(COALESCE(p_floor, 0), 0), 1000000) + 1)
    ON CONFLICT (user_id, doc_type)
    DO UPDATE SET last_value = c.last_value + 1
    RETURNING last_value INTO v_val;
    RETURN v_val;
END;
$$;

REVOKE ALL ON FUNCTION public.next_doc_number(TEXT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.next_doc_number(TEXT, INT) TO authenticated;

-- ------------------------------------------------------------
-- Journal serveur en ajout seul
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.doc_events (
    id      BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    ts      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    action  TEXT NOT NULL,
    doc_id  TEXT,
    number  TEXT,
    detail  TEXT
);
ALTER TABLE public.doc_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS doc_events_select_own ON public.doc_events;
CREATE POLICY doc_events_select_own ON public.doc_events
    FOR SELECT USING (auth.uid() = user_id);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.doc_events FROM anon, authenticated;
CREATE INDEX IF NOT EXISTS doc_events_user_ts ON public.doc_events (user_id, ts DESC);

-- ------------------------------------------------------------
-- Verrouillage des factures émises (clé 'invoices' de user_data)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_issued_invoices()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    o        JSONB;
    n        JSONB;
    f        TEXT;
    old_arr  JSONB := CASE WHEN TG_OP = 'UPDATE' AND OLD.key = 'invoices' AND jsonb_typeof(OLD.value) = 'array' THEN OLD.value ELSE '[]'::jsonb END;
    seq      INT;
    ctype    TEXT;
    last_v   INT;
    was      JSONB;
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.key = 'invoices' AND NEW.key <> 'invoices'
       AND jsonb_typeof(OLD.value) = 'array'
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(OLD.value) e WHERE COALESCE(e->>'status', 'draft') <> 'draft') THEN
        RAISE EXCEPTION 'FACTURE_VERROUILLEE: déplacement interdit (factures émises)';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.user_id <> OLD.user_id THEN
        RAISE EXCEPTION 'FACTURE_VERROUILLEE: changement de propriétaire interdit';
    END IF;
    IF NEW.key <> 'invoices' THEN
        RETURN NEW;
    END IF;
    IF jsonb_typeof(NEW.value) <> 'array' THEN
        RAISE EXCEPTION 'FACTURE_VERROUILLEE: format invalide';
    END IF;

    -- 1) Les factures déjà émises restent intactes
    FOR o IN SELECT e FROM jsonb_array_elements(old_arr) AS e LOOP
        IF COALESCE(o->>'status', 'draft') = 'draft' THEN
            CONTINUE;
        END IF;
        SELECT e INTO n FROM jsonb_array_elements(NEW.value) AS e
        WHERE e->>'id' = o->>'id' LIMIT 1;
        IF n IS NULL THEN
            RAISE EXCEPTION 'FACTURE_VERROUILLEE: suppression interdite (%)', o->>'number';
        END IF;
        IF COALESCE(n->>'status', 'draft') = 'draft' THEN
            RAISE EXCEPTION 'FACTURE_VERROUILLEE: retour au brouillon interdit (%)', o->>'number';
        END IF;
        FOREACH f IN ARRAY ARRAY['number', 'type', 'date', 'clientId', 'clientName', 'clientICE',
                                 'items', 'totalHT', 'totalTVA', 'totalTTC', 'relatedInvoiceId']
        LOOP
            IF (o -> f) IS DISTINCT FROM (n -> f) THEN
                RAISE EXCEPTION 'FACTURE_VERROUILLEE: modification interdite (% / %)', o->>'number', f;
            END IF;
        END LOOP;
        IF (o->>'status') IS DISTINCT FROM (n->>'status') THEN
            INSERT INTO public.doc_events(user_id, action, doc_id, number, detail)
            VALUES (NEW.user_id, 'statut', o->>'id', o->>'number', (o->>'status') || ' -> ' || (n->>'status'));
        END IF;
    END LOOP;

    -- 2) Toute facture nouvellement émise porte un numéro attribué par le serveur, unique
    FOR n IN SELECT e FROM jsonb_array_elements(NEW.value) AS e LOOP
        IF COALESCE(n->>'status', 'draft') = 'draft' THEN
            CONTINUE;
        END IF;
        SELECT e INTO was FROM jsonb_array_elements(old_arr) AS e WHERE e->>'id' = n->>'id' LIMIT 1;
        IF was IS NOT NULL AND COALESCE(was->>'status', 'draft') <> 'draft' THEN
            CONTINUE;   -- déjà émise avant : contrôlée au point 1
        END IF;

        ctype := CASE WHEN n->>'type' = 'credit' THEN 'credit' ELSE 'invoice' END;
        IF (n->>'number') !~ '-[0-9]+$' THEN
            RAISE EXCEPTION 'NUMERO_NON_ATTRIBUE: numéro invalide (%)', n->>'number';
        END IF;
        seq := ((regexp_match(n->>'number', '-([0-9]+)$'))[1])::INT;
        SELECT last_value INTO last_v FROM public.doc_counters
        WHERE user_id = NEW.user_id AND doc_type = ctype;
        IF last_v IS NULL OR seq > last_v THEN
            RAISE EXCEPTION 'NUMERO_NON_ATTRIBUE: numéro % non attribué par le serveur', n->>'number';
        END IF;
        IF (SELECT count(*) FROM jsonb_array_elements(NEW.value) AS e
            WHERE e->>'number' = n->>'number') > 1 THEN
            RAISE EXCEPTION 'NUMERO_EN_DOUBLE: %', n->>'number';
        END IF;
        INSERT INTO public.doc_events(user_id, action, doc_id, number, detail)
        VALUES (NEW.user_id, CASE WHEN ctype = 'credit' THEN 'avoir' ELSE 'emission' END,
                n->>'id', n->>'number', 'total TTC ' || COALESCE(n->>'totalTTC', '?'));
    END LOOP;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_issued_invoices_del()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
    IF OLD.key = 'invoices' AND jsonb_typeof(OLD.value) = 'array'
       AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = OLD.user_id)      -- pas une suppression de compte
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(OLD.value) e
                   WHERE COALESCE(e->>'status', 'draft') <> 'draft') THEN
        RAISE EXCEPTION 'FACTURE_VERROUILLEE: suppression interdite (factures émises)';
    END IF;
    RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_issued_invoices() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_issued_invoices_del() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_issued_invoices_ins ON public.user_data;
CREATE TRIGGER trg_guard_issued_invoices_ins
    BEFORE INSERT ON public.user_data
    FOR EACH ROW
    WHEN (NEW.key = 'invoices')
    EXECUTE FUNCTION public.guard_issued_invoices();

DROP TRIGGER IF EXISTS trg_guard_issued_invoices ON public.user_data;
CREATE TRIGGER trg_guard_issued_invoices
    BEFORE UPDATE ON public.user_data
    FOR EACH ROW
    WHEN (OLD.key = 'invoices' OR NEW.key = 'invoices')
    EXECUTE FUNCTION public.guard_issued_invoices();

DROP TRIGGER IF EXISTS trg_guard_issued_invoices_del ON public.user_data;
CREATE TRIGGER trg_guard_issued_invoices_del
    BEFORE DELETE ON public.user_data
    FOR EACH ROW
    WHEN (OLD.key = 'invoices')
    EXECUTE FUNCTION public.guard_issued_invoices_del();

-- ------------------------------------------------------------
-- Durcissement : les fonctions de déclencheur des scripts 10 et 13 n'ont pas à être
-- exécutables par les utilisateurs (appel direct impossible de toute façon, mais
-- inutile de les exposer). Les déclencheurs continuent de fonctionner.
-- ------------------------------------------------------------
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT p.oid::regprocedure AS sig
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.prorettype = 'trigger'::regtype
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    END LOOP;
END $$;


-- ######## CONTRÔLES FINAUX ########
SELECT to_regprocedure('public.next_doc_number(text,integer)') IS NOT NULL AS numerotation_ok,
       (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity) AS tables_sans_rls,
       (SELECT count(*) FROM pg_tables WHERE schemaname='public') AS tables_public;
