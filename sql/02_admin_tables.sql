-- ============================================
-- 02 - ADMIN TABLES
-- Codes de licence + paiements
-- ============================================

-- Table : Codes de licence
CREATE TABLE IF NOT EXISTS admin_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL,                  -- lifetime / monthly / business
    client_email TEXT,
    note TEXT,
    status TEXT DEFAULT 'pending',       -- pending / used / revoked
    created_at TIMESTAMPTZ DEFAULT NOW(),
    activated_at TIMESTAMPTZ
);

-- Table : Paiements reçus
CREATE TABLE IF NOT EXISTS admin_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_email TEXT NOT NULL,
    payment_date DATE NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    type TEXT NOT NULL,
    payment_mode TEXT NOT NULL,          -- virement / cmi / cash / cheque
    note TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_admin_codes_email ON admin_codes(client_email);
CREATE INDEX IF NOT EXISTS idx_admin_codes_status ON admin_codes(status);
CREATE INDEX IF NOT EXISTS idx_admin_payments_email ON admin_payments(client_email);
CREATE INDEX IF NOT EXISTS idx_admin_payments_date ON admin_payments(payment_date);

-- ⚠️ RLS désactivé pour ces tables admin
-- (accessibles uniquement via la page admin protégée par mot de passe)
ALTER TABLE admin_codes DISABLE ROW LEVEL SECURITY;
ALTER TABLE admin_payments DISABLE ROW LEVEL SECURITY;

SELECT '✓ admin_codes & admin_payments créées' AS message;
