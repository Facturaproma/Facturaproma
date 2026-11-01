-- sql/40 : clôture de période — date de verrouillage, refus de toute écriture datée dans une période clôturée (fonctions, tables,
-- user_data factures/paiements), contrôles avant clôture, réouverture de la dernière clôture avec motif, journal, isolation.
\set VERBOSITY terse
SET client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.ok(name text, cond boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS
$$ BEGIN RAISE NOTICE '%', CASE WHEN cond THEN 'PASS '||name ELSE 'FAIL '||name||' '||detail END; END $$;
CREATE OR REPLACE FUNCTION pg_temp.err(sql text) RETURNS text LANGUAGE plpgsql AS
$$ BEGIN EXECUTE sql; RETURN ''; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $$;
CREATE OR REPLACE FUNCTION pg_temp.as_user(u text) RETURNS void LANGUAGE sql AS $$ SELECT set_config('request.jwt.claim.sub', u, false) $$;
GRANT EXECUTE ON FUNCTION pg_temp.ok(text, boolean, text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION pg_temp.err(text) TO PUBLIC;
INSERT INTO auth.users(id, email, email_confirmed_at) VALUES
  ('40404040-0000-4000-8000-000000000001', 'clo-a@test.invalid', now()),
  ('40404040-0000-4000-8000-000000000002', 'clo-b@test.invalid', now());
CREATE TEMP TABLE IF NOT EXISTS _c(k text, v text);
GRANT ALL ON _c TO PUBLIC;
-- Données user_data de A (déclencheurs de numérotation désactivés pour l'amorçage : on teste ici la clôture, pas la numérotation)
ALTER TABLE public.user_data DISABLE TRIGGER USER;
INSERT INTO public.user_data (user_id, key, value) VALUES
 ('40404040-0000-4000-8000-000000000001', 'invoices', '[{"id":"f1","number":"FAC-2026-001","status":"sent","date":"2026-10-03","totalTTC":1200},{"id":"d1","number":"","status":"draft","date":"2026-10-20","totalTTC":600}]'),
 ('40404040-0000-4000-8000-000000000001', 'payments', '[{"id":"p1","invoiceId":"f1","date":"2026-10-10","amount":200,"method":"especes"}]');
ALTER TABLE public.user_data ENABLE TRIGGER USER;

SELECT pg_temp.ok('table fermée : period_closures (RLS sans politique)', (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.period_closures'::regclass) AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'period_closures'));
SELECT pg_temp.ok('fonctions : authenticated oui, anon non ; vérifications internes non exposées',
  has_function_privilege('authenticated', 'public.period_close(text,text)', 'EXECUTE') AND has_function_privilege('authenticated', 'public.period_status()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.period_close(text,text)', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'public.fin_lock_date(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.fin_assert_open(uuid,date)', 'EXECUTE'));

SET ROLE authenticated; SELECT pg_temp.as_user('40404040-0000-4000-8000-000000000001');
INSERT INTO _c SELECT 'bank', public.cash_account_create('{"name":"Banque","kind":"bank","opening_balance":1000,"opening_date":"2026-09-01"}'::jsonb)->>'id';
INSERT INTO _c SELECT 'pur', public.purchase_record('{"key":"c-p1","supplier_name":"Minoterie","date":"2026-10-05","lines":[{"nature":"goods","product_id":"A","track_stock":true,"description":"Farine","qty":10,"unit_price":50,"tva_rate":20}]}'::jsonb)->>'id';
SELECT public.stock_record('[{"product_id":"A","product_name":"Farine","type":"out","qty":1,"date":"2026-10-12","source":"manual","key":"c-m1"}]'::jsonb);
SELECT pg_temp.ok('sans clôture : aucune date de verrouillage', (public.period_status()->>'lock_date') IS NULL);
SELECT pg_temp.ok('contrôles avant clôture d''octobre : 1 brouillon daté, 1 achat, 1 paiement sans compte, mois terminé',
  (SELECT (c->>'draft_invoices')::int = 1 AND (c->>'purchases')::int = 1 AND (c->>'payments_without_account')::int = 1 AND (c->>'month_finished')::boolean FROM (SELECT public.period_check('2026-10') c) x),
  public.period_check('2026-10')::text);
SELECT pg_temp.ok('mois en cours (novembre) : clôture refusée', pg_temp.err($$SELECT public.period_close('2026-11')$$) LIKE '%MOIS_NON_TERMINE%');
SELECT pg_temp.ok('mois invalide refusé', pg_temp.err($$SELECT public.period_close('2026-13')$$) LIKE '%MOIS_INVALIDE%' AND pg_temp.err($$SELECT public.period_close('oct')$$) LIKE '%MOIS_INVALIDE%');
SELECT pg_temp.ok('clôture d''octobre : verrouillé jusqu''au 31/10/2026', (public.period_close('2026-10', 'Relevé bancaire pointé')->>'lock_date') = '2026-10-31');
SELECT pg_temp.ok('état : date de verrouillage 31/10/2026', (public.period_status()->>'lock_date') = '2026-10-31');
SELECT pg_temp.ok('octobre (ou un mois antérieur) déjà clôturé : refusé', pg_temp.err($$SELECT public.period_close('2026-10')$$) LIKE '%DEJA_CLOTURE%' AND pg_temp.err($$SELECT public.period_close('2026-09')$$) LIKE '%DEJA_CLOTURE%');
-- Toutes les écritures datées ≤ 31/10 sont refusées
SELECT pg_temp.ok('achat daté du 20/10 : refusé (PERIODE_CLOTUREE)', pg_temp.err($$SELECT public.purchase_record('{"supplier_name":"X","date":"2026-10-20","lines":[{"nature":"expense","category":"Loyer","description":"Loyer","qty":1,"unit_price":100,"tva_rate":0}]}'::jsonb)$$) LIKE '%PERIODE_CLOTUREE%');
SELECT pg_temp.ok('achat daté du 01/11 : accepté', (public.purchase_record('{"key":"c-p2","supplier_name":"X","date":"2026-11-01","lines":[{"nature":"expense","category":"Loyer","description":"Loyer","qty":1,"unit_price":100,"tva_rate":0}]}'::jsonb)->>'id') IS NOT NULL);
SELECT pg_temp.ok('annulation d''un achat d''octobre : refusée (elle changerait un mois clôturé)', pg_temp.err(format('SELECT public.purchase_cancel(%L::uuid, %L)', (SELECT v FROM _c WHERE k = 'pur'), 'erreur')) LIKE '%PERIODE_CLOTUREE%');
SELECT pg_temp.ok('mouvement de stock manuel daté du 15/10 : refusé ; daté du 01/11 : accepté',
  pg_temp.err($$SELECT public.stock_record('[{"product_id":"A","type":"in","qty":1,"date":"2026-10-15","source":"manual"}]'::jsonb)$$) LIKE '%PERIODE_CLOTUREE%'
  AND (public.stock_record('[{"product_id":"A","type":"in","qty":1,"date":"2026-11-01","source":"manual","key":"c-m2"}]'::jsonb)->>'inserted')::int = 1);
SELECT pg_temp.ok('bon de livraison daté du 20/10 : refusé', pg_temp.err($$SELECT public.delivery_record('{"client_id":"c1","client_name":"Client","date":"2026-10-20","lines":[{"description":"x","qty":1,"unit_price":10,"tva_rate":20}]}'::jsonb)$$) LIKE '%PERIODE_CLOTUREE%');
SELECT pg_temp.ok('mouvement de trésorerie daté du 31/10 : refusé', pg_temp.err(format('SELECT public.cash_movement_record(%L::jsonb)', jsonb_build_object('account_id', (SELECT v FROM _c WHERE k = 'bank'), 'kind', 'owner_in', 'amount', 10, 'date', '2026-10-31')::text)) LIKE '%PERIODE_CLOTUREE%');
SELECT pg_temp.ok('règlement fournisseur daté du 30/10 : refusé ; daté du 01/11 : accepté',
  pg_temp.err(format('SELECT public.supplier_settle(%L::jsonb)', jsonb_build_object('purchase_id', (SELECT v FROM _c WHERE k = 'pur'), 'account_id', (SELECT v FROM _c WHERE k = 'bank'), 'amount', 100, 'date', '2026-10-30')::text)) LIKE '%PERIODE_CLOTUREE%'
  AND (public.supplier_settle(jsonb_build_object('key', 'c-r1', 'purchase_id', (SELECT v FROM _c WHERE k = 'pur'), 'account_id', (SELECT v FROM _c WHERE k = 'bank'), 'amount', 100, 'date', '2026-11-01'))->>'remaining')::numeric = 500);
SELECT pg_temp.ok('compte ouvert au 01/10 (période clôturée) : refusé', pg_temp.err($$SELECT public.cash_account_create('{"name":"Caisse","kind":"cash","opening_balance":10,"opening_date":"2026-10-01"}'::jsonb)$$) LIKE '%PERIODE_CLOTUREE%');
SELECT pg_temp.ok('accès direct à la table des clôtures : refusé', pg_temp.err($$SELECT * FROM public.period_closures$$) LIKE '%permission denied%'
  AND pg_temp.err($$DELETE FROM public.period_closures$$) LIKE '%permission denied%');
RESET ROLE;
-- user_data : paiements et factures (déclencheurs actifs, sauf la numérotation des factures)
SELECT pg_temp.ok('paiement nouveau daté du 15/10 : refusé',
  pg_temp.err($$UPDATE public.user_data SET value = value || '[{"id":"p2","invoiceId":"f1","date":"2026-10-15","amount":100,"method":"virement"}]'::jsonb WHERE user_id = '40404040-0000-4000-8000-000000000001' AND key = 'payments'$$) LIKE '%PERIODE_CLOTUREE%');
SELECT pg_temp.ok('paiement nouveau daté du 01/11 (avec l''ancien du 10/10 renvoyé) : accepté', pg_temp.err($$UPDATE public.user_data SET value = value || '[{"id":"p3","invoiceId":"f1","date":"2026-11-01","amount":100,"method":"virement"}]'::jsonb WHERE user_id = '40404040-0000-4000-8000-000000000001' AND key = 'payments'$$) = '');
SELECT pg_temp.ok('paiements : l''ancien (10/10) et le nouveau (01/11) seulement', (SELECT string_agg(e->>'id', ',' ORDER BY e->>'id') FROM public.user_data, jsonb_array_elements(value) e WHERE user_id = '40404040-0000-4000-8000-000000000001' AND key = 'payments') = 'p1,p3');
ALTER TABLE public.user_data DISABLE TRIGGER trg_guard_issued_invoices_ins; ALTER TABLE public.user_data DISABLE TRIGGER trg_guard_issued_invoices;
SELECT pg_temp.ok('brouillon du 20/10 émis après la clôture : refusé',
  pg_temp.err($$UPDATE public.user_data SET value = '[{"id":"f1","number":"FAC-2026-001","status":"sent","date":"2026-10-03","totalTTC":1200},{"id":"d1","number":"FAC-2026-002","status":"sent","date":"2026-10-20","totalTTC":600}]'::jsonb WHERE user_id = '40404040-0000-4000-8000-000000000001' AND key = 'invoices'$$) LIKE '%PERIODE_CLOTUREE%FAC-2026-002%');
SELECT pg_temp.ok('nouvelle facture émise datée du 15/10 : refusée',
  pg_temp.err($$UPDATE public.user_data SET value = value || '[{"id":"f9","number":"FAC-2026-009","status":"sent","date":"2026-10-15","totalTTC":10}]'::jsonb WHERE user_id = '40404040-0000-4000-8000-000000000001' AND key = 'invoices'$$) LIKE '%PERIODE_CLOTUREE%');
SELECT pg_temp.ok('facture déjà émise renvoyée (statut payé), brouillon modifié, facture du 01/11 émise : acceptés',
  pg_temp.err($$UPDATE public.user_data SET value = '[{"id":"f1","number":"FAC-2026-001","status":"paid","date":"2026-10-03","totalTTC":1200},{"id":"d1","number":"","status":"draft","date":"2026-10-21","totalTTC":700},{"id":"f3","number":"FAC-2026-003","status":"sent","date":"2026-11-01","totalTTC":50}]'::jsonb WHERE user_id = '40404040-0000-4000-8000-000000000001' AND key = 'invoices'$$) = '');
SELECT pg_temp.ok('sauvegarde par upsert (INSERT … ON CONFLICT) : même contrôle',
  pg_temp.err($$INSERT INTO public.user_data (user_id, key, value) VALUES ('40404040-0000-4000-8000-000000000001', 'invoices', '[{"id":"f1","number":"FAC-2026-001","status":"paid","date":"2026-10-03","totalTTC":1200},{"id":"f8","number":"FAC-2026-008","status":"sent","date":"2026-10-29","totalTTC":5}]') ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value$$) LIKE '%PERIODE_CLOTUREE%');
ALTER TABLE public.user_data ENABLE TRIGGER trg_guard_issued_invoices_ins; ALTER TABLE public.user_data ENABLE TRIGGER trg_guard_issued_invoices;
SELECT pg_temp.ok('modification directe d''une clôture (même par le propriétaire de la base) : refusée',
  pg_temp.err($$UPDATE public.period_closures SET period_end = '2026-09-30' WHERE user_id = '40404040-0000-4000-8000-000000000001'$$) LIKE '%CLOTURE_IMMUABLE%');
-- Isolation : B n'est pas concerné
SET ROLE authenticated; SELECT pg_temp.as_user('40404040-0000-4000-8000-000000000002');
SELECT pg_temp.ok('isolation : B sans clôture, peut saisir au 20/10 ; ne voit pas les clôtures de A',
  (public.period_status()->>'lock_date') IS NULL AND jsonb_array_length(public.period_status()->'history') = 0
  AND (public.purchase_record('{"key":"c-b1","supplier_name":"X","date":"2026-10-20","lines":[{"nature":"expense","category":"Loyer","description":"Loyer","qty":1,"unit_price":100,"tva_rate":0}]}'::jsonb)->>'id') IS NOT NULL);
SELECT pg_temp.ok('isolation : B ne peut pas rouvrir le mois de A', pg_temp.err($$SELECT public.period_reopen('2026-10', 'essai de B')$$) LIKE '%SEULE_LA_DERNIERE_CLOTURE%');
-- Réouverture
SELECT pg_temp.as_user('40404040-0000-4000-8000-000000000001');
SELECT pg_temp.ok('réouverture sans motif : refusée', pg_temp.err($$SELECT public.period_reopen('2026-10', '  ')$$) LIKE '%MOTIF_OBLIGATOIRE%');
SELECT pg_temp.ok('septembre déjà couvert par la clôture d''octobre', pg_temp.err($$SELECT public.period_close('2026-09')$$) LIKE '%DEJA_CLOTURE%');
SELECT pg_temp.ok('réouverture d''un mois autre que la dernière clôture : refusée', pg_temp.err($$SELECT public.period_reopen('2026-09', 'erreur de saisie')$$) LIKE '%SEULE_LA_DERNIERE_CLOTURE%');
SELECT pg_temp.ok('réouverture d''octobre avec motif : plus de verrouillage, saisie au 20/10 de nouveau possible',
  (public.period_reopen('2026-10', 'Facture fournisseur oubliée')->>'lock_date') IS NULL
  AND (public.purchase_record('{"key":"c-p3","supplier_name":"Oubli","date":"2026-10-20","lines":[{"nature":"expense","category":"Loyer","description":"Oubli","qty":1,"unit_price":100,"tva_rate":0}]}'::jsonb)->>'id') IS NOT NULL);
SELECT pg_temp.ok('historique : clôture et réouverture conservées avec le motif', (SELECT h->>'reopen_reason' = 'Facture fournisseur oubliée' AND h->>'note' = 'Relevé bancaire pointé' FROM jsonb_array_elements(public.period_status()->'history') h LIMIT 1));
SELECT pg_temp.ok('clôturer septembre puis octobre de nouveau : verrou au 31/10', (public.period_close('2026-09')->>'lock_date') = '2026-09-30' AND (public.period_close('2026-10')->>'lock_date') = '2026-10-31');
SELECT pg_temp.ok('réouverture d''octobre : le verrou revient au 30/09 (septembre reste clôturé)', (public.period_reopen('2026-10', 'deuxième correction')->>'lock_date') = '2026-09-30'
  AND pg_temp.err($$SELECT public.stock_record('[{"product_id":"A","type":"in","qty":1,"date":"2026-09-15","source":"manual"}]'::jsonb)$$) LIKE '%PERIODE_CLOTUREE%');
RESET ROLE;
SELECT pg_temp.ok('journal fin_audit : clôtures et réouvertures tracées', (SELECT count(*) FILTER (WHERE action = 'period_close') = 3 AND count(*) FILTER (WHERE action = 'period_reopen') = 2 FROM public.fin_audit WHERE user_id = '40404040-0000-4000-8000-000000000001'));
SELECT pg_temp.ok('une seule clôture active par mois (index unique partiel)', (SELECT count(*) FROM public.period_closures WHERE user_id = '40404040-0000-4000-8000-000000000001' AND reopened_at IS NULL) = 1);
-- Recoller sql/37 après sql/40 ne doit pas remettre la version vide de fin_assert_open
SET client_min_messages = warning;
\i sql/37_achats_serveur.sql
SET client_min_messages = notice;
SET ROLE authenticated; SELECT pg_temp.as_user('40404040-0000-4000-8000-000000000001');
SELECT pg_temp.ok('sql/37 recollé après sql/40 : la clôture reste appliquée', pg_temp.err($$SELECT public.purchase_record('{"supplier_name":"X","date":"2026-09-20","lines":[{"nature":"expense","category":"Loyer","description":"Loyer","qty":1,"unit_price":100,"tva_rate":0}]}'::jsonb)$$) LIKE '%PERIODE_CLOTUREE%');
RESET ROLE;
