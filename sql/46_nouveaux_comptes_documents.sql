-- sql/46 : tout NOUVEAU compte démarre directement en mode « documents » (ventes et paiements dans de vraies tables).
-- Depuis le 02/11/2026, tous les comptes existants ont été basculés (fp_doc_mode_set, copie vérifiée). Un compte créé ensuite n'a
-- aucune donnée dans l'ancien stockage : il est autorisé (doc_store_testers) et placé en mode documents dès sa création.
-- Retour arrière d'un compte : fp_doc_mode_set(compte, 'legacy') (sql/17). Réexécutable. Ne modifie aucun compte existant.
CREATE OR REPLACE FUNCTION public.fp_new_account_documents() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    INSERT INTO public.doc_store_testers(user_id, note) VALUES (NEW.id, 'nouveau compte') ON CONFLICT DO NOTHING;
    INSERT INTO public.doc_store_mode(user_id, mode, note) VALUES (NEW.id, 'documents', 'nouveau compte') ON CONFLICT DO NOTHING;
    RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.fp_new_account_documents() FROM PUBLIC, anon, authenticated;
CREATE OR REPLACE TRIGGER trg_fp_new_account_documents AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.fp_new_account_documents();
