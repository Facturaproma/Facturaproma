-- sql/43 : avoirs partiels — le cumul des avoirs émis sur une facture ne peut pas dépasser son total TTC.
-- L'application permet désormais plusieurs avoirs par facture (avoir partiel). Ce garde-fou serveur refuse toute écriture
-- du tableau « invoices » (user_data) qui AUGMENTE le cumul des avoirs d'une facture au-delà de son TTC (tolérance 0,01).
-- Un ancien dépassement déjà enregistré ne bloque rien rétroactivement (seule une augmentation est contrôlée).
-- Réexécutable. Ne modifie aucune donnée. Retour arrière : DROP TRIGGER trg_12_credit_cap ON public.user_data (après accord).

CREATE OR REPLACE FUNCTION public.guard_credit_cap() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    old_val JSONB; rid TEXT; inv JSONB; total NUMERIC; c_new NUMERIC; c_old NUMERIC;
BEGIN
    IF NEW.key <> 'invoices' OR jsonb_typeof(NEW.value) <> 'array' THEN RETURN NEW; END IF;
    -- Rien à contrôler sans avoir émis rattaché à une facture
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.value) e WHERE jsonb_typeof(e) = 'object' AND e->>'type' = 'credit'
                     AND COALESCE(e->>'status', 'draft') <> 'draft' AND NULLIF(e->>'relatedInvoiceId', '') IS NOT NULL) THEN RETURN NEW; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('fp_credit_cap:' || NEW.user_id::text, 0));
    SELECT u.value INTO old_val FROM public.user_data u WHERE u.user_id = NEW.user_id AND u.key = 'invoices' FOR UPDATE;
    FOR rid IN SELECT DISTINCT e->>'relatedInvoiceId' FROM jsonb_array_elements(NEW.value) e
                WHERE jsonb_typeof(e) = 'object' AND e->>'type' = 'credit' AND COALESCE(e->>'status', 'draft') <> 'draft' AND NULLIF(e->>'relatedInvoiceId', '') IS NOT NULL
    LOOP
        SELECT COALESCE(sum(abs(COALESCE(public.fin_num(e->>'totalTTC'), 0))), 0) INTO c_new FROM jsonb_array_elements(NEW.value) e
         WHERE jsonb_typeof(e) = 'object' AND e->>'type' = 'credit' AND COALESCE(e->>'status', 'draft') <> 'draft' AND e->>'relatedInvoiceId' = rid;
        c_old := 0;
        IF old_val IS NOT NULL AND jsonb_typeof(old_val) = 'array' THEN
            SELECT COALESCE(sum(abs(COALESCE(public.fin_num(e->>'totalTTC'), 0))), 0) INTO c_old FROM jsonb_array_elements(old_val) e
             WHERE jsonb_typeof(e) = 'object' AND e->>'type' = 'credit' AND COALESCE(e->>'status', 'draft') <> 'draft' AND e->>'relatedInvoiceId' = rid;
        END IF;
        IF c_new <= c_old + 0.0001 THEN CONTINUE; END IF;
        SELECT e INTO inv FROM jsonb_array_elements(NEW.value) e WHERE jsonb_typeof(e) = 'object' AND e->>'id' = rid AND COALESCE(e->>'type', 'invoice') = 'invoice' LIMIT 1;
        IF inv IS NULL THEN CONTINUE; END IF;          -- facture absente du tableau : rien à comparer
        total := abs(COALESCE(public.fin_num(inv->>'totalTTC'), 0));
        IF c_new > total + 0.01 THEN
            RAISE EXCEPTION 'AVOIR_SUPERIEUR_FACTURE: le cumul des avoirs dépasse le total de la facture' USING ERRCODE = '23514';
        END IF;
    END LOOP;
    RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.guard_credit_cap() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER trg_12_credit_cap BEFORE INSERT OR UPDATE ON public.user_data
    FOR EACH ROW WHEN (NEW.key = 'invoices') EXECUTE FUNCTION public.guard_credit_cap();
