-- sql/41 : indicateurs de gestion — CA net d'avoirs par date d'émission, encaissements par date de paiement, CMV au coût figé
-- (retours déduits, marchandises non suivies ajoutées, achats suivis NON recomptés), charges, investissements hors résultat,
-- créances, dettes, stock, trésorerie, flux, complétude, série mensuelle, isolation. Scénario S18 calculé à la main.
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
  ('41414141-0000-4000-8000-000000000001', 'ind-a@test.invalid', now()),
  ('41414141-0000-4000-8000-000000000002', 'ind-b@test.invalid', now());
CREATE TEMP TABLE IF NOT EXISTS _i(k text, v text);
GRANT ALL ON _i TO PUBLIC;

SELECT pg_temp.ok('fonctions : authenticated oui, anon non ; fonctions internes non exposées',
  has_function_privilege('authenticated', 'public.fin_summary(date,date)', 'EXECUTE') AND has_function_privilege('authenticated', 'public.fin_monthly(date,date)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.fin_summary(date,date)', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'public.fin_figures(uuid,date,date)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.fin_sales_docs(uuid)', 'EXECUTE'));

SET ROLE authenticated; SELECT pg_temp.as_user('41414141-0000-4000-8000-000000000001');
INSERT INTO _i SELECT 'bank', public.cash_account_create('{"name":"Banque","kind":"bank","opening_balance":10000,"opening_date":"2026-10-01"}'::jsonb)->>'id';
INSERT INTO _i SELECT 'p1', public.purchase_record('{"key":"i-p1","supplier_name":"Minoterie","date":"2026-10-05","lines":[{"nature":"goods","product_id":"A","product_name":"Farine","track_stock":true,"description":"Farine","qty":10,"unit_price":50,"tva_rate":20}]}'::jsonb)->>'id';
INSERT INTO _i SELECT 'p2', public.purchase_record('{"key":"i-p2","supplier_name":"Minoterie","date":"2026-10-10","lines":[{"nature":"goods","product_id":"A","product_name":"Farine","track_stock":true,"description":"Farine","qty":10,"unit_price":62,"tva_rate":20}]}'::jsonb)->>'id';
INSERT INTO _i SELECT 'p3', public.purchase_record('{"key":"i-p3","supplier_name":"Bailleur","date":"2026-11-01","lines":[{"nature":"expense","category":"Loyer","description":"Loyer","qty":1,"unit_price":2000,"tva_rate":0}]}'::jsonb)->>'id';
INSERT INTO _i SELECT 'p4', public.purchase_record('{"key":"i-p4","supplier_name":"Lydec","date":"2026-11-06","vat_deductible":false,"lines":[{"nature":"expense","category":"Électricité et eau","description":"Électricité","qty":1,"unit_price":300,"tva_rate":20}]}'::jsonb)->>'id';
INSERT INTO _i SELECT 'p5', public.purchase_record('{"key":"i-p5","supplier_name":"Info","date":"2026-11-14","lines":[{"nature":"asset","description":"Ordinateur","qty":1,"unit_price":8000,"tva_rate":20}]}'::jsonb)->>'id';
INSERT INTO _i SELECT 'p6', public.purchase_record('{"key":"i-p6","supplier_name":"Grossiste","date":"2026-11-08","lines":[{"nature":"goods","product_id":"B","product_name":"Sucre","track_stock":false,"description":"Sucre","qty":2,"unit_price":100,"tva_rate":20}]}'::jsonb)->>'id';
INSERT INTO _i SELECT 'p7', public.purchase_record('{"key":"i-p7","supplier_name":"Erreur","date":"2026-11-09","lines":[{"nature":"expense","category":"Loyer","description":"Saisie en double","qty":1,"unit_price":999,"tva_rate":0}]}'::jsonb)->>'id';
SELECT public.purchase_cancel((SELECT v FROM _i WHERE k = 'p7')::uuid, 'doublon');
-- Ventes : sorties de stock (facture F1, BL B1), retour sur avoir C1
SELECT public.stock_record('[{"product_id":"A","product_name":"Farine","type":"out","qty":5,"date":"2026-11-03","source":"invoice","key":"inv:F1:0","ref":"FAC-1"}]'::jsonb);
INSERT INTO _i SELECT 'b1', public.delivery_record('{"key":"i-b1","client_id":"c1","client_name":"Client","date":"2026-11-04","lines":[{"product_id":"A","product_name":"Farine","track_stock":true,"description":"Farine","qty":3,"unit_price":100,"tva_rate":20}]}'::jsonb)->>'id';
SELECT public.stock_record('[{"product_id":"A","product_name":"Farine","type":"in","qty":1,"date":"2026-11-10","source":"credit","key":"cr:C1:0","return_of":"inv:F1:0"}]'::jsonb);
-- Trésorerie
SELECT public.supplier_settle(jsonb_build_object('key', 'i-r1', 'purchase_id', (SELECT v FROM _i WHERE k = 'p1'), 'account_id', (SELECT v FROM _i WHERE k = 'bank'), 'amount', 600, 'date', '2026-10-05'));
INSERT INTO _i SELECT 'r2a', public.supplier_settle(jsonb_build_object('key', 'i-r2a', 'purchase_id', (SELECT v FROM _i WHERE k = 'p2'), 'account_id', (SELECT v FROM _i WHERE k = 'bank'), 'amount', 100, 'date', '2026-10-20'))->>'id';
SELECT public.cash_movement_reverse((SELECT v FROM _i WHERE k = 'r2a')::uuid, 'erreur de montant');
SELECT public.supplier_settle(jsonb_build_object('key', 'i-r2b', 'purchase_id', (SELECT v FROM _i WHERE k = 'p2'), 'account_id', (SELECT v FROM _i WHERE k = 'bank'), 'amount', 700, 'date', '2026-11-15'));
SELECT public.supplier_settle(jsonb_build_object('key', 'i-r3', 'purchase_id', (SELECT v FROM _i WHERE k = 'p3'), 'account_id', (SELECT v FROM _i WHERE k = 'bank'), 'amount', 2000, 'date', '2026-11-01'));
SELECT public.supplier_settle(jsonb_build_object('key', 'i-r4', 'purchase_id', (SELECT v FROM _i WHERE k = 'p4'), 'account_id', (SELECT v FROM _i WHERE k = 'bank'), 'amount', 360, 'date', '2026-11-20'));
SELECT public.cash_movement_record(jsonb_build_object('key', 'i-m1', 'account_id', (SELECT v FROM _i WHERE k = 'bank'), 'kind', 'owner_in', 'amount', 5000, 'date', '2026-11-02'));
SELECT public.cash_movement_record(jsonb_build_object('key', 'i-m2', 'account_id', (SELECT v FROM _i WHERE k = 'bank'), 'kind', 'tax_payment', 'amount', 150, 'date', '2026-11-25', 'label', 'TVA octobre'));
RESET ROLE;
ALTER TABLE public.user_data DISABLE TRIGGER USER;
INSERT INTO public.user_data (user_id, key, value) VALUES
 ('41414141-0000-4000-8000-000000000001', 'invoices', jsonb_build_array(
    '{"id":"F1","type":"invoice","number":"FAC-1","status":"partial","date":"2026-11-03","totalHT":1000,"totalTTC":1200}'::jsonb,
    '{"id":"F2","type":"invoice","number":"FAC-2","status":"sent","date":"2026-11-05","totalHT":400,"totalTTC":480}'::jsonb,
    '{"id":"C1","type":"credit","number":"AV-1","status":"sent","date":"2026-11-10","totalHT":-300,"totalTTC":-360,"relatedInvoiceId":"F1"}'::jsonb,
    '{"id":"D1","type":"invoice","number":"BRO-1","status":"draft","date":"2026-11-20","totalHT":999,"totalTTC":999}'::jsonb,
    '{"id":"X","number":"FAC-0","status":"sent","date":"2026-10-28","totalHT":500,"totalTTC":600}'::jsonb,
    '{"id":"Y","type":"invoice","number":"FAC-3","status":"cancelled","date":"2026-11-12","totalHT":700,"totalTTC":840}'::jsonb,
    '{"id":"Q","type":"quote","number":"DEV-1","status":"sent","date":"2026-11-12","totalHT":5000,"totalTTC":6000}'::jsonb)),
 ('41414141-0000-4000-8000-000000000001', 'payments', jsonb_build_array(
    jsonb_build_object('id', 'pa', 'invoiceId', 'F1', 'date', '2026-11-15', 'amount', 600, 'accountId', (SELECT v FROM _i WHERE k = 'bank')),
    '{"id":"pb","invoiceId":"X","date":"2026-11-02","amount":"500"}'::jsonb));
ALTER TABLE public.user_data ENABLE TRIGGER USER;
SET ROLE authenticated; SELECT pg_temp.as_user('41414141-0000-4000-8000-000000000001');
INSERT INTO _i SELECT 'nov', public.fin_summary('2026-11-01', '2026-11-30')::text;
SELECT pg_temp.ok('S18 CA HT novembre = 1 000 + 400 − 300 = 1 100 (brouillon, facture annulée sans avoir, devis et octobre exclus)', (SELECT (v::jsonb->>'sales_ht')::numeric = 1100 AND (v::jsonb->>'invoices_ht')::numeric = 1400 AND (v::jsonb->>'credits_ht')::numeric = 300 FROM _i WHERE k = 'nov'), (SELECT v FROM _i WHERE k = 'nov'));
SELECT pg_temp.ok('S18 encaissements novembre (date de paiement) = 600 + 500 = 1 100', (SELECT (v::jsonb->>'collections')::numeric = 1100 FROM _i WHERE k = 'nov'));
SELECT pg_temp.ok('S18 CMV = sorties 5×56 + 3×56 (448) − retour 1×56 + sucre non suivi 200 = 592 ; achats de farine suivie NON recomptés',
  (SELECT (v::jsonb->>'cogs')::numeric = 592 AND (v::jsonb->>'cogs_stock_exits')::numeric = 448 AND (v::jsonb->>'cogs_returns')::numeric = 56 AND (v::jsonb->>'cogs_untracked_goods')::numeric = 200 FROM _i WHERE k = 'nov'));
SELECT pg_temp.ok('S18 marge brute = 1 100 − 592 = 508 (46,2 %)', (SELECT (v::jsonb->>'gross_margin')::numeric = 508 AND (v::jsonb->>'gross_margin_rate')::numeric = 46.2 FROM _i WHERE k = 'nov'));
SELECT pg_temp.ok('S18 charges = loyer 2 000 + électricité 360 (TVA non déductible incluse) ; achat annulé exclu', (SELECT (v::jsonb->>'charges')::numeric = 2360 FROM _i WHERE k = 'nov'));
SELECT pg_temp.ok('S18 investissement 8 000 affiché à part, hors résultat', (SELECT (v::jsonb->>'investments')::numeric = 8000 FROM _i WHERE k = 'nov'));
SELECT pg_temp.ok('S18 résultat de gestion = 508 − 2 360 = −1 852 ; règlements, apport et impôt payé n''y entrent pas', (SELECT (v::jsonb->>'result')::numeric = -1852 FROM _i WHERE k = 'nov'));
SELECT pg_temp.ok('S18 créances au 30/11 = F1 (1 200 − 600 − 360) + F2 480 + X (600 − 500) = 820', (SELECT (v::jsonb->>'receivables')::numeric = 820 FROM _i WHERE k = 'nov'));
SELECT pg_temp.ok('S18 stock au 30/11 = (20 − 5 − 3 + 1) × 56 = 728', (SELECT (v::jsonb->>'stock_value')::numeric = 728 FROM _i WHERE k = 'nov'));
SELECT pg_temp.ok('flux novembre : apport net 5 000, impôt payé 150 (trésorerie, pas charges)', (SELECT (v::jsonb#>>'{cash_flows,owner_net}')::numeric = 5000 AND (v::jsonb#>>'{cash_flows,tax_payments}')::numeric = 150 FROM _i WHERE k = 'nov'));
SELECT pg_temp.ok('complétude : 1 brouillon, achats saisis, comptes présents, 500 encaissés sans compte', (SELECT (v::jsonb#>>'{completeness,draft_invoices}')::int = 1 AND (v::jsonb#>>'{completeness,purchases_recorded}')::int = 4
  AND (v::jsonb#>>'{completeness,has_cash_accounts}')::boolean AND (v::jsonb#>>'{completeness,payments_without_account}')::numeric = 500 FROM _i WHERE k = 'nov'));
SELECT pg_temp.ok('mention : pas un résultat fiscal', (SELECT v::jsonb->>'notice' LIKE '%pas un résultat fiscal%' FROM _i WHERE k = 'nov'));
-- À une date incluant l'annulation du règlement (datée du jour)
INSERT INTO _i SELECT 'end', public.fin_summary('2026-11-01', GREATEST(current_date, DATE '2026-11-30'))::text;
SELECT pg_temp.ok('dettes fournisseurs = farine 744 − 700 (règlement de 100 annulé) + ordinateur 9 600 + sucre 240 = 9 884', (SELECT (v::jsonb->>'payables')::numeric = 9884 FROM _i WHERE k = 'end'), (SELECT v::jsonb->>'payables' FROM _i WHERE k = 'end'));
SELECT pg_temp.ok('trésorerie = 10 000 − 600 − 100 + 100 − 700 − 2 000 − 360 + 5 000 − 150 + 600 (encaissement F1) = 11 790', (SELECT (v::jsonb->>'treasury')::numeric = 11790 FROM _i WHERE k = 'end'), (SELECT v::jsonb->>'treasury' FROM _i WHERE k = 'end'));
SELECT pg_temp.ok('octobre : CA 500, aucun coût des ventes (les achats de farine sont en stock), résultat 500',
  (SELECT (f->>'sales_ht')::numeric = 500 AND (f->>'cogs')::numeric = 0 AND (f->>'charges')::numeric = 0 AND (f->>'result')::numeric = 500 FROM (SELECT public.fin_summary('2026-10-01', '2026-10-31') f) x));
SELECT pg_temp.ok('série mensuelle oct.–nov. : cohérente avec la synthèse', (SELECT string_agg(month || ':' || sales_ht::text || '/' || result::text, ' ' ORDER BY month) FROM public.fin_monthly('2026-10-01', '2026-11-30')) = '2026-10:500.00/500.00 2026-11:1100.00/-1852.00',
  (SELECT string_agg(month || ':' || sales_ht::text || '/' || result::text, ' ' ORDER BY month) FROM public.fin_monthly('2026-10-01', '2026-11-30')));
SELECT pg_temp.ok('somme des mois = période entière (oct.–nov.)', (SELECT sum(result) FROM public.fin_monthly('2026-10-01', '2026-11-30')) = (public.fin_summary('2026-10-01', '2026-11-30')->>'result')::numeric);
SELECT pg_temp.ok('période invalide ou trop longue : refusée', pg_temp.err($$SELECT public.fin_summary('2026-11-30', '2026-11-01')$$) LIKE '%PERIODE_INVALIDE%'
  AND pg_temp.err($$SELECT * FROM public.fin_monthly('2024-01-01', '2026-11-30')$$) LIKE '%PERIODE_TROP_LONGUE%');
-- Isolation
SELECT pg_temp.as_user('41414141-0000-4000-8000-000000000002');
SELECT pg_temp.ok('isolation : B ne voit rien des chiffres de A', (SELECT (f->>'sales_ht')::numeric = 0 AND (f->>'cogs')::numeric = 0 AND (f->>'receivables')::numeric = 0 AND (f->>'payables')::numeric = 0 AND (f->>'treasury')::numeric = 0 AND (f->>'stock_value')::numeric = 0
  FROM (SELECT public.fin_summary('2026-01-01', '2026-12-31') f) x));
SELECT pg_temp.as_user('');
SELECT pg_temp.ok('non connecté : refusé', pg_temp.err($$SELECT public.fin_summary('2026-11-01', '2026-11-30')$$) LIKE '%NON_AUTHENTIFIE%');
RESET ROLE;
