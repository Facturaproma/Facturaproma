-- ============================================
-- 03 - SUBSCRIPTION REQUESTS
-- Demandes d'abonnement créées par les clients
-- ============================================

CREATE TABLE IF NOT EXISTS subscription_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_email TEXT NOT NULL,
    company_name TEXT,
    company_status TEXT,
    tier TEXT NOT NULL,                  -- lifetime / monthly / business
    base_price DECIMAL(10,2) NOT NULL,
    final_price DECIMAL(10,2) NOT NULL,
    promo_code TEXT,
    status TEXT DEFAULT 'pending',       -- pending / contacted / processed / rejected
    license_code TEXT,                   -- Code généré quand traité
    note TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_subscription_requests_status ON subscription_requests(status);
CREATE INDEX IF NOT EXISTS idx_subscription_requests_email ON subscription_requests(client_email);
CREATE INDEX IF NOT EXISTS idx_subscription_requests_created ON subscription_requests(created_at DESC);

-- ⚠️ RLS désactivé (admin accède via mot de passe, clients via INSERT public)
ALTER TABLE subscription_requests DISABLE ROW LEVEL SECURITY;

SELECT '✓ subscription_requests créée' AS message;
