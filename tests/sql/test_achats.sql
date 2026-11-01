-- sql/37 : achats serveur — droits, natures, totaux serveur, stock au coût, idempotence, immuabilité, annulation, reprise, isolation, licence.
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
  ('37373737-0000-4000-8000-000000000001', 'ach-a@test.invalid', now()),
  ('37373737-0000-4000-8000-000000000002', 'ach-b@test.invalid', now()),
  ('37373737-0000-4000-8000-000000000003', 'ach-nc@test.invalid', NULL);

-- Droits
SELECT pg_temp.ok('tables fermées : RLS active, aucune politique (purchases, purchase_lines, fin_counters, fin_audit)',
  (SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('public.purchases'::regclass, 'public.purchase_lines'::regclass, 'public.fin_counters'::regclass, 'public.fin_audit'::regclass))
  AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename IN ('purchases', 'purchase_lines', 'fin_counters', 'fin_audit')));
SELECT pg_temp.ok('fonctions publiques : authenticated oui, anon non',
  has_function_privilege('authenticated', 'public.purchase_record(jsonb)', 'EXECUTE') AND has_function_privilege('authenticated', 'public.purchase_cancel(uuid,text)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.purchase_list(date,date,text,int,int)', 'EXECUTE') AND has_function_privilege('authenticated', 'public.fin_import_legacy_purchases(jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.purchase_record(jsonb)', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.purchase_list(date,date,text,int,int)', 'EXECUTE'));
SELECT pg_temp.ok('fonctions internes non exécutables par authenticated (fin_uid, fin_next_number, fin_assert_open, fin_purchase_paid)',
  NOT has_function_privilege('authenticated', 'public.fin_uid()', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'public.fin_next_number(uuid,text,date)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.fin_assert_open(uuid,date)', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'public.fin_purchase_paid(uuid,uuid)', 'EXECUTE'));

SET ROLE authenticated; SELECT pg_temp.as_user('37373737-0000-4000-8000-000000000001');
-- S1 : marchandise suivie + frais (charge) ; totaux du client ignorés
CREATE TEMP TABLE IF NOT EXISTS _r(k text, v jsonb);
GRANT ALL ON _r TO PUBLIC;
INSERT INTO _r SELECT 's1', public.purchase_record('{"key":"k-s1","supplier_id":"s1","supplier_name":"Minoterie","supplier_ref":"FA-118","date":"2026-10-05","total_ttc":1,
  "lines":[{"nature":"goods","product_id":"A","product_name":"Farine","unit":"sac","track_stock":true,"description":"Farine 25kg","qty":10,"unit_price":50,"tva_rate":20},
           {"nature":"expense","category":"Transport","description":"Frais de port","qty":1,"unit_price":100,"tva_rate":10}]}'::jsonb);
SELECT pg_temp.ok('S1 : numéro serveur ACH-2026-001', (SELECT v->>'number' FROM _r WHERE k = 's1') = 'ACH-2026-001');
SELECT pg_temp.ok('S1 : totaux recalculés par le serveur (HT 600, TVA 110, TTC 710), total du client ignoré', (SELECT (v->>'total_ht')::numeric = 600 AND (v->>'total_tva')::numeric = 110 AND (v->>'total_ttc')::numeric = 710 FROM _r WHERE k = 's1'));
SELECT pg_temp.ok('S1 : stock de A +10 au coût 50 (CMUP 50) ; les frais n''entrent pas en stock', (SELECT qty = 10 AND cmup = 50 FROM public.stock_valuation() WHERE product_id = 'A') AND (SELECT count(*) FROM public.stock_valuation()) = 1);
SELECT pg_temp.ok('S1 : mouvement de stock rattaché à l''achat (clé pur:<id>:0, réf. ACH)', (SELECT count(*) FROM public.stock_list(NULL, NULL, 50, 0) WHERE idem_key = 'pur:' || (SELECT v->>'id' FROM _r WHERE k = 's1') || ':0' AND ref = 'ACH-2026-001') = 1);
SELECT pg_temp.ok('S1 : lignes lues avec leur nature et catégorie', (SELECT jsonb_array_length(lines) = 2 AND lines->0->>'nature' = 'goods' AND lines->1->>'category' = 'Transport' FROM public.purchase_list(NULL, NULL, NULL, 50, 0) WHERE number = 'ACH-2026-001'));
-- Idempotence
SELECT pg_temp.ok('rejeu de la même clé : même achat renvoyé (duplicate), rien de créé',
  (public.purchase_record('{"key":"k-s1","supplier_name":"Autre","date":"2026-10-06","lines":[{"nature":"asset","description":"x","qty":1,"unit_price":1,"tva_rate":20}]}'::jsonb)->>'duplicate')::boolean
  AND (SELECT count(*) FROM public.purchase_list(NULL, NULL, NULL, 50, 0)) = 1 AND (SELECT qty FROM public.stock_valuation() WHERE product_id = 'A') = 10);
-- S12 : TVA non déductible → coût de la marchandise TTC
INSERT INTO _r SELECT 's12', public.purchase_record('{"key":"k-s12","supplier_name":"Station","date":"2026-11-12","vat_deductible":false,
  "lines":[{"nature":"goods","product_id":"B","product_name":"Huile","track_stock":true,"description":"Huile","qty":2,"unit_price":50,"tva_rate":20}]}'::jsonb);
SELECT pg_temp.ok('TVA non déductible : coût d''entrée = 60 (TVA incluse)', (SELECT cmup FROM public.stock_valuation() WHERE product_id = 'B') = 60);
SELECT pg_temp.ok('numérotation séquentielle : ACH-2026-002', (SELECT v->>'number' FROM _r WHERE k = 's12') = 'ACH-2026-002');
-- S13 : investissement ; marchandise non suivie
INSERT INTO _r SELECT 's13', public.purchase_record('{"key":"k-s13","supplier_name":"Info","date":"2026-11-14","lines":[{"nature":"asset","description":"Ordinateur","qty":1,"unit_price":8000,"tva_rate":20},
  {"nature":"goods","product_id":"Z","product_name":"Emballages","track_stock":false,"description":"Emballages","qty":100,"unit_price":1,"tva_rate":20}]}'::jsonb);
SELECT pg_temp.ok('investissement et marchandise non suivie : aucun mouvement de stock', (SELECT count(*) FROM public.stock_valuation() WHERE product_id IN ('Z')) = 0);
SELECT pg_temp.ok('date à plus de 31 jours dans le futur refusée (faute de frappe)', pg_temp.err(format('SELECT public.purchase_record(%L::jsonb)', jsonb_build_object('supplier_name', 'X', 'date', current_date + 60, 'lines', '[{"nature":"asset","description":"x","qty":1,"unit_price":1,"tva_rate":20}]'::jsonb)::text)) LIKE '%DATE_INVALIDE%');
SELECT pg_temp.ok('compteur par année : un achat daté de 2025 reçoit ACH-2025-001', (public.purchase_record('{"key":"k-y","supplier_name":"X","date":"2025-12-30","lines":[{"nature":"expense","category":"Autre","description":"x","qty":1,"unit_price":1,"tva_rate":0}]}'::jsonb)->>'number') = 'ACH-2025-001');
-- Validations (tout ou rien)
SELECT pg_temp.ok('marchandise sans produit refusée', pg_temp.err($$SELECT public.purchase_record('{"supplier_name":"X","date":"2026-11-01","lines":[{"nature":"goods","description":"x","qty":1,"unit_price":1,"tva_rate":20}]}'::jsonb)$$) LIKE '%MARCHANDISE_SANS_PRODUIT%');
SELECT pg_temp.ok('charge sans catégorie refusée', pg_temp.err($$SELECT public.purchase_record('{"supplier_name":"X","date":"2026-11-01","lines":[{"nature":"expense","description":"x","qty":1,"unit_price":1,"tva_rate":20}]}'::jsonb)$$) LIKE '%CATEGORIE_OBLIGATOIRE%');
SELECT pg_temp.ok('taux de TVA inconnu (13 %) refusé', pg_temp.err($$SELECT public.purchase_record('{"supplier_name":"X","date":"2026-11-01","lines":[{"nature":"asset","description":"x","qty":1,"unit_price":1,"tva_rate":13}]}'::jsonb)$$) LIKE '%TAUX_TVA_INVALIDE%');
SELECT pg_temp.ok('quantité 0 refusée', pg_temp.err($$SELECT public.purchase_record('{"supplier_name":"X","date":"2026-11-01","lines":[{"nature":"asset","description":"x","qty":0,"unit_price":1,"tva_rate":20}]}'::jsonb)$$) LIKE '%QUANTITE_INVALIDE%');
SELECT pg_temp.ok('nature inconnue refusée', pg_temp.err($$SELECT public.purchase_record('{"supplier_name":"X","date":"2026-11-01","lines":[{"nature":"salaire","description":"x","qty":1,"unit_price":1,"tva_rate":20}]}'::jsonb)$$) LIKE '%NATURE_INVALIDE%');
SELECT pg_temp.ok('sans fournisseur refusé', pg_temp.err($$SELECT public.purchase_record('{"date":"2026-11-01","lines":[{"nature":"asset","description":"x","qty":1,"unit_price":1,"tva_rate":20}]}'::jsonb)$$) LIKE '%FOURNISSEUR_INVALIDE%');
SELECT pg_temp.ok('échéance avant la date refusée', pg_temp.err($$SELECT public.purchase_record('{"supplier_name":"X","date":"2026-11-01","due_date":"2026-10-01","lines":[{"nature":"asset","description":"x","qty":1,"unit_price":1,"tva_rate":20}]}'::jsonb)$$) LIKE '%ECHEANCE_INVALIDE%');
SELECT pg_temp.ok('ligne invalide : rien n''est écrit, aucun numéro consommé', pg_temp.err($$SELECT public.purchase_record('{"supplier_name":"X","date":"2026-11-01","lines":[{"nature":"asset","description":"ok","qty":1,"unit_price":1,"tva_rate":20},{"nature":"asset","description":"x","qty":-1,"unit_price":1,"tva_rate":20}]}'::jsonb)$$) <> ''
  AND (public.purchase_record('{"key":"k-n","supplier_name":"X","date":"2026-11-20","lines":[{"nature":"expense","category":"Autre","description":"x","qty":1,"unit_price":1,"tva_rate":0}]}'::jsonb)->>'number') = 'ACH-2026-004');
-- Immuabilité (accès direct)
SELECT pg_temp.ok('accès direct aux tables : modification et suppression sans effet', pg_temp.err($$UPDATE public.purchases SET total_ttc = 1$$) <> '' OR NOT EXISTS (SELECT 1 FROM public.purchase_list(NULL, NULL, NULL, 50, 0) WHERE total_ttc = 1));
SELECT pg_temp.ok('accès direct : suppression sans effet', pg_temp.err($$DELETE FROM public.purchases$$) <> '' OR (SELECT count(*) FROM public.purchase_list(NULL, NULL, NULL, 50, 0)) = 5);
RESET ROLE;
SELECT pg_temp.ok('immuabilité : même le propriétaire de la table ne peut pas modifier un montant', pg_temp.err($$UPDATE public.purchases SET total_ht = 1, total_ttc = 1 + total_tva WHERE number = 'ACH-2026-001'$$) LIKE '%non modifiable%');
SELECT pg_temp.ok('immuabilité : lignes non modifiables', pg_temp.err($$UPDATE public.purchase_lines SET qty = 99$$) LIKE '%non modifiable%');
-- Annulation
SET ROLE authenticated; SELECT pg_temp.as_user('37373737-0000-4000-8000-000000000001');
SELECT public.stock_record('[{"product_id":"A","product_name":"Farine","type":"in","qty":10,"unit_cost":70,"date":"2026-10-20","source":"purchase","key":"other:1"}]'::jsonb);
SELECT pg_temp.ok('avant annulation : A = 20 au CMUP 60', (SELECT qty = 20 AND cmup = 60 FROM public.stock_valuation() WHERE product_id = 'A'));
SELECT pg_temp.ok('annulation de S1 : 1 ligne de stock sortie', (public.purchase_cancel((SELECT (v->>'id')::uuid FROM _r WHERE k = 's1'), 'erreur de saisie')->>'stock_lines')::int = 1);
SELECT pg_temp.ok('annulation de S1 : statut annulé, motif conservé', (SELECT status = 'cancelled' AND cancel_reason = 'erreur de saisie' FROM public.purchase_list(NULL, NULL, NULL, 50, 0) WHERE number = 'ACH-2026-001'));
SELECT pg_temp.ok('annulation : sortie AU COÛT DE L''ACHAT (50) ; il reste 10 au coût 70', (SELECT unit_cost FROM public.stock_list(NULL, NULL, 50, 0) WHERE idem_key LIKE 'pur-cancel:%') = 50 AND (SELECT qty = 10 AND cmup = 70 FROM public.stock_valuation() WHERE product_id = 'A'));
SELECT pg_temp.ok('2e annulation : sans effet (already), aucun mouvement en plus', (public.purchase_cancel((SELECT (v->>'id')::uuid FROM _r WHERE k = 's1'), 'x')->>'already')::boolean AND (SELECT count(*) FROM public.stock_list(NULL, NULL, 50, 0) WHERE idem_key LIKE 'pur-cancel:%') = 1);
SELECT pg_temp.ok('lecture filtrée : 4 achats actifs, 1 annulé', (SELECT count(*) FROM public.purchase_list(NULL, NULL, 'active', 50, 0)) = 4 AND (SELECT count(*) FROM public.purchase_list(NULL, NULL, 'cancelled', 50, 0)) = 1);
SELECT pg_temp.ok('lecture par période (novembre 2026) : 3 achats', (SELECT count(*) FROM public.purchase_list('2026-11-01', '2026-11-30', NULL, 50, 0)) = 3);
-- Reprise des achats JSON
SELECT pg_temp.ok('reprise : 2 achats repris, le 2e appel ne reprend rien', (public.fin_import_legacy_purchases('[{"id":"old1","number":"ACH-2026-010","date":"2026-09-01","supplierName":"Ancien","includeVat":true,"lines":[{"productId":"A","description":"Farine","qty":2,"price":40,"tva":20}]},{"id":"old2","number":"ACH-2026-001","date":"2026-09-02","supplierName":"Ancien","lines":[{"description":"Loyer","qty":1,"price":2000,"tva":0}]}]'::jsonb)->>'imported')::int = 2
  AND (public.fin_import_legacy_purchases('[{"id":"old1","number":"ACH-2026-010","date":"2026-09-01","supplierName":"Ancien","lines":[{"productId":"A","description":"Farine","qty":2,"price":40,"tva":20}]}]'::jsonb)->>'imported')::int = 0);
SELECT pg_temp.ok('reprise : numéro d''origine conservé (ACH-2026-010) ; numéro déjà pris remplacé', EXISTS (SELECT 1 FROM public.purchase_list(NULL, NULL, NULL, 50, 0) WHERE number = 'ACH-2026-010')
  AND (SELECT count(*) FROM public.purchase_list(NULL, NULL, NULL, 50, 0) WHERE supplier_name = 'Ancien' AND number <> 'ACH-2026-010' AND number <> 'ACH-2026-001') = 1);
SELECT pg_temp.ok('reprise : aucun mouvement de stock recréé (A toujours 10)', (SELECT qty FROM public.stock_valuation() WHERE product_id = 'A') = 10);
SELECT pg_temp.ok('reprise : ligne sans produit → charge « Autre »', (SELECT lines->0->>'nature' = 'expense' AND lines->0->>'category' = 'Autre' FROM public.purchase_list(NULL, NULL, NULL, 50, 0) WHERE supplier_name = 'Ancien' AND total_ht = 2000));
SELECT pg_temp.ok('reprise : le compteur ne redonnera jamais 010 (prochain = 011 ou plus)', (public.purchase_record('{"key":"k-after","supplier_name":"X","date":"2026-11-21","lines":[{"nature":"expense","category":"Autre","description":"x","qty":1,"unit_price":1,"tva_rate":0}]}'::jsonb)->>'number') >= 'ACH-2026-011');
-- Isolation
SELECT pg_temp.as_user('37373737-0000-4000-8000-000000000002');
SELECT pg_temp.ok('isolation : B ne voit aucun achat de A', (SELECT count(*) FROM public.purchase_list(NULL, NULL, NULL, 50, 0)) = 0);
SELECT pg_temp.ok('isolation : B ne peut pas annuler un achat de A', pg_temp.err(format('SELECT public.purchase_cancel(%L::uuid, %L)', (SELECT v->>'id' FROM _r WHERE k = 's12'), 'x')) LIKE '%ACHAT_INTROUVABLE%');
SELECT pg_temp.ok('isolation : B a son propre compteur (ACH-2026-001) et la même clé k-s1 est indépendante', (public.purchase_record('{"key":"k-s1","supplier_name":"B","date":"2026-11-01","lines":[{"nature":"expense","category":"Autre","description":"x","qty":1,"unit_price":1,"tva_rate":0}]}'::jsonb)->>'number') = 'ACH-2026-001');
SELECT pg_temp.as_user('37373737-0000-4000-8000-000000000003');
SELECT pg_temp.ok('e-mail non confirmé : refusé', pg_temp.err($$SELECT * FROM public.purchase_list(NULL, NULL, NULL, 50, 0)$$) LIKE '%NON_AUTHENTIFIE%');
RESET ROLE;
SET ROLE anon;
SELECT pg_temp.ok('anon : refusé', pg_temp.err($$SELECT public.purchase_record('{}'::jsonb)$$) <> '');
RESET ROLE;
-- Licence expirée
INSERT INTO auth.users(id, email, email_confirmed_at) VALUES ('37373737-0000-4000-8000-000000000004', 'ach-exp@test.invalid', now());
INSERT INTO public.licenses(user_id, status, expires_at) VALUES ('37373737-0000-4000-8000-000000000004', 'active', now() - interval '1 day');
SET ROLE authenticated; SELECT pg_temp.as_user('37373737-0000-4000-8000-000000000004');
SELECT pg_temp.ok('licence expirée : écriture refusée, lecture possible', pg_temp.err($$SELECT public.purchase_record('{"supplier_name":"X","date":"2026-11-01","lines":[{"nature":"asset","description":"x","qty":1,"unit_price":1,"tva_rate":20}]}'::jsonb)$$) LIKE '%LICENCE_INACTIVE%'
  AND (SELECT count(*) FROM public.purchase_list(NULL, NULL, NULL, 50, 0)) = 0);
RESET ROLE;
-- Journal et suppression du compte
SELECT pg_temp.ok('journal : création, annulation et reprise tracées', (SELECT count(DISTINCT action) FROM public.fin_audit WHERE user_id = '37373737-0000-4000-8000-000000000001') = 3);
DELETE FROM auth.users WHERE id = '37373737-0000-4000-8000-000000000002';
SELECT pg_temp.ok('suppression du compte : ses achats et lignes disparaissent (cascade)', NOT EXISTS (SELECT 1 FROM public.purchases WHERE user_id = '37373737-0000-4000-8000-000000000002') AND NOT EXISTS (SELECT 1 FROM public.purchase_lines WHERE user_id = '37373737-0000-4000-8000-000000000002'));
