-- Tests SQL (base locale JETABLE, SIMULATION : pas Supabase) de sql/17_mode_stockage.sql (version 2, revue) : une seule source d'écriture par compte,
-- droits imposés côté serveur, bascule contrôlée, retour arrière sans perte, compatibilité avec sql/15 et sql/16.
\set VERBOSITY terse
SET client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.ok(name text, cond boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS
$$ BEGIN RAISE NOTICE '%', CASE WHEN cond IS TRUE THEN 'PASS '||name ELSE 'FAIL '||name||' '||detail END; END $$;
CREATE OR REPLACE FUNCTION pg_temp.refuse(sql text, motif text) RETURNS boolean LANGUAGE plpgsql AS
$$ BEGIN EXECUTE sql; RETURN false; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM LIKE '%'||motif||'%'; END $$;
CREATE OR REPLACE FUNCTION pg_temp.refuse_state(sql text, state text) RETURNS boolean LANGUAGE plpgsql AS
$$ BEGIN EXECUTE sql; RETURN false; EXCEPTION WHEN OTHERS THEN RETURN SQLSTATE = state; END $$;
CREATE OR REPLACE FUNCTION pg_temp.works(sql text) RETURNS boolean LANGUAGE plpgsql AS
$$ BEGIN EXECUTE sql; RETURN true; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'works() a échoué : %', SQLERRM; RETURN false; END $$;
GRANT ALL ON public.user_data TO authenticated;   -- comme sur Supabase (ancienne table)
\i sql/17_mode_stockage.sql
SET client_min_messages = notice;

INSERT INTO auth.users(id, email) VALUES
 ('c1000000-0000-0000-0000-000000000001', 't1@facturapro-test.invalid'),
 ('c2000000-0000-0000-0000-000000000002', 't2@facturapro-test.invalid'),
 ('c3000000-0000-0000-0000-000000000003', 't3@facturapro-test.invalid'),
 ('c4000000-0000-0000-0000-000000000004', 'ordinaire@example.com'),
 ('c5000000-0000-0000-0000-000000000005', 't5@facturapro-test.invalid'),
 ('c6000000-0000-0000-0000-000000000006', 't6@facturapro-test.invalid'),     -- e-mail de test mais NON autorisé
 ('c7000000-0000-0000-0000-000000000007', 't7@facturapro-test.invalid'),
 ('c8000000-0000-0000-0000-000000000008', 't8@facturapro-test.invalid'),
 ('c9000000-0000-0000-0000-000000000009', 't9@facturapro-test.invalid'),
 ('ca000000-0000-0000-0000-00000000000a', 't10@facturapro-test.invalid');
INSERT INTO public.doc_store_testers(user_id) SELECT id FROM auth.users WHERE id::text <> 'c6000000-0000-0000-0000-000000000006' AND (email LIKE '%@facturapro-test.invalid' OR email = 'ordinaire@example.com');   -- y compris le compte ordinaire (l'e-mail est refusé quand même)
INSERT INTO public.licenses(user_id, type, status, expires_at) SELECT id, 'annual', 'active', now() + interval '200 days' FROM auth.users WHERE (email LIKE '%@facturapro-test.invalid' OR email = 'ordinaire@example.com');
INSERT INTO public.doc_counters(user_id, doc_type, last_value) SELECT id, 'invoice', 1 FROM auth.users WHERE (email LIKE '%@facturapro-test.invalid' OR email = 'ordinaire@example.com');
INSERT INTO public.user_data(user_id, key, value)
SELECT id, 'invoices', '[{"id":"i1","type":"invoice","number":"FAC-2026-001","status":"sent","totalHT":10,"totalTVA":2,"totalTTC":12},{"id":"d1","type":"invoice","number":"BRO-AAAAAA","status":"draft","totalTTC":5,"clientName":"origine"},{"id":"d2","type":"invoice","number":"BRO-BBBBBB","status":"draft","totalTTC":6}]'::jsonb FROM auth.users WHERE (email LIKE '%@facturapro-test.invalid' OR email = 'ordinaire@example.com');
INSERT INTO public.user_data(user_id, key, value) SELECT id, 'docLog', '[{"ts":"2026-02-01T09:00:00Z","action":"emission","docId":"i1","number":"FAC-2026-001","detail":"ok"}]'::jsonb FROM auth.users WHERE (email LIKE '%@facturapro-test.invalid' OR email = 'ordinaire@example.com');
INSERT INTO public.user_data(user_id, key, value) VALUES ('c1000000-0000-0000-0000-000000000001', 'company', '{"name":"Test"}');
-- l'activité « récente » est simulée : tout est écrit il y a 1 heure, sauf mention contraire
ALTER TABLE public.user_data DISABLE TRIGGER USER;
UPDATE public.user_data SET updated_at = now() - interval '1 hour' WHERE user_id IN (SELECT id FROM auth.users WHERE (email LIKE '%@facturapro-test.invalid' OR email = 'ordinaire@example.com'));
ALTER TABLE public.user_data ENABLE TRIGGER USER;

-- ====== 1. DROITS (catalogue PostgreSQL) ======
SELECT pg_temp.ok('fonctions INTERNES (fp_doc_mode_set, fp_doc_mode, gardes) : exécutables ni par anon ni par authenticated',
  NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('fp_doc_mode_set','fp_doc_mode','guard_mode_user_data','guard_mode_documents','guard_doc_store_mode')
     AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))));
SELECT pg_temp.ok('get_doc_mode et append_history : authenticated oui, anon non',
  has_function_privilege('authenticated', 'public.get_doc_mode()', 'EXECUTE') AND has_function_privilege('authenticated', 'public.append_history(jsonb,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.get_doc_mode()', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.append_history(jsonb,text)', 'EXECUTE'));
SELECT pg_temp.ok('doc_store_mode et doc_store_testers : RLS active, aucun droit anon / authenticated',
  (SELECT bool_and(c.relrowsecurity) FROM pg_class c WHERE c.relname IN ('doc_store_mode','doc_store_testers') AND c.relnamespace = 'public'::regnamespace)
  AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['doc_store_mode','doc_store_testers']) t, unnest(ARRAY['anon','authenticated']) r, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p
                   WHERE has_table_privilege(r, 'public.'||t, p)));
SELECT pg_temp.ok('les 4 gardes (3 déclencheurs + celui de doc_store_mode) existent et sont actifs',
  (SELECT count(*) FROM pg_trigger WHERE tgname IN ('trg_00_mode_user_data','trg_00_mode_documents','trg_00_mode_doc_payments','trg_doc_store_mode_check') AND tgenabled = 'O') = 4);
SELECT pg_temp.ok('ordre d''exécution : trg_00_mode_user_data passe AVANT les déclencheurs de sql/14',
  (SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'public.user_data'::regclass AND NOT tgisinternal AND tgtype & 2 = 2 AND tgname LIKE 'trg_%') LIKE 'trg_00_mode_user_data,%');

-- ====== 2. mode « legacy » par défaut : une seule source ======
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', false);
SELECT pg_temp.ok('mode par défaut = legacy (aucune ligne)', public.get_doc_mode() = 'legacy');
SELECT pg_temp.ok('legacy : upsert_document / append_history refusés (MODE_ANCIEN_STOCKAGE)',
  pg_temp.refuse($$SELECT public.upsert_document('{"id":"n1","type":"invoice","number":"BRO-ZZZZZZ","status":"draft"}'::jsonb, 0, 'o1')$$, 'MODE_ANCIEN_STOCKAGE')
  AND pg_temp.refuse($$SELECT public.append_history('[{"id":"e1","action":"x"}]'::jsonb)$$, 'MODE_ANCIEN_STOCKAGE'));
SELECT pg_temp.ok('legacy : l''ancien chemin (user_data) continue de fonctionner', pg_temp.works($$UPDATE public.user_data SET value = value WHERE key='invoices'$$));
SELECT pg_temp.ok('un utilisateur ne peut ni lire doc_store_mode / doc_store_testers, ni se mettre en mode documents, ni s''ajouter à la liste',
  pg_temp.refuse($$SELECT * FROM public.doc_store_mode$$, 'permission denied') AND pg_temp.refuse($$SELECT * FROM public.doc_store_testers$$, 'permission denied')
  AND pg_temp.refuse($$SELECT public.fp_doc_mode_set('c1000000-0000-0000-0000-000000000001','documents')$$, 'permission denied')
  AND pg_temp.refuse($$INSERT INTO public.doc_store_mode(user_id,mode) VALUES ('c1000000-0000-0000-0000-000000000001','documents')$$, 'permission denied')
  AND pg_temp.refuse($$INSERT INTO public.doc_store_testers(user_id) VALUES ('c1000000-0000-0000-0000-000000000001')$$, 'permission denied')
  AND pg_temp.refuse($$SELECT public.fp_doc_mode('c1000000-0000-0000-0000-000000000001')$$, 'permission denied'));
RESET ROLE;
SET ROLE anon; SELECT pg_temp.ok('anon : get_doc_mode / append_history / fp_doc_mode_set inaccessibles', pg_temp.refuse($$SELECT public.get_doc_mode()$$, 'permission denied')
  AND pg_temp.refuse($$SELECT public.append_history('[]'::jsonb)$$, 'permission denied') AND pg_temp.refuse($$SELECT public.fp_doc_mode_set('c1000000-0000-0000-0000-000000000001','documents')$$, 'permission denied')); RESET ROLE;

-- ====== 3. contrôle d'accès SERVEUR : l'e-mail seul ne suffit pas, la liste seule non plus ======
SELECT pg_temp.ok('compte ordinaire (même autorisé dans la liste) : COMPTE_NON_TEST, mode inchangé',
  pg_temp.refuse($$SELECT public.fp_doc_mode_set('c4000000-0000-0000-0000-000000000004','documents', NULL, 0)$$, 'COMPTE_NON_TEST') AND public.fp_doc_mode('c4000000-0000-0000-0000-000000000004') = 'legacy');
SELECT pg_temp.ok('e-mail de test MAIS absent de la liste : COMPTE_NON_AUTORISE, mode inchangé',
  pg_temp.refuse($$SELECT public.fp_doc_mode_set('c6000000-0000-0000-0000-000000000006','documents', NULL, 0)$$, 'COMPTE_NON_AUTORISE') AND public.fp_doc_mode('c6000000-0000-0000-0000-000000000006') = 'legacy');
SELECT pg_temp.ok('même par écriture SQL directe dans doc_store_mode : refus (déclencheur de la table) pour le compte non autorisé et le compte ordinaire',
  pg_temp.refuse($$INSERT INTO public.doc_store_mode(user_id,mode) VALUES ('c6000000-0000-0000-0000-000000000006','documents')$$, 'COMPTE_NON_AUTORISE')
  AND pg_temp.refuse($$INSERT INTO public.doc_store_mode(user_id,mode) VALUES ('c4000000-0000-0000-0000-000000000004','documents')$$, 'COMPTE_NON_AUTORISE'));
SELECT pg_temp.ok('compte inconnu / mode invalide / décision invalide refusés',
  pg_temp.refuse($$SELECT public.fp_doc_mode_set(gen_random_uuid(),'documents')$$, 'COMPTE_INTROUVABLE')
  AND pg_temp.refuse($$SELECT public.fp_doc_mode_set('c1000000-0000-0000-0000-000000000001','autre')$$, 'MODE_INVALIDE')
  AND pg_temp.refuse($$SELECT public.fp_doc_mode_set('c1000000-0000-0000-0000-000000000001','documents','oui')$$, 'RESOLUTION_INVALIDE'));

-- ====== 4. protection contre l'activité récente d'un ancien appareil ======
UPDATE public.user_data SET updated_at = now() WHERE user_id = 'c1000000-0000-0000-0000-000000000001' AND key = 'invoices';
SELECT public.fp_doc_mode_set('c1000000-0000-0000-0000-000000000001', 'documents') AS idle \gset
SELECT pg_temp.ok('écriture ancien stockage il y a < 10 min : bascule REFUSÉE (ACTIVITE_RECENTE_ANCIEN_APPAREIL), mode inchangé, rien copié',
  :'idle'::jsonb->>'reason' = 'ACTIVITE_RECENTE_ANCIEN_APPAREIL' AND public.fp_doc_mode('c1000000-0000-0000-0000-000000000001') = 'legacy'
  AND (SELECT count(*) FROM public.documents WHERE user_id = 'c1000000-0000-0000-0000-000000000001') = 0, :'idle');
UPDATE public.user_data SET updated_at = now() - interval '1 hour' WHERE user_id = 'c1000000-0000-0000-0000-000000000001';

-- ====== 5. bascule d'un compte de test autorisé ======
SELECT public.fp_doc_mode_set('c1000000-0000-0000-0000-000000000001', 'documents', NULL, 0) AS s1 \gset
SELECT pg_temp.ok('t1 : bascule acceptée après rattrapage et vérification', (:'s1'::jsonb->>'ok')::boolean AND :'s1'::jsonb->>'mode' = 'documents', :'s1');
SELECT pg_temp.ok('t1 : 3 documents copiés, l''ancien stockage est intact (3 éléments)', (SELECT count(*) FROM public.documents WHERE user_id='c1000000-0000-0000-0000-000000000001') = 3
  AND jsonb_array_length((SELECT value FROM public.user_data WHERE user_id='c1000000-0000-0000-0000-000000000001' AND key='invoices')) = 3);
SELECT public.fp_doc_mode_set('c1000000-0000-0000-0000-000000000001', 'documents', NULL, 0) AS s1b \gset
SELECT pg_temp.ok('bascule rejouée : sans effet (unchanged)', (:'s1b'::jsonb->>'unchanged')::boolean);
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', false);
SELECT pg_temp.ok('t1 : get_doc_mode = documents', public.get_doc_mode() = 'documents');
SELECT pg_temp.ok('documents : l''ancien chemin est REFUSÉ pour les 4 clés, avec SQLSTATE 42501 (les anciennes versions ne réessaient pas) — pas de double écriture',
  pg_temp.refuse_state($$UPDATE public.user_data SET value = '[]'::jsonb WHERE key='invoices'$$, '42501')
  AND pg_temp.refuse($$INSERT INTO public.user_data(user_id,key,value) VALUES ('c1000000-0000-0000-0000-000000000001','quotes','[]')$$, 'MODE_NOUVEAU_STOCKAGE')
  AND pg_temp.refuse($$INSERT INTO public.user_data(user_id,key,value) VALUES ('c1000000-0000-0000-0000-000000000001','payments','[]')$$, 'MODE_NOUVEAU_STOCKAGE')
  AND pg_temp.refuse_state($$UPDATE public.user_data SET value = '[]'::jsonb WHERE key='docLog'$$, '42501')
  AND pg_temp.refuse($$DELETE FROM public.user_data WHERE key='invoices'$$, 'MODE_NOUVEAU_STOCKAGE'));
SELECT pg_temp.ok('documents : les autres clés (company…) restent écrivables', pg_temp.works($$UPDATE public.user_data SET value = '{"name":"Autre"}'::jsonb WHERE key='company'$$));
SELECT pg_temp.ok('documents : l''ancien contenu est toujours LISIBLE et intact', jsonb_array_length((SELECT value FROM public.user_data WHERE key='invoices')) = 3);
SELECT public.upsert_document('{"id":"n1","type":"invoice","number":"BRO-NEW111","status":"draft","totalTTC":9}'::jsonb, 0, 'op-n1') AS u1 \gset
SELECT pg_temp.ok('documents : upsert_document accepté', (:'u1'::jsonb->>'ok')::boolean, :'u1');
SELECT public.append_history('[{"id":"e-1","ts":"2026-03-01T10:00:00Z","action":"creation","docId":"n1","detail":"brouillon"}]'::jsonb, 'h1') AS h1 \gset
SELECT public.append_history('[{"id":"e-1","ts":"2026-03-01T10:00:00Z","action":"creation","docId":"n1","detail":"brouillon"}]'::jsonb, 'h1') AS h1b \gset
SELECT pg_temp.ok('journal : entrée ajoutée une fois, rejouée sans doublon', (:'h1'::jsonb->>'added')::int = 1 AND (:'h1b'::jsonb->>'added')::int = 0);
SELECT public.append_history('[{"action":"x","detail":"sans id"},{"action":"x","detail":"sans id"}]'::jsonb) AS h2 \gset
SELECT pg_temp.ok('journal : deux entrées identiques sans id sont conservées toutes les deux', (:'h2'::jsonb->>'added')::int = 2);
SELECT pg_temp.ok('journal : valeur invalide / trop longue refusées', pg_temp.refuse($$SELECT public.append_history('"x"'::jsonb)$$, 'JOURNAL_INVALIDE')
  AND pg_temp.refuse($$SELECT public.append_history(('['||repeat('{"a":1},',100)||'{"a":1}]')::jsonb)$$, 'JOURNAL_INVALIDE'));
RESET ROLE;

-- ====== 6. brouillons supprimés sur un ancien appareil AVANT la bascule ======
SELECT public.fp_mig_run('c2000000-0000-0000-0000-000000000002', true) AS m2 \gset
SELECT public.fp_mig_run('c3000000-0000-0000-0000-000000000003', true) AS m3 \gset
UPDATE public.user_data SET value = value - 1 WHERE user_id IN ('c2000000-0000-0000-0000-000000000002','c3000000-0000-0000-0000-000000000003') AND key='invoices';   -- d1 supprimé « sur l'ancien appareil »
SELECT public.fp_doc_mode_set('c2000000-0000-0000-0000-000000000002', 'documents', NULL, 0) AS a2 \gset
SELECT pg_temp.ok('t2 : bascule ARRÊTÉE (ARBITRAGE_REQUIS) avec la liste du brouillon, mode inchangé, rien supprimé en silence, rien noté comme décidé',
  :'a2'::jsonb->>'reason' = 'ARBITRAGE_REQUIS' AND :'a2'::jsonb->'drafts'->0->>'id' = 'd1' AND public.fp_doc_mode('c2000000-0000-0000-0000-000000000002') = 'legacy'
  AND (SELECT count(*) FROM public.documents WHERE user_id='c2000000-0000-0000-0000-000000000002' AND id='d1') = 1
  AND (SELECT count(*) FROM public._mig_conflicts WHERE user_id='c2000000-0000-0000-0000-000000000002' AND kind='brouillon_supprime_ancien_appareil') = 0, :'a2');
SELECT public.fp_doc_mode_set('c2000000-0000-0000-0000-000000000002', 'documents', NULL, 0) AS a2b \gset
SELECT pg_temp.ok('t2 : ré-essai sans décision => toujours arrêté (l''arbitrage est recalculé, pas mémorisé)', :'a2b'::jsonb->>'reason' = 'ARBITRAGE_REQUIS');
SELECT public.fp_doc_mode_set('c2000000-0000-0000-0000-000000000002', 'documents', 'keep', 0) AS k2 \gset
SELECT pg_temp.ok('t2 : décision « keep » => bascule faite, brouillon conservé, décision notée',
  (:'k2'::jsonb->>'ok')::boolean AND (SELECT count(*) FROM public.documents WHERE user_id='c2000000-0000-0000-0000-000000000002' AND id='d1') = 1
  AND (SELECT count(*) FROM public._mig_conflicts WHERE user_id='c2000000-0000-0000-0000-000000000002' AND kind='brouillon_supprime_ancien_appareil' AND legacy->>'decision'='keep') = 1, :'k2');
SELECT public.fp_doc_mode_set('c3000000-0000-0000-0000-000000000003', 'documents', 'delete', 0) AS k3 \gset
SELECT pg_temp.ok('t3 : décision « delete » => bascule faite, brouillon retiré avec pierre tombale, décision notée, autres documents intacts',
  (:'k3'::jsonb->>'ok')::boolean AND (SELECT count(*) FROM public.documents WHERE user_id='c3000000-0000-0000-0000-000000000003') = 2
  AND (SELECT count(*) FROM public.doc_deleted WHERE user_id='c3000000-0000-0000-0000-000000000003' AND id='d1') = 1
  AND (SELECT count(*) FROM public._mig_conflicts WHERE user_id='c3000000-0000-0000-0000-000000000003' AND legacy->>'decision'='delete') = 1, :'k3');

-- ====== 7. conflits forcés et document émis absent : arrêts sans écrasement ======
SELECT public.fp_mig_run('c8000000-0000-0000-0000-000000000008', true) AS m8 \gset
ALTER TABLE public.documents DISABLE TRIGGER trg_00_mode_documents;                                          -- intervention d'administration simulée : modification côté nouveau stockage
UPDATE public.documents SET body = body || '{"clientName":"côté documents"}' WHERE user_id='c8000000-0000-0000-0000-000000000008' AND id='d1';
ALTER TABLE public.documents ENABLE TRIGGER trg_00_mode_documents;
UPDATE public.user_data SET value = (SELECT jsonb_agg(CASE WHEN e->>'id' = 'd1' THEN e || '{"clientName":"côté ancien"}' ELSE e END) FROM jsonb_array_elements(value) e)
 WHERE user_id='c8000000-0000-0000-0000-000000000008' AND key='invoices';
UPDATE public.user_data SET updated_at = now() - interval '1 hour' WHERE user_id='c8000000-0000-0000-0000-000000000008';
SELECT public.fp_doc_mode_set('c8000000-0000-0000-0000-000000000008', 'documents', NULL, 0) AS c8 \gset
SELECT pg_temp.ok('t8 : document modifié des DEUX côtés => CONFLITS_A_ARBITRER, mode inchangé, version « côté ancien » conservée dans _mig_conflicts',
  :'c8'::jsonb->>'reason' = 'CONFLITS_A_ARBITRER' AND public.fp_doc_mode('c8000000-0000-0000-0000-000000000008') = 'legacy'
  AND (SELECT count(*) FROM public._mig_conflicts WHERE user_id='c8000000-0000-0000-0000-000000000008' AND kind='document' AND legacy->>'clientName'='côté ancien') = 1, :'c8');
SELECT public.fp_doc_mode_set('c8000000-0000-0000-0000-000000000008', 'documents', NULL, 0) AS c8b \gset
SELECT pg_temp.ok('t8 : ré-essai sans décision => toujours arrêté (conflit recalculé sur l''état réel)', :'c8b'::jsonb->>'reason' = 'CONFLITS_A_ARBITRER', :'c8b');
SELECT public.fp_doc_mode_set('c8000000-0000-0000-0000-000000000008', 'documents', 'keep', 0) AS c8c \gset
SELECT pg_temp.ok('t8 : décision explicite => bascule faite ; aucune des deux versions perdue (nouveau stockage actif, ancienne dans _mig_conflicts)',
  (:'c8c'::jsonb->>'ok')::boolean AND (SELECT body->>'clientName' FROM public.documents WHERE user_id='c8000000-0000-0000-0000-000000000008' AND id='d1') = 'côté documents'
  AND (SELECT count(*) FROM public._mig_conflicts WHERE user_id='c8000000-0000-0000-0000-000000000008' AND legacy->>'clientName'='côté ancien') = 1, :'c8c');
SELECT public.fp_mig_run('c9000000-0000-0000-0000-000000000009', true) AS m9 \gset
ALTER TABLE public.user_data DISABLE TRIGGER USER;
UPDATE public.user_data SET value = value - 0 WHERE user_id='c9000000-0000-0000-0000-000000000009' AND key='invoices';
UPDATE public.user_data SET value = (SELECT jsonb_agg(e) FROM jsonb_array_elements(value) e WHERE e->>'id' <> 'i1'), updated_at = now() - interval '1 hour' WHERE user_id='c9000000-0000-0000-0000-000000000009' AND key='invoices';
ALTER TABLE public.user_data ENABLE TRIGGER USER;
SELECT public.fp_doc_mode_set('c9000000-0000-0000-0000-000000000009', 'documents', 'delete', 0) AS e9 \gset
SELECT pg_temp.ok('t9 : facture ÉMISE absente de l''ancien tableau => arrêt définitif, même avec la décision « delete » ; mode inchangé, document intact',
  (:'e9'::jsonb->>'ok')::boolean IS NOT TRUE AND (:'e9'::jsonb->>'stopped')::boolean AND public.fp_doc_mode('c9000000-0000-0000-0000-000000000009') = 'legacy'
  AND (SELECT count(*) FROM public.documents WHERE user_id='c9000000-0000-0000-0000-000000000009' AND id='i1') = 1, :'e9');
SELECT pg_temp.ok('les triggers utilisateur de user_data sont tous actifs après les interventions simulées', (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.user_data'::regclass AND NOT tgisinternal AND tgenabled <> 'O') = 0);

-- ====== 8. aller-retour complet : créations, modifications, suppressions, paiements rejoués, journal => retour au mode ancien SANS PERTE ======
SELECT public.fp_doc_mode_set('c7000000-0000-0000-0000-000000000007', 'documents', NULL, 0) AS s7 \gset
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', 'c7000000-0000-0000-0000-000000000007', false);
SELECT public.upsert_document('{"id":"d1","type":"invoice","number":"BRO-AAAAAA","status":"draft","totalTTC":5,"clientName":"modifié en documents"}'::jsonb, 1, 'm1') AS w1 \gset
SELECT public.upsert_document('{"id":"n1","type":"invoice","number":"BRO-NEW111","status":"draft","totalTTC":9}'::jsonb, 0, 'm2') AS w2 \gset
SELECT public.delete_document('invoice', 'd2', 1, 'm3') AS w3 \gset
SELECT public.record_payment('i1', '{"id":"p1","amount":5,"date":"2026-03-05","method":"virement"}'::jsonb, 'pay1') AS pa1 \gset
SELECT public.record_payment('i1', '{"id":"p1","amount":5,"date":"2026-03-05","method":"virement"}'::jsonb, 'pay1') AS pa2 \gset
SELECT public.append_history('[{"id":"e-7","ts":"2026-03-05T10:00:00Z","action":"paiement","docId":"i1","detail":"5 DH"},{"action":"plain","detail":"x"},{"action":"plain","detail":"x"}]'::jsonb) AS hh \gset
SELECT public.upsert_document('{"id":"d1","type":"invoice","number":"BRO-AAAAAA","status":"draft","totalTTC":5,"clientName":"périmé"}'::jsonb, 1, 'm4') AS w4 \gset
RESET ROLE;
SELECT pg_temp.ok('paiement rejoué (même id) : une seule ligne, facture payée 5 une seule fois',
  (:'pa2'::jsonb->>'replay')::boolean AND (SELECT count(*) FROM public.doc_payments WHERE user_id='c7000000-0000-0000-0000-000000000007') = 1 AND (SELECT paid_amount FROM public.documents WHERE user_id='c7000000-0000-0000-0000-000000000007' AND id='i1') = 5);
SELECT pg_temp.ok('modification sur une version périmée => CONFLIT explicite, rien écrasé', (:'w4'::jsonb->>'conflict')::boolean AND (SELECT body->>'clientName' FROM public.documents WHERE user_id='c7000000-0000-0000-0000-000000000007' AND id='d1') = 'modifié en documents');
SELECT public.fp_doc_mode_set('c7000000-0000-0000-0000-000000000007', 'legacy') AS rb \gset
SELECT pg_temp.ok('retour au mode ancien accepté', (:'rb'::jsonb->>'ok')::boolean AND public.fp_doc_mode('c7000000-0000-0000-0000-000000000007') = 'legacy', :'rb');
SELECT pg_temp.ok('retour : d1 modifié, n1 créé, d2 supprimé, i1 payée 5 — tout est dans user_data',
  (SELECT e->>'clientName' FROM public.user_data u, jsonb_array_elements(u.value) e WHERE u.user_id='c7000000-0000-0000-0000-000000000007' AND u.key='invoices' AND e->>'id'='d1') = 'modifié en documents'
  AND (SELECT count(*) FROM public.user_data u, jsonb_array_elements(u.value) e WHERE u.user_id='c7000000-0000-0000-0000-000000000007' AND u.key='invoices' AND e->>'id' IN ('i1','d1','n1')) = 3
  AND (SELECT count(*) FROM public.user_data u, jsonb_array_elements(u.value) e WHERE u.user_id='c7000000-0000-0000-0000-000000000007' AND u.key='invoices' AND e->>'id'='d2') = 0
  AND (SELECT (e->>'paidAmount')::numeric FROM public.user_data u, jsonb_array_elements(u.value) e WHERE u.user_id='c7000000-0000-0000-0000-000000000007' AND u.key='invoices' AND e->>'id'='i1') = 5);
SELECT pg_temp.ok('retour : paiement p1 présent une seule fois dans user_data.payments',
  (SELECT jsonb_array_length(value) FROM public.user_data WHERE user_id='c7000000-0000-0000-0000-000000000007' AND key='payments') = 1);
SELECT pg_temp.ok('retour : le JOURNAL du nouveau chemin (3 entrées dont 2 identiques) est réintégré dans docLog : 1 d''origine + 3 = 4',
  (SELECT jsonb_array_length(value) FROM public.user_data WHERE user_id='c7000000-0000-0000-0000-000000000007' AND key='docLog') = 4 AND (:'rb'::jsonb->>'journal_entries_restored')::int = 3, :'rb');
SELECT pg_temp.ok('retour : l''état précédent de chaque liste est conservé dans _mig_source_backup',
  EXISTS (SELECT 1 FROM public._mig_source_backup WHERE user_id='c7000000-0000-0000-0000-000000000007' AND key='invoices')
  AND EXISTS (SELECT 1 FROM public._mig_source_backup WHERE user_id='c7000000-0000-0000-0000-000000000007' AND key='docLog'));
SELECT pg_temp.ok('retour : les nouvelles tables sont conservées (rien supprimé)', (SELECT count(*) FROM public.documents WHERE user_id='c7000000-0000-0000-0000-000000000007') >= 3
  AND (SELECT count(*) FROM public.doc_history WHERE user_id='c7000000-0000-0000-0000-000000000007') = 4);
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', 'c7000000-0000-0000-0000-000000000007', false);
SELECT pg_temp.ok('retour : ancien chemin de nouveau écrivable, nouveau chemin refusé',
  pg_temp.works($$UPDATE public.user_data SET value = value WHERE key='invoices'$$)
  AND pg_temp.refuse($$SELECT public.upsert_document('{"id":"n3","type":"invoice","number":"BRO-NEW333","status":"draft"}'::jsonb, 0, 'o3')$$, 'MODE_ANCIEN_STOCKAGE'));
-- « ancien appareil » : modifie d1 puis SUPPRIME le brouillon n1 (créé en mode documents) dans l'ancien tableau
UPDATE public.user_data SET value = (SELECT jsonb_agg(CASE WHEN e->>'id'='d1' THEN e || '{"clientName":"modifié sur ancien appareil"}' ELSE e END) FROM jsonb_array_elements(value) e WHERE e->>'id' <> 'n1'),
  updated_at = now() - interval '1 hour' WHERE key = 'invoices';
RESET ROLE;
SELECT public.fp_doc_mode_set('c7000000-0000-0000-0000-000000000007', 'documents', NULL, 0) AS re1 \gset
SELECT pg_temp.ok('re-bascule : la suppression de n1 sur l''ancien appareil est SIGNALÉE (ARBITRAGE_REQUIS, brouillon créé par le nouveau chemin), pas ignorée ; d2 (pierre tombale) n''est pas ressuscité',
  :'re1'::jsonb->>'reason' = 'ARBITRAGE_REQUIS' AND :'re1'::jsonb->'drafts'->0->>'id' = 'n1' AND jsonb_array_length(:'re1'::jsonb->'drafts') = 1
  AND (SELECT count(*) FROM public.documents WHERE user_id='c7000000-0000-0000-0000-000000000007' AND id='d2') = 0, :'re1');
SELECT pg_temp.ok('re-bascule : la modification faite sur l''ancien appareil (d1) a été rattrapée sans faux conflit',
  (SELECT body->>'clientName' FROM public.documents WHERE user_id='c7000000-0000-0000-0000-000000000007' AND id='d1') = 'modifié sur ancien appareil'
  AND (SELECT count(*) FROM public._mig_conflicts WHERE user_id='c7000000-0000-0000-0000-000000000007' AND kind='document') = 0);
SELECT public.fp_doc_mode_set('c7000000-0000-0000-0000-000000000007', 'documents', 'keep', 0) AS re2 \gset
SELECT pg_temp.ok('re-bascule avec « keep » : n1 conservé, aucune donnée dupliquée (3 documents, 1 paiement, 4 entrées de journal)',
  (:'re2'::jsonb->>'ok')::boolean AND (SELECT count(*) FROM public.documents WHERE user_id='c7000000-0000-0000-0000-000000000007') = 3
  AND (SELECT count(*) FROM public.doc_payments WHERE user_id='c7000000-0000-0000-0000-000000000007') = 1
  AND (SELECT count(*) FROM public.doc_history WHERE user_id='c7000000-0000-0000-0000-000000000007') = 4, :'re2');

-- ====== 9. échec de bascule vers legacy : tout est annulé ======
SELECT public.fp_doc_mode_set('ca000000-0000-0000-0000-00000000000a', 'documents', NULL, 0) AS s10 \gset
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', 'ca000000-0000-0000-0000-00000000000a', false);
SELECT public.upsert_document('{"id":"nx","type":"invoice","number":"BRO-NEWXXX","status":"draft","totalTTC":2}'::jsonb, 0, 'ox') AS ux \gset
RESET ROLE;
SELECT md5(value::text) AS h FROM public.user_data WHERE user_id='ca000000-0000-0000-0000-00000000000a' AND key='invoices' \gset
SELECT pg_temp.ok('rollback direct (fp_mig_rollback) sur un compte en mode documents ayant des écritures nouvelles : REFUSÉ par la garde, aucun effet partiel',
  pg_temp.refuse($$SELECT public.fp_mig_rollback('ca000000-0000-0000-0000-00000000000a', true)$$, 'MODE_NOUVEAU_STOCKAGE')
  AND md5((SELECT value::text FROM public.user_data WHERE user_id='ca000000-0000-0000-0000-00000000000a' AND key='invoices')) = :'h'
  AND public.fp_doc_mode('ca000000-0000-0000-0000-00000000000a') = 'documents');
SELECT pg_temp.ok('fp_mig_run / fp_mig_verify (sql/16) restent utilisables sur un compte en mode documents, sans toucher à user_data',
  (public.fp_mig_run('ca000000-0000-0000-0000-00000000000a', true)->>'status') = 'applied' AND (public.fp_mig_verify('ca000000-0000-0000-0000-00000000000a')->>'ok')::boolean IS NOT NULL
  AND md5((SELECT value::text FROM public.user_data WHERE user_id='ca000000-0000-0000-0000-00000000000a' AND key='invoices')) = :'h');
-- retour impossible : une liste legacy au format inattendu bloque la resynchronisation => TOUT est annulé (y compris le retour arrière déjà exécuté), le mode reste documents
ALTER TABLE public.user_data DISABLE TRIGGER USER;
INSERT INTO public.user_data(user_id, key, value) VALUES ('ca000000-0000-0000-0000-00000000000a', 'quotes', '"pas un tableau"') ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value;
ALTER TABLE public.user_data ENABLE TRIGGER USER;
SELECT pg_temp.ok('retour bloqué par un format inattendu : erreur explicite (RESYNCHRO_ECHOUEE), transaction annulée, mode toujours documents, user_data inchangé',
  pg_temp.refuse($$SELECT public.fp_doc_mode_set('ca000000-0000-0000-0000-00000000000a', 'legacy')$$, 'RESYNCHRO_ECHOUEE')
  AND public.fp_doc_mode('ca000000-0000-0000-0000-00000000000a') = 'documents'
  AND md5((SELECT value::text FROM public.user_data WHERE user_id='ca000000-0000-0000-0000-00000000000a' AND key='invoices')) = :'h'
  AND (SELECT count(*) FROM public.documents WHERE user_id='ca000000-0000-0000-0000-00000000000a' AND id='nx') = 1);

-- ====== 10. suppression d'un compte en mode nouveau ======
SELECT public.fp_doc_mode_set('c5000000-0000-0000-0000-000000000005', 'documents', NULL, 0) AS s5 \gset
DELETE FROM auth.users WHERE id = 'c5000000-0000-0000-0000-000000000005';
SELECT pg_temp.ok('suppression d''un compte en mode nouveau : non bloquée par les gardes, tout supprimé en cascade',
  (SELECT count(*) FROM public.documents WHERE user_id='c5000000-0000-0000-0000-000000000005') = 0 AND (SELECT count(*) FROM public.user_data WHERE user_id='c5000000-0000-0000-0000-000000000005') = 0
  AND (SELECT count(*) FROM public.doc_store_mode WHERE user_id='c5000000-0000-0000-0000-000000000005') = 0 AND (SELECT count(*) FROM public.doc_store_testers WHERE user_id='c5000000-0000-0000-0000-000000000005') = 0);

-- ====== 11. isolation entre comptes ======
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-000000000002', false);
SELECT pg_temp.ok('t2 (documents) ne voit que ses documents', (SELECT count(*) FROM public.documents WHERE user_id <> 'c2000000-0000-0000-0000-000000000002') = 0 AND public.get_doc_mode() = 'documents');
SELECT set_config('request.jwt.claim.sub', 'c4000000-0000-0000-0000-000000000004', false);
SELECT pg_temp.ok('compte ordinaire : mode legacy, nouveau chemin refusé, ancien chemin intact', public.get_doc_mode() = 'legacy'
  AND pg_temp.refuse($$SELECT public.upsert_document('{"id":"z","type":"invoice","number":"BRO-ZZZZZZ","status":"draft"}'::jsonb, 0, 'oz')$$, 'MODE_ANCIEN_STOCKAGE')
  AND pg_temp.works($$UPDATE public.user_data SET value = value WHERE key='invoices'$$));
RESET ROLE;
-- nettoyage (la base est partagée avec les tests suivants)
DELETE FROM auth.users WHERE email LIKE '%@facturapro-test.invalid' OR email = 'ordinaire@example.com';
TRUNCATE public._mig_runs CASCADE;
