-- ============================================================================================================
-- 17 — MODE DE STOCKAGE PAR COMPTE (transition progressive vers « une ligne par document »)   *** VERSION 2 — REVUE ***
--
-- STATUT : proposé, NON appliqué sur Supabase, NON ajouté à sql/MANIFEST.json (donc pas dans l'installateur).
--          À valider avant toute application sur la PRÉPRODUCTION. Jamais sur la production sans autorisation distincte.
-- Prérequis : sql/14, sql/15, sql/16 (vérifiés au début du script ; il s'arrête sinon, sans rien créer).
-- N'ALTÈRE aucune table ni fonction existante : il ajoute 2 tables, 7 fonctions et 3 déclencheurs de garde (+ 1 sur sa propre table).
--
-- PRINCIPE — une SEULE source d'écriture par compte, décidée côté serveur :
--   mode 'legacy'    (défaut, aucune ligne) : user_data (invoices, quotes, payments, docLog) fait autorité ; les écritures dans
--                                             documents / doc_payments / doc_history par l'API sont refusées (MODE_ANCIEN_STOCKAGE).
--   mode 'documents' (comptes de TEST autorisés) : documents / doc_payments / doc_history font autorité ; les écritures de ces 4 clés dans
--                                             user_data sont refusées avec SQLSTATE 42501 + MODE_NOUVEAU_STOCKAGE ; l'ancien contenu
--                                             reste lisible, intact (retour arrière). Aucune double écriture : le serveur la rejette.
--
-- DROITS (tous imposés côté serveur ; l'e-mail seul ne donne rien) :
--   * seule la fonction INTERNE fp_doc_mode_set change un mode ; elle n'est exécutable ni par anon ni par authenticated ;
--   * passer en 'documents' exige DEUX conditions serveur : une ligne dans doc_store_testers (liste d'autorisation posée par l'opérateur)
--     ET un e-mail *@facturapro-test.invalid. Un déclencheur sur doc_store_mode impose la même règle, même pour une écriture SQL directe ;
--   * un utilisateur ne lit que SON mode (get_doc_mode) ; doc_store_mode et doc_store_testers n'ont aucun droit anon / authenticated.
--
-- VERROUS : chaque écriture sur les tables concernées prend un verrou consultatif PARTAGÉ propre au compte ; la bascule prend le verrou
--   EXCLUSIF. Une écriture en cours se termine avant que la copie ne lise ; une écriture qui arrive pendant la bascule attend, puis voit
--   le nouveau mode (et est refusée si elle vise l'ancienne source). Aucune écriture ne peut tomber « entre deux » sources.
--   Cas rarissime : interblocage détecté par PostgreSQL => l'une des deux transactions est annulée proprement (rien de perdu), à rejouer.
--
-- BASCULE vers 'documents' : refuse tout compte non autorisé ; refuse si l'ancien stockage a été écrit depuis moins de p_min_idle_seconds
--   (600 s par défaut : un ancien appareil est probablement actif) ; rattrape la copie (fp_mig_run) et vérifie (fp_mig_verify) ;
--   S'ARRÊTE (rien n'est modifié côté mode) tant qu'une décision explicite manque pour : (a) des documents modifiés des DEUX côtés
--   (CONFLITS_A_ARBITRER : la version du nouveau stockage est gardée, l'autre est conservée dans _mig_conflicts) ; (b) des BROUILLONS
--   absents de l'ancien tableau (supprimés sur un ancien appareil, ARBITRAGE_REQUIS) : 'keep' les conserve, 'delete' les supprime avec
--   pierre tombale ; (c) un document ÉMIS absent de l'ancien tableau : arrêt définitif (DOCUMENT_EMIS_ABSENT), aucune décision possible.
-- BASCULE vers 'legacy' : fp_mig_rollback appliqué (factures, devis, paiements) PUIS réintégration des entrées de journal absentes du
--   tableau docLog, puis resynchronisation des empreintes de référence (fp_mig_run) ; l'état précédent de chaque liste est mis de côté
--   dans _mig_source_backup ; tout est annulé si une étape échoue.
--
-- RETOUR ARRIÈRE DE CE SCRIPT (aucune donnée métier supprimée) :
--   DROP TRIGGER IF EXISTS trg_00_mode_user_data ON public.user_data; DROP TRIGGER IF EXISTS trg_00_mode_documents ON public.documents;
--   DROP TRIGGER IF EXISTS trg_00_mode_doc_payments ON public.doc_payments;
--   (avant de retirer les gardes : repasser tous les comptes en 'legacy' avec fp_doc_mode_set, sinon des écritures pourraient diverger)
--   DROP TABLE IF EXISTS public.doc_store_mode, public.doc_store_testers CASCADE;
--   DROP FUNCTION IF EXISTS public.append_history(JSONB, TEXT), public.get_doc_mode(), public.fp_doc_mode_set(UUID, TEXT, TEXT, INT),
--     public.guard_mode_user_data(), public.guard_mode_documents(), public.guard_doc_store_mode(), public.fp_doc_mode(UUID);
-- ============================================================================================================

DO $$
BEGIN
    IF to_regclass('public.documents') IS NULL OR to_regclass('public.doc_payments') IS NULL OR to_regclass('public.doc_history') IS NULL
       OR to_regclass('public.doc_deleted') IS NULL OR to_regclass('public._mig_conflicts') IS NULL OR to_regclass('public._mig_source_backup') IS NULL
       OR to_regprocedure('public.fp_mig_run(uuid,boolean)') IS NULL OR to_regprocedure('public.fp_mig_verify(uuid)') IS NULL
       OR to_regprocedure('public.fp_mig_rollback(uuid,boolean)') IS NULL OR to_regprocedure('public.fp_mig_active()') IS NULL
       OR to_regprocedure('public.fp_mig_legacy_docs(uuid)') IS NULL OR to_regprocedure('public.fp_mig_ts(text)') IS NULL
       OR to_regprocedure('public.fp_sha(jsonb)') IS NULL OR to_regprocedure('public.has_active_license(uuid)') IS NULL THEN
        RAISE EXCEPTION 'PREREQUIS_MANQUANT: appliquer sql/14, sql/15 et sql/16 avant sql/17';
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.doc_store_testers (     -- liste d'autorisation posée par l'opérateur (SQL), jamais par l'API
    user_id  UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    note     TEXT
);
ALTER TABLE public.doc_store_testers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.doc_store_testers FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.doc_store_mode (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    mode    TEXT NOT NULL DEFAULT 'legacy' CHECK (mode IN ('legacy', 'documents')),
    since   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    note    TEXT
);
ALTER TABLE public.doc_store_mode ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.doc_store_mode FROM anon, authenticated;     -- lu uniquement via get_doc_mode()

-- Règle imposée au niveau de la table : 'documents' seulement pour un compte autorisé ET dont l'e-mail est un e-mail de test
CREATE OR REPLACE FUNCTION public.guard_doc_store_mode() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
BEGIN
    IF NEW.mode = 'documents' AND NOT (
        EXISTS (SELECT 1 FROM public.doc_store_testers t WHERE t.user_id = NEW.user_id)
        AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = NEW.user_id AND u.email LIKE '%@facturapro-test.invalid')) THEN
        RAISE EXCEPTION 'COMPTE_NON_AUTORISE: le nouveau stockage exige une autorisation explicite et un compte de test';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_doc_store_mode() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_doc_store_mode_check ON public.doc_store_mode;
CREATE TRIGGER trg_doc_store_mode_check BEFORE INSERT OR UPDATE ON public.doc_store_mode
    FOR EACH ROW EXECUTE FUNCTION public.guard_doc_store_mode();

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
    IF r.key IN ('invoices', 'quotes', 'payments', 'docLog') THEN
        PERFORM pg_advisory_xact_lock_shared(hashtextextended('fp_doc_mode:' || r.user_id::text, 0));   -- attend une bascule en cours
        IF public.fp_doc_mode(r.user_id) = 'documents' AND NOT public.fp_mig_active() THEN
            IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = r.user_id) THEN RETURN OLD; END IF;   -- suppression du compte
            -- 42501 : les anciennes versions de l'application traitent ce code comme un refus définitif (pas de file de réessais)
            RAISE EXCEPTION 'MODE_NOUVEAU_STOCKAGE: ce compte utilise le nouveau stockage ; mettez l''application à jour (clé %)', r.key
                USING ERRCODE = '42501', HINT = 'MODE_NOUVEAU_STOCKAGE';
        END IF;
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
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('fp_doc_mode:' || r.user_id::text, 0));
    IF public.fp_doc_mode(r.user_id) <> 'documents' AND NOT public.fp_mig_active() THEN
        IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = r.user_id) THEN RETURN OLD; END IF;
        RAISE EXCEPTION 'MODE_ANCIEN_STOCKAGE: ce compte n''est pas en mode nouveau stockage' USING HINT = 'MODE_ANCIEN_STOCKAGE';
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
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('fp_doc_mode:' || v_uid::text, 0));
    IF public.fp_doc_mode(v_uid) <> 'documents' THEN RAISE EXCEPTION 'MODE_ANCIEN_STOCKAGE: ce compte n''est pas en mode nouveau stockage' USING HINT = 'MODE_ANCIEN_STOCKAGE'; END IF;
    IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array' OR jsonb_array_length(p_entries) > 100 THEN RAISE EXCEPTION 'JOURNAL_INVALIDE'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('fp_history:' || v_uid::text, 0));
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
CREATE OR REPLACE FUNCTION public.fp_doc_mode_set(p_user UUID, p_mode TEXT, p_resolution TEXT DEFAULT NULL, p_min_idle_seconds INT DEFAULT 600) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    v_email TEXT; v_cur TEXT; r JSONB; v JSONB; v_drafts JSONB; v_n INT; v_last TIMESTAMPTZ; v_conf INT;
    cur JSONB; v_add JSONB; v_new JSONB; v_jn INT := 0;
BEGIN
    IF p_mode NOT IN ('legacy', 'documents') THEN RAISE EXCEPTION 'MODE_INVALIDE'; END IF;
    IF p_resolution IS NOT NULL AND p_resolution NOT IN ('keep', 'delete') THEN RAISE EXCEPTION 'RESOLUTION_INVALIDE'; END IF;
    SELECT email INTO v_email FROM auth.users WHERE id = p_user;
    IF v_email IS NULL THEN RAISE EXCEPTION 'COMPTE_INTROUVABLE'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('fp_doc_mode:' || p_user::text, 0));      -- attend les écritures en cours, bloque les nouvelles
    INSERT INTO public.doc_store_mode(user_id) VALUES (p_user) ON CONFLICT DO NOTHING;
    SELECT mode INTO v_cur FROM public.doc_store_mode WHERE user_id = p_user FOR UPDATE;
    IF v_cur = p_mode THEN RETURN jsonb_build_object('ok', true, 'unchanged', true, 'mode', p_mode); END IF;

    IF p_mode = 'documents' THEN
        IF v_email NOT LIKE '%@facturapro-test.invalid' THEN
            RAISE EXCEPTION 'COMPTE_NON_TEST: le nouveau stockage n''est activable que pour les comptes *@facturapro-test.invalid';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM public.doc_store_testers WHERE user_id = p_user) THEN
            RAISE EXCEPTION 'COMPTE_NON_AUTORISE: compte absent de doc_store_testers';
        END IF;
        SELECT MAX(updated_at) INTO v_last FROM public.user_data WHERE user_id = p_user AND key IN ('invoices', 'quotes', 'payments', 'docLog');
        IF v_last IS NOT NULL AND v_last > NOW() - make_interval(secs => p_min_idle_seconds) THEN
            RETURN jsonb_build_object('ok', false, 'stopped', true, 'reason', 'ACTIVITE_RECENTE_ANCIEN_APPAREIL', 'last_legacy_write', v_last,
                                      'note', 'un appareil écrit encore dans l''ancien stockage : réessayer plus tard');
        END IF;
        r := public.fp_mig_run(p_user, TRUE);
        IF r->>'status' <> 'applied' THEN RETURN jsonb_build_object('ok', false, 'stopped', true, 'reason', 'MIGRATION_NON_APPLIQUEE', 'run', r); END IF;
        v := public.fp_mig_verify(p_user);
        IF (v->>'ok')::boolean IS NOT TRUE THEN RETURN jsonb_build_object('ok', false, 'stopped', true, 'reason', 'VERIFICATION_ECHOUEE', 'verify', v); END IF;

        -- (c) document ÉMIS absent de l'ancien tableau : jamais résolu automatiquement
        IF EXISTS (SELECT 1 FROM public.documents d WHERE d.user_id = p_user AND d.status <> 'draft'
                    AND NOT EXISTS (SELECT 1 FROM public.fp_mig_legacy_docs(p_user) l WHERE l.doc_type = d.doc_type AND l.doc_id = d.id)) THEN
            RETURN jsonb_build_object('ok', false, 'stopped', true, 'reason', 'DOCUMENT_EMIS_ABSENT');
        END IF;
        -- (a) modifiés des deux côtés
        SELECT (SELECT count(*) FROM public.documents d JOIN public.fp_mig_legacy_docs(p_user) l ON (d.user_id, d.doc_type, d.id) = (l.user_id, l.doc_type, l.doc_id)
                 WHERE d.body_sha <> d.legacy_sha AND d.legacy_sha <> public.fp_sha(l.el))
             + (SELECT count(*) FROM public.doc_payments p JOIN public.fp_mig_legacy_pay(p_user) l ON (p.user_id, p.id) = (l.user_id, l.pay_id)
                 WHERE p.body_sha <> p.legacy_sha AND p.legacy_sha <> public.fp_sha(l.el)) INTO v_conf;      -- état réel (pas seulement ceux de cette exécution)
        IF v_conf > 0 AND p_resolution IS NULL THEN
            RETURN jsonb_build_object('ok', false, 'stopped', true, 'reason', 'CONFLITS_A_ARBITRER', 'conflicts', v_conf,
                                      'note', 'versions de l''ancien stockage conservées dans _mig_conflicts ; décision : keep (garder le nouveau stockage)');
        END IF;
        -- (b) brouillons absents de l'ancien tableau (supprimés sur un ancien appareil), sans pierre tombale du nouveau chemin
        SELECT COALESCE(jsonb_agg(jsonb_build_object('doc_type', d.doc_type, 'id', d.id, 'number', d.number, 'modified_since_copy', d.body_sha <> d.legacy_sha)), '[]'::jsonb)
          INTO v_drafts
          FROM public.documents d
         WHERE d.user_id = p_user AND d.status = 'draft'
           AND NOT EXISTS (SELECT 1 FROM public.fp_mig_legacy_docs(p_user) l WHERE l.doc_type = d.doc_type AND l.doc_id = d.id)
           AND NOT EXISTS (SELECT 1 FROM public.doc_deleted g WHERE (g.user_id, g.doc_type, g.id) = (d.user_id, d.doc_type, d.id));
        v_n := jsonb_array_length(v_drafts);
        IF v_n > 0 AND p_resolution IS NULL THEN
            RETURN jsonb_build_object('ok', false, 'stopped', true, 'reason', 'ARBITRAGE_REQUIS', 'drafts', v_drafts);
        END IF;
        IF v_n > 0 THEN
            INSERT INTO public._mig_conflicts(user_id, kind, doc_type, doc_id, legacy)
            SELECT p_user, 'brouillon_supprime_ancien_appareil', x->>'doc_type', x->>'id', jsonb_build_object('decision', p_resolution, 'doc', x)
              FROM jsonb_array_elements(v_drafts) x;
        END IF;
        UPDATE public.doc_store_mode SET mode = 'documents', since = NOW(), note = 'bascule contrôlée' WHERE user_id = p_user;
        IF v_n > 0 AND p_resolution = 'delete' THEN       -- le mode est 'documents' : la suppression passe par les gardes habituelles
            INSERT INTO public.doc_deleted(user_id, doc_type, id) SELECT p_user, x->>'doc_type', x->>'id' FROM jsonb_array_elements(v_drafts) x ON CONFLICT DO NOTHING;
            DELETE FROM public.documents d USING jsonb_array_elements(v_drafts) x WHERE d.user_id = p_user AND d.doc_type = x->>'doc_type' AND d.id = x->>'id' AND d.status = 'draft';
        END IF;
        RETURN jsonb_build_object('ok', true, 'mode', 'documents', 'drafts_decided', v_n, 'conflicts_noted', v_conf, 'resolution', p_resolution, 'run', r);
    END IF;

    -- ===== retour au mode ancien : le mode change d'abord (le retour arrière doit pouvoir écrire user_data) ; tout est annulé si une étape échoue =====
    UPDATE public.doc_store_mode SET mode = 'legacy', since = NOW(), note = 'retour arrière' WHERE user_id = p_user;
    r := public.fp_mig_rollback(p_user, TRUE);
    IF r->>'status' <> 'rollback_applied' THEN RAISE EXCEPTION 'RETOUR_ARRIERE_ECHOUE: %', r; END IF;
    -- journal : entrées de doc_history absentes du tableau docLog (rang compris, pour les entrées strictement identiques)
    SELECT value INTO cur FROM public.user_data WHERE user_id = p_user AND key = 'docLog';
    IF cur IS NULL OR jsonb_typeof(cur) = 'array' THEN
        cur := COALESCE(cur, '[]'::jsonb);
        WITH have AS (SELECT public.fp_sha(e.v) AS sha, (row_number() OVER (PARTITION BY public.fp_sha(e.v) ORDER BY e.ord) - 1)::int AS dup
                        FROM jsonb_array_elements(cur) WITH ORDINALITY e(v, ord) WHERE jsonb_typeof(e.v) = 'object'),
             miss AS (SELECT h.body, h.ts, h.seq FROM public.doc_history h
                       WHERE h.user_id = p_user AND NOT EXISTS (SELECT 1 FROM have WHERE have.sha = h.entry_sha AND have.dup = h.dup))
        SELECT COALESCE(jsonb_agg(body ORDER BY ts NULLS FIRST, seq), '[]'::jsonb), count(*)::int INTO v_add, v_jn FROM miss;
        IF v_jn > 0 THEN
            INSERT INTO public._mig_source_backup(user_id, key, sha256, value) VALUES (p_user, 'docLog', public.fp_sha(cur), cur) ON CONFLICT DO NOTHING;
            SELECT COALESCE(jsonb_agg(x.v ORDER BY x.o), '[]'::jsonb) INTO v_new
              FROM (SELECT e.v, e.ord AS o FROM jsonb_array_elements(cur || v_add) WITH ORDINALITY e(v, ord) ORDER BY e.ord DESC LIMIT 2000) x;   -- plafond de l'application : 2000
            INSERT INTO public.user_data(user_id, key, value, updated_at) VALUES (p_user, 'docLog', v_new, NOW())
            ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
        END IF;
    END IF;
    -- resynchronisation : l'ancien stockage a rejoint le nouveau ; on aligne l'empreinte de référence (legacy_sha) pour qu'une modification
    -- faite ensuite sur un ancien appareil soit un simple rattrapage lors d'une prochaine bascule, et non un faux conflit
    v := public.fp_mig_run(p_user, TRUE);
    IF v->>'status' <> 'applied' THEN RAISE EXCEPTION 'RESYNCHRO_ECHOUEE: %', v; END IF;
    RETURN jsonb_build_object('ok', true, 'mode', 'legacy', 'journal_entries_restored', v_jn, 'rollback', r, 'resync', v->>'status');
END;
$$;
REVOKE ALL ON FUNCTION public.fp_doc_mode_set(UUID, TEXT, TEXT, INT) FROM PUBLIC, anon, authenticated;
