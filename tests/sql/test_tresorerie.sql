-- sql/39 : trésorerie — comptes, solde d'ouverture, mouvements immuables, règlements fournisseurs plafonnés, encaissements lus (sans recopie),
-- annulations, virements, interdiction d'annuler un achat réglé, isolation. Scénario de référence S1-S17 du plan FacturaPro 2.0.
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
  ('39393939-0000-4000-8000-000000000001', 'tre-a@test.invalid', now()),
  ('39393939-0000-4000-8000-000000000002', 'tre-b@test.invalid', now());
CREATE TEMP TABLE IF NOT EXISTS _t(k text, v text);
GRANT ALL ON _t TO PUBLIC;

SELECT pg_temp.ok('tables fermées : cash_accounts, cash_movements', (SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('public.cash_accounts'::regclass, 'public.cash_movements'::regclass)) AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename IN ('cash_accounts', 'cash_movements')));
SELECT pg_temp.ok('fonctions : authenticated oui, anon non ; lectures internes non exposées',
  has_function_privilege('authenticated', 'public.supplier_settle(jsonb)', 'EXECUTE') AND has_function_privilege('authenticated', 'public.cash_balances(date)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.cash_movement_record(jsonb)', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'public.fin_customer_payments(uuid)', 'EXECUTE'));

SET ROLE authenticated; SELECT pg_temp.as_user('39393939-0000-4000-8000-000000000001');
INSERT INTO _t SELECT 'bank', public.cash_account_create('{"key":"acc-b","name":"Banque","kind":"bank","opening_balance":10000,"opening_date":"2026-10-01"}'::jsonb)->>'id';
INSERT INTO _t SELECT 'cash', public.cash_account_create('{"key":"acc-c","name":"Caisse","kind":"cash","opening_balance":500,"opening_date":"2026-10-01"}'::jsonb)->>'id';
SELECT pg_temp.ok('comptes : rejeu de la même clé sans doublon ; nom en double refusé', (public.cash_account_create('{"key":"acc-b","name":"Autre","kind":"bank","opening_balance":1,"opening_date":"2026-10-01"}'::jsonb)->>'duplicate')::boolean
  AND pg_temp.err($$SELECT public.cash_account_create('{"name":"Banque","kind":"bank","opening_balance":1,"opening_date":"2026-10-01"}'::jsonb)$$) LIKE '%COMPTE_EXISTANT%');
SELECT pg_temp.ok('ouverture dans le futur refusée', pg_temp.err(format('SELECT public.cash_account_create(%L::jsonb)', jsonb_build_object('name', 'Futur', 'kind', 'bank', 'opening_balance', 1, 'opening_date', current_date + 5)::text)) LIKE '%DATE_OUVERTURE_INVALIDE%');
-- Achats (sql/37)
INSERT INTO _t SELECT 's1', public.purchase_record('{"key":"p-s1","supplier_name":"Minoterie","date":"2026-10-05","lines":[{"nature":"goods","product_id":"A","track_stock":true,"description":"Farine","qty":10,"unit_price":50,"tva_rate":20}]}'::jsonb)->>'id';
INSERT INTO _t SELECT 's2', public.purchase_record('{"key":"p-s2","supplier_name":"Minoterie","date":"2026-10-10","due_date":"2026-11-15","lines":[{"nature":"goods","product_id":"A","track_stock":true,"description":"Farine","qty":10,"unit_price":62,"tva_rate":20}]}'::jsonb)->>'id';
INSERT INTO _t SELECT 's10', public.purchase_record('{"key":"p-s10","supplier_name":"Bailleur","date":"2026-11-01","lines":[{"nature":"expense","category":"Loyer","description":"Loyer novembre","qty":1,"unit_price":2000,"tva_rate":0}]}'::jsonb)->>'id';
INSERT INTO _t SELECT 's11', public.purchase_record('{"key":"p-s11","supplier_name":"Lydec","date":"2026-11-06","lines":[{"nature":"expense","category":"Électricité et eau","description":"Électricité","qty":1,"unit_price":300,"tva_rate":20}]}'::jsonb)->>'id';
INSERT INTO _t SELECT 's13', public.purchase_record('{"key":"p-s13","supplier_name":"Info","date":"2026-11-14","lines":[{"nature":"asset","description":"Ordinateur","qty":1,"unit_price":8000,"tva_rate":20}]}'::jsonb)->>'id';
-- Règlements
SELECT public.supplier_settle(jsonb_build_object('key', 'r-s1', 'purchase_id', (SELECT v FROM _t WHERE k = 's1'), 'account_id', (SELECT v FROM _t WHERE k = 'bank'), 'amount', 600, 'date', '2026-10-05'));
SELECT public.supplier_settle(jsonb_build_object('key', 'r-s10', 'purchase_id', (SELECT v FROM _t WHERE k = 's10'), 'account_id', (SELECT v FROM _t WHERE k = 'bank'), 'amount', 2000, 'date', '2026-11-01'));
SELECT pg_temp.ok('S11 : avant règlement, dette 360', (SELECT total_ttc - paid FROM public.purchase_list(NULL, NULL, NULL, 50, 0) WHERE id = (SELECT v FROM _t WHERE k = 's11')::uuid) = 360);
SELECT public.supplier_settle(jsonb_build_object('key', 'r-s11', 'purchase_id', (SELECT v FROM _t WHERE k = 's11'), 'account_id', (SELECT v FROM _t WHERE k = 'bank'), 'amount', 360, 'date', '2026-11-20'));
SELECT public.supplier_settle(jsonb_build_object('key', 'r-s13', 'purchase_id', (SELECT v FROM _t WHERE k = 's13'), 'account_id', (SELECT v FROM _t WHERE k = 'bank'), 'amount', 9600, 'date', '2026-11-14'));
SELECT pg_temp.ok('S14 : règlement partiel 700 puis 44 ; un dirham de plus refusé', (public.supplier_settle(jsonb_build_object('key', 'r-s2a', 'purchase_id', (SELECT v FROM _t WHERE k = 's2'), 'account_id', (SELECT v FROM _t WHERE k = 'bank'), 'amount', 700, 'date', '2026-11-15'))->>'remaining')::numeric = 44
  AND (public.supplier_settle(jsonb_build_object('key', 'r-s2b', 'purchase_id', (SELECT v FROM _t WHERE k = 's2'), 'account_id', (SELECT v FROM _t WHERE k = 'bank'), 'amount', 44, 'date', '2026-11-15'))->>'remaining')::numeric = 0);
SELECT pg_temp.ok('S14 : règlement au-delà de la dette refusé', pg_temp.err(format('SELECT public.supplier_settle(%L::jsonb)', jsonb_build_object('purchase_id', (SELECT v FROM _t WHERE k = 's2'), 'account_id', (SELECT v FROM _t WHERE k = 'bank'), 'amount', 1, 'date', '2026-11-15')::text)) LIKE '%REGLEMENT_SUPERIEUR_A_LA_DETTE%');
SELECT pg_temp.ok('rejeu d''un règlement (même clé) : aucun doublon', (public.supplier_settle(jsonb_build_object('key', 'r-s1', 'purchase_id', (SELECT v FROM _t WHERE k = 's1'), 'account_id', (SELECT v FROM _t WHERE k = 'bank'), 'amount', 600, 'date', '2026-10-05'))->>'duplicate')::boolean);
SELECT pg_temp.ok('règlement : aucune charge ni stock modifiés (stock A = 20, CMUP 56)', (SELECT qty = 20 AND cmup = 56 FROM public.stock_valuation() WHERE product_id = 'A'));
-- Apport et encaissements clients (lus dans user_data)
SELECT public.cash_movement_record(jsonb_build_object('key', 'm-apport', 'account_id', (SELECT v FROM _t WHERE k = 'bank'), 'kind', 'owner_in', 'amount', 5000, 'date', '2026-11-02', 'label', 'Apport'));
RESET ROLE;
ALTER TABLE public.user_data DISABLE TRIGGER USER;
INSERT INTO public.user_data (user_id, key, value) VALUES ('39393939-0000-4000-8000-000000000001', 'payments',
  jsonb_build_array(jsonb_build_object('id', 'pay1', 'invoiceId', 'f4', 'date', '2026-11-05', 'amount', 250, 'method', 'especes', 'accountId', (SELECT v FROM _t WHERE k = 'cash')),
                    jsonb_build_object('id', 'pay2', 'invoiceId', 'f9', 'date', '2026-11-06', 'amount', 100, 'method', 'virement'),
                    jsonb_build_object('id', 'pay0', 'invoiceId', 'f0', 'date', '2026-09-20', 'amount', 70, 'method', 'especes', 'accountId', (SELECT v FROM _t WHERE k = 'cash'))));
ALTER TABLE public.user_data ENABLE TRIGGER USER;
SET ROLE authenticated; SELECT pg_temp.as_user('39393939-0000-4000-8000-000000000001');
-- S17
SELECT pg_temp.ok('S17 : Banque au 30/11 = 10 000 − 600 − 2 000 − 360 − 9 600 − 744 + 5 000 = 1 696', (SELECT balance FROM public.cash_balances('2026-11-30') WHERE account_id = (SELECT v FROM _t WHERE k = 'bank')::uuid) = 1696);
SELECT pg_temp.ok('S17 : Caisse = 500 + 250 = 750 (paiement antérieur à l''ouverture non recompté)', (SELECT balance FROM public.cash_balances('2026-11-30') WHERE account_id = (SELECT v FROM _t WHERE k = 'cash')::uuid) = 750);
SELECT pg_temp.ok('S17 : encaissement sans compte affiché à part (100), hors soldes', (SELECT customer_in FROM public.cash_balances('2026-11-30') WHERE account_id IS NULL) = 100);
SELECT pg_temp.ok('solde à une date passée (31/10) : Banque 10 000 − 600 = 9 400', (SELECT balance FROM public.cash_balances('2026-10-31') WHERE account_id = (SELECT v FROM _t WHERE k = 'bank')::uuid) = 9400);
SELECT pg_temp.ok('aucune recopie : les encaissements clients ne sont pas dans cash_movements', (SELECT count(*) FROM public.cash_list(NULL, NULL, NULL, 500, 0) WHERE kind = 'customer_payment') = 3
  AND (SELECT count(*) FROM public.cash_list(NULL, NULL, NULL, 500, 0) WHERE id LIKE 'pay:%') = 3);
SELECT pg_temp.ok('dettes : S2 réglé (paid = 744)', (SELECT paid FROM public.purchase_list(NULL, NULL, NULL, 50, 0) WHERE id = (SELECT v FROM _t WHERE k = 's2')::uuid) = 744);
-- Annulations
SELECT pg_temp.ok('S15 : annuler un achat réglé est refusé', pg_temp.err(format('SELECT public.purchase_cancel(%L::uuid, %L)', (SELECT v FROM _t WHERE k = 's11'), 'x')) LIKE '%ACHAT_REGLE%');
SELECT pg_temp.ok('annulation du règlement S11 : 1 ligne inverse', (public.cash_movement_reverse((SELECT id::uuid FROM public.cash_list(NULL, NULL, NULL, 500, 0) WHERE kind = 'supplier_payment' AND amount = 360), 'erreur')->>'reversed')::int = 1);
SELECT pg_temp.ok('annulation : ligne inverse datée du jour, dette S11 revenue à 360', (SELECT total_ttc - paid FROM public.purchase_list(NULL, NULL, NULL, 50, 0) WHERE id = (SELECT v FROM _t WHERE k = 's11')::uuid) = 360
  AND (SELECT move_date FROM public.cash_list(NULL, NULL, NULL, 500, 0) WHERE kind = 'reversal' LIMIT 1) = current_date);
SELECT pg_temp.ok('2e annulation du même mouvement : sans effet ; annuler une annulation : refusé', (public.cash_movement_reverse((SELECT id::uuid FROM public.cash_list(NULL, NULL, NULL, 500, 0) WHERE kind = 'supplier_payment' AND amount = 360), 'x')->>'reversed')::int = 0
  AND pg_temp.err(format('SELECT public.cash_movement_reverse(%L::uuid, %L)', (SELECT id FROM public.cash_list(NULL, NULL, NULL, 500, 0) WHERE kind = 'reversal' LIMIT 1), 'x')) LIKE '%ANNULATION_D_ANNULATION_INTERDITE%');
SELECT pg_temp.ok('S15 : règlement annulé → l''achat peut être annulé', (public.purchase_cancel((SELECT v FROM _t WHERE k = 's11')::uuid, 'doublon')->>'already')::boolean = false);
SELECT pg_temp.ok('achat annulé : plus de règlement possible', pg_temp.err(format('SELECT public.supplier_settle(%L::jsonb)', jsonb_build_object('purchase_id', (SELECT v FROM _t WHERE k = 's11'), 'account_id', (SELECT v FROM _t WHERE k = 'bank'), 'amount', 1, 'date', '2026-11-20')::text)) LIKE '%ACHAT_ANNULE%');
-- Virement interne puis annulation (les deux jambes)
SELECT public.cash_movement_record(jsonb_build_object('key', 'm-vir', 'account_id', (SELECT v FROM _t WHERE k = 'bank'), 'to_account_id', (SELECT v FROM _t WHERE k = 'cash'), 'kind', 'transfer', 'amount', 1000, 'date', '2026-11-03'));
SELECT pg_temp.ok('virement : Banque −1 000, Caisse +1 000, total inchangé', (SELECT sum(balance) FROM public.cash_balances('2026-11-30') WHERE account_id IS NOT NULL) = 1696 + 360 + 750);
SELECT pg_temp.ok('annuler une jambe du virement annule les deux', (public.cash_movement_reverse((SELECT id::uuid FROM public.cash_list(NULL, NULL, NULL, 500, 0) WHERE kind = 'transfer_in'), 'erreur')->>'reversed')::int = 2);
SELECT pg_temp.ok('virement vers le même compte refusé', pg_temp.err(format('SELECT public.cash_movement_record(%L::jsonb)', jsonb_build_object('account_id', (SELECT v FROM _t WHERE k = 'bank'), 'to_account_id', (SELECT v FROM _t WHERE k = 'bank'), 'kind', 'transfer', 'amount', 1, 'date', '2026-11-03')::text)) LIKE '%COMPTE_DESTINATION_INVALIDE%');
SELECT pg_temp.ok('type de mouvement libre (supplier_payment direct) refusé', pg_temp.err(format('SELECT public.cash_movement_record(%L::jsonb)', jsonb_build_object('account_id', (SELECT v FROM _t WHERE k = 'bank'), 'kind', 'supplier_payment', 'amount', 1, 'date', '2026-11-03')::text)) LIKE '%TYPE_MOUVEMENT_INVALIDE%');
SELECT pg_temp.ok('montant négatif refusé', pg_temp.err(format('SELECT public.cash_movement_record(%L::jsonb)', jsonb_build_object('account_id', (SELECT v FROM _t WHERE k = 'bank'), 'kind', 'other_out', 'amount', -5, 'date', '2026-11-03')::text)) LIKE '%MONTANT_INVALIDE%');
-- Archivage
SELECT public.cash_account_create('{"key":"acc-o","name":"Ancien compte","kind":"other","opening_balance":0,"opening_date":"2026-10-01"}'::jsonb);
SELECT pg_temp.ok('compte archivé : plus de mouvement possible', (public.cash_account_archive((SELECT id FROM public.cash_accounts_list() WHERE name = 'Ancien compte'), true)->>'archived')::boolean
  AND pg_temp.err(format('SELECT public.cash_movement_record(%L::jsonb)', jsonb_build_object('account_id', (SELECT id FROM public.cash_accounts_list() WHERE name = 'Ancien compte'), 'kind', 'other_in', 'amount', 1, 'date', '2026-11-03')::text)) LIKE '%COMPTE_INTROUVABLE%');
-- Immuabilité
RESET ROLE;
SELECT pg_temp.ok('mouvements non modifiables (même par le propriétaire)', pg_temp.err($$UPDATE public.cash_movements SET amount = 1$$) LIKE '%non modifiable%');
SELECT pg_temp.ok('solde d''ouverture non modifiable (archivage seulement)', pg_temp.err($$UPDATE public.cash_accounts SET opening_balance = 0$$) LIKE '%non modifiable%');
-- Isolation
SET ROLE authenticated; SELECT pg_temp.as_user('39393939-0000-4000-8000-000000000001');
INSERT INTO _t SELECT 'mv', id FROM public.cash_list(NULL, NULL, NULL, 500, 0) WHERE kind = 'owner_in' LIMIT 1;
SELECT pg_temp.as_user('39393939-0000-4000-8000-000000000002');
SELECT pg_temp.ok('isolation : B ne voit ni comptes ni mouvements ni encaissements de A', (SELECT count(*) FROM public.cash_accounts_list()) = 0 AND (SELECT count(*) FROM public.cash_list(NULL, NULL, NULL, 500, 0)) = 0 AND (SELECT count(*) FROM public.cash_balances(NULL)) = 0);
SELECT pg_temp.ok('isolation : B ne peut pas écrire sur un compte de A', pg_temp.err(format('SELECT public.cash_movement_record(%L::jsonb)', jsonb_build_object('account_id', (SELECT v FROM _t WHERE k = 'bank'), 'kind', 'owner_in', 'amount', 1, 'date', '2026-11-03')::text)) LIKE '%COMPTE_INTROUVABLE%');
SELECT pg_temp.ok('isolation : B ne peut ni régler un achat de A ni annuler un mouvement de A', pg_temp.err(format('SELECT public.supplier_settle(%L::jsonb)', jsonb_build_object('purchase_id', (SELECT v FROM _t WHERE k = 's13'), 'account_id', (SELECT v FROM _t WHERE k = 'bank'), 'amount', 1, 'date', '2026-11-20')::text)) LIKE '%ACHAT_INTROUVABLE%'
  AND pg_temp.err(format('SELECT public.cash_movement_reverse(%L::uuid, %L)', (SELECT v FROM _t WHERE k = 'mv'), 'x')) <> '');
RESET ROLE;
SET ROLE anon;
SELECT pg_temp.ok('anon : refusé', pg_temp.err($$SELECT * FROM public.cash_balances(NULL)$$) <> '');
RESET ROLE;
DELETE FROM auth.users WHERE id = '39393939-0000-4000-8000-000000000001';
SELECT pg_temp.ok('suppression du compte : comptes et mouvements supprimés en cascade', NOT EXISTS (SELECT 1 FROM public.cash_accounts WHERE user_id = '39393939-0000-4000-8000-000000000001') AND NOT EXISTS (SELECT 1 FROM public.cash_movements WHERE user_id = '39393939-0000-4000-8000-000000000001'));
