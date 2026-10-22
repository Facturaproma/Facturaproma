-- Tests SQL (base PostgreSQL locale jetable, pas Supabase) : isolation entre comptes,
-- numérotation serveur, verrouillage des factures émises, contournements directs, journal.
-- Données fictives. Chaque test affiche PASS ou FAIL.
\set VERBOSITY terse
SET client_min_messages = notice;

CREATE OR REPLACE FUNCTION pg_temp.ok(name text, cond boolean) RETURNS void LANGUAGE plpgsql AS
$$ BEGIN RAISE NOTICE '%', CASE WHEN cond THEN 'PASS '||name ELSE 'FAIL '||name END; END $$;
-- exécute une instruction et dit si elle a été refusée (message commençant par un motif)
CREATE OR REPLACE FUNCTION pg_temp.refuse(sql text, motif text) RETURNS boolean LANGUAGE plpgsql AS
$$ BEGIN EXECUTE sql; RETURN false; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM LIKE motif || '%' OR motif = '*'; END $$;

INSERT INTO auth.users(id, email) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a@test.invalid'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'b@test.invalid'),
  ('cccccccc-0000-0000-0000-000000000003', 'c@test.invalid');
INSERT INTO public.licenses(user_id, type, status, expires_at) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'annual', 'active', now() + interval '300 days'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'annual', 'active', now() + interval '300 days'),
  ('cccccccc-0000-0000-0000-000000000003', 'annual', 'suspended', now() + interval '300 days');
-- comme sur Supabase : droits par défaut accordés à authenticated (la sécurité repose sur RLS + REVOKE explicites)
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.doc_counters, public.doc_events FROM authenticated;

-- ====== Numérotation serveur (compte A) ======
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
SELECT pg_temp.ok('1er numéro = 1', public.next_doc_number('invoice', 0) = 1);
SELECT pg_temp.ok('2e numéro = 2', public.next_doc_number('invoice', 0) = 2);
SELECT pg_temp.ok('compteur des avoirs indépendant', public.next_doc_number('credit', 0) = 1);
SELECT pg_temp.ok('plancher local lu à la 1re attribution seulement (devis : 41 => 42)', public.next_doc_number('quote', 41) = 42);
SELECT pg_temp.ok('plancher plus bas ignoré (43)', public.next_doc_number('quote', 5) = 43);
SELECT pg_temp.ok('plancher plus haut ignoré (44)', public.next_doc_number('quote', 9999) = 44);
SELECT pg_temp.ok('type invalide refusé', pg_temp.refuse($$SELECT public.next_doc_number('hack', 0)$$, 'TYPE_INVALIDE'));

-- ====== Isolation (A écrit, B tente) ======
INSERT INTO public.user_data(user_id, key, value) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'clients', '[{"id":"c1","name":"Client secret A"}]'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'invoices',
   '[{"id":"i1","number":"FAC-2026-001","type":"invoice","status":"sent","clientId":"c1","items":[{"price":100}],"totalHT":100,"totalTVA":20,"totalTTC":120,"date":"2026-10-01"},{"id":"i2","number":"BRO-X","status":"draft","totalTTC":50}]');
SELECT pg_temp.ok('A : émission avec numéro serveur acceptée', (SELECT count(*) FROM public.user_data WHERE key='invoices') = 1);
SELECT pg_temp.ok('A : journal serveur « emission » créé automatiquement', (SELECT count(*) FROM public.doc_events WHERE action='emission' AND number='FAC-2026-001') = 1);

SELECT set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-000000000002', false);
SELECT pg_temp.ok('B ne lit aucune donnée de A', (SELECT count(*) FROM public.user_data) = 0);
SELECT pg_temp.ok('B ne lit pas les compteurs de A', (SELECT count(*) FROM public.doc_counters) = 0);
SELECT pg_temp.ok('B ne lit pas le journal de A', (SELECT count(*) FROM public.doc_events) = 0);
UPDATE public.user_data SET value = '[]' WHERE key = 'clients';
DELETE FROM public.user_data;
SELECT pg_temp.ok('B ne peut pas écrire chez A', pg_temp.refuse($$INSERT INTO public.user_data(user_id, key, value) VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'x', '[]')$$, '*'));
SELECT pg_temp.ok('compteur de B indépendant de A', public.next_doc_number('invoice', 0) = 1);
RESET ROLE;
SELECT pg_temp.ok('A : clients intacts après les tentatives de B', (SELECT value->0->>'name' FROM public.user_data WHERE key='clients') = 'Client secret A');
SELECT pg_temp.ok('A : factures intactes après les tentatives de B', (SELECT count(*) FROM public.user_data WHERE user_id='aaaaaaaa-0000-0000-0000-000000000001') = 2);

-- ====== Droits d'écriture directs sur compteurs et journal ======
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-000000000002', false);
SELECT pg_temp.ok('B ne peut pas modifier son compteur', pg_temp.refuse($$UPDATE public.doc_counters SET last_value = 0$$, '*'));
SELECT pg_temp.ok('B ne peut pas créer un compteur', pg_temp.refuse($$INSERT INTO public.doc_counters VALUES ('bbbbbbbb-0000-0000-0000-000000000002','credit',5)$$, '*'));
SELECT pg_temp.ok('B ne peut pas écrire dans le journal', pg_temp.refuse($$INSERT INTO public.doc_events(user_id, action) VALUES ('bbbbbbbb-0000-0000-0000-000000000002','x')$$, '*'));
SELECT pg_temp.ok('B ne peut pas effacer le journal', pg_temp.refuse($$DELETE FROM public.doc_events$$, '*'));
RESET ROLE;
SET ROLE anon;
SELECT pg_temp.ok('anonyme : numérotation refusée', pg_temp.refuse($$SELECT public.next_doc_number('invoice', 0)$$, '*'));
SELECT pg_temp.ok('anonyme : user_data inaccessible', pg_temp.refuse($$SELECT * FROM public.user_data$$, '*'));
RESET ROLE;
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', 'cccccccc-0000-0000-0000-000000000003', false);
SELECT pg_temp.ok('licence suspendue : numérotation refusée', pg_temp.refuse($$SELECT public.next_doc_number('invoice', 0)$$, 'LICENCE_INACTIVE'));
SELECT pg_temp.ok('les fonctions de garde ne sont pas appelables par un utilisateur', pg_temp.refuse($$SELECT public.guard_issued_invoices()$$, '*'));
RESET ROLE;

-- ====== Contournements directs du verrouillage (compte A) ======
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
CREATE TEMP TABLE base AS SELECT value AS v FROM public.user_data WHERE key='invoices';
GRANT ALL ON base TO authenticated;
SELECT pg_temp.ok('suppression d''une facture émise refusée', pg_temp.refuse($$UPDATE public.user_data SET value = (SELECT v FROM base) - 0 WHERE key='invoices'$$, 'FACTURE_VERROUILLEE'));
SELECT pg_temp.ok('modification du montant refusée', pg_temp.refuse($$UPDATE public.user_data SET value = jsonb_set((SELECT v FROM base), '{0,totalTTC}', '999') WHERE key='invoices'$$, 'FACTURE_VERROUILLEE'));
SELECT pg_temp.ok('modification des lignes refusée', pg_temp.refuse($$UPDATE public.user_data SET value = jsonb_set((SELECT v FROM base), '{0,items,0,price}', '1') WHERE key='invoices'$$, 'FACTURE_VERROUILLEE'));
SELECT pg_temp.ok('changement de numéro refusé', pg_temp.refuse($$UPDATE public.user_data SET value = jsonb_set((SELECT v FROM base), '{0,number}', '"FAC-2026-002"') WHERE key='invoices'$$, 'FACTURE_VERROUILLEE'));
SELECT pg_temp.ok('changement de client refusé', pg_temp.refuse($$UPDATE public.user_data SET value = jsonb_set((SELECT v FROM base), '{0,clientName}', '"Autre"') WHERE key='invoices'$$, 'FACTURE_VERROUILLEE'));
SELECT pg_temp.ok('retour au brouillon refusé', pg_temp.refuse($$UPDATE public.user_data SET value = jsonb_set((SELECT v FROM base), '{0,status}', '"draft"') WHERE key='invoices'$$, 'FACTURE_VERROUILLEE'));
SELECT pg_temp.ok('vider la liste refusé', pg_temp.refuse($$UPDATE public.user_data SET value = '[]' WHERE key='invoices'$$, 'FACTURE_VERROUILLEE'));
SELECT pg_temp.ok('supprimer la ligne entière refusé', pg_temp.refuse($$DELETE FROM public.user_data WHERE key='invoices'$$, 'FACTURE_VERROUILLEE'));
SELECT pg_temp.ok('renommer la clé (la cacher) refusé', pg_temp.refuse($$UPDATE public.user_data SET key='autre' WHERE key='invoices'$$, 'FACTURE_VERROUILLEE'));
SELECT pg_temp.ok('émission avec numéro non attribué refusée', pg_temp.refuse($$UPDATE public.user_data SET value = (SELECT v FROM base) || '[{"id":"x1","number":"FAC-2026-050","type":"invoice","status":"sent","totalTTC":1}]'::jsonb WHERE key='invoices'$$, 'NUMERO_NON_ATTRIBUE'));
SELECT pg_temp.ok('émission avec numéro sans format refusée', pg_temp.refuse($$UPDATE public.user_data SET value = (SELECT v FROM base) || '[{"id":"x2","number":"HACK","type":"invoice","status":"sent","totalTTC":1}]'::jsonb WHERE key='invoices'$$, 'NUMERO_NON_ATTRIBUE'));
SELECT pg_temp.ok('émission avec numéro déjà utilisé refusée', pg_temp.refuse($$UPDATE public.user_data SET value = (SELECT v FROM base) || '[{"id":"x3","number":"FAC-2026-001","type":"invoice","status":"sent","totalTTC":1}]'::jsonb WHERE key='invoices'$$, 'NUMERO_EN_DOUBLE'));
SELECT pg_temp.ok('création directe (ligne neuve) avec numéro non attribué refusée', pg_temp.refuse($$INSERT INTO public.user_data(user_id,key,value) VALUES ('aaaaaaaa-0000-0000-0000-000000000001','invoices','[]')$$, '*'));
-- opérations autorisées
SELECT pg_temp.ok('enregistrer un paiement autorisé', pg_temp.refuse($$UPDATE public.user_data SET value = jsonb_set(jsonb_set((SELECT v FROM base), '{0,status}', '"paid"'), '{0,paidAmount}', '120') WHERE key='invoices'$$, 'ZZZ') = false);
SELECT pg_temp.ok('journal serveur : changement de statut tracé', (SELECT count(*) FROM public.doc_events WHERE action='statut' AND number='FAC-2026-001') = 1);
SELECT pg_temp.ok('brouillon modifiable', pg_temp.refuse($$UPDATE public.user_data SET value = jsonb_set((SELECT value FROM public.user_data WHERE key='invoices'), '{1,totalTTC}', '75') WHERE key='invoices'$$, 'ZZZ') = false);
SELECT pg_temp.ok('émission d''un nouveau numéro serveur autorisée', public.next_doc_number('invoice', 0) = 3);
SELECT pg_temp.ok('... facture n°3 acceptée', pg_temp.refuse($$UPDATE public.user_data SET value = (SELECT value FROM public.user_data WHERE key='invoices') || '[{"id":"i3","number":"FAC-2026-003","type":"invoice","status":"sent","totalTTC":10}]'::jsonb WHERE key='invoices'$$, 'ZZZ') = false);
SELECT pg_temp.ok('avoir émis avec numéro du compteur « credit » accepté', pg_temp.refuse($$UPDATE public.user_data SET value = (SELECT value FROM public.user_data WHERE key='invoices') || '[{"id":"cr1","number":"AVR-2026-001","type":"credit","status":"sent","totalTTC":-120}]'::jsonb WHERE key='invoices'$$, 'ZZZ') = false);
SELECT pg_temp.ok('avoir avec numéro hors compteur « credit » refusé', pg_temp.refuse($$UPDATE public.user_data SET value = (SELECT value FROM public.user_data WHERE key='invoices') || '[{"id":"cr2","number":"AVR-2026-009","type":"credit","status":"sent","totalTTC":-1}]'::jsonb WHERE key='invoices'$$, 'NUMERO_NON_ATTRIBUE'));
RESET ROLE;

-- ====== Suppression du compte (cascade) et brouillons seuls ======
INSERT INTO public.user_data(user_id,key,value) VALUES ('bbbbbbbb-0000-0000-0000-000000000002','invoices','[{"id":"d1","number":"BRO-1","status":"draft"}]');
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-000000000002', false);
SELECT pg_temp.ok('liste de brouillons seuls : suppression autorisée', pg_temp.refuse($$DELETE FROM public.user_data WHERE key='invoices'$$, 'ZZZ') = false);
RESET ROLE;
DELETE FROM auth.users WHERE id = 'aaaaaaaa-0000-0000-0000-000000000001';
SELECT pg_temp.ok('suppression du compte A (cascade) autorisée malgré les factures émises', (SELECT count(*) FROM public.user_data WHERE user_id='aaaaaaaa-0000-0000-0000-000000000001') = 0);
SELECT pg_temp.ok('... et ses compteurs/journal supprimés avec lui', (SELECT count(*) FROM public.doc_counters WHERE user_id='aaaaaaaa-0000-0000-0000-000000000001') = 0);
