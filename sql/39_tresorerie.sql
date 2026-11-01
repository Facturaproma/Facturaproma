-- ============================================================================================================
-- 39 — Trésorerie : comptes (banque, caisse) avec solde d'ouverture, mouvements d'argent IMMUABLES, règlements fournisseurs
-- ============================================================================================================
-- FacturaPro 2.0 — PR 6. Dépend de : sql/37 (fin_uid, purchases, fin_audit, fin_assert_open, fin_purchase_paid). À coller APRÈS sql/38.
--
-- PRINCIPE
--  * Un compte = un solde d'ouverture daté, saisi UNE fois (une erreur se corrige par un mouvement d'ajustement).
--  * Tout mouvement d'argent est une ligne immuable (aucune modification, aucune suppression). Une erreur se corrige par une
--    ANNULATION : ligne inverse liée (reverses_id, une seule annulation par mouvement). Un virement interne = deux lignes liées.
--  * Encaissements clients : ils ne sont PAS recopiés ici. Ils restent dans user_data (clé 'payments', déjà immuables, sql/26) et
--    portent un champ facultatif accountId ; cash_balances() les LIT. C'est ce qui évite tout double comptage paiement / trésorerie.
--  * Règlement fournisseur = mouvement « supplier_payment » rattaché à un achat ; cumul ≤ TTC de l'achat (verrou sur l'achat).
--    fin_purchase_paid() (déclarée en sql/37) est remplacée : un achat réglé ne peut plus être annulé tant que ses règlements existent.
--  * Solde d'un compte à une date = ouverture + flux datés entre la date d'ouverture et cette date (les flux antérieurs à l'ouverture
--    sont réputés inclus dans le solde d'ouverture).
--  * Clôture de période via fin_assert_open (sql/40) : aucun mouvement ni aucune annulation datés dans une période clôturée.
-- Sécurité : tables FERMÉES (RLS sans politique, aucun droit direct), fonctions SECURITY DEFINER limitées au compte connecté,
-- licence active pour écrire, lecture toujours possible, ON DELETE CASCADE. Réexécutable.
--
-- RETOUR ARRIÈRE (retirer d'abord l'application de la PR 6) :
--   DROP FUNCTION IF EXISTS public.cash_account_create(JSONB), public.cash_account_archive(UUID, BOOLEAN), public.cash_movement_record(JSONB),
--     public.supplier_settle(JSONB), public.cash_movement_reverse(UUID, TEXT), public.cash_balances(DATE), public.cash_list(DATE, DATE, UUID, INT, INT),
--     public.cash_accounts_list(), public.fin_customer_payments(UUID), public.fin_cash_guard(), public.fin_account_guard();
--   recoller la version « 0 » de fin_purchase_paid de sql/37 ;  DROP TABLE IF EXISTS public.cash_movements, public.cash_accounts;
-- ============================================================================================================

DO $$ BEGIN
    IF to_regclass('public.purchases') IS NULL THEN RAISE EXCEPTION 'PREREQUIS_MANQUANT: sql/37 doit être appliqué avant sql/39'; END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.cash_accounts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
    kind            TEXT NOT NULL CHECK (kind IN ('bank', 'cash', 'other')),
    opening_balance NUMERIC(14,2) NOT NULL CHECK (opening_balance BETWEEN -1000000000 AND 1000000000),
    opening_date    DATE NOT NULL,
    archived        BOOLEAN NOT NULL DEFAULT false,
    idem_key        TEXT CHECK (idem_key IS NULL OR char_length(idem_key) BETWEEN 1 AND 200),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, name),
    UNIQUE (user_id, idem_key)
);
ALTER TABLE public.cash_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cash_accounts FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.cash_movements (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    account_id  UUID NOT NULL REFERENCES public.cash_accounts(id) ON DELETE CASCADE,
    move_date   DATE NOT NULL,
    direction   TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0 AND amount <= 1000000000),
    kind        TEXT NOT NULL CHECK (kind IN ('supplier_payment', 'owner_in', 'owner_out', 'transfer_in', 'transfer_out', 'tax_payment',
                                              'other_in', 'other_out', 'adjustment_in', 'adjustment_out', 'reversal')),
    purchase_id UUID REFERENCES public.purchases(id) ON DELETE CASCADE,
    transfer_id UUID,
    reverses_id UUID UNIQUE REFERENCES public.cash_movements(id) ON DELETE CASCADE,
    label       TEXT CHECK (label IS NULL OR char_length(label) <= 200),
    idem_key    TEXT CHECK (idem_key IS NULL OR char_length(idem_key) BETWEEN 1 AND 200),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, idem_key),
    CHECK (kind <> 'supplier_payment' OR (purchase_id IS NOT NULL AND direction = 'out')),
    CHECK ((kind = 'reversal') = (reverses_id IS NOT NULL)),
    CHECK (kind NOT IN ('transfer_in', 'transfer_out') OR transfer_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS cash_movements_account_idx ON public.cash_movements (user_id, account_id, move_date);
CREATE INDEX IF NOT EXISTS cash_movements_account_fk_idx ON public.cash_movements (account_id);   -- clé étrangère vers cash_accounts
CREATE INDEX IF NOT EXISTS cash_movements_purchase_idx ON public.cash_movements (purchase_id) WHERE purchase_id IS NOT NULL;
ALTER TABLE public.cash_movements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cash_movements FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fin_cash_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'mouvement de trésorerie non modifiable' USING ERRCODE = '42501'; END; $$;
REVOKE ALL ON FUNCTION public.fin_cash_guard() FROM PUBLIC, anon, authenticated;
CREATE OR REPLACE TRIGGER trg_cash_guard BEFORE UPDATE ON public.cash_movements FOR EACH ROW EXECUTE FUNCTION public.fin_cash_guard();

CREATE OR REPLACE FUNCTION public.fin_account_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF (to_jsonb(NEW) - 'archived') IS DISTINCT FROM (to_jsonb(OLD) - 'archived') THEN RAISE EXCEPTION 'compte non modifiable (archivage uniquement)' USING ERRCODE = '42501'; END IF;
    RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.fin_account_guard() FROM PUBLIC, anon, authenticated;
CREATE OR REPLACE TRIGGER trg_account_guard BEFORE UPDATE ON public.cash_accounts FOR EACH ROW EXECUTE FUNCTION public.fin_account_guard();

-- Montant réglé d'un achat = règlements non annulés (remplace la version « 0 » de sql/37)
CREATE OR REPLACE FUNCTION public.fin_purchase_paid(p_uid UUID, p_purchase UUID) RETURNS NUMERIC
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT COALESCE(sum(m.amount), 0)::numeric FROM public.cash_movements m
     WHERE m.user_id = p_uid AND m.purchase_id = p_purchase AND m.kind = 'supplier_payment'
       AND NOT EXISTS (SELECT 1 FROM public.cash_movements r WHERE r.reverses_id = m.id)
$$;
REVOKE ALL ON FUNCTION public.fin_purchase_paid(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- Encaissements clients du compte, LUS dans user_data (clé 'payments'). Aucune écriture.
CREATE OR REPLACE FUNCTION public.fin_customer_payments(p_uid UUID)
RETURNS TABLE (payment_id TEXT, invoice_id TEXT, pay_date DATE, amount NUMERIC, account_id TEXT, method TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT e->>'id', e->>'invoiceId',
           CASE WHEN (e->>'date') ~ '^\d{4}-\d{2}-\d{2}' THEN left(e->>'date', 10)::date END,
           CASE WHEN (e->>'amount') ~ '^-?\d+(\.\d+)?$' THEN round((e->>'amount')::numeric, 2) ELSE 0 END,
           NULLIF(e->>'accountId', ''), e->>'method'
      FROM public.user_data d, LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(d.value) = 'array' THEN d.value ELSE '[]'::jsonb END) e
     WHERE d.user_id = p_uid AND d.key = 'payments' AND jsonb_typeof(e) = 'object'
$$;
REVOKE ALL ON FUNCTION public.fin_customer_payments(UUID) FROM PUBLIC, anon, authenticated;

-- ---------- comptes ----------
CREATE OR REPLACE FUNCTION public.cash_account_create(p JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fin_uid(); r public.cash_accounts%ROWTYPE; v_key TEXT; v_date DATE; v_bal NUMERIC; v_kind TEXT; v_name TEXT;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    IF NOT public.has_active_license(v) THEN RAISE EXCEPTION 'LICENCE_INACTIVE'; END IF;
    v_key := left(NULLIF(btrim(p->>'key'), ''), 200);
    IF v_key IS NOT NULL THEN SELECT * INTO r FROM public.cash_accounts WHERE user_id = v AND idem_key = v_key; IF FOUND THEN RETURN jsonb_build_object('id', r.id, 'duplicate', true); END IF; END IF;
    v_name := left(btrim(COALESCE(p->>'name', '')), 60); v_kind := p->>'kind';
    IF v_name = '' THEN RAISE EXCEPTION 'NOM_INVALIDE'; END IF;
    IF v_kind IS NULL OR v_kind NOT IN ('bank', 'cash', 'other') THEN RAISE EXCEPTION 'TYPE_COMPTE_INVALIDE'; END IF;
    IF EXISTS (SELECT 1 FROM public.cash_accounts WHERE user_id = v AND name = v_name) THEN RAISE EXCEPTION 'COMPTE_EXISTANT'; END IF;
    IF (SELECT count(*) FROM public.cash_accounts WHERE user_id = v) >= 50 THEN RAISE EXCEPTION 'TROP_DE_COMPTES'; END IF;
    BEGIN v_bal := round(COALESCE((p->>'opening_balance')::numeric, 0), 2); v_date := (p->>'opening_date')::date;
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'OUVERTURE_INVALIDE'; END;
    IF v_date IS NULL OR v_date < DATE '2000-01-01' OR v_date > current_date THEN RAISE EXCEPTION 'DATE_OUVERTURE_INVALIDE'; END IF;
    IF v_bal < -1000000000 OR v_bal > 1000000000 THEN RAISE EXCEPTION 'OUVERTURE_INVALIDE'; END IF;
    INSERT INTO public.cash_accounts (user_id, name, kind, opening_balance, opening_date, idem_key) VALUES (v, v_name, v_kind, v_bal, v_date, v_key) RETURNING * INTO r;
    INSERT INTO public.fin_audit (user_id, action, entity, entity_id, detail) VALUES (v, 'solde_ouverture', 'cash_account', r.id::text, jsonb_build_object('name', v_name, 'balance', v_bal, 'date', v_date));
    RETURN jsonb_build_object('id', r.id, 'duplicate', false);
END; $$;
REVOKE ALL ON FUNCTION public.cash_account_create(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cash_account_create(JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION public.cash_account_archive(p_id UUID, p_archived BOOLEAN) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fin_uid(); n INT;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    IF NOT public.has_active_license(v) THEN RAISE EXCEPTION 'LICENCE_INACTIVE'; END IF;
    UPDATE public.cash_accounts SET archived = COALESCE(p_archived, true) WHERE id = p_id AND user_id = v;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 0 THEN RAISE EXCEPTION 'COMPTE_INTROUVABLE'; END IF;
    RETURN jsonb_build_object('id', p_id, 'archived', COALESCE(p_archived, true));
END; $$;
REVOKE ALL ON FUNCTION public.cash_account_archive(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cash_account_archive(UUID, BOOLEAN) TO authenticated;

CREATE OR REPLACE FUNCTION public.cash_accounts_list()
RETURNS TABLE (id UUID, name TEXT, kind TEXT, opening_balance NUMERIC, opening_date DATE, archived BOOLEAN, created_at TIMESTAMPTZ)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fin_uid();
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    RETURN QUERY SELECT a.id, a.name, a.kind, a.opening_balance, a.opening_date, a.archived, a.created_at FROM public.cash_accounts a WHERE a.user_id = v ORDER BY a.archived, a.created_at;
END; $$;
REVOKE ALL ON FUNCTION public.cash_accounts_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cash_accounts_list() TO authenticated;

-- ---------- mouvements ----------
-- p = { key, account_id, date, kind (owner_in | owner_out | tax_payment | other_in | other_out | adjustment_in | adjustment_out | transfer),
--       amount, label, to_account_id (virement) }
CREATE OR REPLACE FUNCTION public.cash_movement_record(p JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fin_uid(); m public.cash_movements%ROWTYPE; v_key TEXT; v_kind TEXT; v_date DATE; v_amt NUMERIC; v_acc UUID; v_to UUID; v_tr UUID; v_id UUID; v_label TEXT;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    IF NOT public.has_active_license(v) THEN RAISE EXCEPTION 'LICENCE_INACTIVE'; END IF;
    v_key := left(NULLIF(btrim(p->>'key'), ''), 200);
    IF v_key IS NOT NULL THEN SELECT * INTO m FROM public.cash_movements WHERE user_id = v AND idem_key = v_key; IF FOUND THEN RETURN jsonb_build_object('id', m.id, 'duplicate', true); END IF; END IF;
    v_kind := p->>'kind';
    IF v_kind IS NULL OR v_kind NOT IN ('owner_in', 'owner_out', 'tax_payment', 'other_in', 'other_out', 'adjustment_in', 'adjustment_out', 'transfer') THEN RAISE EXCEPTION 'TYPE_MOUVEMENT_INVALIDE'; END IF;
    BEGIN v_date := (p->>'date')::date; v_amt := round((p->>'amount')::numeric, 2); v_acc := (p->>'account_id')::uuid; v_to := NULLIF(p->>'to_account_id', '')::uuid;
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'MOUVEMENT_INVALIDE'; END;
    IF v_date IS NULL OR v_date < DATE '2000-01-01' OR v_date > current_date + 31 THEN RAISE EXCEPTION 'DATE_INVALIDE'; END IF;
    IF v_amt IS NULL OR v_amt <= 0 OR v_amt > 1000000000 THEN RAISE EXCEPTION 'MONTANT_INVALIDE'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.cash_accounts WHERE id = v_acc AND user_id = v AND NOT archived) THEN RAISE EXCEPTION 'COMPTE_INTROUVABLE'; END IF;
    PERFORM public.fin_assert_open(v, v_date);
    v_label := left(NULLIF(btrim(p->>'label'), ''), 200);
    IF v_kind = 'transfer' THEN
        IF v_to IS NULL OR v_to = v_acc OR NOT EXISTS (SELECT 1 FROM public.cash_accounts WHERE id = v_to AND user_id = v AND NOT archived) THEN RAISE EXCEPTION 'COMPTE_DESTINATION_INVALIDE'; END IF;
        v_tr := gen_random_uuid();
        INSERT INTO public.cash_movements (user_id, account_id, move_date, direction, amount, kind, transfer_id, label, idem_key)
        VALUES (v, v_acc, v_date, 'out', v_amt, 'transfer_out', v_tr, v_label, v_key) RETURNING id INTO v_id;
        INSERT INTO public.cash_movements (user_id, account_id, move_date, direction, amount, kind, transfer_id, label, idem_key)
        VALUES (v, v_to, v_date, 'in', v_amt, 'transfer_in', v_tr, v_label, CASE WHEN v_key IS NULL THEN NULL ELSE left(v_key || ':in', 200) END);
    ELSE
        INSERT INTO public.cash_movements (user_id, account_id, move_date, direction, amount, kind, label, idem_key)
        VALUES (v, v_acc, v_date, CASE WHEN v_kind IN ('owner_in', 'other_in', 'adjustment_in') THEN 'in' ELSE 'out' END, v_amt, v_kind, v_label, v_key)
        RETURNING id INTO v_id;
    END IF;
    RETURN jsonb_build_object('id', v_id, 'duplicate', false);
END; $$;
REVOKE ALL ON FUNCTION public.cash_movement_record(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cash_movement_record(JSONB) TO authenticated;

-- Règlement fournisseur : p = { key, purchase_id, account_id, amount, date, label }
CREATE OR REPLACE FUNCTION public.supplier_settle(p JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fin_uid(); m public.cash_movements%ROWTYPE; pu public.purchases%ROWTYPE; v_key TEXT; v_date DATE; v_amt NUMERIC; v_acc UUID; v_paid NUMERIC; v_id UUID;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    IF NOT public.has_active_license(v) THEN RAISE EXCEPTION 'LICENCE_INACTIVE'; END IF;
    v_key := left(NULLIF(btrim(p->>'key'), ''), 200);
    IF v_key IS NOT NULL THEN SELECT * INTO m FROM public.cash_movements WHERE user_id = v AND idem_key = v_key; IF FOUND THEN RETURN jsonb_build_object('id', m.id, 'duplicate', true); END IF; END IF;
    BEGIN v_date := (p->>'date')::date; v_amt := round((p->>'amount')::numeric, 2); v_acc := (p->>'account_id')::uuid;
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'REGLEMENT_INVALIDE'; END;
    SELECT * INTO pu FROM public.purchases WHERE id = (p->>'purchase_id')::uuid AND user_id = v FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'ACHAT_INTROUVABLE'; END IF;
    IF pu.status <> 'active' THEN RAISE EXCEPTION 'ACHAT_ANNULE'; END IF;
    IF v_date IS NULL OR v_date < DATE '2000-01-01' OR v_date > current_date + 31 THEN RAISE EXCEPTION 'DATE_INVALIDE'; END IF;
    IF v_amt IS NULL OR v_amt <= 0 THEN RAISE EXCEPTION 'MONTANT_INVALIDE'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.cash_accounts WHERE id = v_acc AND user_id = v AND NOT archived) THEN RAISE EXCEPTION 'COMPTE_INTROUVABLE'; END IF;
    PERFORM public.fin_assert_open(v, v_date);
    v_paid := public.fin_purchase_paid(v, pu.id);
    IF v_paid + v_amt > pu.total_ttc + 0.005 THEN RAISE EXCEPTION 'REGLEMENT_SUPERIEUR_A_LA_DETTE: reste %', pu.total_ttc - v_paid; END IF;
    INSERT INTO public.cash_movements (user_id, account_id, move_date, direction, amount, kind, purchase_id, label, idem_key)
    VALUES (v, v_acc, v_date, 'out', v_amt, 'supplier_payment', pu.id, left(COALESCE(NULLIF(btrim(p->>'label'), ''), pu.number || ' · ' || pu.supplier_name), 200), v_key)
    RETURNING id INTO v_id;
    RETURN jsonb_build_object('id', v_id, 'duplicate', false, 'remaining', pu.total_ttc - v_paid - v_amt);
END; $$;
REVOKE ALL ON FUNCTION public.supplier_settle(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.supplier_settle(JSONB) TO authenticated;

-- Annulation d'un mouvement : ligne inverse datée du jour (un virement : les deux jambes)
CREATE OR REPLACE FUNCTION public.cash_movement_reverse(p_id UUID, p_reason TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fin_uid(); m public.cash_movements%ROWTYPE; x public.cash_movements%ROWTYPE; n INT := 0;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    IF NOT public.has_active_license(v) THEN RAISE EXCEPTION 'LICENCE_INACTIVE'; END IF;
    SELECT * INTO m FROM public.cash_movements WHERE id = p_id AND user_id = v FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'MOUVEMENT_INTROUVABLE'; END IF;
    IF m.kind = 'reversal' THEN RAISE EXCEPTION 'ANNULATION_D_ANNULATION_INTERDITE'; END IF;
    PERFORM public.fin_assert_open(v, current_date);
    FOR x IN SELECT * FROM public.cash_movements WHERE user_id = v AND (id = m.id OR (m.transfer_id IS NOT NULL AND transfer_id = m.transfer_id)) ORDER BY id FOR UPDATE LOOP
        IF EXISTS (SELECT 1 FROM public.cash_movements r WHERE r.reverses_id = x.id) THEN CONTINUE; END IF;
        INSERT INTO public.cash_movements (user_id, account_id, move_date, direction, amount, kind, purchase_id, reverses_id, label)
        VALUES (v, x.account_id, current_date, CASE WHEN x.direction = 'in' THEN 'out' ELSE 'in' END, x.amount, 'reversal', x.purchase_id, x.id,
                left('Annulation : ' || COALESCE(NULLIF(btrim(p_reason), ''), COALESCE(x.label, x.kind)), 200));
        n := n + 1;
    END LOOP;
    IF n > 0 THEN INSERT INTO public.fin_audit (user_id, action, entity, entity_id, detail) VALUES (v, 'annulation', 'cash_movement', m.id::text, jsonb_build_object('amount', m.amount, 'kind', m.kind, 'reason', left(p_reason, 200))); END IF;
    RETURN jsonb_build_object('reversed', n);
END; $$;
REVOKE ALL ON FUNCTION public.cash_movement_reverse(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cash_movement_reverse(UUID, TEXT) TO authenticated;

-- ---------- lecture ----------
-- Soldes à une date (NULL = aujourd'hui). account_id NULL = encaissements clients sans compte (« non affectés »), hors soldes.
CREATE OR REPLACE FUNCTION public.cash_balances(p_date DATE DEFAULT NULL)
RETURNS TABLE (account_id UUID, name TEXT, kind TEXT, archived BOOLEAN, opening_balance NUMERIC, opening_date DATE, customer_in NUMERIC, other_in NUMERIC, total_out NUMERIC, balance NUMERIC)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fin_uid(); d DATE := COALESCE(p_date, current_date);
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    RETURN QUERY
    WITH cp AS (SELECT * FROM public.fin_customer_payments(v) WHERE pay_date IS NOT NULL AND pay_date <= d)
    SELECT a.id, a.name, a.kind, a.archived, a.opening_balance, a.opening_date,
           COALESCE((SELECT sum(cp.amount) FROM cp WHERE cp.account_id = a.id::text AND cp.pay_date >= a.opening_date), 0)::numeric(14,2),
           COALESCE((SELECT sum(m.amount) FROM public.cash_movements m WHERE m.account_id = a.id AND m.direction = 'in' AND m.move_date BETWEEN a.opening_date AND d), 0)::numeric(14,2),
           COALESCE((SELECT sum(m.amount) FROM public.cash_movements m WHERE m.account_id = a.id AND m.direction = 'out' AND m.move_date BETWEEN a.opening_date AND d), 0)::numeric(14,2),
           (a.opening_balance
             + COALESCE((SELECT sum(cp.amount) FROM cp WHERE cp.account_id = a.id::text AND cp.pay_date >= a.opening_date), 0)
             + COALESCE((SELECT sum(CASE WHEN m.direction = 'in' THEN m.amount ELSE -m.amount END) FROM public.cash_movements m WHERE m.account_id = a.id AND m.move_date BETWEEN a.opening_date AND d), 0))::numeric(14,2)
      FROM public.cash_accounts a WHERE a.user_id = v AND a.opening_date <= d
    UNION ALL
    SELECT NULL::uuid, 'Encaissements clients sans compte'::text, NULL::text, false, 0::numeric, NULL::date,
           COALESCE(sum(cp.amount), 0)::numeric(14,2), 0::numeric, 0::numeric, 0::numeric
      FROM cp WHERE cp.account_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.cash_accounts a WHERE a.user_id = v AND a.id::text = cp.account_id)
    HAVING count(*) > 0;
END; $$;
REVOKE ALL ON FUNCTION public.cash_balances(DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cash_balances(DATE) TO authenticated;

-- Journal : mouvements de trésorerie + encaissements clients (lus), du plus récent au plus ancien
CREATE OR REPLACE FUNCTION public.cash_list(p_from DATE, p_to DATE, p_account UUID DEFAULT NULL, p_limit INT DEFAULT 300, p_offset INT DEFAULT 0)
RETURNS TABLE (id TEXT, account_id UUID, move_date DATE, direction TEXT, amount NUMERIC, kind TEXT, label TEXT, purchase_id UUID, reverses_id UUID, reversed BOOLEAN, created_at TIMESTAMPTZ)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fin_uid();
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    RETURN QUERY
    SELECT * FROM (
        SELECT m.id::text, m.account_id, m.move_date, m.direction, m.amount, m.kind, m.label, m.purchase_id, m.reverses_id,
               EXISTS (SELECT 1 FROM public.cash_movements r WHERE r.reverses_id = m.id), m.created_at
          FROM public.cash_movements m
         WHERE m.user_id = v AND (p_account IS NULL OR m.account_id = p_account)
           AND (p_from IS NULL OR m.move_date >= p_from) AND (p_to IS NULL OR m.move_date <= p_to)
        UNION ALL
        SELECT 'pay:' || cp.payment_id, CASE WHEN cp.account_id ~ '^[0-9a-f-]{36}$' THEN cp.account_id::uuid END, cp.pay_date, 'in', cp.amount, 'customer_payment',
               cp.method, NULL::uuid, NULL::uuid, false, NULL::timestamptz
          FROM public.fin_customer_payments(v) cp
         WHERE cp.pay_date IS NOT NULL AND (p_account IS NULL OR cp.account_id = p_account::text)
           AND (p_from IS NULL OR cp.pay_date >= p_from) AND (p_to IS NULL OR cp.pay_date <= p_to)
    ) j ORDER BY j.move_date DESC, j.created_at DESC NULLS LAST
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 300), 1), 5000) OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END; $$;
REVOKE ALL ON FUNCTION public.cash_list(DATE, DATE, UUID, INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cash_list(DATE, DATE, UUID, INT, INT) TO authenticated;
