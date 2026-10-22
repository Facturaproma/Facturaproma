-- ============================================================
-- 16 — Migration user_data -> documents / doc_payments / doc_history (NON DESTRUCTIVE, idempotente, avec arrêt automatique)
--
-- ÉTAT : PRÉPARATION. Ne crée que des fonctions. Rien n'est migré tant qu'un humain n'appelle pas fp_mig_run(..., true).
-- À exécuter UNIQUEMENT en PRÉPRODUCTION, après accord écrit. Jamais en production sans autorisation distincte
-- et sans sauvegarde dont la restauration a été testée (voir docs/MIGRATION_TABLE_FACTURES.md).
-- Dépend de sql/14 et sql/15. Les fonctions fp_mig_* ne sont exécutables par aucun utilisateur de l'API (ni anon ni authenticated).
--
--   SELECT public.fp_mig_dry_run(NULL);          -- lecture seule : comptages, sommes, doublons, bloquants, avertissements
--   SELECT public.fp_mig_run(NULL, false);       -- = dry-run (aucune écriture)
--   SELECT public.fp_mig_run(NULL, true);        -- copie réelle ; s'arrête (et annule la copie) au moindre bloquant ou écart
--   SELECT public.fp_mig_verify(NULL);           -- relecture seule : ancien stockage <-> nouveau stockage
--   SELECT public.fp_mig_rollback(NULL, false);  -- aperçu du retour arrière ; true pour l'appliquer (sauvegarde préalable de user_data)
-- Le premier argument est un compte (uuid) ou NULL pour tous les comptes.
--
-- Garanties
--   * user_data n'est JAMAIS modifié par la migration (copie). Seul fp_mig_rollback(…, true) l'écrit, après avoir mis de côté
--     l'état courant dans _mig_source_backup (clé : compte + clé + empreinte : jamais écrasé).
--   * Rejouable : une 2e exécution ne duplique rien ; elle rattrape les écritures faites entre-temps dans l'ancien stockage
--     (rafraîchissement des lignes non modifiées depuis la copie) et note en _mig_conflicts celles qui ont changé des deux côtés.
--   * Les éléments sont copiés tels quels (body = élément JSON d'origine) ; les empreintes SHA-256 sont comparées élément par élément.
-- ============================================================

-- ---------- lecture de l'ancien stockage ----------
CREATE OR REPLACE FUNCTION public.fp_mig_legacy_docs(p_user UUID)
RETURNS TABLE(user_id UUID, doc_type TEXT, doc_id TEXT, el JSONB, ord BIGINT)
LANGUAGE sql STABLE SET search_path = public AS $$
    SELECT d.user_id,
           CASE WHEN d.key = 'quotes' THEN 'quote' WHEN e.v->>'type' = 'credit' THEN 'credit' ELSE 'invoice' END,
           e.v->>'id', e.v, e.ord
      FROM public.user_data d CROSS JOIN LATERAL jsonb_array_elements(d.value) WITH ORDINALITY AS e(v, ord)
     WHERE d.key IN ('invoices', 'quotes') AND jsonb_typeof(d.value) = 'array' AND jsonb_typeof(e.v) = 'object'
       AND (p_user IS NULL OR d.user_id = p_user)
$$;

CREATE OR REPLACE FUNCTION public.fp_mig_legacy_pay(p_user UUID)
RETURNS TABLE(user_id UUID, pay_id TEXT, el JSONB, ord BIGINT)
LANGUAGE sql STABLE SET search_path = public AS $$
    SELECT d.user_id, e.v->>'id', e.v, e.ord
      FROM public.user_data d CROSS JOIN LATERAL jsonb_array_elements(d.value) WITH ORDINALITY AS e(v, ord)
     WHERE d.key = 'payments' AND jsonb_typeof(d.value) = 'array' AND jsonb_typeof(e.v) = 'object'
       AND (p_user IS NULL OR d.user_id = p_user)
$$;

CREATE OR REPLACE FUNCTION public.fp_mig_legacy_hist(p_user UUID)
RETURNS TABLE(user_id UUID, entry_sha TEXT, dup INT, ord BIGINT, el JSONB)
LANGUAGE sql STABLE SET search_path = public AS $$
    SELECT x.user_id, x.sha, (row_number() OVER (PARTITION BY x.user_id, x.sha ORDER BY x.ord) - 1)::INT, x.ord, x.v
      FROM (SELECT d.user_id, public.fp_sha(e.v) AS sha, e.v, e.ord
              FROM public.user_data d CROSS JOIN LATERAL jsonb_array_elements(d.value) WITH ORDINALITY AS e(v, ord)
             WHERE d.key = 'docLog' AND jsonb_typeof(d.value) = 'array' AND jsonb_typeof(e.v) = 'object'
               AND (p_user IS NULL OR d.user_id = p_user)) x
$$;

CREATE OR REPLACE FUNCTION public.fp_mig_add(acc JSONB, code TEXT, items JSONB) RETURNS JSONB
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
    SELECT CASE WHEN items IS NULL THEN acc ELSE acc || jsonb_build_array(jsonb_build_object('code', code, 'items', items)) END
$$;

-- ---------- 1. DRY-RUN (lecture seule) ----------
CREATE OR REPLACE FUNCTION public.fp_mig_dry_run(p_user UUID DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql STABLE SET search_path = public, auth AS $$
DECLARE
    b JSONB := '[]'; w JSONB := '[]'; t JSONB; acc JSONB;
BEGIN
    -- BLOQUANTS : la migration refuse de démarrer si l'un d'eux existe
    SELECT jsonb_agg(x) INTO t FROM (SELECT jsonb_build_object('user', left(user_id::text, 8), 'key', key, 'type', jsonb_typeof(value)) x
       FROM public.user_data WHERE key IN ('invoices', 'quotes', 'payments', 'docLog') AND jsonb_typeof(value) NOT IN ('array', 'null')
        AND (p_user IS NULL OR user_id = p_user) LIMIT 20) q;
    b := public.fp_mig_add(b, 'VALEUR_NON_TABLEAU', t);

    SELECT jsonb_agg(x) INTO t FROM (SELECT jsonb_build_object('user', left(d.user_id::text, 8), 'key', d.key, 'rang', e.ord) x
       FROM public.user_data d CROSS JOIN LATERAL jsonb_array_elements(d.value) WITH ORDINALITY e(v, ord)
      WHERE d.key IN ('invoices', 'quotes', 'payments', 'docLog') AND jsonb_typeof(d.value) = 'array' AND jsonb_typeof(e.v) <> 'object'
        AND (p_user IS NULL OR d.user_id = p_user) LIMIT 20) q;
    b := public.fp_mig_add(b, 'ELEMENT_NON_OBJET', t);

    SELECT jsonb_agg(x) INTO t FROM (SELECT jsonb_build_object('user', left(user_id::text, 8), 'type', doc_type, 'rang', ord) x
       FROM public.fp_mig_legacy_docs(p_user) WHERE doc_id IS NULL OR doc_id = '' LIMIT 20) q;
    b := public.fp_mig_add(b, 'DOCUMENT_SANS_ID', t);

    SELECT jsonb_agg(x) INTO t FROM (SELECT jsonb_build_object('user', left(user_id::text, 8), 'type', doc_type, 'id', doc_id, 'occurrences', count(*)) x
       FROM public.fp_mig_legacy_docs(p_user) WHERE doc_id IS NOT NULL AND doc_id <> '' GROUP BY user_id, doc_type, doc_id HAVING count(*) > 1 LIMIT 20) q;
    b := public.fp_mig_add(b, 'ID_EN_DOUBLE', t);

    SELECT jsonb_agg(x) INTO t FROM (SELECT jsonb_build_object('user', left(user_id::text, 8), 'type', doc_type, 'id', doc_id, 'numero', el->>'number') x
       FROM public.fp_mig_legacy_docs(p_user)
      WHERE doc_type IN ('invoice', 'credit') AND COALESCE(el->>'status', 'draft') <> 'draft' AND COALESCE(el->>'number', '') !~ '-[0-9]+$' LIMIT 20) q;
    b := public.fp_mig_add(b, 'EMISE_SANS_NUMERO_VALIDE', t);

    SELECT jsonb_agg(x) INTO t FROM (SELECT jsonb_build_object('user', left(user_id::text, 8), 'type', doc_type, 'numero', el->>'number', 'occurrences', count(*)) x
       FROM public.fp_mig_legacy_docs(p_user)
      WHERE COALESCE(el->>'status', 'draft') <> 'draft' AND COALESCE(el->>'number', '') <> ''
      GROUP BY user_id, doc_type, el->>'number' HAVING count(*) > 1 LIMIT 20) q;
    b := public.fp_mig_add(b, 'NUMERO_EN_DOUBLE', t);

    SELECT jsonb_agg(x) INTO t FROM (SELECT jsonb_build_object('user', left(user_id::text, 8), 'rang', ord) x
       FROM public.fp_mig_legacy_pay(p_user) WHERE pay_id IS NULL OR pay_id = '' LIMIT 20) q;
    b := public.fp_mig_add(b, 'PAIEMENT_SANS_ID', t);

    SELECT jsonb_agg(x) INTO t FROM (SELECT jsonb_build_object('user', left(user_id::text, 8), 'id', pay_id, 'occurrences', count(*)) x
       FROM public.fp_mig_legacy_pay(p_user) WHERE pay_id IS NOT NULL AND pay_id <> '' GROUP BY user_id, pay_id HAVING count(*) > 1 LIMIT 20) q;
    b := public.fp_mig_add(b, 'PAIEMENT_ID_EN_DOUBLE', t);

    -- AVERTISSEMENTS : données d'origine incohérentes, copiées telles quelles et signalées
    SELECT jsonb_agg(x) INTO t FROM (SELECT jsonb_build_object('user', left(p.user_id::text, 8), 'paiement', p.pay_id, 'facture', p.el->>'invoiceId') x
       FROM public.fp_mig_legacy_pay(p_user) p
      WHERE NOT EXISTS (SELECT 1 FROM public.fp_mig_legacy_docs(p.user_id) d WHERE d.doc_type = 'invoice' AND d.doc_id = p.el->>'invoiceId') LIMIT 20) q;
    w := public.fp_mig_add(w, 'PAIEMENT_ORPHELIN', t);

    SELECT jsonb_agg(x) INTO t FROM (SELECT jsonb_build_object('user', left(d.user_id::text, 8), 'numero', d.el->>'number',
              'paidAmount', d.el->>'paidAmount', 'somme_paiements', (SELECT COALESCE(sum(public.fp_num(p.el->>'amount')), 0) FROM public.fp_mig_legacy_pay(d.user_id) p WHERE p.el->>'invoiceId' = d.doc_id)) x
       FROM public.fp_mig_legacy_docs(p_user) d
      WHERE d.doc_type = 'invoice' AND COALESCE(public.fp_num(d.el->>'paidAmount'), 0)
            <> (SELECT COALESCE(sum(public.fp_num(p.el->>'amount')), 0) FROM public.fp_mig_legacy_pay(d.user_id) p WHERE p.el->>'invoiceId' = d.doc_id) LIMIT 20) q;
    w := public.fp_mig_add(w, 'REGLEMENT_INCOHERENT', t);

    SELECT jsonb_agg(x) INTO t FROM (SELECT jsonb_build_object('user', left(user_id::text, 8), 'type', doc_type, 'id', doc_id) x
       FROM public.fp_mig_legacy_docs(p_user)
      WHERE (el ? 'totalTTC' AND public.fp_num(el->>'totalTTC') IS NULL) OR (el ? 'totalHT' AND public.fp_num(el->>'totalHT') IS NULL)
         OR (el ? 'totalTVA' AND public.fp_num(el->>'totalTVA') IS NULL) OR (el ? 'date' AND public.fp_date(el->>'date') IS NULL) LIMIT 20) q;
    w := public.fp_mig_add(w, 'MONTANT_OU_DATE_ILLISIBLE', t);

    SELECT jsonb_agg(x) INTO t FROM (SELECT jsonb_build_object('user', left(user_id::text, 8), 'type', doc_type, 'id', doc_id) x
       FROM public.fp_mig_legacy_docs(p_user)
      WHERE el::text ~ '"data:[a-z]+/' OR el ?| ARRAY['attachments', 'attachment', 'files', 'pieceJointe', 'piecesJointes'] LIMIT 20) q;
    w := public.fp_mig_add(w, 'PIECE_JOINTE_OU_DATA_URI', t);   -- copiée dans body sans modification ; signalée pour décision

    SELECT jsonb_agg(x) INTO t FROM (SELECT jsonb_build_object('user', left(d.user_id::text, 8), 'avoir', d.el->>'number', 'facture_origine', d.el->>'relatedInvoiceId') x
       FROM public.fp_mig_legacy_docs(p_user) d
      WHERE d.doc_type = 'credit' AND NOT EXISTS (SELECT 1 FROM public.fp_mig_legacy_docs(d.user_id) o WHERE o.doc_type = 'invoice' AND o.doc_id = d.el->>'relatedInvoiceId') LIMIT 20) q;
    w := public.fp_mig_add(w, 'AVOIR_SANS_FACTURE_ORIGINE', t);

    SELECT jsonb_agg(x) INTO t FROM (SELECT jsonb_build_object('user', left(d.user_id::text, 8), 'type', d.doc_type, 'numero', d.el->>'number') x
       FROM public.fp_mig_legacy_docs(p_user) d
       LEFT JOIN public.doc_counters c ON c.user_id = d.user_id AND c.doc_type = CASE WHEN d.doc_type = 'credit' THEN 'credit' ELSE 'invoice' END
      WHERE d.doc_type IN ('invoice', 'credit') AND COALESCE(d.el->>'status', 'draft') <> 'draft' AND d.el->>'number' ~ '-[0-9]+$'
        AND (c.last_value IS NULL OR ((regexp_match(d.el->>'number', '-([0-9]+)$'))[1])::INT > c.last_value) LIMIT 20) q;
    w := public.fp_mig_add(w, 'NUMERO_AU_DELA_DU_COMPTEUR_SERVEUR', t);   -- le prochain numéro serveur pourrait réutiliser un numéro déjà émis

    SELECT jsonb_agg(x) INTO t FROM (SELECT jsonb_build_object('user', left(g.user_id::text, 8), 'id', g.id, 'type', g.doc_type) x
       FROM public.doc_deleted g JOIN public.fp_mig_legacy_docs(p_user) l ON (l.user_id, l.doc_type, l.doc_id) = (g.user_id, g.doc_type, g.id) LIMIT 20) q;
    w := public.fp_mig_add(w, 'SUPPRIME_DEPUIS_LE_NOUVEAU_CHEMIN', t);

    -- COMPTAGES par compte
    SELECT COALESCE(jsonb_agg(a ORDER BY a->>'user'), '[]') INTO acc FROM (
        SELECT jsonb_build_object('user', left(u.uid::text, 8),
            'invoices',  (SELECT count(*) FROM public.fp_mig_legacy_docs(u.uid) WHERE doc_type = 'invoice'),
            'credits',   (SELECT count(*) FROM public.fp_mig_legacy_docs(u.uid) WHERE doc_type = 'credit'),
            'quotes',    (SELECT count(*) FROM public.fp_mig_legacy_docs(u.uid) WHERE doc_type = 'quote'),
            'issued',    (SELECT count(*) FROM public.fp_mig_legacy_docs(u.uid) WHERE doc_type <> 'quote' AND COALESCE(el->>'status', 'draft') <> 'draft'),
            'sum_ttc',   (SELECT COALESCE(sum(public.fp_num(el->>'totalTTC')), 0) FROM public.fp_mig_legacy_docs(u.uid) WHERE doc_type <> 'quote'),
            'payments',  (SELECT count(*) FROM public.fp_mig_legacy_pay(u.uid)),
            'sum_payments', (SELECT COALESCE(sum(public.fp_num(el->>'amount')), 0) FROM public.fp_mig_legacy_pay(u.uid)),
            'journal',   (SELECT count(*) FROM public.fp_mig_legacy_hist(u.uid))) a
          FROM (SELECT DISTINCT user_id AS uid FROM public.user_data WHERE key IN ('invoices', 'quotes', 'payments', 'docLog') AND (p_user IS NULL OR user_id = p_user)) u) z;

    RETURN jsonb_build_object('ok', jsonb_array_length(b) = 0, 'blockers', b, 'warnings', w, 'accounts', acc);
END;
$$;

-- ---------- 2. VÉRIFICATION (lecture seule) ----------
CREATE OR REPLACE FUNCTION public.fp_mig_verify(p_user UUID DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql STABLE SET search_path = public, auth AS $$
DECLARE
    m JSONB := '[]'; t JSONB; n_missing INT; n_stale INT; n_edited INT; n_conf INT; n_corrupt INT;
BEGIN
    -- documents
    SELECT count(*) INTO n_missing FROM public.fp_mig_legacy_docs(p_user) l
      WHERE NOT EXISTS (SELECT 1 FROM public.documents d WHERE (d.user_id, d.doc_type, d.id) = (l.user_id, l.doc_type, l.doc_id))
        AND NOT EXISTS (SELECT 1 FROM public.doc_deleted g WHERE (g.user_id, g.doc_type, g.id) = (l.user_id, l.doc_type, l.doc_id));
    SELECT jsonb_agg(x) INTO t FROM (SELECT jsonb_build_object('user', left(l.user_id::text, 8), 'type', l.doc_type, 'id', l.doc_id) x
       FROM public.fp_mig_legacy_docs(p_user) l
      WHERE NOT EXISTS (SELECT 1 FROM public.documents d WHERE (d.user_id, d.doc_type, d.id) = (l.user_id, l.doc_type, l.doc_id))
        AND NOT EXISTS (SELECT 1 FROM public.doc_deleted g WHERE (g.user_id, g.doc_type, g.id) = (l.user_id, l.doc_type, l.doc_id)) LIMIT 20) q;
    m := public.fp_mig_add(m, 'DOCUMENT_ABSENT_DU_NOUVEAU_STOCKAGE', t);

    -- ancien stockage modifié depuis la copie et non rafraîchi (hors conflits déjà notés)
    SELECT count(*) INTO n_stale FROM public.fp_mig_legacy_docs(p_user) l JOIN public.documents d ON (d.user_id, d.doc_type, d.id) = (l.user_id, l.doc_type, l.doc_id)
      WHERE d.legacy_sha IS DISTINCT FROM public.fp_sha(l.el) AND d.body_sha <> public.fp_sha(l.el)
        AND NOT EXISTS (SELECT 1 FROM public._mig_conflicts c WHERE c.kind = 'document' AND (c.user_id, c.doc_type, c.doc_id) = (l.user_id, l.doc_type, l.doc_id) AND public.fp_sha(c.legacy) = public.fp_sha(l.el));
    SELECT jsonb_agg(x) INTO t FROM (SELECT jsonb_build_object('user', left(l.user_id::text, 8), 'type', l.doc_type, 'id', l.doc_id) x
       FROM public.fp_mig_legacy_docs(p_user) l JOIN public.documents d ON (d.user_id, d.doc_type, d.id) = (l.user_id, l.doc_type, l.doc_id)
      WHERE d.legacy_sha IS DISTINCT FROM public.fp_sha(l.el) AND d.body_sha <> public.fp_sha(l.el)
        AND NOT EXISTS (SELECT 1 FROM public._mig_conflicts c WHERE c.kind = 'document' AND (c.user_id, c.doc_type, c.doc_id) = (l.user_id, l.doc_type, l.doc_id) AND public.fp_sha(c.legacy) = public.fp_sha(l.el)) LIMIT 20) q;
    m := public.fp_mig_add(m, 'ANCIEN_STOCKAGE_MODIFIE_RATTRAPAGE_NECESSAIRE', t);

    -- corruption interne du nouveau stockage (corps <-> empreinte)
    SELECT count(*) INTO n_corrupt FROM public.documents d WHERE (p_user IS NULL OR d.user_id = p_user) AND d.body_sha <> public.fp_sha(d.body);
    m := public.fp_mig_add(m, 'EMPREINTE_INCOHERENTE', CASE WHEN n_corrupt > 0 THEN jsonb_build_object('lignes', n_corrupt) END);

    -- lignes non modifiées depuis la copie : contenu et colonnes dérivées identiques à l'élément d'origine
    SELECT jsonb_agg(x) INTO t FROM (SELECT jsonb_build_object('user', left(l.user_id::text, 8), 'type', l.doc_type, 'id', l.doc_id) x
       FROM public.fp_mig_legacy_docs(p_user) l JOIN public.documents d ON (d.user_id, d.doc_type, d.id) = (l.user_id, l.doc_type, l.doc_id)
      WHERE d.body_sha = d.legacy_sha AND d.legacy_sha = public.fp_sha(l.el)
        AND (d.body <> l.el OR d.number IS DISTINCT FROM l.el->>'number' OR d.status <> COALESCE(l.el->>'status', 'draft')
             OR d.total_ht <> COALESCE(public.fp_num(l.el->>'totalHT'), 0) OR d.total_tva <> COALESCE(public.fp_num(l.el->>'totalTVA'), 0)
             OR d.total_ttc <> COALESCE(public.fp_num(l.el->>'totalTTC'), 0) OR d.paid_amount <> COALESCE(public.fp_num(l.el->>'paidAmount'), 0)) LIMIT 20) q;
    m := public.fp_mig_add(m, 'LIGNE_DIFFERENTE_DE_L_ORIGINE', t);

    -- sommes et comptes par compte et par type (lignes non modifiées)
    SELECT jsonb_agg(x) INTO t FROM (
        SELECT jsonb_build_object('user', left(user_id::text, 8), 'type', doc_type, 'ancien', jsonb_build_array(a.n, a.ht, a.tva, a.ttc), 'nouveau', jsonb_build_array(b.n, b.ht, b.tva, b.ttc)) x
          FROM (SELECT l.user_id, l.doc_type, count(*) n, COALESCE(sum(public.fp_num(l.el->>'totalHT')), 0) ht, COALESCE(sum(public.fp_num(l.el->>'totalTVA')), 0) tva, COALESCE(sum(public.fp_num(l.el->>'totalTTC')), 0) ttc
                  FROM public.fp_mig_legacy_docs(p_user) l JOIN public.documents d ON (d.user_id, d.doc_type, d.id) = (l.user_id, l.doc_type, l.doc_id)
                 WHERE d.body_sha = d.legacy_sha GROUP BY 1, 2) a
          FULL JOIN (SELECT d.user_id, d.doc_type, count(*) n, sum(d.total_ht) ht, sum(d.total_tva) tva, sum(d.total_ttc) ttc
                       FROM public.documents d JOIN public.fp_mig_legacy_docs(p_user) l ON (d.user_id, d.doc_type, d.id) = (l.user_id, l.doc_type, l.doc_id)
                      WHERE d.body_sha = d.legacy_sha GROUP BY 1, 2) b USING (user_id, doc_type)
         WHERE (a.n, a.ht, a.tva, a.ttc) IS DISTINCT FROM (b.n, b.ht, b.tva, b.ttc) LIMIT 20) q;
    m := public.fp_mig_add(m, 'SOMMES_OU_COMPTES_DIFFERENTS', t);

    SELECT count(*) INTO n_edited FROM public.documents d WHERE (p_user IS NULL OR d.user_id = p_user) AND d.body_sha <> d.legacy_sha;
    SELECT count(*) INTO n_conf FROM public._mig_conflicts c WHERE (p_user IS NULL OR c.user_id = p_user);

    -- paiements
    SELECT jsonb_agg(x) INTO t FROM (SELECT jsonb_build_object('user', left(l.user_id::text, 8), 'id', l.pay_id) x
       FROM public.fp_mig_legacy_pay(p_user) l WHERE NOT EXISTS (SELECT 1 FROM public.doc_payments p WHERE (p.user_id, p.id) = (l.user_id, l.pay_id)) LIMIT 20) q;
    m := public.fp_mig_add(m, 'PAIEMENT_ABSENT_DU_NOUVEAU_STOCKAGE', t);
    SELECT jsonb_agg(x) INTO t FROM (SELECT jsonb_build_object('user', left(l.user_id::text, 8), 'id', l.pay_id) x
       FROM public.fp_mig_legacy_pay(p_user) l JOIN public.doc_payments p ON (p.user_id, p.id) = (l.user_id, l.pay_id)
      WHERE p.body_sha <> public.fp_sha(l.el) OR p.legacy_sha <> public.fp_sha(l.el) OR p.amount <> COALESCE(public.fp_num(l.el->>'amount'), 0) LIMIT 20) q;
    m := public.fp_mig_add(m, 'PAIEMENT_DIFFERENT', t);
    SELECT jsonb_agg(x) INTO t FROM (
        SELECT jsonb_build_object('user', left(user_id::text, 8), 'ancien', jsonb_build_array(a.n, a.s), 'nouveau', jsonb_build_array(b.n, b.s)) x
          FROM (SELECT user_id, count(*) n, COALESCE(sum(public.fp_num(el->>'amount')), 0) s FROM public.fp_mig_legacy_pay(p_user) GROUP BY 1) a
          FULL JOIN (SELECT p.user_id, count(*) n, sum(p.amount) s FROM public.doc_payments p
                      WHERE EXISTS (SELECT 1 FROM public.fp_mig_legacy_pay(p_user) l WHERE (l.user_id, l.pay_id) = (p.user_id, p.id)) GROUP BY 1) b USING (user_id)
         WHERE (a.n, a.s) IS DISTINCT FROM (b.n, b.s) LIMIT 20) q;
    m := public.fp_mig_add(m, 'SOMMES_PAIEMENTS_DIFFERENTES', t);

    -- historique : chaque entrée de l'ancien journal existe, identique
    SELECT jsonb_agg(x) INTO t FROM (SELECT jsonb_build_object('user', left(l.user_id::text, 8), 'rang', l.ord) x
       FROM public.fp_mig_legacy_hist(p_user) l
      WHERE NOT EXISTS (SELECT 1 FROM public.doc_history h WHERE (h.user_id, h.entry_sha, h.dup) = (l.user_id, l.entry_sha, l.dup) AND public.fp_sha(h.body) = l.entry_sha) LIMIT 20) q;
    m := public.fp_mig_add(m, 'JOURNAL_INCOMPLET', t);

    RETURN jsonb_build_object('ok', jsonb_array_length(m) = 0, 'mismatches', m, 'missing', n_missing, 'stale', n_stale,
                              'edited_after_migration', n_edited, 'conflicts_noted', n_conf);
END;
$$;

-- ---------- 3. MIGRATION (dry-run par défaut ; p_apply = true pour écrire) ----------
CREATE OR REPLACE FUNCTION public.fp_mig_run(p_user UUID DEFAULT NULL, p_apply BOOLEAN DEFAULT FALSE) RETURNS JSONB
LANGUAGE plpgsql SET search_path = public, auth AS $$
DECLARE
    v_run UUID := gen_random_uuid(); dry JSONB; ver JSONB;
    n_doc_new INT; n_doc_ref INT; n_doc_conf INT; n_pay_new INT; n_pay_ref INT; n_pay_conf INT; n_hist INT; rep JSONB;
BEGIN
    dry := public.fp_mig_dry_run(p_user);
    IF NOT p_apply THEN
        RETURN jsonb_build_object('status', CASE WHEN (dry->>'ok')::boolean THEN 'dry_run_ok' ELSE 'dry_run_blocked' END, 'dry_run', dry);
    END IF;
    IF NOT (dry->>'ok')::boolean THEN
        INSERT INTO public._mig_runs(run_id, mode, status, finished_at, report) VALUES (v_run, 'apply', 'stopped', NOW(), jsonb_build_object('stage', 'dry_run', 'dry_run', dry));
        RETURN jsonb_build_object('status', 'stopped', 'stage', 'dry_run', 'run_id', v_run, 'dry_run', dry);
    END IF;

    INSERT INTO public._mig_runs(run_id, mode, status, report) VALUES (v_run, 'apply', 'running', jsonb_build_object('dry_run', dry));
    -- mise de côté de l'ancien stockage tel qu'il est AVANT la copie (jamais écrasée : clé = empreinte)
    INSERT INTO public._mig_source_backup(user_id, key, sha256, value, run_id)
    SELECT d.user_id, d.key, public.fp_sha(d.value), d.value, v_run FROM public.user_data d
     WHERE d.key IN ('invoices', 'quotes', 'payments', 'docLog') AND jsonb_typeof(d.value) = 'array' AND (p_user IS NULL OR d.user_id = p_user)
    ON CONFLICT DO NOTHING;

    BEGIN   -- sous-transaction : si quoi que ce soit échoue ou diffère, TOUTE la copie est annulée
        PERFORM set_config('fp.migration_run', v_run::text, true);

        INSERT INTO public.documents(user_id, doc_type, id, body, body_sha, legacy_sha, source, version)
        SELECT l.user_id, l.doc_type, l.doc_id, l.el, '', public.fp_sha(l.el), 'migration', 1
          FROM public.fp_mig_legacy_docs(p_user) l
         WHERE NOT EXISTS (SELECT 1 FROM public.doc_deleted g WHERE (g.user_id, g.doc_type, g.id) = (l.user_id, l.doc_type, l.doc_id))
        ON CONFLICT (user_id, doc_type, id) DO NOTHING;
        GET DIAGNOSTICS n_doc_new = ROW_COUNT;

        UPDATE public.documents d SET legacy_sha = d.body_sha          -- l'ancien stockage a rejoint le nouveau (ex. retour arrière appliqué) : rien à rattraper
          FROM public.fp_mig_legacy_docs(p_user) l
         WHERE (d.user_id, d.doc_type, d.id) = (l.user_id, l.doc_type, l.doc_id) AND d.legacy_sha <> d.body_sha AND public.fp_sha(l.el) = d.body_sha;

        UPDATE public.documents d SET body = l.el, legacy_sha = public.fp_sha(l.el), version = d.version + 1, source = 'migration'
          FROM public.fp_mig_legacy_docs(p_user) l
         WHERE (d.user_id, d.doc_type, d.id) = (l.user_id, l.doc_type, l.doc_id)
           AND d.body_sha = d.legacy_sha AND d.legacy_sha <> public.fp_sha(l.el);        -- modifié dans l'ancien stockage seulement : rattrapage
        GET DIAGNOSTICS n_doc_ref = ROW_COUNT;

        INSERT INTO public._mig_conflicts(run_id, user_id, kind, doc_type, doc_id, legacy)
        SELECT v_run, l.user_id, 'document', l.doc_type, l.doc_id, l.el
          FROM public.fp_mig_legacy_docs(p_user) l JOIN public.documents d ON (d.user_id, d.doc_type, d.id) = (l.user_id, l.doc_type, l.doc_id)
         WHERE d.body_sha <> d.legacy_sha AND d.legacy_sha <> public.fp_sha(l.el)            -- modifié des DEUX côtés : rien n'est écrasé
           AND NOT EXISTS (SELECT 1 FROM public._mig_conflicts c WHERE c.kind = 'document' AND (c.user_id, c.doc_type, c.doc_id) = (l.user_id, l.doc_type, l.doc_id) AND public.fp_sha(c.legacy) = public.fp_sha(l.el));
        GET DIAGNOSTICS n_doc_conf = ROW_COUNT;

        INSERT INTO public.doc_payments(user_id, id, body, body_sha, legacy_sha, source)
        SELECT l.user_id, l.pay_id, l.el, '', public.fp_sha(l.el), 'migration' FROM public.fp_mig_legacy_pay(p_user) l
        ON CONFLICT (user_id, id) DO NOTHING;
        GET DIAGNOSTICS n_pay_new = ROW_COUNT;

        UPDATE public.doc_payments p SET body = l.el, legacy_sha = public.fp_sha(l.el)
          FROM public.fp_mig_legacy_pay(p_user) l
         WHERE (p.user_id, p.id) = (l.user_id, l.pay_id) AND p.body_sha = p.legacy_sha AND p.legacy_sha <> public.fp_sha(l.el);
        GET DIAGNOSTICS n_pay_ref = ROW_COUNT;

        INSERT INTO public._mig_conflicts(run_id, user_id, kind, doc_id, legacy)
        SELECT v_run, l.user_id, 'payment', l.pay_id, l.el
          FROM public.fp_mig_legacy_pay(p_user) l JOIN public.doc_payments p ON (p.user_id, p.id) = (l.user_id, l.pay_id)
         WHERE p.body_sha <> p.legacy_sha AND p.legacy_sha <> public.fp_sha(l.el)
           AND NOT EXISTS (SELECT 1 FROM public._mig_conflicts c WHERE c.kind = 'payment' AND (c.user_id, c.doc_id) = (l.user_id, l.pay_id) AND public.fp_sha(c.legacy) = public.fp_sha(l.el));
        GET DIAGNOSTICS n_pay_conf = ROW_COUNT;

        INSERT INTO public.doc_history(user_id, entry_sha, dup, seq, ts, action, doc_id, number, detail, body)
        SELECT l.user_id, l.entry_sha, l.dup, l.ord, public.fp_mig_ts(l.el->>'ts'), l.el->>'action', l.el->>'docId', l.el->>'number', l.el->>'detail', l.el
          FROM public.fp_mig_legacy_hist(p_user) l
        ON CONFLICT (user_id, entry_sha, dup) DO UPDATE SET seq = EXCLUDED.seq;
        GET DIAGNOSTICS n_hist = ROW_COUNT;

        ver := public.fp_mig_verify(p_user);
        IF NOT (ver->>'ok')::boolean THEN
            RAISE EXCEPTION 'MIGRATION_ECART' USING DETAIL = ver::text;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        PERFORM set_config('fp.migration_run', '', true);
        rep := jsonb_build_object('stage', 'copy_or_verify', 'error', SQLERRM, 'detail', CASE WHEN SQLERRM = 'MIGRATION_ECART' THEN ver END);
        UPDATE public._mig_runs SET status = 'stopped', finished_at = NOW(), report = report || rep WHERE run_id = v_run;
        RETURN jsonb_build_object('status', 'stopped', 'stage', 'copy_or_verify', 'run_id', v_run, 'error', SQLERRM,
                                  'note', 'copie annulée (sous-transaction), ancien stockage intact', 'verify', ver);
    END;

    PERFORM set_config('fp.migration_run', '', true);
    rep := jsonb_build_object('documents_new', n_doc_new, 'documents_refreshed', n_doc_ref, 'documents_conflicts', n_doc_conf,
                              'payments_new', n_pay_new, 'payments_refreshed', n_pay_ref, 'payments_conflicts', n_pay_conf, 'history_rows_touched', n_hist, 'verify', ver);
    UPDATE public._mig_runs SET status = 'applied', finished_at = NOW(), report = report || rep WHERE run_id = v_run;
    RETURN jsonb_build_object('status', 'applied', 'run_id', v_run) || rep;
END;
$$;

CREATE OR REPLACE FUNCTION public.fp_mig_ts(t TEXT) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
BEGIN RETURN t::timestamptz; EXCEPTION WHEN others THEN RETURN NULL; END $$;

-- ---------- 4. RETOUR ARRIÈRE (aperçu par défaut) ----------
-- Reconstruit user_data.invoices / quotes / payments à partir de l'ancien stockage COURANT + des écritures faites depuis dans le nouveau :
--   * éléments de l'ancien tableau : conservés, sauf s'ils ont été modifiés dans le nouveau stockage (alors la version nouvelle l'emporte) ;
--   * éléments créés dans le nouveau stockage : ajoutés ; éléments supprimés dans le nouveau stockage (brouillons) : retirés ;
--   * avant toute écriture, l'état courant de user_data est mis de côté dans _mig_source_backup ; documents / doc_payments / doc_history
--     ne sont jamais supprimés (suppression manuelle ultérieure).
CREATE OR REPLACE FUNCTION public.fp_mig_rollback(p_user UUID DEFAULT NULL, p_apply BOOLEAN DEFAULT FALSE) RETURNS JSONB
LANGUAGE plpgsql SET search_path = public, auth AS $$
DECLARE
    u RECORD; k TEXT; cur JSONB; nv JSONB; v_run UUID := gen_random_uuid(); out JSONB := '[]'; changed INT := 0; appended INT; replaced INT; removed INT;
BEGIN
    IF p_apply THEN
        INSERT INTO public._mig_runs(run_id, mode, status) VALUES (v_run, 'rollback', 'running');
    END IF;
    FOR u IN SELECT DISTINCT x.user_id FROM (SELECT user_id FROM public.documents UNION SELECT user_id FROM public.doc_payments UNION
                SELECT user_id FROM public.user_data WHERE key IN ('invoices', 'quotes', 'payments')) x
              WHERE p_user IS NULL OR x.user_id = p_user ORDER BY 1
    LOOP
        FOREACH k IN ARRAY ARRAY['invoices', 'quotes', 'payments'] LOOP
            SELECT value INTO cur FROM public.user_data WHERE user_id = u.user_id AND key = k;
            IF cur IS NOT NULL AND jsonb_typeof(cur) <> 'array' THEN CONTINUE; END IF;      -- format inattendu : on n'y touche pas
            cur := COALESCE(cur, '[]'::jsonb);
            IF k = 'payments' THEN
                SELECT COALESCE(jsonb_agg(z.el ORDER BY z.g, z.o), '[]'::jsonb),
                       count(*) FILTER (WHERE z.g = 1), 0, 0
                  INTO nv, appended, replaced, removed
                  FROM (SELECT e.v AS el, 0 AS g, e.ord AS o FROM jsonb_array_elements(cur) WITH ORDINALITY e(v, ord)
                        UNION ALL
                        SELECT p.body, 1, row_number() OVER (ORDER BY p.created_at, p.id)
                          FROM public.doc_payments p
                         WHERE p.user_id = u.user_id AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(cur) e WHERE e->>'id' = p.id)) z;
            ELSE
                SELECT COALESCE(jsonb_agg(z.el ORDER BY z.g, z.o), '[]'::jsonb),
                       count(*) FILTER (WHERE z.g = 1), count(*) FILTER (WHERE z.g = 0 AND z.rep), 0
                  INTO nv, appended, replaced, removed
                  FROM (SELECT COALESCE(CASE WHEN d.body_sha <> d.legacy_sha THEN d.body END, e.v) AS el, 0 AS g, e.ord AS o, (d.body_sha <> d.legacy_sha) AS rep
                          FROM jsonb_array_elements(cur) WITH ORDINALITY e(v, ord)
                          LEFT JOIN public.documents d ON d.user_id = u.user_id AND d.id = e.v->>'id'
                               AND d.doc_type = CASE WHEN k = 'quotes' THEN 'quote' WHEN e.v->>'type' = 'credit' THEN 'credit' ELSE 'invoice' END
                         WHERE NOT EXISTS (SELECT 1 FROM public.doc_deleted g WHERE g.user_id = u.user_id AND g.id = e.v->>'id'
                                             AND g.doc_type = CASE WHEN k = 'quotes' THEN 'quote' WHEN e.v->>'type' = 'credit' THEN 'credit' ELSE 'invoice' END)
                        UNION ALL
                        SELECT d.body, 1, row_number() OVER (ORDER BY d.created_at, d.id), FALSE
                          FROM public.documents d
                         WHERE d.user_id = u.user_id AND (CASE WHEN k = 'quotes' THEN d.doc_type = 'quote' ELSE d.doc_type IN ('invoice', 'credit') END)
                           AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(cur) e WHERE e->>'id' = d.id
                                             AND d.doc_type = CASE WHEN e->>'type' = 'credit' THEN 'credit' WHEN k = 'quotes' THEN 'quote' ELSE 'invoice' END)) z;
                removed := (SELECT count(*) FROM jsonb_array_elements(cur) e WHERE EXISTS (SELECT 1 FROM public.doc_deleted g WHERE g.user_id = u.user_id AND g.id = e->>'id'));
            END IF;
            IF nv IS DISTINCT FROM cur THEN
                changed := changed + 1;
                out := out || jsonb_build_array(jsonb_build_object('user', left(u.user_id::text, 8), 'key', k, 'before', jsonb_array_length(cur), 'after', jsonb_array_length(nv),
                                                'appended', appended, 'replaced', replaced, 'removed', removed));
                IF p_apply THEN
                    IF jsonb_array_length(cur) > 0 OR EXISTS (SELECT 1 FROM public.user_data WHERE user_id = u.user_id AND key = k) THEN
                        INSERT INTO public._mig_source_backup(user_id, key, sha256, value, run_id) VALUES (u.user_id, k, public.fp_sha(cur), cur, v_run) ON CONFLICT DO NOTHING;
                    END IF;
                    INSERT INTO public.user_data(user_id, key, value, updated_at) VALUES (u.user_id, k, nv, NOW())
                    ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
                END IF;
            END IF;
        END LOOP;
    END LOOP;
    IF p_apply THEN
        UPDATE public._mig_runs SET status = 'rollback_applied', finished_at = NOW(), report = jsonb_build_object('changes', out) WHERE run_id = v_run;
    END IF;
    RETURN jsonb_build_object('status', CASE WHEN p_apply THEN 'rollback_applied' ELSE 'rollback_preview' END, 'run_id', CASE WHEN p_apply THEN v_run END,
                              'lists_changed', changed, 'changes', out);
END;
$$;

-- ---------- droits : réservé aux sessions d'administration de la base (jamais l'API publique) ----------
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND (p.proname LIKE 'fp\_mig\_%' OR p.proname = 'guard_documents' OR p.proname = 'guard_doc_payments')
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    END LOOP;
END $$;
