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

-- RLS désactivé (accès via mot de passe admin)
ALTER TABLE admins DISABLE ROW LEVEL SECURITY;

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
-- Le compte Master sera créé automatiquement à la 
-- première connexion avec :
--   Email : webnour@gmail.com
--   Password : Saadnawal79@@££ (mot de passe par défaut)
--
-- Changez-le immédiatement après votre première connexion !
-- ============================================
