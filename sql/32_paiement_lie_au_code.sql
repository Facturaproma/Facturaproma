-- ============================================================
-- 32 — Chaque code de licence a son paiement « en attente » (plus de code ni de paiement orphelin)
-- Règles (toutes appliquées par la base, quel que soit le chemin de création du code) :
--  * création d'un code (non offert) → un paiement 'pending' lié (code_id), dans LA MÊME transaction : les deux existent ou aucun ;
--    montant attendu = prix de la formule (table plans pour les formules personnalisées, sinon 49 / 449 / 199 ; code FONDATEUR = 299) ;
--    un code « à vie » (offert, montant 0) n'a pas de paiement.
--  * code révoqué → son paiement en attente passe à 'cancelled' (conservé pour l'historique, jamais compté).
--  * code supprimé → son paiement en attente / annulé est supprimé ; un paiement ENCAISSÉ est conservé (comptabilité), simplement détaché.
--  * admin_confirm_payment() : seul moyen de passer 'pending' → 'paid' (montant réel, mode, date) ; refuse un double encaissement.
--  * Les paiements existants restent 'paid'. Les totaux ne doivent compter que status = 'paid' (admin.html le fait).
-- Réexécutable. Dépend de 05, 06, 13, 20, 21, 27.
-- Retour arrière : DROP TRIGGER trg_code_paiement_attente, trg_code_paiement_statut, trg_code_paiement_suppr ON public.admin_codes;
--   DROP FUNCTION public.code_creer_paiement(), public.code_sync_paiement(), public.code_supprimer_paiement(), public.admin_confirm_payment(UUID,NUMERIC,TEXT,DATE,TEXT);
--   (puis, si voulu : DELETE FROM public.admin_payments WHERE status <> 'paid'; ALTER TABLE public.admin_payments DROP COLUMN code_id, DROP COLUMN status;)
-- ============================================================
ALTER TABLE public.admin_payments ADD COLUMN IF NOT EXISTS status  TEXT NOT NULL DEFAULT 'paid';
ALTER TABLE public.admin_payments ADD COLUMN IF NOT EXISTS code_id UUID;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admin_payments_status_chk') THEN
        ALTER TABLE public.admin_payments ADD CONSTRAINT admin_payments_status_chk CHECK (status IN ('pending', 'paid', 'cancelled'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admin_payments_code_fk') THEN
        ALTER TABLE public.admin_payments ADD CONSTRAINT admin_payments_code_fk FOREIGN KEY (code_id) REFERENCES public.admin_codes(id) ON DELETE SET NULL;
    END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_admin_payments_code ON public.admin_payments(code_id) WHERE code_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_admin_payments_status ON public.admin_payments(status);

-- Prix attendu d'un code (même logique que admin.html : formule personnalisée > prix historiques)
CREATE OR REPLACE FUNCTION public.code_prix_attendu(p_type TEXT, p_note TEXT)
RETURNS NUMERIC LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT CASE
        WHEN p_note ~ '^FONDATEUR' THEN 299
        WHEN p_type = 'monthly'  THEN 49
        WHEN p_type = 'annual'   THEN 449
        WHEN p_type = 'founder'  THEN 299
        WHEN p_type = 'business' THEN 199
        WHEN p_type = 'lifetime' THEN 0
        ELSE COALESCE((SELECT price_dh FROM public.plans WHERE key = p_type), 0)
    END;
$$;
REVOKE ALL ON FUNCTION public.code_prix_attendu(TEXT, TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.code_creer_paiement()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v_amount NUMERIC;
BEGIN
    IF NEW.client_email IS NULL OR btrim(NEW.client_email) = '' THEN RETURN NEW; END IF;
    v_amount := public.code_prix_attendu(NEW.type, NEW.note);
    IF v_amount IS NULL OR v_amount <= 0 THEN RETURN NEW; END IF;   -- accès offert : rien à encaisser
    INSERT INTO public.admin_payments (client_email, payment_date, amount, type, payment_mode, note, status, code_id)
    VALUES (lower(btrim(NEW.client_email)), CURRENT_DATE, v_amount, NEW.type, 'virement',
            'En attente — code ' || NEW.code, CASE WHEN NEW.status = 'revoked' THEN 'cancelled' ELSE 'pending' END, NEW.id);
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.code_creer_paiement() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_code_paiement_attente ON public.admin_codes;
CREATE TRIGGER trg_code_paiement_attente AFTER INSERT ON public.admin_codes
    FOR EACH ROW EXECUTE FUNCTION public.code_creer_paiement();

CREATE OR REPLACE FUNCTION public.code_sync_paiement()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
BEGIN
    IF NEW.status = 'revoked' AND OLD.status IS DISTINCT FROM 'revoked' THEN
        UPDATE public.admin_payments SET status = 'cancelled', note = COALESCE(note, '') || ' — code révoqué'
         WHERE code_id = NEW.id AND status = 'pending';
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.code_sync_paiement() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_code_paiement_statut ON public.admin_codes;
CREATE TRIGGER trg_code_paiement_statut AFTER UPDATE OF status ON public.admin_codes
    FOR EACH ROW EXECUTE FUNCTION public.code_sync_paiement();

CREATE OR REPLACE FUNCTION public.code_supprimer_paiement()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
BEGIN
    DELETE FROM public.admin_payments WHERE code_id = OLD.id AND status IN ('pending', 'cancelled');
    RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION public.code_supprimer_paiement() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_code_paiement_suppr ON public.admin_codes;
CREATE TRIGGER trg_code_paiement_suppr BEFORE DELETE ON public.admin_codes
    FOR EACH ROW EXECUTE FUNCTION public.code_supprimer_paiement();

-- Encaissement : 'pending' → 'paid', une seule fois. Administrateur ou assistant.
CREATE OR REPLACE FUNCTION public.admin_confirm_payment(p_id UUID, p_amount NUMERIC, p_mode TEXT, p_date DATE, p_note TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v_row public.admin_payments%ROWTYPE; v_email TEXT;
BEGIN
    IF NOT (public.is_admin() OR public.is_staff()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
    IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 100000 THEN RETURN jsonb_build_object('ok', false, 'reason', 'bad_amount'); END IF;
    IF p_mode NOT IN ('virement', 'cmi', 'cash', 'cheque') THEN RETURN jsonb_build_object('ok', false, 'reason', 'bad_mode'); END IF;
    IF p_date IS NULL OR p_date NOT BETWEEN CURRENT_DATE - 400 AND CURRENT_DATE + 1 THEN RETURN jsonb_build_object('ok', false, 'reason', 'bad_date'); END IF;
    SELECT * INTO v_row FROM public.admin_payments WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
    IF v_row.status = 'paid' THEN RETURN jsonb_build_object('ok', false, 'reason', 'already_paid'); END IF;
    IF v_row.status = 'cancelled' THEN RETURN jsonb_build_object('ok', false, 'reason', 'cancelled'); END IF;
    SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();
    UPDATE public.admin_payments
       SET status = 'paid', amount = p_amount, payment_mode = p_mode, payment_date = p_date,
           note = COALESCE(NULLIF(btrim(p_note), ''), note), entered_by = COALESCE(v_email, entered_by)
     WHERE id = p_id;
    INSERT INTO public.admin_audit (admin_email, action, target_email, details)
    VALUES (v_email, 'payment_confirmed', v_row.client_email, jsonb_build_object('payment_id', p_id, 'amount', p_amount, 'mode', p_mode, 'code_id', v_row.code_id));
    RETURN jsonb_build_object('ok', true, 'id', p_id);
END $$;
REVOKE ALL ON FUNCTION public.admin_confirm_payment(UUID, NUMERIC, TEXT, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_confirm_payment(UUID, NUMERIC, TEXT, DATE, TEXT) TO authenticated;

-- Rattrapage des codes EN ATTENTE créés avant ce script (ni activés ni révoqués) : un paiement attendu chacun,
-- sauf si un paiement encaissé du même client et de la même formule existe déjà à partir de la date du code.
INSERT INTO public.admin_payments (client_email, payment_date, amount, type, payment_mode, note, status, code_id)
SELECT lower(btrim(c.client_email)), CURRENT_DATE, public.code_prix_attendu(c.type, c.note), c.type, 'virement', 'En attente — code ' || c.code, 'pending', c.id
  FROM public.admin_codes c
 WHERE c.status = 'pending' AND c.client_email IS NOT NULL AND btrim(c.client_email) <> ''
   AND public.code_prix_attendu(c.type, c.note) > 0
   AND NOT EXISTS (SELECT 1 FROM public.admin_payments p WHERE p.code_id = c.id)
   AND NOT EXISTS (SELECT 1 FROM public.admin_payments p WHERE lower(p.client_email) = lower(btrim(c.client_email)) AND p.type = c.type AND p.status = 'paid' AND p.payment_date >= c.created_at::date);
