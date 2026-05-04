-- ============================================
-- 01 - INITIAL SETUP
-- Table principale pour les données utilisateurs
-- ============================================

-- Table : Données utilisateur (clé/valeur générique)
CREATE TABLE IF NOT EXISTS user_data (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, key)
);

-- Indexes pour performance
CREATE INDEX IF NOT EXISTS idx_user_data_lookup ON user_data(user_id, key);
CREATE INDEX IF NOT EXISTS idx_user_data_updated ON user_data(updated_at);

-- Row Level Security (CRITIQUE pour la sécurité)
ALTER TABLE user_data ENABLE ROW LEVEL SECURITY;

-- Policy : chaque utilisateur ne voit QUE ses propres données
DROP POLICY IF EXISTS "users_own_data" ON user_data;
CREATE POLICY "users_own_data" ON user_data 
    FOR ALL USING (auth.uid() = user_id);

-- Trigger pour updated_at automatique
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

SELECT '✓ user_data créée' AS message;
