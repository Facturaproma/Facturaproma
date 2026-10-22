-- ============================================================================================================
-- 17 — MODE DE STOCKAGE PAR COMPTE (transition progressive vers « une ligne par document »)       *** BROUILLON ***
--
-- STATUT : proposé, NON appliqué sur Supabase, NON ajouté à sql/MANIFEST.json (donc pas dans l'installateur).
--          À présenter et faire valider avant toute application sur la PRÉPRODUCTION. Jamais sur la production sans autorisation distincte.
-- Prérequis : sql/14, sql/15, sql/16. Ne modifie AUCUNE fonction ni table existante ; n'ajoute que des objets nouveaux.
--
-- OBJET : une SEULE source fait autorité pour un compte donné, décidée côté serveur et non par le navigateur :
--   mode 'legacy'    (défaut, aucune ligne)  : user_data (invoices, quotes, payments, docLog) fait autorité ; les écritures vers
--                                              documents / doc_payments sont REFUSÉES (MODE_ANCIEN_STOCKAGE).
--   mode 'documents' (comptes de TEST seulement) : documents / doc_payments / doc_history font autorité ; les écritures vers ces 4 clés de
--                                              user_data sont REFUSÉES (MODE_NOUVEAU_STOCKAGE) — l'ancien contenu reste en lecture, intact,
--                                              pour le retour arrière. Pas de double écriture possible : le serveur la rejette.
-- Un ancien appareil (ancienne version de l'application) qui tente d'écrire en mode 'documents' reçoit une ERREUR explicite : rien ne
-- disparaît silencieusement, rien n'est écrit en double.
--
-- BASCULE (fonction interne, jamais appelable par l'API) :
--   fp_doc_mode_set(uid, 'documents', resolution) : refuse tout compte hors *@facturapro-test.invalid ; rattrape la copie (fp_mig_run) ;
--       vérifie (fp_mig_verify) ; détecte les BROUILLONS SUPPRIMÉS sur un ancien appareil depuis la copie (présents dans documents,
--       jamais modifiés depuis, absents de l'ancien tableau) : sans décision explicite ('keep' ou 'delete') la bascule S'ARRÊTE
--       (ARBITRAGE_REQUIS) et la liste est renvoyée ; la décision prise pour chaque cas est notée dans _mig_conflicts. Toute la bascule est une transaction.
--   fp_doc_mode_set(uid, 'legacy') : retour arrière complet (fp_mig_rollback appliqué) puis mode ancien, dans la même transaction.
--
-- JOURNAL : append_history(entrées, op) — seul moyen d'écrire doc_history en mode 'documents' (rejouable, 100 entrées max par appel).
--
-- RETOUR ARRIÈRE DE CE SCRIPT (aucune donnée métier n'est supprimée) :
--   DROP TRIGGER IF EXISTS trg_00_mode_user_data ON public.user_data; DROP TRIGGER IF EXISTS trg_00_mode_documents ON public.documents;
--   DROP TRIGGER IF EXISTS trg_00_mode_doc_payments ON public.doc_payments;
--   DROP FUNCTION IF EXISTS public.append_history(JSONB, TEXT), public.get_doc_mode(), public.fp_doc_mode_set(UUID, TEXT, TEXT),
--     public.guard_mode_user_data(), public.guard_mode_documents(), public.fp_doc_mode(UUID); DROP TABLE IF EXISTS public.doc_store_mode;
-- ============================================================================================================

CREATE TABLE IF NOT EXISTS public.doc_store_mode (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    mode    TEXT NOT NULL DEFAULT 'legacy' CHECK (mode IN ('legacy', 'documents')),
    since   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    note    TEXT
);
ALTER TABLE public.doc_store_mode ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.doc_store_mode FROM anon, authenticated;     -- lu uniquement via get_doc_mode()

CREATE OR REPLACE FUNCTION public.fp_doc_mode(p_uid UUID) RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT COALESCE((SELECT mode FROM public.doc_store_mode WHERE user_id = p_uid), 'legacy')
$$;
REVOKE ALL ON FUNCTION public.fp_doc_mode(UUID) FROM PUBLIC, anon, authenticated;

-- Le mode de SON propre compte (jamais celui d'un autre)
CREATE OR REPLACE FUNCTION public.get_doc_mode() RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
    SELECT CASE WHEN auth.uid() IS NULL THEN NULL ELSE public.fp_doc_mode(auth.uid()) END
$$;
REVOKE ALL ON FUNCTION public.get_doc_mode() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_doc_mode() TO authenticated;

-- ---------- gardes : une seule source d'écriture à la fois ----------
CREATE OR REPLACE FUNCTION public.guard_mode_user_data() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE r public.user_data%ROWTYPE;
BEGIN
    r := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    IF r.key IN ('invoices', 'quotes', 'payments', 'docLog') AND public.fp_doc_mode(r.user_id) = 'documents' AND NOT public.fp_mig_active() THEN
        IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = r.user_id) THEN RETURN OLD; END IF;   -- suppression du compte
        RAISE EXCEPTION 'MODE_NOUVEAU_STOCKAGE: ce compte utilise le nouveau stockage ; mettez l''application à jour (clé %)', r.key;
    END IF;
    RETURN r;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_mode_user_data() FROM PUBLIC, anon, authenticated;
-- « trg_00_ » : s'exécute AVANT les déclencheurs de sql/14 (ordre alphabétique des noms)
DROP TRIGGER IF EXISTS trg_00_mode_user_data ON public.user_data;
CREATE TRIGGER trg_00_mode_user_data BEFORE INSERT OR UPDATE OR DELETE ON public.user_data
    FOR EACH ROW EXECUTE FUNCTION public.guard_mode_user_data();

CREATE OR REPLACE FUNCTION public.guard_mode_documents() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE r RECORD;
BEGIN
    r := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    IF public.fp_doc_mode(r.user_id) <> 'documents' AND NOT public.fp_mig_active() THEN
        IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = r.user_id) THEN RETURN OLD; END IF;
        RAISE EXCEPTION 'MODE_ANCIEN_STOCKAGE: ce compte n''est pas en mode nouveau stockage';
    END IF;
    RETURN r;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_mode_documents() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_00_mode_documents ON public.documents;
CREATE TRIGGER trg_00_mode_documents BEFORE INSERT OR UPDATE OR DELETE ON public.documents
    FOR EACH ROW EXECUTE FUNCTION public.guard_mode_documents();
DROP TRIGGER IF EXISTS trg_00_mode_doc_payments ON public.doc_payments;
CREATE TRIGGER trg_00_mode_doc_payments BEFORE INSERT OR UPDATE OR DELETE ON public.doc_payments
    FOR EACH ROW EXECUTE FUNCTION public.guard_mode_documents();

-- ---------- journal ----------
-- append_history : ajoute des entrées de journal (objets JSON). Une entrée qui porte un champ « id » est rejouable sans doublon.
CREATE OR REPLACE FUNCTION public.append_history(p_entries JSONB, p_op_id TEXT DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v_uid UUID := auth.uid(); e JSONB; v_sha TEXT; v_dup INT; v_new INT := 0; v_seq BIGINT;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE'; END IF;
    IF NOT COALESCE(public.has_active_license(v_uid), FALSE) THEN RAISE EXCEPTION 'LICENCE_INACTIVE'; END IF;
    IF public.fp_doc_mode(v_uid) <> 'documents' THEN RAISE EXCEPTION 'MODE_ANCIEN_STOCKAGE: ce compte n''est pas en mode nouveau stockage'; END IF;
    IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array' OR jsonb_array_length(p_entries) > 100 THEN RAISE EXCEPTION 'JOURNAL_INVALIDE'; END IF;
    PERFORM pg_advisory_xact_lock(hashtext('append_history:' || v_uid::text));
    FOR e IN SELECT * FROM jsonb_array_elements(p_entries) LOOP
        IF jsonb_typeof(e) <> 'object' THEN RAISE EXCEPTION 'JOURNAL_INVALIDE'; END IF;
        v_sha := public.fp_sha(e);
        IF e ? 'id' THEN v_dup := 0;
        ELSE SELECT COALESCE(MAX(dup) + 1, 0) INTO v_dup FROM public.doc_history WHERE user_id = v_uid AND entry_sha = v_sha; END IF;
        SELECT COALESCE(MAX(seq), 0) + 1 INTO v_seq FROM public.doc_history WHERE user_id = v_uid;
        INSERT INTO public.doc_history(user_id, entry_sha, dup, seq, ts, action, doc_id, number, detail, body)
        VALUES (v_uid, v_sha, v_dup, v_seq, public.fp_mig_ts(e->>'ts'), e->>'action', e->>'docId', e->>'number', e->>'detail', e)
        ON CONFLICT (user_id, entry_sha, dup) DO NOTHING;
        IF FOUND THEN v_new := v_new + 1; END IF;
    END LOOP;
    RETURN jsonb_build_object('ok', true, 'added', v_new);
END;
$$;
REVOKE ALL ON FUNCTION public.append_history(JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.append_history(JSONB, TEXT) TO authenticated;

-- ---------- bascule contrôlée (INTERNE : non exécutable par anon / authenticated) ----------
CREATE OR REPLACE FUNCTION public.fp_doc_mode_set(p_user UUID, p_mode TEXT, p_resolution TEXT DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    v_email TEXT; v_cur TEXT; r JSONB; v JSONB; v_drafts JSONB; v_n INT;
BEGIN
    IF p_mode NOT IN ('legacy', 'documents') THEN RAISE EXCEPTION 'MODE_INVALIDE'; END IF;
    SELECT email INTO v_email FROM auth.users WHERE id = p_user;
    IF v_email IS NULL THEN RAISE EXCEPTION 'COMPTE_INTROUVABLE'; END IF;
    IF v_email NOT LIKE '%@facturapro-test.invalid' THEN
        RAISE EXCEPTION 'COMPTE_NON_TEST: le nouveau stockage n''est activable que pour les comptes *@facturapro-test.invalid';
    END IF;
    INSERT INTO public.doc_store_mode(user_id) VALUES (p_user) ON CONFLICT DO NOTHING;
    SELECT mode INTO v_cur FROM public.doc_store_mode WHERE user_id = p_user FOR UPDATE;
    IF v_cur = p_mode THEN RETURN jsonb_build_object('ok', true, 'unchanged', true, 'mode', p_mode); END IF;

    IF p_mode = 'documents' THEN
        r := public.fp_mig_run(p_user, TRUE);
        IF r->>'status' <> 'applied' THEN RETURN jsonb_build_object('ok', false, 'stopped', true, 'reason', 'MIGRATION_NON_APPLIQUEE', 'run', r); END IF;
        v := public.fp_mig_verify(p_user);
        IF (v->>'ok')::boolean IS NOT TRUE THEN RETURN jsonb_build_object('ok', false, 'stopped', true, 'reason', 'VERIFICATION_ECHOUEE', 'verify', v); END IF;
        -- brouillons supprimés sur un ancien appareil depuis la copie : jamais résolus en silence
        SELECT COALESCE(jsonb_agg(jsonb_build_object('doc_type', d.doc_type, 'id', d.id, 'number', d.number)), '[]'::jsonb) INTO v_drafts
          FROM public.documents d
         WHERE d.user_id = p_user AND d.status = 'draft' AND d.source = 'migration' AND d.body_sha = d.legacy_sha
           AND NOT EXISTS (SELECT 1 FROM public.fp_mig_legacy_docs(p_user) l WHERE l.doc_type = d.doc_type AND l.doc_id = d.id);
        v_n := jsonb_array_length(v_drafts);
        IF v_n > 0 THEN
            IF p_resolution IS NULL OR p_resolution NOT IN ('keep', 'delete') THEN
                RETURN jsonb_build_object('ok', false, 'stopped', true, 'reason', 'ARBITRAGE_REQUIS', 'drafts', v_drafts);
            END IF;
            INSERT INTO public._mig_conflicts(user_id, kind, doc_type, doc_id, legacy)
            SELECT p_user, 'brouillon_supprime_ancien_appareil', x->>'doc_type', x->>'id', jsonb_build_object('decision', p_resolution, 'doc', x)
              FROM jsonb_array_elements(v_drafts) x;
            IF p_resolution = 'delete' THEN
                -- suppression décidée explicitement : tombe sur la pierre tombale, comme une suppression par le nouveau chemin
                UPDATE public.doc_store_mode SET mode = 'documents', since = NOW(), note = 'bascule contrôlée' WHERE user_id = p_user;
                INSERT INTO public.doc_deleted(user_id, doc_type, id) SELECT p_user, x->>'doc_type', x->>'id' FROM jsonb_array_elements(v_drafts) x ON CONFLICT DO NOTHING;
                DELETE FROM public.documents d USING jsonb_array_elements(v_drafts) x WHERE d.user_id = p_user AND d.doc_type = x->>'doc_type' AND d.id = x->>'id' AND d.status = 'draft';
            END IF;
        END IF;
        UPDATE public.doc_store_mode SET mode = 'documents', since = NOW(), note = 'bascule contrôlée' WHERE user_id = p_user;
        RETURN jsonb_build_object('ok', true, 'mode', 'documents', 'drafts_decided', v_n, 'resolution', p_resolution, 'run', r);
    END IF;

    -- retour au mode ancien : le mode change d'abord (le retour arrière doit pouvoir écrire user_data), tout est annulé si le retour arrière échoue
    UPDATE public.doc_store_mode SET mode = 'legacy', since = NOW(), note = 'retour arrière' WHERE user_id = p_user;
    r := public.fp_mig_rollback(p_user, TRUE);
    IF r->>'status' <> 'rollback_applied' THEN RAISE EXCEPTION 'RETOUR_ARRIERE_ECHOUE: %', r; END IF;
    RETURN jsonb_build_object('ok', true, 'mode', 'legacy', 'rollback', r);
END;
$$;
REVOKE ALL ON FUNCTION public.fp_doc_mode_set(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
