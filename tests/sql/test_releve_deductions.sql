-- sql/47 : relevé des déductions — mode de paiement des règlements fournisseurs, lecture par période, annulations, isolation.
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
  ('47474747-0000-4000-8000-000000000001', 'rd-a@test.invalid', now()),
  ('47474747-0000-4000-8000-000000000002', 'rd-b@test.invalid', now());
CREATE TEMP TABLE IF NOT EXISTS _r(k text, v text);
GRANT ALL ON _r TO PUBLIC;

SELECT pg_temp.ok('table payment_modes fermée', (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.payment_modes'::regclass)
  AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'payment_modes'));
-- (test_securite.sql accorde plus tôt GRANT ALL ON ALL TABLES à authenticated : le vrai verrou est RLS sans politique, vérifié ci-dessus et ci-dessous)
SELECT pg_temp.ok('fonctions : authenticated oui, anon non, contrôle interne non exposé',
  has_function_privilege('authenticated', 'public.payment_mode_set(uuid,text)', 'EXECUTE') AND has_function_privilege('authenticated', 'public.vat_deduction_payments(date,date)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.payment_mode_set(uuid,text)', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.vat_deduction_payments(date,date)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.supplier_settle(jsonb)', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'public.fin_pay_mode(text)', 'EXECUTE'));
SELECT pg_temp.ok('garde des mouvements de trésorerie toujours en place', EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_cash_guard' AND tgrelid = 'public.cash_movements'::regclass AND NOT tgisinternal));

SET ROLE authenticated; SELECT pg_temp.as_user('47474747-0000-4000-8000-000000000001');
INSERT INTO _r SELECT 'bank', public.cash_account_create('{"key":"r-acc","name":"Banque","kind":"bank","opening_balance":50000,"opening_date":"2026-09-01"}'::jsonb)->>'id';
INSERT INTO _r SELECT 'p', public.purchase_record('{"key":"r-p1","supplier_name":"Bricolage","date":"2026-09-10","lines":[
  {"nature":"expense","category":"Fournitures","description":"Outillage","qty":1,"unit_price":1000,"tva_rate":20}]}'::jsonb)->>'id';
SELECT pg_temp.ok('mode inconnu refusé, aucun règlement créé',
  pg_temp.err(format('SELECT public.supplier_settle(%L::jsonb)', jsonb_build_object('key', 'r-bad', 'purchase_id', (SELECT v FROM _r WHERE k = 'p'), 'account_id', (SELECT v FROM _r WHERE k = 'bank'), 'amount', 100, 'date', '2026-09-15', 'mode', 'bitcoin')::text)) LIKE '%MODE_PAIEMENT_INVALIDE%'
  AND (SELECT count(*) FROM public.vat_deduction_payments(NULL, NULL)) = 0);
-- Règlement 1 : 600 en septembre, par virement ; règlement 2 : 600 en octobre, sans mode (ancien écran)
INSERT INTO _r SELECT 's1', public.supplier_settle(jsonb_build_object('key', 'r-s1', 'purchase_id', (SELECT v FROM _r WHERE k = 'p'), 'account_id', (SELECT v FROM _r WHERE k = 'bank'), 'amount', 600, 'date', '2026-09-15', 'mode', 'virement'))->>'id';
INSERT INTO _r SELECT 's2', public.supplier_settle(jsonb_build_object('key', 'r-s2', 'purchase_id', (SELECT v FROM _r WHERE k = 'p'), 'account_id', (SELECT v FROM _r WHERE k = 'bank'), 'amount', 600, 'date', '2026-10-03'))->>'id';
SELECT pg_temp.ok('rejeu de la même clé : même règlement, mode inchangé', (public.supplier_settle(jsonb_build_object('key', 'r-s1', 'purchase_id', (SELECT v FROM _r WHERE k = 'p'), 'account_id', (SELECT v FROM _r WHERE k = 'bank'), 'amount', 600, 'date', '2026-09-15', 'mode', 'cheque'))->>'duplicate')::boolean
  AND (SELECT mode FROM public.vat_deduction_payments(NULL, NULL) WHERE movement_id = (SELECT v FROM _r WHERE k = 's1')::uuid) = 'virement');
SELECT pg_temp.ok('septembre : 1 règlement, 600, virement', (SELECT count(*) = 1 AND sum(amount) = 600 AND min(mode) = 'virement' FROM public.vat_deduction_payments('2026-09-01', '2026-09-30')));
SELECT pg_temp.ok('octobre : 1 règlement, 600, mode à compléter', (SELECT count(*) = 1 AND sum(amount) = 600 AND bool_and(mode IS NULL) FROM public.vat_deduction_payments('2026-10-01', '2026-10-31')));
SELECT public.payment_mode_set((SELECT v FROM _r WHERE k = 's2')::uuid, 'cheque')->>'mode' AS m2 \gset
SELECT pg_temp.ok('compléter le mode : chèque', :'m2' = 'cheque' AND (SELECT mode FROM public.vat_deduction_payments('2026-10-01', '2026-10-31')) = 'cheque');
SELECT pg_temp.ok('mode vide ou inconnu refusé à la correction', pg_temp.err(format('SELECT public.payment_mode_set(%L, %L)', (SELECT v FROM _r WHERE k = 's2'), '')) LIKE '%MODE_PAIEMENT_INVALIDE%'
  AND pg_temp.err(format('SELECT public.payment_mode_set(%L, %L)', (SELECT v FROM _r WHERE k = 's2'), 'carte')) LIKE '%MODE_PAIEMENT_INVALIDE%');
-- Annulation du règlement d'octobre : ligne négative à la date du jour, avec le mode d'origine
SELECT public.cash_movement_reverse((SELECT v FROM _r WHERE k = 's2')::uuid, 'Erreur de saisie') \gset
SELECT pg_temp.ok('annulation : ligne négative datée du jour, mode d''origine, lien vers le règlement',
  (SELECT count(*) = 1 AND sum(amount) = -600 AND min(mode) = 'cheque' AND bool_and(reversal) AND min(original_id::text) = (SELECT v FROM _r WHERE k = 's2') FROM public.vat_deduction_payments(current_date, current_date) WHERE reversal));
SELECT pg_temp.ok('toutes périodes : net = 600 (600 + 600 − 600)', (SELECT sum(amount) FROM public.vat_deduction_payments(NULL, NULL)) = 600);
SELECT pg_temp.ok('une annulation n''accepte pas de mode', pg_temp.err(format('SELECT public.payment_mode_set(%L, %L)', (SELECT movement_id FROM public.vat_deduction_payments(NULL, NULL) WHERE reversal), 'cheque')) LIKE '%REGLEMENT_INTROUVABLE%');
SELECT pg_temp.err(format('UPDATE public.cash_movements SET amount = 1 WHERE id = %L', (SELECT v FROM _r WHERE k = 's1'))) AS u1 \gset
SELECT pg_temp.err(format('INSERT INTO public.payment_modes (movement_id, user_id, mode) VALUES (%L, %L, %L) ON CONFLICT (movement_id) DO UPDATE SET mode = %L', (SELECT v FROM _r WHERE k = 's1'), '47474747-0000-4000-8000-000000000001', 'especes', 'especes')) AS u2 \gset
RESET ROLE;
SELECT pg_temp.ok('écriture directe sans effet : montant et mode inchangés', (SELECT amount FROM public.cash_movements WHERE id = (SELECT v FROM _r WHERE k = 's1')::uuid) = 600
  AND (SELECT mode FROM public.payment_modes WHERE movement_id = (SELECT v FROM _r WHERE k = 's1')::uuid) = 'virement', :'u1' || ' / ' || :'u2');
RESET ROLE;
SELECT pg_temp.ok('trace : correction de mode dans fin_audit', EXISTS (SELECT 1 FROM public.fin_audit WHERE user_id = '47474747-0000-4000-8000-000000000001' AND action = 'mode_paiement' AND detail->>'apres' = 'cheque' AND detail->>'avant' IS NULL));
SELECT pg_temp.ok('montants inchangés par le mode : payé 600', public.fin_purchase_paid('47474747-0000-4000-8000-000000000001', (SELECT v FROM _r WHERE k = 'p')::uuid) = 600);

-- Isolation : B ne voit ni ne modifie rien de A
SET ROLE authenticated; SELECT pg_temp.as_user('47474747-0000-4000-8000-000000000002');
SELECT pg_temp.ok('isolation : B ne voit aucun règlement de A', (SELECT count(*) FROM public.vat_deduction_payments(NULL, NULL)) = 0);
SELECT pg_temp.ok('isolation : B ne peut pas changer le mode d''un règlement de A', pg_temp.err(format('SELECT public.payment_mode_set(%L, %L)', (SELECT v FROM _r WHERE k = 's1'), 'especes')) LIKE '%REGLEMENT_INTROUVABLE%');
RESET ROLE;
SELECT pg_temp.ok('mode de A intact', (SELECT mode FROM public.payment_modes WHERE movement_id = (SELECT v FROM _r WHERE k = 's1')::uuid) = 'virement');
SELECT pg_temp.as_user('');
