-- ============================================
-- 04 - ADMIN SETTINGS
-- Stockage du mot de passe admin (hash SHA-256)
-- ============================================

CREATE TABLE IF NOT EXISTS admin_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS désactivé (accès via mot de passe admin)
ALTER TABLE admin_settings DISABLE ROW LEVEL SECURITY;

SELECT '✓ admin_settings créée' AS message;

-- ============================================
-- En cas d'oubli du mot de passe admin :
-- DELETE FROM admin_settings WHERE key = 'admin_password_hash';
-- → Ça remet le mot de passe par défaut
-- ============================================
