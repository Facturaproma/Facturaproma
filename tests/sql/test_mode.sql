-- Tests SQL (base locale JETABLE, simulation) du BROUILLON sql/17_mode_stockage.sql : une seule source d'écriture par compte, bascule contrôlée.
\set VERBOSITY terse
SET client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.ok(name text, cond boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS
$$ BEGIN RAISE NOTICE '%', CASE WHEN cond IS TRUE THEN 'PASS '||name ELSE 'FAIL '||name||' '||detail END; END $$;
CREATE OR REPLACE FUNCTION pg_temp.refuse(sql text, motif text) RETURNS boolean LANGUAGE plpgsql AS
$$ BEGIN EXECUTE sql; RETURN false; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM LIKE '%'||motif||'%'; END $$;
CREATE OR REPLACE FUNCTION pg_temp.works(sql text) RETURNS boolean LANGUAGE plpgsql AS
$$ BEGIN EXECUTE sql; RETURN true; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'works() a échoué : %', SQLERRM; RETURN false; END $$;
GRANT ALL ON public.user_data TO authenticated;   -- comme sur Supabase (ancienne table)
\i sql/17_mode_stockage.sql
SET client_min_messages = notice;

INSERT INTO auth.users(id, email) VALUES
 ('c1000000-0000-0000-0000-000000000001', 't1@facturapro-test.invalid'),  -- bascule simple, écritures, retour arrière
 ('c2000000-0000-0000-0000-000000000002', 't2@facturapro-test.invalid'),  -- brouillon supprimé sur un ancien appareil : décision « keep »
 ('c3000000-0000-0000-0000-000000000003', 't3@facturapro-test.invalid'),  -- idem : décision « delete »
 ('c4000000-0000-0000-0000-000000000004', 'ordinaire@example.com'),       -- compte ordinaire : jamais basculable
 ('c5000000-0000-0000-0000-000000000005', 't5@facturapro-test.invalid');  -- suppression de compte en mode nouveau
INSERT INTO public.licenses(user_id, type, status, expires_at)
SELECT u, 'annual', 'active', now() + interval '200 days' FROM unnest(ARRAY['c1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000002','c3000000-0000-0000-0000-000000000003','c4000000-0000-0000-0000-000000000004','c5000000-0000-0000-0000-000000000005']::uuid[]) u;
INSERT INTO public.doc_counters(user_id, doc_type, last_value) SELECT u, 'invoice', 1 FROM unnest(ARRAY['c1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000002','c3000000-0000-0000-0000-000000000003','c4000000-0000-0000-0000-000000000004','c5000000-0000-0000-0000-000000000005']::uuid[]) u;
INSERT INTO public.user_data(user_id, key, value)
SELECT u, 'invoices', '[{"id":"i1","type":"invoice","number":"FAC-2026-001","status":"sent","totalHT":10,"totalTVA":2,"totalTTC":12},{"id":"d1","type":"invoice","number":"BRO-AAAAAA","status":"draft","totalTTC":5},{"id":"d2","type":"invoice","number":"BRO-BBBBBB","status":"draft","totalTTC":6}]'::jsonb
FROM unnest(ARRAY['c1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000002','c3000000-0000-0000-0000-000000000003','c4000000-0000-0000-0000-000000000004','c5000000-0000-0000-0000-000000000005']::uuid[]) u;
INSERT INTO public.user_data(user_id, key, value) SELECT u, 'docLog', '[{"ts":"2026-02-01T09:00:00Z","action":"emission","docId":"i1","number":"FAC-2026-001","detail":"ok"}]'::jsonb
FROM unnest(ARRAY['c1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000002','c3000000-0000-0000-0000-000000000003','c5000000-0000-0000-0000-000000000005']::uuid[]) u;
INSERT INTO public.user_data(user_id, key, value) VALUES ('c1000000-0000-0000-0000-000000000001', 'company', '{"name":"Test"}');

-- ====== 1. mode « legacy » par défaut : une seule source ======
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', false);
SELECT pg_temp.ok('mode par défaut = legacy (aucune ligne)', public.get_doc_mode() = 'legacy');
SELECT pg_temp.ok('legacy : upsert_document / record_payment / append_history refusés (MODE_ANCIEN_STOCKAGE)',
  pg_temp.refuse($$SELECT public.upsert_document('{"id":"n1","type":"invoice","number":"BRO-ZZZZZZ","status":"draft"}'::jsonb, 0, 'o1')$$, 'MODE_ANCIEN_STOCKAGE')
  AND pg_temp.refuse($$SELECT public.append_history('[{"id":"e1","action":"x"}]'::jsonb)$$, 'MODE_ANCIEN_STOCKAGE'));
SELECT pg_temp.ok('legacy : l''ancien chemin (user_data) continue de fonctionner', pg_temp.works($$UPDATE public.user_data SET value = value WHERE key='invoices'$$));
SELECT pg_temp.ok('un utilisateur ne peut ni lire doc_store_mode, ni changer de mode', pg_temp.refuse($$SELECT * FROM public.doc_store_mode$$, 'permission denied')
  AND pg_temp.refuse($$SELECT public.fp_doc_mode_set('c1000000-0000-0000-0000-000000000001','documents')$$, 'permission denied') AND pg_temp.refuse($$INSERT INTO public.doc_store_mode(user_id,mode) VALUES ('c1000000-0000-0000-0000-000000000001','documents')$$, 'permission denied'));
RESET ROLE;
SET ROLE anon; SELECT pg_temp.ok('anon : get_doc_mode / append_history inaccessibles', pg_temp.refuse($$SELECT public.get_doc_mode()$$, 'permission denied') AND pg_temp.refuse($$SELECT public.append_history('[]'::jsonb)$$, 'permission denied')); RESET ROLE;

-- ====== 2. comptes ordinaires : jamais basculables ======
SELECT pg_temp.ok('compte ordinaire : bascule refusée (COMPTE_NON_TEST), mode inchangé', pg_temp.refuse($$SELECT public.fp_doc_mode_set('c4000000-0000-0000-0000-000000000004','documents')$$, 'COMPTE_NON_TEST')
  AND public.fp_doc_mode('c4000000-0000-0000-0000-000000000004') = 'legacy');
SELECT pg_temp.ok('compte inconnu / mode invalide refusés', pg_temp.refuse($$SELECT public.fp_doc_mode_set(gen_random_uuid(),'documents')$$, 'COMPTE_INTROUVABLE')
  AND pg_temp.refuse($$SELECT public.fp_doc_mode_set('c1000000-0000-0000-0000-000000000001','autre')$$, 'MODE_INVALIDE'));

-- ====== 3. bascule d'un compte de test, sans brouillon supprimé ======
SELECT public.fp_doc_mode_set('c1000000-0000-0000-0000-000000000001', 'documents') AS s1 \gset
SELECT pg_temp.ok('t1 : bascule acceptée après rattrapage et vérification', (:'s1'::jsonb->>'ok')::boolean AND :'s1'::jsonb->>'mode' = 'documents', :'s1');
SELECT pg_temp.ok('t1 : 3 documents copiés, l''ancien stockage est intact', (SELECT count(*) FROM public.documents WHERE user_id='c1000000-0000-0000-0000-000000000001') = 3
  AND jsonb_array_length((SELECT value FROM public.user_data WHERE user_id='c1000000-0000-0000-0000-000000000001' AND key='invoices')) = 3);
SELECT public.fp_doc_mode_set('c1000000-0000-0000-0000-000000000001', 'documents') AS s1b \gset
SELECT pg_temp.ok('bascule rejouée : sans effet (unchanged)', (:'s1b'::jsonb->>'unchanged')::boolean);
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', false);
SELECT pg_temp.ok('t1 : get_doc_mode = documents', public.get_doc_mode() = 'documents');
SELECT pg_temp.ok('documents : l''ancien chemin est REFUSÉ pour les 4 clés (invoices, quotes, payments, docLog) — pas de double écriture',
  pg_temp.refuse($$UPDATE public.user_data SET value = '[]'::jsonb WHERE key='invoices'$$, 'MODE_NOUVEAU_STOCKAGE')
  AND pg_temp.refuse($$INSERT INTO public.user_data(user_id,key,value) VALUES ('c1000000-0000-0000-0000-000000000001','quotes','[]')$$, 'MODE_NOUVEAU_STOCKAGE')
  AND pg_temp.refuse($$INSERT INTO public.user_data(user_id,key,value) VALUES ('c1000000-0000-0000-0000-000000000001','payments','[]')$$, 'MODE_NOUVEAU_STOCKAGE')
  AND pg_temp.refuse($$UPDATE public.user_data SET value = '[]'::jsonb WHERE key='docLog'$$, 'MODE_NOUVEAU_STOCKAGE')
  AND pg_temp.refuse($$DELETE FROM public.user_data WHERE key='invoices'$$, 'MODE_NOUVEAU_STOCKAGE'));
SELECT pg_temp.ok('documents : les autres clés (company…) restent écrivables normalement', (SELECT count(*) FROM public.user_data WHERE key='company') = 1
  AND pg_temp.works($$UPDATE public.user_data SET value = '{"name":"Autre"}'::jsonb WHERE key='company'$$));
SELECT public.upsert_document('{"id":"n1","type":"invoice","number":"BRO-NEW111","status":"draft","totalTTC":9}'::jsonb, 0, 'op-n1') AS u1 \gset
SELECT pg_temp.ok('documents : upsert_document accepté', (:'u1'::jsonb->>'ok')::boolean, :'u1');
SELECT public.append_history('[{"id":"e-1","ts":"2026-03-01T10:00:00Z","action":"creation","docId":"n1","detail":"brouillon"}]'::jsonb, 'h1') AS h1 \gset
SELECT public.append_history('[{"id":"e-1","ts":"2026-03-01T10:00:00Z","action":"creation","docId":"n1","detail":"brouillon"}]'::jsonb, 'h1') AS h1b \gset
SELECT pg_temp.ok('journal : entrée ajoutée une fois, rejouée sans doublon', (:'h1'::jsonb->>'added')::int = 1 AND (:'h1b'::jsonb->>'added')::int = 0
  AND (SELECT count(*) FROM public.doc_history WHERE body->>'id' = 'e-1') = 1);
SELECT public.append_history('[{"action":"x","detail":"sans id"},{"action":"x","detail":"sans id"}]'::jsonb) AS h2 \gset
SELECT pg_temp.ok('journal : deux entrées strictement identiques sans id sont conservées toutes les deux', (:'h2'::jsonb->>'added')::int = 2);
SELECT pg_temp.ok('journal : valeur invalide / trop longue refusées', pg_temp.refuse($$SELECT public.append_history('"x"'::jsonb)$$, 'JOURNAL_INVALIDE')
  AND pg_temp.refuse($$SELECT public.append_history(('['||repeat('{"a":1},',100)||'{"a":1}]')::jsonb)$$, 'JOURNAL_INVALIDE'));
RESET ROLE;

-- ====== 4. brouillons supprimés sur un ancien appareil avant la bascule ======
SELECT public.fp_mig_run('c2000000-0000-0000-0000-000000000002', true) AS m2 \gset
SELECT public.fp_mig_run('c3000000-0000-0000-0000-000000000003', true) AS m3 \gset
-- « ancien appareil » : supprime le brouillon d1 de l'ancien tableau APRÈS la copie
UPDATE public.user_data SET value = value - 1 WHERE user_id IN ('c2000000-0000-0000-0000-000000000002','c3000000-0000-0000-0000-000000000003') AND key='invoices';
SELECT pg_temp.ok('préparation : d1 retiré de l''ancien tableau, toujours présent dans documents',
  (SELECT count(*) FROM public.documents WHERE user_id='c2000000-0000-0000-0000-000000000002') = 3
  AND (SELECT count(*) FROM public.user_data u, jsonb_array_elements(u.value) e WHERE u.user_id='c2000000-0000-0000-0000-000000000002' AND u.key='invoices' AND e->>'id'='d1') = 0);
SELECT public.fp_doc_mode_set('c2000000-0000-0000-0000-000000000002', 'documents') AS a2 \gset
SELECT pg_temp.ok('t2 : bascule ARRÊTÉE (ARBITRAGE_REQUIS) avec la liste du brouillon concerné, mode inchangé, rien supprimé en silence',
  :'a2'::jsonb->>'reason' = 'ARBITRAGE_REQUIS' AND :'a2'::jsonb->'drafts'->0->>'id' = 'd1' AND public.fp_doc_mode('c2000000-0000-0000-0000-000000000002') = 'legacy'
  AND (SELECT count(*) FROM public.documents WHERE user_id='c2000000-0000-0000-0000-000000000002' AND id='d1') = 1, :'a2');
SELECT public.fp_doc_mode_set('c2000000-0000-0000-0000-000000000002', 'documents', 'keep') AS k2 \gset
SELECT pg_temp.ok('t2 : décision « keep » => bascule faite, le brouillon est conservé, la décision est notée',
  (:'k2'::jsonb->>'ok')::boolean AND (SELECT count(*) FROM public.documents WHERE user_id='c2000000-0000-0000-0000-000000000002' AND id='d1') = 1
  AND (SELECT count(*) FROM public._mig_conflicts WHERE user_id='c2000000-0000-0000-0000-000000000002' AND kind='brouillon_supprime_ancien_appareil' AND legacy->>'decision'='keep') = 1, :'k2');
SELECT public.fp_doc_mode_set('c3000000-0000-0000-0000-000000000003', 'documents', 'delete') AS k3 \gset
SELECT pg_temp.ok('t3 : décision « delete » => bascule faite, brouillon retiré avec pierre tombale, décision notée, autres documents intacts',
  (:'k3'::jsonb->>'ok')::boolean AND (SELECT count(*) FROM public.documents WHERE user_id='c3000000-0000-0000-0000-000000000003') = 2
  AND (SELECT count(*) FROM public.doc_deleted WHERE user_id='c3000000-0000-0000-0000-000000000003' AND id='d1') = 1
  AND (SELECT count(*) FROM public._mig_conflicts WHERE user_id='c3000000-0000-0000-0000-000000000003' AND legacy->>'decision'='delete') = 1, :'k3');
SELECT pg_temp.ok('une facture ÉMISE absente de l''ancien tableau n''est jamais proposée à la suppression (seuls les brouillons non modifiés)',
  NOT EXISTS (SELECT 1 FROM public._mig_conflicts WHERE doc_id = 'i1'));

-- ====== 5. retour arrière complet ======
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', false);
SELECT public.upsert_document('{"id":"n2","type":"invoice","number":"BRO-NEW222","status":"draft","totalTTC":1}'::jsonb, 0, 'op-n2') AS u2 \gset
RESET ROLE;
SELECT public.fp_doc_mode_set('c1000000-0000-0000-0000-000000000001', 'legacy') AS rb \gset
SELECT pg_temp.ok('retour au mode ancien : écritures du nouveau chemin (n1, n2) reprises dans user_data, rien perdu',
  (:'rb'::jsonb->>'ok')::boolean AND public.fp_doc_mode('c1000000-0000-0000-0000-000000000001') = 'legacy'
  AND (SELECT count(*) FROM public.user_data u, jsonb_array_elements(u.value) e WHERE u.user_id='c1000000-0000-0000-0000-000000000001' AND u.key='invoices' AND e->>'id' IN ('i1','d1','d2','n1','n2')) = 5, :'rb');
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', false);
SELECT pg_temp.ok('après le retour : ancien chemin de nouveau écrivable, nouveau chemin refusé',
  pg_temp.works($$UPDATE public.user_data SET value = value WHERE key='invoices'$$)
  AND pg_temp.refuse($$SELECT public.upsert_document('{"id":"n3","type":"invoice","number":"BRO-NEW333","status":"draft"}'::jsonb, 0, 'o3')$$, 'MODE_ANCIEN_STOCKAGE'));
RESET ROLE;

-- ====== 6. suppression d'un compte en mode nouveau ======
SELECT public.fp_doc_mode_set('c5000000-0000-0000-0000-000000000005', 'documents') AS s5 \gset
DELETE FROM auth.users WHERE id = 'c5000000-0000-0000-0000-000000000005';
SELECT pg_temp.ok('suppression d''un compte en mode nouveau : non bloquée par les gardes, lignes supprimées en cascade',
  (SELECT count(*) FROM public.documents WHERE user_id='c5000000-0000-0000-0000-000000000005') = 0 AND (SELECT count(*) FROM public.user_data WHERE user_id='c5000000-0000-0000-0000-000000000005') = 0
  AND (SELECT count(*) FROM public.doc_store_mode WHERE user_id='c5000000-0000-0000-0000-000000000005') = 0);

-- ====== 7. isolation entre comptes ======
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', 'c2000000-0000-0000-0000-000000000002', false);
SELECT pg_temp.ok('t2 (documents) ne voit que ses documents ; son mode ne dépend pas de celui des autres', (SELECT count(*) FROM public.documents WHERE user_id <> 'c2000000-0000-0000-0000-000000000002') = 0 AND public.get_doc_mode() = 'documents');
SELECT set_config('request.jwt.claim.sub', 'c4000000-0000-0000-0000-000000000004', false);
SELECT pg_temp.ok('compte ordinaire : mode legacy, nouveau chemin refusé, ancien chemin intact', public.get_doc_mode() = 'legacy'
  AND pg_temp.refuse($$SELECT public.upsert_document('{"id":"z","type":"invoice","number":"BRO-ZZZZZZ","status":"draft"}'::jsonb, 0, 'oz')$$, 'MODE_ANCIEN_STOCKAGE'));
RESET ROLE;
-- nettoyage (la base est partagée avec les tests suivants)
DELETE FROM auth.users WHERE email LIKE '%@facturapro-test.invalid' OR email = 'ordinaire@example.com';
TRUNCATE public._mig_runs CASCADE;
