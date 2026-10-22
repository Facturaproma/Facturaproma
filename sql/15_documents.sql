-- ============================================================
-- 15 — Stockage « une ligne par document » (factures, avoirs, devis) + paiements + historique
--
-- ÉTAT : PRÉPARATION. À exécuter UNIQUEMENT en PRÉPRODUCTION, après accord écrit. Ce script ne copie AUCUNE donnée :
-- il crée des tables vides et des fonctions. L'ancien stockage (public.user_data) n'est ni lu, ni modifié ici.
-- Il N'EST PAS dans l'ordre d'installation de sql/MANIFEST.json (clé « ordre ») : les outils d'installation automatique l'ignorent.
--
-- Contenu
--   * documents      : 1 ligne par facture / avoir / devis (clé : compte + type + id), version pour la concurrence,
--                      corps complet conservé tel quel (body), empreintes SHA-256 (body_sha = état actuel, legacy_sha = état migré).
--   * doc_payments   : 1 ligne par encaissement (aujourd'hui : tableau user_data.payments).
--   * doc_history    : journal client migré (aujourd'hui : tableau user_data.docLog), en ajout seul. doc_events (serveur) est inchangé.
--   * Aucun droit d'écriture direct pour les utilisateurs : tout passe par upsert_document / delete_document / record_payment
--     (SECURITY DEFINER) qui appliquent : contrôle de version (conflit explicite), reprise idempotente (identifiant d'opération),
--     licence active, verrouillage des documents émis, numéro attribué par le serveur (même règle que sql/14).
--
-- Retour arrière de CE script (aucune donnée métier n'y est encore) :
--   DROP FUNCTION IF EXISTS public.upsert_document(jsonb,int,text), public.delete_document(text,text,int,text), public.record_payment(text,jsonb,text);
--   DROP TABLE IF EXISTS public.doc_deleted, public.doc_history, public.doc_payments, public.documents CASCADE;  (+ fonctions fp_* / tables _mig_* du script 16)
-- ============================================================

-- ---------- utilitaires purs ----------
CREATE OR REPLACE FUNCTION public.fp_num(t text) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
BEGIN RETURN t::numeric; EXCEPTION WHEN others THEN RETURN NULL; END $$;

CREATE OR REPLACE FUNCTION public.fp_date(t text) RETURNS date
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
BEGIN RETURN t::date; EXCEPTION WHEN others THEN RETURN NULL; END $$;

CREATE OR REPLACE FUNCTION public.fp_sha(j jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public AS $$ SELECT encode(sha256(convert_to(j::text, 'UTF8')), 'hex') $$;

REVOKE ALL ON FUNCTION public.fp_num(text), public.fp_date(text), public.fp_sha(jsonb) FROM PUBLIC, anon;   -- utilitaires internes
GRANT EXECUTE ON FUNCTION public.fp_num(text), public.fp_date(text), public.fp_sha(jsonb) TO authenticated;

-- ---------- tables ----------
CREATE TABLE IF NOT EXISTS public.documents (
    user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    doc_type    TEXT        NOT NULL CHECK (doc_type IN ('invoice', 'credit', 'quote')),
    id          TEXT        NOT NULL CHECK (length(id) > 0),
    number      TEXT,
    status      TEXT        NOT NULL DEFAULT 'draft',
    doc_date    DATE,
    due_date    DATE,
    client_id   TEXT,
    client_name TEXT,
    total_ht    NUMERIC     NOT NULL DEFAULT 0,      -- NUMERIC sans échelle : aucun arrondi caché
    total_tva   NUMERIC     NOT NULL DEFAULT 0,
    total_ttc   NUMERIC     NOT NULL DEFAULT 0,
    paid_amount NUMERIC     NOT NULL DEFAULT 0,
    related_id  TEXT,
    body        JSONB       NOT NULL CHECK (jsonb_typeof(body) = 'object'),   -- document complet, tel quel
    body_sha    TEXT        NOT NULL,                -- empreinte de l'état actuel (recalculée par le déclencheur)
    legacy_sha  TEXT,                                -- empreinte de l'élément de user_data au moment de la copie/rafraîchissement
    version     INTEGER     NOT NULL DEFAULT 1,
    source      TEXT        NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'migration')),
    last_op_id  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, doc_type, id)
);
-- Unicité des numéros officiels (factures et avoirs émis). Les brouillons (BRO-…) et les devis (numéro non fiscal) en sont exclus.
CREATE UNIQUE INDEX IF NOT EXISTS documents_number_uq ON public.documents (user_id, doc_type, number)
    WHERE number IS NOT NULL AND status <> 'draft' AND doc_type IN ('invoice', 'credit');
CREATE INDEX IF NOT EXISTS documents_user_date ON public.documents (user_id, doc_date DESC);

CREATE TABLE IF NOT EXISTS public.doc_payments (
    user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    id         TEXT        NOT NULL CHECK (length(id) > 0),
    invoice_id TEXT,
    pay_date   DATE,
    amount     NUMERIC     NOT NULL DEFAULT 0,
    method     TEXT,
    body       JSONB       NOT NULL CHECK (jsonb_typeof(body) = 'object'),
    body_sha   TEXT        NOT NULL,
    legacy_sha TEXT,
    source     TEXT        NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'migration')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS doc_payments_invoice ON public.doc_payments (user_id, invoice_id);

CREATE TABLE IF NOT EXISTS public.doc_history (
    user_id   UUID   NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    entry_sha TEXT   NOT NULL,                     -- empreinte de l'entrée (le journal local est tronqué à 2000 : le rang ne sert pas d'identité)
    dup       INT    NOT NULL DEFAULT 0,           -- rang parmi des entrées strictement identiques
    seq       BIGINT,                              -- rang dans l'ancien tableau docLog lors de la dernière copie (information)
    ts        TIMESTAMPTZ,
    action    TEXT,
    doc_id    TEXT,
    number    TEXT,
    detail    TEXT,
    body      JSONB  NOT NULL,
    PRIMARY KEY (user_id, entry_sha, dup)
);

-- Suppressions de documents faites par le nouveau chemin (pour ne pas les ressusciter lors d'un retour arrière ou d'un rattrapage)
CREATE TABLE IF NOT EXISTS public.doc_deleted (
    user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    doc_type   TEXT NOT NULL,
    id         TEXT NOT NULL,
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, doc_type, id)
);
ALTER TABLE public.doc_deleted ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.doc_deleted FROM anon, authenticated;

-- ---------- RLS : lecture de ses propres lignes uniquement, aucune écriture directe ----------
ALTER TABLE public.documents    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doc_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doc_history  ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS documents_select_own    ON public.documents;
DROP POLICY IF EXISTS doc_payments_select_own ON public.doc_payments;
DROP POLICY IF EXISTS doc_history_select_own  ON public.doc_history;
CREATE POLICY documents_select_own    ON public.documents    FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY doc_payments_select_own ON public.doc_payments FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY doc_history_select_own  ON public.doc_history  FOR SELECT USING (auth.uid() = user_id);
REVOKE ALL ON public.documents, public.doc_payments, public.doc_history FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.documents, public.doc_payments, public.doc_history FROM authenticated;
GRANT SELECT ON public.documents, public.doc_payments, public.doc_history TO authenticated;

-- ---------- tables techniques de migration (aucun accès via l'API) ----------
CREATE TABLE IF NOT EXISTS public._mig_runs (
    run_id      UUID PRIMARY KEY,
    mode        TEXT NOT NULL,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    status      TEXT NOT NULL,           -- running | stopped | applied | dry_run_ok | rollback_applied
    report      JSONB
);
CREATE TABLE IF NOT EXISTS public._mig_source_backup (   -- copie des lignes user_data AVANT toute écriture dessus (jamais écrasée)
    user_id UUID NOT NULL,
    key     TEXT NOT NULL,
    sha256  TEXT NOT NULL,
    value   JSONB NOT NULL,
    saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    run_id  UUID,
    PRIMARY KEY (user_id, key, sha256)
);
CREATE TABLE IF NOT EXISTS public._mig_conflicts (
    id        BIGSERIAL PRIMARY KEY,
    run_id    UUID,
    user_id   UUID NOT NULL,
    kind      TEXT NOT NULL,             -- document | payment
    doc_type  TEXT,
    doc_id    TEXT NOT NULL,
    legacy    JSONB NOT NULL,            -- version de l'ancien stockage, conservée intégralement
    noted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public._mig_runs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public._mig_source_backup ENABLE ROW LEVEL SECURITY;
ALTER TABLE public._mig_conflicts     ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public._mig_runs, public._mig_source_backup, public._mig_conflicts FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public._mig_conflicts_id_seq FROM anon, authenticated;

-- ---------- déclencheur : valeurs dérivées + verrouillage + numéro serveur (mêmes règles que sql/14) ----------
CREATE OR REPLACE FUNCTION public.fp_mig_active() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    -- vrai uniquement pendant une migration en cours dont l'identifiant (aléatoire, illisible pour les utilisateurs) est fourni
    SELECT EXISTS (SELECT 1 FROM public._mig_runs r
                    WHERE r.status = 'running' AND r.run_id::text = current_setting('fp.migration_run', true))
$$;

CREATE OR REPLACE FUNCTION public.guard_documents() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    f TEXT; seq INT; last_v INT; mig BOOLEAN := public.fp_mig_active();
    was_locked BOOLEAN; now_locked BOOLEAN;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.doc_type <> 'quote' AND OLD.status <> 'draft' AND NOT mig
           AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = OLD.user_id) THEN      -- la suppression du compte reste possible
            RAISE EXCEPTION 'FACTURE_VERROUILLEE: suppression interdite (%)', OLD.number;
        END IF;
        RETURN OLD;
    END IF;

    -- valeurs dérivées : le corps (body) est la seule source de vérité
    NEW.number      := NEW.body->>'number';
    NEW.status      := COALESCE(NEW.body->>'status', 'draft');
    NEW.doc_date    := public.fp_date(NEW.body->>'date');
    NEW.due_date    := public.fp_date(NEW.body->>'dueDate');
    NEW.client_id   := NEW.body->>'clientId';
    NEW.client_name := NEW.body->>'clientName';
    NEW.total_ht    := COALESCE(public.fp_num(NEW.body->>'totalHT'), 0);
    NEW.total_tva   := COALESCE(public.fp_num(NEW.body->>'totalTVA'), 0);
    NEW.total_ttc   := COALESCE(public.fp_num(NEW.body->>'totalTTC'), 0);
    NEW.paid_amount := COALESCE(public.fp_num(NEW.body->>'paidAmount'), 0);
    NEW.related_id  := NEW.body->>'relatedInvoiceId';
    NEW.body_sha    := public.fp_sha(NEW.body);
    NEW.updated_at  := NOW();

    IF TG_OP = 'UPDATE' THEN
        IF NEW.user_id <> OLD.user_id OR NEW.id <> OLD.id OR NEW.doc_type <> OLD.doc_type THEN
            RAISE EXCEPTION 'FACTURE_VERROUILLEE: identité du document non modifiable';
        END IF;
    END IF;
    IF mig OR NEW.doc_type = 'quote' THEN
        RETURN NEW;                                   -- copie de migration / devis (non fiscal)
    END IF;

    was_locked := TG_OP = 'UPDATE' AND OLD.status <> 'draft';
    now_locked := NEW.status <> 'draft';

    IF was_locked THEN
        IF NOT now_locked THEN
            RAISE EXCEPTION 'FACTURE_VERROUILLEE: retour au brouillon interdit (%)', OLD.number;
        END IF;
        FOREACH f IN ARRAY ARRAY['number', 'type', 'date', 'clientId', 'clientName', 'clientICE',
                                 'items', 'totalHT', 'totalTVA', 'totalTTC', 'relatedInvoiceId'] LOOP
            IF (OLD.body -> f) IS DISTINCT FROM (NEW.body -> f) THEN
                RAISE EXCEPTION 'FACTURE_VERROUILLEE: modification interdite (% / %)', OLD.number, f;
            END IF;
        END LOOP;
        IF OLD.status IS DISTINCT FROM NEW.status THEN
            INSERT INTO public.doc_events(user_id, action, doc_id, number, detail)
            VALUES (NEW.user_id, 'statut', NEW.id, NEW.number, OLD.status || ' -> ' || NEW.status);
        END IF;
    ELSIF now_locked THEN
        -- émission (création directe en statut émis, ou passage brouillon -> émis) : numéro attribué par le serveur
        IF COALESCE(NEW.number, '') !~ '-[0-9]+$' THEN
            RAISE EXCEPTION 'NUMERO_NON_ATTRIBUE: numéro invalide (%)', NEW.number;
        END IF;
        seq := ((regexp_match(NEW.number, '-([0-9]+)$'))[1])::INT;
        SELECT c.last_value INTO last_v FROM public.doc_counters c
         WHERE c.user_id = NEW.user_id AND c.doc_type = CASE WHEN NEW.doc_type = 'credit' THEN 'credit' ELSE 'invoice' END;
        IF last_v IS NULL OR seq > last_v THEN
            RAISE EXCEPTION 'NUMERO_NON_ATTRIBUE: numéro % non attribué par le serveur', NEW.number;
        END IF;
        INSERT INTO public.doc_events(user_id, action, doc_id, number, detail)
        VALUES (NEW.user_id, CASE WHEN NEW.doc_type = 'credit' THEN 'avoir' ELSE 'emission' END,
                NEW.id, NEW.number, 'total TTC ' || COALESCE(NEW.body->>'totalTTC', '?'));
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_documents() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fp_mig_active()  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_documents ON public.documents;
CREATE TRIGGER trg_guard_documents BEFORE INSERT OR UPDATE OR DELETE ON public.documents
    FOR EACH ROW EXECUTE FUNCTION public.guard_documents();

-- dérivation des paiements
CREATE OR REPLACE FUNCTION public.guard_doc_payments() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF NOT public.fp_mig_active() AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = OLD.user_id) THEN
            RAISE EXCEPTION 'PAIEMENT_VERROUILLE: un paiement enregistré ne se supprime pas';
        END IF;
        RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE' AND NOT public.fp_mig_active() THEN
        RAISE EXCEPTION 'PAIEMENT_VERROUILLE: un paiement enregistré ne se modifie pas';
    END IF;
    NEW.invoice_id := NEW.body->>'invoiceId';
    NEW.pay_date   := public.fp_date(NEW.body->>'date');
    NEW.amount     := COALESCE(public.fp_num(NEW.body->>'amount'), 0);
    NEW.method     := NEW.body->>'method';
    NEW.body_sha   := public.fp_sha(NEW.body);
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_doc_payments() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_guard_doc_payments ON public.doc_payments;
CREATE TRIGGER trg_guard_doc_payments BEFORE INSERT OR UPDATE OR DELETE ON public.doc_payments
    FOR EACH ROW EXECUTE FUNCTION public.guard_doc_payments();

-- ---------- API : écritures contrôlées ----------
-- upsert_document : p_expected_version = NULL ou 0 pour une création ; sinon la version vue par l'appareil.
--   Réponses (jsonb) : {ok:true, version, replay?}  |  {ok:false, conflict:true, server_version, server_doc}
--   p_op_id : identifiant d'opération généré par l'appareil ; rejouer la même opération après une coupure réseau est sans effet.
CREATE OR REPLACE FUNCTION public.upsert_document(p_doc JSONB, p_expected_version INT DEFAULT NULL, p_op_id TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    v_uid UUID := auth.uid(); v_type TEXT; v_id TEXT; r public.documents%ROWTYPE; v_ver INT;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE'; END IF;
    IF NOT COALESCE(public.has_active_license(v_uid), FALSE) THEN RAISE EXCEPTION 'LICENCE_INACTIVE'; END IF;
    IF p_doc IS NULL OR jsonb_typeof(p_doc) <> 'object' THEN RAISE EXCEPTION 'DOCUMENT_INVALIDE'; END IF;
    v_id := p_doc->>'id';
    v_type := COALESCE(p_doc->>'type', 'invoice');
    IF v_id IS NULL OR length(v_id) = 0 OR v_type NOT IN ('invoice', 'credit', 'quote') THEN RAISE EXCEPTION 'DOCUMENT_INVALIDE'; END IF;

    SELECT * INTO r FROM public.documents WHERE user_id = v_uid AND doc_type = v_type AND id = v_id FOR UPDATE;
    IF FOUND THEN
        IF p_op_id IS NOT NULL AND r.last_op_id = p_op_id THEN
            RETURN jsonb_build_object('ok', true, 'replay', true, 'version', r.version);       -- même opération rejouée
        END IF;
        IF p_expected_version IS DISTINCT FROM r.version THEN
            RETURN jsonb_build_object('ok', false, 'conflict', true, 'server_version', r.version, 'server_doc', r.body);
        END IF;
        UPDATE public.documents SET body = p_doc, version = r.version + 1, last_op_id = p_op_id, source = 'app'
         WHERE user_id = v_uid AND doc_type = v_type AND id = v_id RETURNING version INTO v_ver;
        RETURN jsonb_build_object('ok', true, 'version', v_ver);
    END IF;

    IF COALESCE(p_expected_version, 0) <> 0 THEN       -- l'appareil croyait modifier un document qui n'existe pas (supprimé ailleurs)
        RETURN jsonb_build_object('ok', false, 'conflict', true, 'server_version', NULL, 'server_doc', NULL);
    END IF;
    DELETE FROM public.doc_deleted WHERE user_id = v_uid AND doc_type = v_type AND id = v_id;
    BEGIN
        INSERT INTO public.documents(user_id, doc_type, id, body, body_sha, source, last_op_id, version)
        VALUES (v_uid, v_type, v_id, p_doc, '', 'app', p_op_id, 1);
    EXCEPTION WHEN unique_violation THEN
        IF SQLERRM LIKE '%documents_number_uq%' THEN RAISE EXCEPTION 'NUMERO_EN_DOUBLE: %', p_doc->>'number'; END IF;
        -- création simultanée du même id par un autre appareil : conflit explicite, pas d'écrasement
        SELECT * INTO r FROM public.documents WHERE user_id = v_uid AND doc_type = v_type AND id = v_id;
        IF p_op_id IS NOT NULL AND r.last_op_id = p_op_id THEN
            RETURN jsonb_build_object('ok', true, 'replay', true, 'version', r.version);
        END IF;
        RETURN jsonb_build_object('ok', false, 'conflict', true, 'server_version', r.version, 'server_doc', r.body);
    END;
    RETURN jsonb_build_object('ok', true, 'version', 1);
EXCEPTION WHEN unique_violation THEN
    IF SQLERRM LIKE '%documents_number_uq%' THEN RAISE EXCEPTION 'NUMERO_EN_DOUBLE: %', p_doc->>'number'; END IF;
    RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_document(p_type TEXT, p_id TEXT, p_expected_version INT, p_op_id TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v_uid UUID := auth.uid(); r public.documents%ROWTYPE;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE'; END IF;
    IF NOT COALESCE(public.has_active_license(v_uid), FALSE) THEN RAISE EXCEPTION 'LICENCE_INACTIVE'; END IF;
    SELECT * INTO r FROM public.documents WHERE user_id = v_uid AND doc_type = p_type AND id = p_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', true, 'already_deleted', true); END IF;   -- rejeu après coupure : sans effet
    IF p_expected_version IS DISTINCT FROM r.version THEN
        RETURN jsonb_build_object('ok', false, 'conflict', true, 'server_version', r.version, 'server_doc', r.body);
    END IF;
    DELETE FROM public.documents WHERE user_id = v_uid AND doc_type = p_type AND id = p_id;   -- refusé par le déclencheur si émis
    INSERT INTO public.doc_deleted(user_id, doc_type, id) VALUES (v_uid, p_type, p_id) ON CONFLICT DO NOTHING;
    RETURN jsonb_build_object('ok', true);
END;
$$;

-- record_payment : ajoute un encaissement (identifiant fourni par l'appareil => rejouable) et met à jour la facture, de façon atomique.
CREATE OR REPLACE FUNCTION public.record_payment(p_invoice_id TEXT, p_payment JSONB, p_op_id TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE
    v_uid UUID := auth.uid(); r public.documents%ROWTYPE; v_pid TEXT := p_payment->>'id'; v_total NUMERIC; b JSONB; n INT;
BEGIN
    IF v_uid IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE'; END IF;
    IF NOT COALESCE(public.has_active_license(v_uid), FALSE) THEN RAISE EXCEPTION 'LICENCE_INACTIVE'; END IF;
    IF v_pid IS NULL OR length(v_pid) = 0 OR COALESCE(public.fp_num(p_payment->>'amount'), 0) <= 0 THEN RAISE EXCEPTION 'PAIEMENT_INVALIDE'; END IF;
    SELECT * INTO r FROM public.documents WHERE user_id = v_uid AND doc_type = 'invoice' AND id = p_invoice_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'FACTURE_INTROUVABLE'; END IF;
    IF r.status = 'draft' THEN RAISE EXCEPTION 'PAIEMENT_SUR_BROUILLON: émettez la facture avant d''enregistrer un paiement'; END IF;
    IF EXISTS (SELECT 1 FROM public.doc_payments WHERE user_id = v_uid AND id = v_pid) THEN
        RETURN jsonb_build_object('ok', true, 'replay', true, 'version', r.version);              -- paiement déjà enregistré
    END IF;
    INSERT INTO public.doc_payments(user_id, id, body, body_sha, source)
    VALUES (v_uid, v_pid, p_payment || jsonb_build_object('invoiceId', p_invoice_id), '', 'app');
    SELECT COALESCE(SUM(amount), 0) INTO v_total FROM public.doc_payments WHERE user_id = v_uid AND invoice_id = p_invoice_id;
    b := r.body || jsonb_build_object('paidAmount', v_total);
    IF v_total + 0.01 >= r.total_ttc THEN
        b := b || jsonb_build_object('status', 'paid', 'paidAt', COALESCE(p_payment->>'date', to_char(NOW(), 'YYYY-MM-DD')));
    END IF;
    UPDATE public.documents SET body = b, version = r.version + 1, last_op_id = p_op_id, source = 'app'
     WHERE user_id = v_uid AND doc_type = 'invoice' AND id = p_invoice_id RETURNING version INTO n;
    RETURN jsonb_build_object('ok', true, 'version', n, 'paid_amount', v_total);
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_document(JSONB, INT, TEXT)       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_document(TEXT, TEXT, INT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_payment(TEXT, JSONB, TEXT)       FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_document(JSONB, INT, TEXT)       TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_document(TEXT, TEXT, INT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_payment(TEXT, JSONB, TEXT)       TO authenticated;
