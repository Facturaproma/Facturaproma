-- Tests SQL (base locale JETABLE, données fictives) de la migration « une ligne par document » : sql/15 + sql/16.
-- Chaque test affiche PASS ou FAIL. Rien ici ne touche une base Supabase.
\set VERBOSITY terse
SET client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.ok(name text, cond boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS
$$ BEGIN RAISE NOTICE '%', CASE WHEN cond IS TRUE THEN 'PASS '||name ELSE 'FAIL '||name||' '||detail END; END $$;
CREATE OR REPLACE FUNCTION pg_temp.refuse(sql text, motif text) RETURNS boolean LANGUAGE plpgsql AS
$$ BEGIN EXECUTE sql; RETURN false; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM LIKE '%'||motif||'%'; END $$;

-- ---------- données fictives ----------
INSERT INTO auth.users(id, email) VALUES
  ('b1000000-0000-0000-0000-000000000001', 'm1@test.invalid'),   -- compte riche (factures, avoirs, devis, paiements, journal)
  ('b2000000-0000-0000-0000-000000000002', 'm2@test.invalid'),   -- autre compte (isolation)
  ('b3000000-0000-0000-0000-000000000003', 'm3@test.invalid'),   -- données incohérentes (doit bloquer)
  ('b4000000-0000-0000-0000-000000000004', 'm4@test.invalid'),   -- sabotage de la copie (arrêt automatique)
  ('b5000000-0000-0000-0000-000000000005', 'm5@test.invalid');   -- licence suspendue
INSERT INTO public.licenses(user_id, type, status, expires_at)
SELECT u, 'annual', CASE WHEN u = 'b5000000-0000-0000-0000-000000000005' THEN 'suspended' ELSE 'active' END, now() + interval '200 days'
FROM unnest(ARRAY['b1000000-0000-0000-0000-000000000001','b2000000-0000-0000-0000-000000000002','b3000000-0000-0000-0000-000000000003',
                  'b4000000-0000-0000-0000-000000000004','b5000000-0000-0000-0000-000000000005']::uuid[]) u;
GRANT ALL ON public.user_data, public.licenses, public.doc_counters, public.doc_events, public.admins TO authenticated;   -- anciennes tables : comme sur Supabase
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.doc_counters, public.doc_events FROM authenticated;
INSERT INTO public.doc_counters(user_id, doc_type, last_value) VALUES
  ('b1000000-0000-0000-0000-000000000001', 'invoice', 6), ('b1000000-0000-0000-0000-000000000001', 'credit', 1), ('b1000000-0000-0000-0000-000000000001', 'quote', 3),
  ('b2000000-0000-0000-0000-000000000002', 'invoice', 2),
  ('b4000000-0000-0000-0000-000000000004', 'invoice', 2);

INSERT INTO public.user_data(user_id, key, value) VALUES
 ('b1000000-0000-0000-0000-000000000001', 'invoices', $j$[
   {"id":"i1","type":"invoice","number":"FAC-2026-001","status":"paid","date":"2026-01-05","clientId":"c1","clientName":"Client A","items":[{"d":"Prestation","q":1,"p":100}],"totalHT":100,"totalTVA":20,"totalTTC":120,"paidAmount":120,"paidAt":"2026-01-20"},
   {"id":"i2","type":"invoice","number":"FAC-2026-002","status":"sent","date":"2026-02-01","clientId":"c1","clientName":"Client A","items":[],"totalHT":200,"totalTVA":40,"totalTTC":240,"paidAmount":100},
   {"id":"i3","type":"invoice","number":"FAC-2026-003","status":"sent","date":"2026-03-01","clientId":"c2","clientName":"Client B","items":[],"totalHT":50.005,"totalTVA":10.001,"totalTTC":60.006,"paidAmount":0},
   {"id":"i4","type":"invoice","number":"BRO-AAAAAA","status":"draft","date":"2026-03-02","clientName":"Client B","items":[],"totalHT":10,"totalTVA":2,"totalTTC":12},
   {"id":"i5","type":"invoice","number":"FAC-2026-004","status":"overdue","date":"2026-01-01","clientName":"Client C","items":[],"totalHT":300,"totalTVA":60,"totalTTC":360,"paidAmount":0},
   {"id":"c1","type":"credit","number":"AVR-2026-001","status":"sent","date":"2026-01-25","clientName":"Client A","items":[],"totalHT":-100,"totalTVA":-20,"totalTTC":-120,"relatedInvoiceId":"i1","relatedInvoiceNumber":"FAC-2026-001"}]$j$::jsonb),
 ('b1000000-0000-0000-0000-000000000001', 'quotes', $j$[
   {"id":"q1","type":"quote","number":"DEV-2026-001","status":"sent","date":"2026-02-10","clientName":"Client A","items":[],"totalHT":80,"totalTVA":16,"totalTTC":96},
   {"id":"q2","type":"quote","number":"DEV-2026-002","status":"accepted","date":"2026-02-11","clientName":"Client B","items":[],"totalHT":50,"totalTVA":10,"totalTTC":60,"convertedTo":"i3"},
   {"id":"q3","type":"quote","number":"BRO-QQQQQQ","status":"draft","date":"2026-02-12","clientName":"Client B","items":[],"totalHT":5,"totalTVA":1,"totalTTC":6}]$j$::jsonb),
 ('b1000000-0000-0000-0000-000000000001', 'payments', $j$[
   {"id":"p1","invoiceId":"i1","date":"2026-01-20","amount":120,"method":"virement","reference":"R1","notes":"","createdAt":"2026-01-20T10:00:00Z"},
   {"id":"p2","invoiceId":"i2","date":"2026-02-15","amount":100,"method":"espèces","reference":"","notes":"acompte","createdAt":"2026-02-15T10:00:00Z"}]$j$::jsonb),
 ('b1000000-0000-0000-0000-000000000001', 'docLog', $j$[
   {"ts":"2026-01-05T09:00:00Z","action":"emission","docId":"i1","number":"FAC-2026-001","detail":"Facture émise"},
   {"ts":"2026-01-20T10:00:00Z","action":"paiement","docId":"i1","number":"FAC-2026-001","detail":"120 DH (virement)"},
   {"ts":"2026-01-25T10:00:00Z","action":"avoir","docId":"c1","number":"AVR-2026-001","detail":"Avoir"},
   {"ts":"2026-01-25T10:00:00Z","action":"avoir","docId":"c1","number":"AVR-2026-001","detail":"Avoir"},
   {"ts":"2026-02-01T10:00:00Z","action":"emission","docId":"i2","number":"FAC-2026-002","detail":"Facture émise"}]$j$::jsonb),
 ('b1000000-0000-0000-0000-000000000001', 'company', '{"name":"Ma société","logo":"data:image/png;base64,AAAA"}'::jsonb),
 ('b1000000-0000-0000-0000-000000000001', 'clients', '[{"id":"c1","name":"Client A"}]'::jsonb),
 ('b2000000-0000-0000-0000-000000000002', 'invoices', '[{"id":"i1","type":"invoice","number":"FAC-2026-001","status":"sent","totalHT":1,"totalTVA":0.2,"totalTTC":1.2}]'::jsonb),
 ('b4000000-0000-0000-0000-000000000004', 'invoices', '[{"id":"s1","type":"invoice","number":"FAC-2026-001","status":"sent","totalHT":10,"totalTVA":2,"totalTTC":12}]'::jsonb);
-- M3 : données incohérentes écrites directement (sans déclencheur : compte sans compteur => on contourne le garde de sql/14 pour fabriquer l'état « historique »)
ALTER TABLE public.user_data DISABLE TRIGGER trg_guard_issued_invoices_ins;
INSERT INTO public.user_data(user_id, key, value) VALUES
 ('b3000000-0000-0000-0000-000000000003', 'invoices', $j$[
   {"id":"d1","type":"invoice","number":"FAC-2026-001","status":"sent","totalTTC":10},
   {"id":"d2","type":"invoice","number":"FAC-2026-001","status":"sent","totalTTC":20},
   {"id":"d3","type":"invoice","number":"SANS-NUMERO","status":"sent","totalTTC":30},
   {"id":"d1","type":"invoice","number":"BRO-X","status":"draft","totalTTC":1},
   {"number":"BRO-Y","status":"draft"}, 42]$j$::jsonb),
 ('b3000000-0000-0000-0000-000000000003', 'payments', '[{"invoiceId":"zz","amount":5}]'::jsonb);
ALTER TABLE public.user_data ENABLE TRIGGER trg_guard_issued_invoices_ins;

SELECT md5(string_agg(user_id::text||key||value::text||updated_at::text, '|' ORDER BY user_id, key)) AS h_before
  FROM public.user_data WHERE user_id IN ('b1000000-0000-0000-0000-000000000001','b2000000-0000-0000-0000-000000000002','b4000000-0000-0000-0000-000000000004') \gset

-- ====== 1. DRY-RUN : lecture seule, comptages ======
SELECT public.fp_mig_dry_run('b1000000-0000-0000-0000-000000000001') AS d1 \gset
SELECT pg_temp.ok('dry-run M1 : aucun bloquant', (:'d1'::jsonb->>'ok')::boolean);
SELECT pg_temp.ok('dry-run M1 : 5 factures + 1 avoir + 3 devis + 2 paiements + 5 entrées de journal comptés',
  (:'d1'::jsonb #> '{accounts,0}') @> '{"invoices":5,"credits":1,"quotes":3,"payments":2,"journal":5,"issued":5}'::jsonb, :'d1');
SELECT pg_temp.ok('dry-run M1 : avertissement « règlement incohérent » sur i3? non ; sur i2 (paidAmount 100 = paiements 100) non',
  NOT (:'d1'::jsonb->'warnings') @> '[{"code":"REGLEMENT_INCOHERENT"}]'::jsonb);
SELECT pg_temp.ok('dry-run M1 : le logo (data URI) dans company n''est pas un document : aucun avertissement de pièce jointe',
  NOT (:'d1'::jsonb->'warnings') @> '[{"code":"PIECE_JOINTE_OU_DATA_URI"}]'::jsonb);
SELECT pg_temp.ok('dry-run : rien n''a été écrit', (SELECT count(*) FROM public.documents) = 0 AND (SELECT count(*) FROM public._mig_runs) = 0);
SELECT pg_temp.ok('fp_mig_run(M1, false) = dry-run, aucune écriture', (public.fp_mig_run('b1000000-0000-0000-0000-000000000001', false)->>'status') = 'dry_run_ok' AND (SELECT count(*) FROM public.documents) = 0);

-- ====== 2. BLOQUANTS : arrêt automatique avant toute copie ======
SELECT public.fp_mig_run('b3000000-0000-0000-0000-000000000003', true) AS r3 \gset
SELECT pg_temp.ok('M3 : migration arrêtée avant la copie', (:'r3'::jsonb->>'status') = 'stopped' AND (:'r3'::jsonb->>'stage') = 'dry_run', :'r3');
SELECT pg_temp.ok('M3 : id en double, numéro en double, numéro invalide, élément non objet, document sans id : tous détectés',
  (SELECT bool_and(c) FROM (SELECT (:'r3'::jsonb->'dry_run'->'blockers') @> jsonb_build_array(jsonb_build_object('code', x)) c
   FROM unnest(ARRAY['ID_EN_DOUBLE','NUMERO_EN_DOUBLE','EMISE_SANS_NUMERO_VALIDE','ELEMENT_NON_OBJET','DOCUMENT_SANS_ID']) x) z), (:'r3'::jsonb->'dry_run'->'blockers')::text);
SELECT pg_temp.ok('M3 : aucune ligne copiée, aucune sauvegarde faite, user_data intact',
  (SELECT count(*) FROM public.documents WHERE user_id='b3000000-0000-0000-0000-000000000003') = 0
  AND (SELECT count(*) FROM public._mig_source_backup WHERE user_id='b3000000-0000-0000-0000-000000000003') = 0
  AND (SELECT jsonb_array_length(value) FROM public.user_data WHERE user_id='b3000000-0000-0000-0000-000000000003' AND key='invoices') = 6);
SELECT pg_temp.ok('M3 : avertissement paiement orphelin signalé', (public.fp_mig_dry_run('b3000000-0000-0000-0000-000000000003')->'warnings') @> '[{"code":"PAIEMENT_ORPHELIN"}]'::jsonb);

-- ====== 3. ARRÊT AUTOMATIQUE SUR ÉCART PENDANT LA COPIE (sabotage volontaire) ======
CREATE OR REPLACE FUNCTION pg_temp.sab() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id = 'b4000000-0000-0000-0000-000000000004' THEN NEW.total_ttc := NEW.total_ttc + 1; END IF; RETURN NEW; END $$;
CREATE TRIGGER zz_sabotage BEFORE INSERT ON public.documents FOR EACH ROW EXECUTE FUNCTION pg_temp.sab();
SELECT public.fp_mig_run('b4000000-0000-0000-0000-000000000004', true) AS r4 \gset
DROP TRIGGER zz_sabotage ON public.documents;
SELECT pg_temp.ok('M4 : écart détecté pendant la copie => statut stopped', (:'r4'::jsonb->>'status') = 'stopped' AND (:'r4'::jsonb->>'error') = 'MIGRATION_ECART', :'r4');
SELECT pg_temp.ok('M4 : la copie est ENTIÈREMENT annulée (0 ligne), l''ancien stockage est intact',
  (SELECT count(*) FROM public.documents WHERE user_id='b4000000-0000-0000-0000-000000000004') = 0
  AND (SELECT jsonb_array_length(value) FROM public.user_data WHERE user_id='b4000000-0000-0000-0000-000000000004' AND key='invoices') = 1);
SELECT pg_temp.ok('M4 : la sauvegarde de l''original a été conservée', (SELECT count(*) FROM public._mig_source_backup WHERE user_id='b4000000-0000-0000-0000-000000000004') = 1);
SELECT pg_temp.ok('M4 : l''échec est enregistré (statut stopped)', (SELECT count(*) FROM public._mig_runs WHERE status='stopped' AND report->>'error'='MIGRATION_ECART') = 1);
SELECT pg_temp.ok('M4 : sans sabotage, la migration réussit', (public.fp_mig_run('b4000000-0000-0000-0000-000000000004', true)->>'status') = 'applied');

-- ====== 4. MIGRATION RÉELLE DE M1 ======
SELECT public.fp_mig_run('b1000000-0000-0000-0000-000000000001', true) AS r1 \gset
SELECT pg_temp.ok('M1 : migration appliquée', (:'r1'::jsonb->>'status') = 'applied', :'r1');
SELECT pg_temp.ok('M1 : 9 documents (5 factures + 1 avoir + 3 devis), 2 paiements, 5 entrées de journal',
  (SELECT count(*) FROM public.documents WHERE user_id='b1000000-0000-0000-0000-000000000001') = 9
  AND (SELECT count(*) FROM public.doc_payments WHERE user_id='b1000000-0000-0000-0000-000000000001') = 2
  AND (SELECT count(*) FROM public.doc_history WHERE user_id='b1000000-0000-0000-0000-000000000001') = 5);
SELECT pg_temp.ok('M1 : deux entrées de journal strictement identiques toutes deux conservées (dup 0 et 1)',
  (SELECT count(*) FROM public.doc_history WHERE user_id='b1000000-0000-0000-0000-000000000001' AND action='avoir') = 2);
SELECT pg_temp.ok('M1 : chaque élément copié est identique à l''original (corps ET empreinte)',
  NOT EXISTS (SELECT 1 FROM public.fp_mig_legacy_docs('b1000000-0000-0000-0000-000000000001') l JOIN public.documents d ON (d.user_id,d.doc_type,d.id)=(l.user_id,l.doc_type,l.doc_id)
              WHERE d.body <> l.el OR d.body_sha <> public.fp_sha(l.el) OR d.legacy_sha <> public.fp_sha(l.el)));
SELECT pg_temp.ok('M1 : numéros conservés à l''identique (ensemble factures/avoirs émis)',
  (SELECT array_agg(number ORDER BY number) FROM public.documents WHERE user_id='b1000000-0000-0000-0000-000000000001' AND doc_type<>'quote' AND status<>'draft')
  = ARRAY['AVR-2026-001','FAC-2026-001','FAC-2026-002','FAC-2026-003','FAC-2026-004']);
SELECT pg_temp.ok('M1 : sommes exactes, sans arrondi caché (HT 50.005, TTC 60.006 conservés)',
  (SELECT total_ht = 50.005 AND total_ttc = 60.006 FROM public.documents WHERE user_id='b1000000-0000-0000-0000-000000000001' AND id='i3')
  AND (SELECT sum(total_ttc) FROM public.documents WHERE user_id='b1000000-0000-0000-0000-000000000001' AND doc_type IN ('invoice','credit')) = 120+240+60.006+12+360-120);
SELECT pg_temp.ok('M1 : avoir lié à sa facture d''origine (related_id)', (SELECT related_id FROM public.documents WHERE user_id='b1000000-0000-0000-0000-000000000001' AND id='c1') = 'i1');
SELECT pg_temp.ok('M1 : paiements : somme 220 conservée', (SELECT sum(amount) FROM public.doc_payments WHERE user_id='b1000000-0000-0000-0000-000000000001') = 220);
SELECT pg_temp.ok('M1 : fp_mig_verify = ok', (public.fp_mig_verify('b1000000-0000-0000-0000-000000000001')->>'ok')::boolean);
SELECT pg_temp.ok('M1 : l''ancien stockage n''a PAS été modifié (empreinte de toutes les lignes user_data de M1, M2, M4)',
  (SELECT md5(string_agg(user_id::text||key||value::text||updated_at::text, '|' ORDER BY user_id, key)) FROM public.user_data
    WHERE user_id IN ('b1000000-0000-0000-0000-000000000001','b2000000-0000-0000-0000-000000000002','b4000000-0000-0000-0000-000000000004')) = :'h_before');
SELECT pg_temp.ok('M1 : les clés non migrées (company avec logo, clients) sont intactes',
  (SELECT value->>'logo' FROM public.user_data WHERE user_id='b1000000-0000-0000-0000-000000000001' AND key='company') = 'data:image/png;base64,AAAA');
SELECT pg_temp.ok('M1 : sauvegardes des 4 clés d''origine présentes', (SELECT count(*) FROM public._mig_source_backup WHERE user_id='b1000000-0000-0000-0000-000000000001') = 4);

-- ====== 5. IDEMPOTENCE ======
SELECT public.fp_mig_run('b1000000-0000-0000-0000-000000000001', true) AS r1b \gset
SELECT pg_temp.ok('2e exécution : rien de nouveau, rien de rafraîchi, aucun conflit',
  (:'r1b'::jsonb->>'status') = 'applied' AND (:'r1b'::jsonb->>'documents_new')::int = 0 AND (:'r1b'::jsonb->>'documents_refreshed')::int = 0
  AND (:'r1b'::jsonb->>'documents_conflicts')::int = 0 AND (:'r1b'::jsonb->>'payments_new')::int = 0, :'r1b');
SELECT pg_temp.ok('2e exécution : mêmes effectifs (9 / 2 / 5), aucun doublon',
  (SELECT count(*) FROM public.documents WHERE user_id='b1000000-0000-0000-0000-000000000001') = 9
  AND (SELECT count(*) FROM public.doc_payments WHERE user_id='b1000000-0000-0000-0000-000000000001') = 2
  AND (SELECT count(*) FROM public.doc_history WHERE user_id='b1000000-0000-0000-0000-000000000001') = 5
  AND (SELECT count(*) FROM (SELECT 1 FROM public.documents WHERE doc_type<>'quote' AND status<>'draft' GROUP BY user_id, doc_type, number HAVING count(*)>1) z) = 0);
SELECT pg_temp.ok('2e exécution : versions inchangées (aucune écriture inutile)', (SELECT max(version) FROM public.documents WHERE user_id='b1000000-0000-0000-0000-000000000001') = 1);

-- ====== 6. ÉCRITURES PENDANT LA MIGRATION (ancien appareil encore actif) : rattrapage ======
UPDATE public.user_data SET value = (SELECT jsonb_agg(CASE WHEN e->>'id' = 'i3' THEN e || '{"paidAmount":30,"status":"sent"}'::jsonb ELSE e END) FROM jsonb_array_elements(value) e) || '[{"id":"i6","type":"invoice","number":"BRO-NEW","status":"draft","totalHT":1,"totalTVA":0,"totalTTC":1}]'::jsonb
 WHERE user_id='b1000000-0000-0000-0000-000000000001' AND key='invoices';
UPDATE public.user_data SET value = value || '[{"id":"p3","invoiceId":"i3","date":"2026-03-10","amount":30,"method":"chèque"}]'::jsonb WHERE user_id='b1000000-0000-0000-0000-000000000001' AND key='payments';
SELECT pg_temp.ok('avant rattrapage : verify signale précisément le retard (2 éléments à rattraper)', (public.fp_mig_verify('b1000000-0000-0000-0000-000000000001')->>'ok')::boolean = false);
SELECT public.fp_mig_run('b1000000-0000-0000-0000-000000000001', true) AS r1c \gset
SELECT pg_temp.ok('rattrapage : 1 nouveau document (i6), 1 rafraîchi (i3), 1 paiement ajouté, 0 conflit',
  (:'r1c'::jsonb->>'documents_new')::int = 1 AND (:'r1c'::jsonb->>'documents_refreshed')::int = 1 AND (:'r1c'::jsonb->>'payments_new')::int = 1 AND (:'r1c'::jsonb->>'documents_conflicts')::int = 0, :'r1c');
SELECT pg_temp.ok('rattrapage : i3 porte le règlement de 30 et rien d''autre n''a changé',
  (SELECT paid_amount FROM public.documents WHERE user_id='b1000000-0000-0000-0000-000000000001' AND id='i3') = 30
  AND (SELECT count(*) FROM public.documents WHERE user_id='b1000000-0000-0000-0000-000000000001') = 10);

-- ====== 7. DROITS (RLS) ======
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', 'b2000000-0000-0000-0000-000000000002', false);
SELECT pg_temp.ok('RLS : M2 ne voit aucun document, paiement ni journal de M1', (SELECT count(*) FROM public.documents WHERE user_id='b1000000-0000-0000-0000-000000000001') = 0
  AND (SELECT count(*) FROM public.doc_payments) = 0 AND (SELECT count(*) FROM public.doc_history) = 0);
SELECT pg_temp.ok('écriture directe dans documents refusée (INSERT)', pg_temp.refuse($$INSERT INTO public.documents(user_id,doc_type,id,body,body_sha) VALUES ('b2000000-0000-0000-0000-000000000002','invoice','x','{}','')$$, 'permission denied'));
SELECT pg_temp.ok('écriture directe dans documents refusée (UPDATE / DELETE)', pg_temp.refuse($$UPDATE public.documents SET status='paid'$$, 'permission denied') AND pg_temp.refuse($$DELETE FROM public.documents$$, 'permission denied'));
SELECT pg_temp.ok('fonctions de migration non exécutables par un utilisateur', pg_temp.refuse($$SELECT public.fp_mig_run(NULL, true)$$, 'permission denied')
  AND pg_temp.refuse($$SELECT public.fp_mig_rollback(NULL, true)$$, 'permission denied') AND pg_temp.refuse($$SELECT public.fp_mig_dry_run(NULL)$$, 'permission denied'));
SELECT pg_temp.ok('tables techniques _mig_* illisibles', pg_temp.refuse($$SELECT * FROM public._mig_source_backup$$, 'permission denied') AND pg_temp.refuse($$SELECT * FROM public._mig_conflicts$$, 'permission denied'));
RESET ROLE;
SET ROLE anon;
SELECT pg_temp.ok('anon : aucun accès aux nouvelles tables ni aux fonctions', pg_temp.refuse($$SELECT * FROM public.documents$$, 'permission denied') AND pg_temp.refuse($$SELECT public.upsert_document('{"id":"a"}'::jsonb)$$, 'permission denied'));
RESET ROLE;
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-000000000001', false);
SELECT pg_temp.ok('RLS : M1 voit ses 10 documents, 3 paiements, 5 entrées de journal', (SELECT count(*) FROM public.documents) = 10 AND (SELECT count(*) FROM public.doc_payments) = 3 AND (SELECT count(*) FROM public.doc_history) = 5);

-- ====== 8. DEUX APPAREILS : versions, conflits, reprise ======
SELECT (public.upsert_document((SELECT body FROM public.documents WHERE id='i6') || '{"clientName":"Appareil A"}'::jsonb, 1, 'opA1')) AS ra \gset
SELECT pg_temp.ok('appareil A modifie i6 (version 1) : accepté, version 2', (:'ra'::jsonb->>'ok')::boolean AND (:'ra'::jsonb->>'version')::int = 2, :'ra');
SELECT public.upsert_document((SELECT body FROM public.documents WHERE id='i6') || '{"clientName":"Appareil B"}'::jsonb, 1, 'opB1') AS rb \gset
SELECT pg_temp.ok('appareil B, resté sur la version 1 : CONFLIT explicite, avec la version serveur, rien écrasé',
  (:'rb'::jsonb->>'conflict')::boolean AND (:'rb'::jsonb->>'server_version')::int = 2 AND :'rb'::jsonb #>> '{server_doc,clientName}' = 'Appareil A', :'rb');
SELECT pg_temp.ok('le contenu serveur est toujours celui de A', (SELECT body->>'clientName' FROM public.documents WHERE id='i6') = 'Appareil A');
SELECT public.upsert_document((SELECT body FROM public.documents WHERE id='i6') || '{"clientName":"Appareil B (fusion)"}'::jsonb, 2, 'opB2') AS rb2 \gset
SELECT pg_temp.ok('B relit la version 2, applique sa modification : accepté (version 3)', (:'rb2'::jsonb->>'ok')::boolean AND (:'rb2'::jsonb->>'version')::int = 3);
SELECT public.upsert_document((SELECT body FROM public.documents WHERE id='i6') || '{"clientName":"Appareil B (fusion)"}'::jsonb, 2, 'opB2') AS rb3 \gset
SELECT pg_temp.ok('REPRISE après coupure : la même opération rejouée est reconnue, sans double application (reste version 3)',
  (:'rb3'::jsonb->>'replay')::boolean AND (SELECT version FROM public.documents WHERE id='i6') = 3, :'rb3');
SELECT public.upsert_document((SELECT body FROM public.documents WHERE id='i2') || '{"notes":"A"}'::jsonb, 1, 'opA2') AS rc \gset
SELECT pg_temp.ok('modifications de documents DIFFÉRENTS : aucun conflit', (:'rc'::jsonb->>'ok')::boolean);
SELECT public.upsert_document('{"id":"i6","type":"invoice","number":"BRO-ZZZ","status":"draft"}'::jsonb, 0, 'opC1') AS rd \gset
SELECT pg_temp.ok('création d''un id déjà pris avec version 0 : conflit, pas d''écrasement', (:'rd'::jsonb->>'conflict')::boolean);
SELECT public.upsert_document('{"id":"n1","type":"invoice","number":"BRO-N1","status":"draft","totalTTC":5}'::jsonb, NULL, 'opN1') AS re \gset
SELECT pg_temp.ok('création d''un nouveau brouillon : version 1', (:'re'::jsonb->>'version')::int = 1);
SELECT pg_temp.ok('modification d''un document supprimé ailleurs : conflit', (public.upsert_document('{"id":"fantome","type":"invoice","status":"draft","number":"BRO-F"}'::jsonb, 4, 'opF')->>'conflict')::boolean);

-- ====== 9. VERROUILLAGE, NUMÉROS, LICENCE, PAIEMENTS (nouveau chemin) ======
SELECT pg_temp.ok('facture émise : modifier le montant est refusé', pg_temp.refuse($$SELECT public.upsert_document((SELECT body FROM public.documents WHERE id='i1') || '{"totalTTC":1}'::jsonb, 1, 'opL1')$$, 'FACTURE_VERROUILLEE'));
SELECT pg_temp.ok('facture émise : suppression refusée', pg_temp.refuse($$SELECT public.delete_document('invoice','i1',1,'opL2')$$, 'FACTURE_VERROUILLEE'));
SELECT pg_temp.ok('facture émise : retour au brouillon refusé', pg_temp.refuse($$SELECT public.upsert_document((SELECT body FROM public.documents WHERE id='i2') || '{"status":"draft"}'::jsonb, 2, 'opL3')$$, 'FACTURE_VERROUILLEE'));
SELECT pg_temp.ok('émission avec un numéro non attribué par le serveur refusée', pg_temp.refuse($$SELECT public.upsert_document('{"id":"n1","type":"invoice","number":"FAC-2026-099","status":"sent","totalTTC":5}'::jsonb, 1, 'opL4')$$, 'NUMERO_NON_ATTRIBUE'));
SELECT pg_temp.ok('émission avec un numéro déjà utilisé refusée', pg_temp.refuse($$SELECT public.upsert_document('{"id":"n1","type":"invoice","number":"FAC-2026-002","status":"sent","totalTTC":5}'::jsonb, 1, 'opL5')$$, 'NUMERO_EN_DOUBLE'));
SELECT public.next_doc_number('invoice', 0) AS nn \gset
SELECT pg_temp.ok('le serveur attribue le numéro suivant (7)', :nn = 7);
SELECT public.upsert_document(jsonb_build_object('id','n1','type','invoice','number','FAC-2026-00'||:nn,'status','sent','totalHT',5,'totalTVA',1,'totalTTC',6), 1, 'opL6') AS rf \gset
SELECT pg_temp.ok('émission avec le numéro attribué : acceptée et journalisée (doc_events)', (:'rf'::jsonb->>'ok')::boolean AND EXISTS (SELECT 1 FROM public.doc_events WHERE doc_id='n1' AND action='emission'), :'rf');
SELECT public.record_payment('n1', '{"id":"pay-n1","date":"2026-04-01","amount":6,"method":"virement"}'::jsonb, 'opP1') AS rp \gset
SELECT pg_temp.ok('paiement intégral : facture payée, règlement et version mis à jour atomiquement',
  (SELECT status = 'paid' AND paid_amount = 6 AND version = 3 FROM public.documents WHERE id='n1'), :'rp');
SELECT pg_temp.ok('paiement rejoué (coupure réseau) : sans double enregistrement',
  (public.record_payment('n1', '{"id":"pay-n1","date":"2026-04-01","amount":6,"method":"virement"}'::jsonb, 'opP1')->>'replay')::boolean
  AND (SELECT count(*) FROM public.doc_payments WHERE id='pay-n1') = 1 AND (SELECT paid_amount FROM public.documents WHERE id='n1') = 6);
SELECT pg_temp.ok('paiement sur brouillon refusé', pg_temp.refuse($$SELECT public.record_payment('i6','{"id":"px","amount":1}'::jsonb,'opP2')$$, 'PAIEMENT_SUR_BROUILLON'));
SELECT pg_temp.ok('paiement de montant nul refusé', pg_temp.refuse($$SELECT public.record_payment('i2','{"id":"py","amount":0}'::jsonb,'opP3')$$, 'PAIEMENT_INVALIDE'));
RESET ROLE;
SELECT pg_temp.ok('paiement : suppression/modification directes refusées par le déclencheur', pg_temp.refuse($$DELETE FROM public.doc_payments WHERE id='pay-n1'$$, 'PAIEMENT_VERROUILLE') AND pg_temp.refuse($$UPDATE public.doc_payments SET body = body || '{"amount":1}' WHERE id='pay-n1'$$, 'PAIEMENT_VERROUILLE'));
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', 'b5000000-0000-0000-0000-000000000005', false);
SELECT pg_temp.ok('licence suspendue : écriture refusée (LICENCE_INACTIVE)', pg_temp.refuse($$SELECT public.upsert_document('{"id":"z","type":"invoice","status":"draft","number":"BRO-Z"}'::jsonb, NULL, 'opZ')$$, 'LICENCE_INACTIVE'));
RESET ROLE;

-- ====== 10. SUPPRESSIONS PAR LE NOUVEAU CHEMIN + CONFLIT « DES DEUX CÔTÉS » ======
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-000000000001', false);
SELECT (public.delete_document('invoice','i4',1,'opD1')->>'ok')::boolean AND (public.delete_document('quote','q3',1,'opD2')->>'ok')::boolean AS del_ok \gset
SELECT pg_temp.ok('suppression d''un brouillon (i4) et d''un devis brouillon (q3) par le nouveau chemin', :'del_ok' = 't' AND (SELECT count(*) FROM public.documents WHERE id IN ('i4','q3')) = 0);
SELECT pg_temp.ok('suppression rejouée après coupure : sans effet', (public.delete_document('invoice','i4',1,'opD1')->>'already_deleted')::boolean);
RESET ROLE;
UPDATE public.user_data SET value = (SELECT jsonb_agg(CASE WHEN e->>'id' = 'i2' THEN e || '{"paidAmount":150}'::jsonb ELSE e END) FROM jsonb_array_elements(value) e)
 WHERE user_id='b1000000-0000-0000-0000-000000000001' AND key='invoices';       -- l'ancien appareil modifie i2, déjà modifié (v2) par le nouveau chemin
SELECT public.fp_mig_run('b1000000-0000-0000-0000-000000000001', true) AS r1d \gset
SELECT pg_temp.ok('modifié des DEUX côtés (i2) : 1 conflit noté, AUCUN écrasement',
  (:'r1d'::jsonb->>'status') = 'applied' AND (:'r1d'::jsonb->>'documents_conflicts')::int = 1
  AND (SELECT body->>'notes' FROM public.documents WHERE id='i2') = 'A' AND (SELECT paid_amount FROM public.documents WHERE id='i2') = 100, :'r1d');
SELECT pg_temp.ok('la version de l''ancien appareil est conservée intégralement dans _mig_conflicts', (SELECT (legacy->>'paidAmount')::numeric FROM public._mig_conflicts WHERE doc_id='i2') = 150);
SELECT pg_temp.ok('rejouer : le même conflit n''est pas noté deux fois', (public.fp_mig_run('b1000000-0000-0000-0000-000000000001', true)->>'documents_conflicts')::int = 0);
SELECT pg_temp.ok('les suppressions du nouveau chemin ne ressuscitent pas lors du rattrapage', (SELECT count(*) FROM public.documents WHERE id IN ('i4','q3')) = 0);

-- ====== 11. RETOUR ARRIÈRE : aucune perte, originaux sauvegardés, rejouable ======
SELECT md5(value::text) AS h_inv_avant, jsonb_array_length(value) AS n_inv_avant FROM public.user_data WHERE user_id='b1000000-0000-0000-0000-000000000001' AND key='invoices' \gset
SELECT public.fp_mig_rollback('b1000000-0000-0000-0000-000000000001', false) AS rb_prev \gset
SELECT pg_temp.ok('aperçu du retour arrière : change 3 listes (factures, devis, paiements) sans rien écrire',
  (:'rb_prev'::jsonb->>'status') = 'rollback_preview' AND (:'rb_prev'::jsonb->>'lists_changed')::int = 3
  AND (SELECT md5(value::text) FROM public.user_data WHERE user_id='b1000000-0000-0000-0000-000000000001' AND key='invoices') = :'h_inv_avant', :'rb_prev');
SELECT public.fp_mig_rollback('b1000000-0000-0000-0000-000000000001', true) AS rb \gset
SELECT pg_temp.ok('retour arrière appliqué', (:'rb'::jsonb->>'status') = 'rollback_applied', :'rb');
SELECT pg_temp.ok('factures : toutes les émises conservées + celle émise depuis (FAC-2026-007) ; i4 retirée (supprimée depuis)',
  (SELECT array_agg(e->>'number' ORDER BY e->>'number') FROM public.user_data u, jsonb_array_elements(u.value) e
    WHERE u.user_id='b1000000-0000-0000-0000-000000000001' AND u.key='invoices' AND COALESCE(e->>'status','draft')<>'draft')
  = ARRAY['AVR-2026-001','FAC-2026-001','FAC-2026-002','FAC-2026-003','FAC-2026-004','FAC-2026-007']
  AND NOT EXISTS (SELECT 1 FROM public.user_data u, jsonb_array_elements(u.value) e WHERE u.user_id='b1000000-0000-0000-0000-000000000001' AND u.key='invoices' AND e->>'id'='i4'));
SELECT pg_temp.ok('factures : les écritures faites pendant la migration sont reprises (i6 modifié, i2 notes, n1 payée)',
  (SELECT e->>'clientName' FROM public.user_data u, jsonb_array_elements(u.value) e WHERE u.user_id='b1000000-0000-0000-0000-000000000001' AND u.key='invoices' AND e->>'id'='i6') = 'Appareil B (fusion)'
  AND (SELECT e->>'notes' FROM public.user_data u, jsonb_array_elements(u.value) e WHERE u.user_id='b1000000-0000-0000-0000-000000000001' AND u.key='invoices' AND e->>'id'='i2') = 'A'
  AND (SELECT e->>'status' FROM public.user_data u, jsonb_array_elements(u.value) e WHERE u.user_id='b1000000-0000-0000-0000-000000000001' AND u.key='invoices' AND e->>'id'='n1') = 'paid');
SELECT pg_temp.ok('paiements : p1, p2, p3 et pay-n1 (4) ; devis : q1, q2 (q3 supprimé)',
  (SELECT jsonb_array_length(value) FROM public.user_data WHERE user_id='b1000000-0000-0000-0000-000000000001' AND key='payments') = 4
  AND (SELECT jsonb_array_length(value) FROM public.user_data WHERE user_id='b1000000-0000-0000-0000-000000000001' AND key='quotes') = 2);
SELECT pg_temp.ok('l''état d''avant le retour arrière est conservé tel quel (sauvegarde sous son empreinte)',
  EXISTS (SELECT 1 FROM public._mig_source_backup WHERE user_id='b1000000-0000-0000-0000-000000000001' AND key='invoices' AND md5(value::text) = :'h_inv_avant' AND jsonb_array_length(value) = :n_inv_avant));
SELECT pg_temp.ok('les nouvelles tables ne sont pas supprimées par le retour arrière', (SELECT count(*) FROM public.documents WHERE user_id='b1000000-0000-0000-0000-000000000001') = 9);
SELECT pg_temp.ok('retour arrière rejoué : aucun changement (idempotent)', (public.fp_mig_rollback('b1000000-0000-0000-0000-000000000001', true)->>'lists_changed')::int = 0);
SELECT pg_temp.ok('clés non migrées intactes après retour arrière (logo conservé)', (SELECT value->>'logo' FROM public.user_data WHERE user_id='b1000000-0000-0000-0000-000000000001' AND key='company') = 'data:image/png;base64,AAAA');
SELECT public.fp_mig_run('b1000000-0000-0000-0000-000000000001', true) AS r1e \gset
SELECT pg_temp.ok('aller-retour : la migration relancée après le retour arrière est cohérente (verify ok, aucun doublon)',
  (:'r1e'::jsonb->>'status') = 'applied' AND (public.fp_mig_verify('b1000000-0000-0000-0000-000000000001')->>'ok')::boolean
  AND (SELECT count(*) FROM public.documents WHERE user_id='b1000000-0000-0000-0000-000000000001') = 9, :'r1e');

-- ====== 12. SUPPRESSION DE COMPTE (cascade) ======
DELETE FROM auth.users WHERE id = 'b4000000-0000-0000-0000-000000000004';
SELECT pg_temp.ok('suppression du compte M4 : ses documents, paiements et journal disparaissent avec lui',
  (SELECT count(*) FROM public.documents WHERE user_id='b4000000-0000-0000-0000-000000000004') = 0);

-- ====== nettoyage : la base de test est partagée avec les autres fichiers de tests ======
DELETE FROM auth.users WHERE id::text LIKE 'b_000000-0000-0000-0000-00000000000_' OR id::text ~ '^b[1-5]000000-';
TRUNCATE public._mig_runs, public._mig_source_backup, public._mig_conflicts, public.doc_deleted;
