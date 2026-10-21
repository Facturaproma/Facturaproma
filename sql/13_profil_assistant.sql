-- ============================================================
-- 13 - PROFIL « ASSISTANT » (saisie des paiements reçus, sans droits de licence)
-- ============================================================
-- À exécuter dans Supabase > SQL Editor (nouvelle requête), après 08 et 12. Idempotent.
--
-- L'assistant peut :
--   * voir la liste des paiements et les demandes d'abonnement en attente
--   * enregistrer un paiement reçu en banque (offres Mensuel / Annuel / Fondateur)
--   * annuler SA propre saisie pendant 24 h (erreur de frappe)
-- L'assistant ne peut PAS : voir ou créer des codes, activer/prolonger/suspendre une licence,
-- voir les comptes clients, supprimer quoi que ce soit d'autre, ni gérer les admins.
-- Chaque saisie est journalisée (Journal admin) avec le nom de la personne.
-- ============================================================

-- 1. Table des assistants (gérée uniquement par les admins)
CREATE TABLE IF NOT EXISTS public.staff (
    email      TEXT PRIMARY KEY,
    role       TEXT NOT NULL DEFAULT 'assistant' CHECK (role IN ('assistant')),
    added_by   TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.staff ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff FROM PUBLIC, anon;
GRANT SELECT ON public.staff TO authenticated;
DROP POLICY IF EXISTS staff_admin_select ON public.staff;
CREATE POLICY staff_admin_select ON public.staff
    FOR SELECT TO authenticated USING (public.is_admin());
-- Aucune écriture directe : uniquement via admin_add_staff / admin_remove_staff

-- 2. Identité
CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM auth.users u
          JOIN public.staff s ON lower(s.email) = lower(u.email)
         WHERE u.id = auth.uid()
           AND u.email_confirmed_at IS NOT NULL
    );
$$;
REVOKE ALL ON FUNCTION public.is_staff() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_staff() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_whoami()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
    SELECT jsonb_build_object(
        'is_admin',  public.is_admin(),
        'is_master', public.is_master(),
        'is_staff',  public.is_staff(),
        'email',     (SELECT email FROM auth.users WHERE id = auth.uid())
    );
$$;

-- 3. Paiements : colonne « saisi par » + droits de l'assistant
ALTER TABLE public.admin_payments ADD COLUMN IF NOT EXISTS entered_by TEXT;

DROP POLICY IF EXISTS pay_staff_select ON public.admin_payments;
CREATE POLICY pay_staff_select ON public.admin_payments
    FOR SELECT TO authenticated USING (public.is_staff());

DROP POLICY IF EXISTS pay_staff_insert ON public.admin_payments;
CREATE POLICY pay_staff_insert ON public.admin_payments
    FOR INSERT TO authenticated
    WITH CHECK (
        public.is_staff()
        AND amount > 0 AND amount <= 20000
        AND type IN ('monthly', 'annual', 'founder')
        AND payment_mode IN ('virement', 'cmi', 'cash', 'cheque')
        AND payment_date BETWEEN CURRENT_DATE - 400 AND CURRENT_DATE + 1
    );

GRANT SELECT, INSERT ON public.admin_payments TO authenticated;

-- Qui a saisi quoi : renseigné par le serveur (non falsifiable) + journal
CREATE OR REPLACE FUNCTION public.admin_payments_stamp()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE v_email TEXT;
BEGIN
    SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();
    NEW.entered_by := v_email;
    IF v_email IS NOT NULL AND NOT public.is_admin() THEN
        INSERT INTO public.admin_audit (admin_email, action, target_email, details)
        VALUES (v_email, 'staff_payment', NEW.client_email,
                jsonb_build_object('amount', NEW.amount, 'type', NEW.type,
                                   'mode', NEW.payment_mode, 'note', NEW.note));
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_admin_payments_stamp ON public.admin_payments;
CREATE TRIGGER trg_admin_payments_stamp
    BEFORE INSERT ON public.admin_payments
    FOR EACH ROW EXECUTE FUNCTION public.admin_payments_stamp();

-- 4. Annuler sa propre saisie (24 h)
CREATE OR REPLACE FUNCTION public.staff_cancel_payment(p_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_email TEXT;
    v_row   public.admin_payments%ROWTYPE;
BEGIN
    IF NOT public.is_staff() THEN
        RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;
    SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();
    SELECT * INTO v_row FROM public.admin_payments WHERE id = p_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'unknown');
    END IF;
    IF lower(coalesce(v_row.entered_by, '')) <> lower(v_email)
       OR v_row.created_at < NOW() - INTERVAL '24 hours' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'not_allowed');
    END IF;
    DELETE FROM public.admin_payments WHERE id = p_id;
    INSERT INTO public.admin_audit (admin_email, action, target_email, details)
    VALUES (v_email, 'staff_payment_cancel', v_row.client_email,
            jsonb_build_object('amount', v_row.amount, 'type', v_row.type, 'note', v_row.note));
    RETURN jsonb_build_object('ok', true);
END;
$$;
REVOKE ALL ON FUNCTION public.staff_cancel_payment(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_cancel_payment(UUID) TO authenticated;

-- 5. Demandes en attente, SANS le code de licence
CREATE OR REPLACE FUNCTION public.staff_open_requests()
RETURNS TABLE (
    id           UUID,
    created_at   TIMESTAMPTZ,
    client_email TEXT,
    tier         TEXT,
    final_price  NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
    IF NOT (public.is_staff() OR public.is_admin()) THEN
        RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
    SELECT r.id, r.created_at, r.client_email::TEXT, r.tier::TEXT, r.final_price::NUMERIC
      FROM public.subscription_requests r
     WHERE r.status = 'pending'
     ORDER BY r.created_at DESC
     LIMIT 200;
END;
$$;
REVOKE ALL ON FUNCTION public.staff_open_requests() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_open_requests() TO authenticated;

-- 6. Gestion des assistants (Master uniquement, journalisée)
CREATE OR REPLACE FUNCTION public.admin_add_staff(p_email TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE v_me TEXT; v_target TEXT := lower(trim(p_email));
BEGIN
    IF NOT public.is_master() THEN
        RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;
    IF v_target IS NULL OR v_target = '' OR v_target NOT LIKE '%@%' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'bad_email');
    END IF;
    IF EXISTS (SELECT 1 FROM public.admins a WHERE lower(a.email) = v_target) THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'is_admin');
    END IF;
    SELECT email INTO v_me FROM auth.users WHERE id = auth.uid();
    INSERT INTO public.staff (email, added_by) VALUES (v_target, v_me)
    ON CONFLICT (email) DO NOTHING;
    INSERT INTO public.admin_audit (admin_email, action, target_email, details)
    VALUES (v_me, 'add_staff', v_target, '{}'::jsonb);
    RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_remove_staff(p_email TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE v_me TEXT; v_target TEXT := lower(trim(p_email));
BEGIN
    IF NOT public.is_master() THEN
        RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
    END IF;
    SELECT email INTO v_me FROM auth.users WHERE id = auth.uid();
    DELETE FROM public.staff WHERE lower(email) = v_target;
    INSERT INTO public.admin_audit (admin_email, action, target_email, details)
    VALUES (v_me, 'remove_staff', v_target, '{}'::jsonb);
    RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_add_staff(TEXT), public.admin_remove_staff(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_add_staff(TEXT), public.admin_remove_staff(TEXT) TO authenticated;

SELECT 'profil assistant' AS check,
       string_agg(proname, ', ' ORDER BY proname) AS result
  FROM pg_proc
 WHERE proname IN ('is_staff','staff_cancel_payment','staff_open_requests','admin_add_staff','admin_remove_staff');
