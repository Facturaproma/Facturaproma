-- sql/44 : avoir fournisseur — plafonds par ligne et par achat, retour de marchandise au coût d'achat, dette, règlements, charges,
-- annulation d'achat bloquée, idempotence, clôture, isolation.
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
  ('44444444-0000-4000-8000-000000000001', 'avf-a@test.invalid', now()),
  ('44444444-0000-4000-8000-000000000002', 'avf-b@test.invalid', now());
CREATE TEMP TABLE IF NOT EXISTS _f(k text, v text);
GRANT ALL ON _f TO PUBLIC;

SELECT pg_temp.ok('tables fermées : purchase_credits, purchase_credit_lines', (SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('public.purchase_credits'::regclass, 'public.purchase_credit_lines'::regclass))
  AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename IN ('purchase_credits', 'purchase_credit_lines')) AND NOT has_table_privilege('authenticated', 'public.purchase_credits', 'SELECT'));
SELECT pg_temp.ok('fonctions : enregistrement et lecture pour authenticated, rien pour anon, calculs internes non exposés',
  has_function_privilege('authenticated', 'public.purchase_credit_record(jsonb)', 'EXECUTE') AND has_function_privilege('authenticated', 'public.purchase_credit_list(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.purchase_credit_record(jsonb)', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'public.fin_purchase_credited(uuid,uuid,date)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.fin_purchase_credit_figures(uuid,date,date)', 'EXECUTE'));

SET ROLE authenticated; SELECT pg_temp.as_user('44444444-0000-4000-8000-000000000001');
INSERT INTO _f SELECT 'bank', public.cash_account_create('{"key":"f-acc","name":"Banque","kind":"bank","opening_balance":10000,"opening_date":"2026-10-01"}'::jsonb)->>'id';
-- Achat : 10 sacs suivis (50 HT) + loyer (2000 HT, charge) + ordinateur (5000 HT, investissement) ; TVA 20 %
INSERT INTO _f SELECT 'p', public.purchase_record('{"key":"f-p1","supplier_name":"Grossiste","date":"2026-10-05","lines":[
  {"nature":"goods","product_id":"A","track_stock":true,"description":"Farine","qty":10,"unit_price":50,"tva_rate":20},
  {"nature":"expense","category":"Loyer","description":"Loyer octobre","qty":1,"unit_price":2000,"tva_rate":20},
  {"nature":"asset","description":"Ordinateur","qty":1,"unit_price":5000,"tva_rate":20}]}'::jsonb)->>'id';
RESET ROLE;
SELECT pg_temp.ok('achat : 9 000 TTC, stock 10', (SELECT total_ttc FROM public.purchases WHERE id = (SELECT v FROM _f WHERE k = 'p')::uuid) = 9000
  AND (SELECT qty FROM public.stock_cost_state WHERE product_id = 'A' AND user_id = '44444444-0000-4000-8000-000000000001') = 10);
SELECT pg_temp.ok('sans avoir : charges 2000, investissements 5000', (SELECT (f->>'charges')::numeric = 2000 AND (f->>'investments')::numeric = 5000 FROM (SELECT public.fin_figures('44444444-0000-4000-8000-000000000001', '2026-10-01', '2026-10-31') f) x));
SET ROLE authenticated; SELECT pg_temp.as_user('44444444-0000-4000-8000-000000000001');
CREATE OR REPLACE FUNCTION pg_temp.cr(lines text, d text DEFAULT '2026-10-20', k text DEFAULT NULL, reason text DEFAULT 'Retour fournisseur') RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.err(format('SELECT public.purchase_credit_record(%L::jsonb)', jsonb_build_object('key', k, 'purchase_id', (SELECT v FROM _f WHERE k = 'p'), 'date', d, 'reason', reason, 'lines', lines::jsonb)::text)) $$;
GRANT EXECUTE ON FUNCTION pg_temp.cr(text, text, text, text) TO PUBLIC;
SELECT pg_temp.ok('quantité > achetée refusée', pg_temp.cr('[{"line_no":0,"qty":11,"unit_price":50}]') LIKE '%QUANTITE_INVALIDE%');
SELECT pg_temp.ok('prix > prix d''achat refusé', pg_temp.cr('[{"line_no":1,"qty":1,"unit_price":2500}]') LIKE '%PRIX_INVALIDE%');
SELECT pg_temp.ok('remise sur marchandise suivie refusée (V1)', pg_temp.cr('[{"line_no":0,"qty":2,"unit_price":40}]') LIKE '%REMISE_STOCK_NON_GEREE%');
SELECT pg_temp.ok('motif obligatoire', pg_temp.cr('[{"line_no":1,"qty":1,"unit_price":100}]', '2026-10-20', NULL, '') LIKE '%MOTIF_OBLIGATOIRE%');
SELECT pg_temp.ok('date avant l''achat refusée', pg_temp.cr('[{"line_no":1,"qty":1,"unit_price":100}]', '2026-10-01') LIKE '%DATE_INVALIDE%');
SELECT pg_temp.ok('ligne inconnue refusée', pg_temp.cr('[{"line_no":7,"qty":1,"unit_price":1}]') LIKE '%LIGNE_INTROUVABLE%');
SELECT pg_temp.ok('aucune pièce créée par les refus', (SELECT count(*) FROM public.purchase_credit_list(NULL)) = 0);
-- Avoir 1 : retour de 3 sacs + remise de 500 HT sur le loyer
SELECT public.purchase_credit_record(jsonb_build_object('key', 'f-c1', 'purchase_id', (SELECT v FROM _f WHERE k = 'p'), 'date', '2026-10-20', 'supplier_ref', 'AV-778', 'reason', 'Sacs abîmés et remise loyer',
  'lines', '[{"line_no":0,"qty":3,"unit_price":50},{"line_no":1,"qty":1,"unit_price":500}]'::jsonb)) AS c1 \gset
SELECT pg_temp.ok('avoir 1 : 650 HT, 780 TTC, numéro AVF-ACH-…-1, 1 sortie de stock', (:'c1'::jsonb->>'total_ht')::numeric = 650 AND (:'c1'::jsonb->>'total_ttc')::numeric = 780
  AND (:'c1'::jsonb->>'number') LIKE 'AVF-ACH-2026-%-1' AND (:'c1'::jsonb->>'stock_lines')::int = 1, :'c1');
SELECT pg_temp.ok('rejeu de la même clé : même avoir, sans doublon', (public.purchase_credit_record(jsonb_build_object('key', 'f-c1', 'purchase_id', (SELECT v FROM _f WHERE k = 'p'), 'date', '2026-10-20', 'reason', 'xxx', 'lines', '[{"line_no":2,"qty":1,"unit_price":1}]'::jsonb))->>'duplicate')::boolean
  AND (SELECT count(*) FROM public.purchase_credit_list(NULL)) = 1);
RESET ROLE;
SELECT pg_temp.ok('stock : 10 → 7, sortie au coût d''achat (50), CMUP inchangé', (SELECT qty = 7 AND cmup = 50 FROM public.stock_cost_state WHERE product_id = 'A' AND user_id = '44444444-0000-4000-8000-000000000001'));
SET ROLE authenticated; SELECT pg_temp.as_user('44444444-0000-4000-8000-000000000001');
SELECT pg_temp.ok('loyer : cumul limité au HT de la ligne (500 + 1600 > 2000 refusé)', pg_temp.cr('[{"line_no":1,"qty":1,"unit_price":1600}]') LIKE '%AVOIR_SUPERIEUR_A_LA_LIGNE%');
SELECT pg_temp.ok('retours cumulés limités à la quantité achetée (3 + 8 > 10 refusé)', pg_temp.cr('[{"line_no":0,"qty":8,"unit_price":50}]') LIKE '%RETOUR_SUPERIEUR_A_L_ACHAT%');
SELECT pg_temp.ok('lecture : lignes, quantités retournées, désignations', (SELECT jsonb_array_length(lines) = 2 AND (lines->0->>'returned_qty')::numeric = 3 AND lines->1->>'description' = 'Loyer octobre' AND supplier_ref = 'AV-778' FROM public.purchase_credit_list((SELECT v FROM _f WHERE k = 'p')::uuid)));
RESET ROLE;
SELECT pg_temp.ok('Pilotage : charges 2000 − 500 = 1500, investissements 5000', (SELECT (f->>'charges')::numeric = 1500 AND (f->>'investments')::numeric = 5000 FROM (SELECT public.fin_figures('44444444-0000-4000-8000-000000000001', '2026-10-01', '2026-10-31') f) x),
  (SELECT public.fin_figures('44444444-0000-4000-8000-000000000001', '2026-10-01', '2026-10-31'))::text);
SET ROLE authenticated; SELECT pg_temp.as_user('44444444-0000-4000-8000-000000000001');
SELECT pg_temp.ok('dette : 9000 − 780 = 8220 ; avant la date de l''avoir : 9000', (public.fin_summary('2026-10-01', '2026-10-31')->>'payables')::numeric = 8220 AND (public.fin_summary('2026-10-01', '2026-10-10')->>'payables')::numeric = 9000);
SELECT pg_temp.ok('règlement au-delà de la dette diminuée (8300 > 8220) refusé', pg_temp.err(format('SELECT public.supplier_settle(%L::jsonb)', jsonb_build_object('purchase_id', (SELECT v FROM _f WHERE k = 'p'), 'account_id', (SELECT v FROM _f WHERE k = 'bank'), 'date', '2026-10-25', 'amount', 8300)::text)) LIKE '%REGLEMENT_SUPERIEUR_A_LA_DETTE%');
SELECT public.supplier_settle(jsonb_build_object('purchase_id', (SELECT v FROM _f WHERE k = 'p'), 'account_id', (SELECT v FROM _f WHERE k = 'bank'), 'date', '2026-10-25', 'amount', 8220)) AS st \gset
SELECT pg_temp.ok('règlement du reste (8220) accepté, dette 0', (:'st'::jsonb->>'remaining')::numeric = 0 AND (public.fin_summary('2026-10-01', '2026-10-31')->>'payables')::numeric = 0, :'st');
-- Avoir 2 après règlement complet : accepté, signale le trop-payé (remboursement à obtenir du fournisseur)
SELECT public.purchase_credit_record(jsonb_build_object('purchase_id', (SELECT v FROM _f WHERE k = 'p'), 'date', '2026-10-28', 'reason', 'Remise ordinateur', 'lines', '[{"line_no":2,"qty":1,"unit_price":1000}]'::jsonb)) AS c2 \gset
SELECT pg_temp.ok('avoir 2 (investissement, 1200 TTC) : numéro -2, trop-payé signalé 1200, dette jamais négative', (:'c2'::jsonb->>'number') LIKE 'AVF-%-2' AND (:'c2'::jsonb->>'overpaid')::numeric = 1200
  AND (public.fin_summary('2026-10-01', '2026-10-31')->>'payables')::numeric = 0, :'c2');
SELECT pg_temp.ok('annulation d''un achat avec avoir refusée', pg_temp.err(format('SELECT public.purchase_cancel(%L::uuid, %L)', (SELECT v FROM _f WHERE k = 'p'), 'test')) LIKE '%ACHAT_%');
SELECT pg_temp.ok('avoir non modifiable, même en direct (aucun droit)', pg_temp.err($$UPDATE public.purchase_credits SET reason = 'x'$$) <> '');
-- Clôture d'octobre : un avoir daté d'octobre est refusé
RESET ROLE;
UPDATE auth.users SET email_confirmed_at = now() WHERE id = '44444444-0000-4000-8000-000000000001';
SET ROLE authenticated; SELECT pg_temp.as_user('44444444-0000-4000-8000-000000000001');
SELECT public.period_close('2026-10', 'Relevé pointé') IS NOT NULL AS closed \gset
SELECT pg_temp.ok('période clôturée : avoir daté dedans refusé', pg_temp.cr('[{"line_no":2,"qty":1,"unit_price":10}]', '2026-10-30') LIKE '%PERIODE_CLOTUREE%');
-- Isolation
SELECT pg_temp.as_user('44444444-0000-4000-8000-000000000002');
SELECT pg_temp.ok('B : ne voit pas les avoirs de A et ne peut pas en créer sur son achat', (SELECT count(*) FROM public.purchase_credit_list(NULL)) = 0
  AND pg_temp.cr('[{"line_no":2,"qty":1,"unit_price":10}]', '2026-11-01') LIKE '%ACHAT_INTROUVABLE%');
RESET ROLE;
