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

ALTER TABLE admin_codes DISABLE ROW LEVEL SECURITY;
ALTER TABLE admin_payments DISABLE ROW LEVEL SECURITY;

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

ALTER TABLE subscription_requests DISABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════
-- 4. PARAMÈTRES ADMIN (mot de passe)
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS admin_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE admin_settings DISABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════
-- ✅ VÉRIFICATION FINALE
-- ═══════════════════════════════════════════
SELECT 
    tablename, 
    rowsecurity,
    CASE 
        WHEN tablename = 'user_data' AND rowsecurity = true THEN '✅ OK (sécurisé)'
        WHEN tablename != 'user_data' AND rowsecurity = false THEN '✅ OK (admin)'
        ELSE '⚠️ À vérifier'
    END AS status
FROM pg_tables 
WHERE tablename IN ('user_data', 'admin_codes', 'admin_payments', 'subscription_requests', 'admin_settings')
ORDER BY tablename;
