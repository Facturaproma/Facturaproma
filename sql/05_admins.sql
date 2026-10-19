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
