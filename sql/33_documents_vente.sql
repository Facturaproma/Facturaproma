-- ============================================================
-- 33 — Chaque commande (code) a sa FACTURE ; chaque encaissement a son REÇU (numéros séquentiels, non supprimables)
-- Règles (appliquées par la base, quel que soit le chemin de création) :
--  * paiement 'pending' créé (= code généré, sql/32)  → une facture « émise » liée au paiement.
--  * paiement passé 'paid' (admin_confirm_payment) ou saisi directement 'paid' → un reçu lié (et la facture si elle n'existe pas encore).
--  * paiement 'cancelled' / supprimé tant qu'il n'est pas encaissé → la facture est marquée « annulée » (numéro conservé, jamais réutilisé).
--  * numérotation : compteur par type et par année, incrémenté de façon atomique (pas de doublon, pas de trou hors annulation de transaction).
--    Préfixes : réglages « Ma facturation » (invPrefix / receiptPrefix), sinon LIC / REC.
--  * un document ne se modifie ni ne se supprime depuis l'application (aucun droit UPDATE/DELETE, déclencheur de garde) ; lecture : admin et assistants.
--  * taux de TVA : repris des réglages « Ma facturation » (tvaRate) AU MOMENT de l'émission, sinon NULL (le PDF le demandera).
--  * rattrapage : les paiements existants reçoivent leur facture (et leur reçu s'ils sont encaissés).
-- Réexécutable. Dépend de 05, 13, 32.
-- Retour arrière : DROP TRIGGER trg_doc_creation, trg_doc_statut, trg_doc_suppression ON public.admin_payments;
--   DROP FUNCTION public.doc_on_payment_insert(), public.doc_on_payment_update(), public.doc_on_payment_delete(), public.doc_issue(public.admin_payments, TEXT, TIMESTAMPTZ), public.doc_next_number(TEXT, TIMESTAMPTZ), public.fp_setting_json(TEXT), public.doc_guard();
--   DROP TABLE public.admin_documents, public.admin_doc_counters;   (supprime aussi les numéros émis : à ne faire qu'avant toute utilisation réelle)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.admin_doc_counters (
    doc_type TEXT NOT NULL CHECK (doc_type IN ('invoice', 'receipt')),
    year     INT  NOT NULL,
    last     INT  NOT NULL DEFAULT 0,
    PRIMARY KEY (doc_type, year)
);
ALTER TABLE public.admin_doc_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_doc_counters FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.admin_documents (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doc_type     TEXT NOT NULL CHECK (doc_type IN ('invoice', 'receipt')),
    number       TEXT NOT NULL UNIQUE,
    payment_id   UUID REFERENCES public.admin_payments(id) ON DELETE SET NULL,
    ref_id       UUID,                       -- reçu → facture
    client_email TEXT NOT NULL,
    tier         TEXT,
    code         TEXT,
    total_ttc    NUMERIC(12,2) NOT NULL CHECK (total_ttc > 0),
    tva_rate     NUMERIC(5,2),
    status       TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'void')),
    void_note    TEXT,
    payment_mode TEXT,
    payment_date DATE,
    issued_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_documents_pay_type ON public.admin_documents(payment_id, doc_type) WHERE payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_admin_documents_email ON public.admin_documents(client_email);
ALTER TABLE public.admin_documents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_documents FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.admin_documents TO authenticated;
DROP POLICY IF EXISTS admin_documents_read ON public.admin_documents;
CREATE POLICY admin_documents_read ON public.admin_documents FOR SELECT TO authenticated USING (public.is_admin() OR public.is_staff());

-- Un document ne se supprime jamais ; seuls le statut et la note d'annulation peuvent changer (par les fonctions ci-dessous)
CREATE OR REPLACE FUNCTION public.doc_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'document non supprimable' USING ERRCODE = '42501'; END IF;
    IF NEW.number IS DISTINCT FROM OLD.number OR NEW.doc_type IS DISTINCT FROM OLD.doc_type OR NEW.client_email IS DISTINCT FROM OLD.client_email
       OR NEW.total_ttc IS DISTINCT FROM OLD.total_ttc OR NEW.issued_at IS DISTINCT FROM OLD.issued_at OR NEW.tva_rate IS DISTINCT FROM OLD.tva_rate THEN
        RAISE EXCEPTION 'document non modifiable' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_doc_guard ON public.admin_documents;
CREATE TRIGGER trg_doc_guard BEFORE UPDATE OR DELETE ON public.admin_documents FOR EACH ROW EXECUTE FUNCTION public.doc_guard();

-- Réglage JSON (admin_settings.value est du texte) ; NULL si absent ou illisible
CREATE OR REPLACE FUNCTION public.fp_setting_json(p_key TEXT) RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v TEXT;
BEGIN
    SELECT value INTO v FROM public.admin_settings WHERE key = p_key;
    IF v IS NULL THEN RETURN NULL; END IF;
    RETURN v::jsonb;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.fp_setting_json(TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.doc_next_number(p_type TEXT, p_at TIMESTAMPTZ DEFAULT now()) RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_year INT := extract(year FROM p_at AT TIME ZONE 'Africa/Casablanca')::int; v_n INT; v_cfg JSONB := public.fp_setting_json('fp_company_config'); v_prefix TEXT;
BEGIN
    v_prefix := upper(btrim(COALESCE(v_cfg->>(CASE WHEN p_type = 'invoice' THEN 'invPrefix' ELSE 'receiptPrefix' END), '')));
    IF v_prefix !~ '^[A-Z0-9]{2,6}$' THEN v_prefix := CASE WHEN p_type = 'invoice' THEN 'LIC' ELSE 'REC' END; END IF;
    INSERT INTO public.admin_doc_counters(doc_type, year, last) VALUES (p_type, v_year, 1)
    ON CONFLICT (doc_type, year) DO UPDATE SET last = public.admin_doc_counters.last + 1 RETURNING last INTO v_n;
    RETURN v_prefix || '-' || v_year || '-' || lpad(v_n::text, 4, '0');
END $$;
REVOKE ALL ON FUNCTION public.doc_next_number(TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.doc_issue(p_pay public.admin_payments, p_type TEXT, p_at TIMESTAMPTZ DEFAULT now()) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id UUID; v_cfg JSONB := public.fp_setting_json('fp_company_config'); v_rate NUMERIC; v_code TEXT; v_ref UUID; v_paid BOOLEAN := p_type = 'receipt';
BEGIN
    SELECT id INTO v_id FROM public.admin_documents WHERE payment_id = p_pay.id AND doc_type = p_type;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;
    IF p_pay.amount IS NULL OR p_pay.amount <= 0 THEN RETURN NULL; END IF;
    BEGIN v_rate := NULLIF(v_cfg->>'tvaRate', '')::numeric; EXCEPTION WHEN OTHERS THEN v_rate := NULL; END;
    IF v_rate IS NOT NULL AND (v_rate < 0 OR v_rate > 100) THEN v_rate := NULL; END IF;
    SELECT code INTO v_code FROM public.admin_codes WHERE id = p_pay.code_id;
    IF v_paid THEN SELECT id INTO v_ref FROM public.admin_documents WHERE payment_id = p_pay.id AND doc_type = 'invoice'; END IF;
    INSERT INTO public.admin_documents(doc_type, number, payment_id, ref_id, client_email, tier, code, total_ttc, tva_rate, payment_mode, payment_date, issued_at)
    VALUES (p_type, public.doc_next_number(p_type, p_at), p_pay.id, v_ref, p_pay.client_email, p_pay.type, v_code, p_pay.amount, v_rate,
            CASE WHEN v_paid THEN p_pay.payment_mode END, CASE WHEN v_paid THEN p_pay.payment_date END, p_at)
    RETURNING id INTO v_id;
    RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.doc_issue(public.admin_payments, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.doc_on_payment_insert() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NEW.status = 'cancelled' THEN RETURN NEW; END IF;
    PERFORM public.doc_issue(NEW, 'invoice', now());
    IF NEW.status = 'paid' THEN PERFORM public.doc_issue(NEW, 'receipt', now()); END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.doc_on_payment_insert() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_doc_creation ON public.admin_payments;
CREATE TRIGGER trg_doc_creation AFTER INSERT ON public.admin_payments FOR EACH ROW EXECUTE FUNCTION public.doc_on_payment_insert();

CREATE OR REPLACE FUNCTION public.doc_on_payment_update() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid' THEN
        PERFORM public.doc_issue(NEW, 'invoice', now());
        PERFORM public.doc_issue(NEW, 'receipt', now());
    ELSIF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
        UPDATE public.admin_documents SET status = 'void', void_note = 'Commande annulée' WHERE payment_id = NEW.id AND doc_type = 'invoice' AND status = 'issued'
           AND NOT EXISTS (SELECT 1 FROM public.admin_documents r WHERE r.payment_id = NEW.id AND r.doc_type = 'receipt');
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.doc_on_payment_update() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_doc_statut ON public.admin_payments;
CREATE TRIGGER trg_doc_statut AFTER UPDATE OF status ON public.admin_payments FOR EACH ROW EXECUTE FUNCTION public.doc_on_payment_update();

CREATE OR REPLACE FUNCTION public.doc_on_payment_delete() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    UPDATE public.admin_documents SET status = 'void', void_note = 'Commande supprimée' WHERE payment_id = OLD.id AND doc_type = 'invoice' AND status = 'issued'
       AND NOT EXISTS (SELECT 1 FROM public.admin_documents r WHERE r.payment_id = OLD.id AND r.doc_type = 'receipt');
    RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION public.doc_on_payment_delete() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_doc_suppression ON public.admin_payments;
CREATE TRIGGER trg_doc_suppression BEFORE DELETE ON public.admin_payments FOR EACH ROW EXECUTE FUNCTION public.doc_on_payment_delete();

-- Rattrapage (dans l'ordre de création des paiements, date d'émission = date de création du paiement)
DO $$
DECLARE r public.admin_payments;
BEGIN
    FOR r IN SELECT * FROM public.admin_payments WHERE status IN ('pending', 'paid') ORDER BY created_at, id LOOP
        PERFORM public.doc_issue(r, 'invoice', r.created_at);
        IF r.status = 'paid' THEN PERFORM public.doc_issue(r, 'receipt', r.created_at); END IF;
    END LOOP;
END $$;
