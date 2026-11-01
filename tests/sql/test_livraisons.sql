-- sql/38 : BL serveur — droits, sortie de stock au CMUP, idempotence, immuabilité, lien facture contrôlé, annulation au coût d'origine, reprise, isolation.
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
  ('38383838-0000-4000-8000-000000000001', 'bl-a@test.invalid', now()),
  ('38383838-0000-4000-8000-000000000002', 'bl-b@test.invalid', now());
-- Factures du compte A dans user_data (l'une brouillon, l'autre émise) — déclencheurs de user_data neutralisés dans cette base de test seulement
ALTER TABLE public.user_data DISABLE TRIGGER USER;
INSERT INTO public.user_data (user_id, key, value) VALUES ('38383838-0000-4000-8000-000000000001', 'invoices',
  '[{"id":"inv-d","number":"BRO-1","status":"draft"},{"id":"inv-e","number":"FAC-2026-009","status":"sent"}]'::jsonb);
ALTER TABLE public.user_data ENABLE TRIGGER USER;

SELECT pg_temp.ok('tables fermées : deliveries, delivery_lines (RLS, aucune politique)',
  (SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('public.deliveries'::regclass, 'public.delivery_lines'::regclass)) AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename IN ('deliveries', 'delivery_lines')));
SELECT pg_temp.ok('fonctions : authenticated oui, anon non ; fin_invoice_status interne',
  has_function_privilege('authenticated', 'public.delivery_record(jsonb)', 'EXECUTE') AND has_function_privilege('authenticated', 'public.delivery_link_invoice(uuid[],text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.delivery_record(jsonb)', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'public.fin_invoice_status(uuid,text)', 'EXECUTE'));

SET ROLE authenticated; SELECT pg_temp.as_user('38383838-0000-4000-8000-000000000001');
SELECT public.stock_record('[{"product_id":"A","product_name":"Farine","type":"in","qty":20,"unit_cost":56,"date":"2026-10-01","source":"purchase","key":"init"}]'::jsonb);
CREATE TEMP TABLE IF NOT EXISTS _b(k text, v jsonb);
GRANT ALL ON _b TO PUBLIC;
INSERT INTO _b SELECT 'b1', public.delivery_record('{"key":"kb1","client_id":"c1","client_name":"Épicerie Nour","date":"2026-10-31","source_quote":"q1","source_quote_number":"DEV-1",
  "lines":[{"product_id":"A","product_name":"Farine","unit":"sac","track_stock":true,"description":"Farine 25kg","qty":4,"unit_price":100,"tva_rate":20},
           {"description":"Transport","qty":1,"unit_price":50,"tva_rate":20,"discount":10}]}'::jsonb);
SELECT pg_temp.ok('BL : numéro serveur BL-2026-001, totaux serveur (HT 445, TVA 89)', (SELECT v->>'number' = 'BL-2026-001' AND (v->>'total_ht')::numeric = 445 AND (v->>'total_tva')::numeric = 89 FROM _b WHERE k = 'b1'));
SELECT pg_temp.ok('BL : sortie de 4 au CMUP 56, clé bl:<id>:0, à la date du BL', (SELECT qty = 4 AND unit_cost = 56 AND move_date = '2026-10-31' FROM public.stock_list(NULL, NULL, 50, 0) WHERE idem_key = 'bl:' || (SELECT v->>'id' FROM _b WHERE k = 'b1') || ':0'));
SELECT pg_temp.ok('BL : la ligne non suivie ne touche pas le stock', (SELECT count(*) FROM public.stock_list(NULL, NULL, 50, 0) WHERE source = 'delivery') = 1);
SELECT pg_temp.ok('rejeu de la même clé : même BL, pas de 2e sortie', (public.delivery_record('{"key":"kb1","client_id":"c1","client_name":"X","date":"2026-10-31","lines":[{"description":"x","qty":1,"unit_price":1,"tva_rate":20}]}'::jsonb)->>'duplicate')::boolean
  AND (SELECT qty FROM public.stock_valuation() WHERE product_id = 'A') = 16);
INSERT INTO _b SELECT 'b2', public.delivery_record('{"key":"kb2","client_id":"c1","client_name":"Épicerie Nour","date":"2026-11-02","lines":[{"product_id":"A","track_stock":true,"description":"Farine","qty":2,"unit_price":100,"tva_rate":20}]}'::jsonb);
INSERT INTO _b SELECT 'b3', public.delivery_record('{"key":"kb3","client_id":"c2","client_name":"Café Atlas","date":"2026-11-02","lines":[{"product_id":"A","track_stock":true,"description":"Farine","qty":1,"unit_price":100,"tva_rate":20}]}'::jsonb);
-- Validations
SELECT pg_temp.ok('sans client refusé', pg_temp.err($$SELECT public.delivery_record('{"date":"2026-11-01","lines":[{"description":"x","qty":1,"unit_price":1,"tva_rate":20}]}'::jsonb)$$) LIKE '%CLIENT_INVALIDE%');
SELECT pg_temp.ok('quantité 0 refusée', pg_temp.err($$SELECT public.delivery_record('{"client_id":"c1","client_name":"X","date":"2026-11-01","lines":[{"description":"x","qty":0,"unit_price":1,"tva_rate":20}]}'::jsonb)$$) LIKE '%QUANTITE_INVALIDE%');
SELECT pg_temp.ok('remise > 100 % refusée', pg_temp.err($$SELECT public.delivery_record('{"client_id":"c1","client_name":"X","date":"2026-11-01","lines":[{"description":"x","qty":1,"unit_price":1,"tva_rate":20,"discount":150}]}'::jsonb)$$) LIKE '%REMISE_INVALIDE%');
-- Lien facture
SELECT pg_temp.ok('lier des BL de clients différents : refusé, rien n''est lié', pg_temp.err(format('SELECT public.delivery_link_invoice(ARRAY[%L,%L]::uuid[], %L)', (SELECT v->>'id' FROM _b WHERE k = 'b1'), (SELECT v->>'id' FROM _b WHERE k = 'b3'), 'inv-new')) LIKE '%BL_CLIENTS_DIFFERENTS%'
  AND (SELECT count(*) FROM public.delivery_list(NULL, NULL, NULL, 50, 0) WHERE invoice_id IS NOT NULL) = 0);
SELECT pg_temp.ok('lier à une facture déjà émise : refusé', pg_temp.err(format('SELECT public.delivery_link_invoice(ARRAY[%L]::uuid[], %L)', (SELECT v->>'id' FROM _b WHERE k = 'b1'), 'inv-e')) LIKE '%FACTURE_EMISE%');
SELECT pg_temp.ok('lier BL1 + BL2 (même client) à une nouvelle facture brouillon : 2 liés', (public.delivery_link_invoice(ARRAY[(SELECT (v->>'id')::uuid FROM _b WHERE k = 'b1'), (SELECT (v->>'id')::uuid FROM _b WHERE k = 'b2')], 'inv-new')->>'linked')::int = 2);
SELECT pg_temp.ok('BL déjà lié à une autre facture : refusé', pg_temp.err(format('SELECT public.delivery_link_invoice(ARRAY[%L]::uuid[], %L)', (SELECT v->>'id' FROM _b WHERE k = 'b1'), 'inv-autre')) LIKE '%BL_DEJA_FACTURE%');
SELECT pg_temp.ok('BL lié : annulation refusée', pg_temp.err(format('SELECT public.delivery_cancel(%L::uuid, %L)', (SELECT v->>'id' FROM _b WHERE k = 'b1'), 'x')) LIKE '%BL_FACTURE%');
SELECT pg_temp.ok('facture absente (brouillon supprimé) : retrait du lien accepté, 2 BL libérés', (public.delivery_unlink_invoice('inv-new')->>'unlinked')::int = 2);
SELECT pg_temp.ok('lier BL2 à la facture émise inv-e via ancien lien : refusé (facture émise)', pg_temp.err(format('SELECT public.delivery_link_invoice(ARRAY[%L]::uuid[], %L)', (SELECT v->>'id' FROM _b WHERE k = 'b2'), 'inv-e')) LIKE '%FACTURE_EMISE%');
RESET ROLE;
-- simule un lien vers la facture émise (créé quand elle était brouillon) : le retrait doit être refusé
ALTER TABLE public.deliveries DISABLE TRIGGER trg_delivery_guard;
UPDATE public.deliveries SET invoice_id = 'inv-e' WHERE number = 'BL-2026-002' AND user_id = '38383838-0000-4000-8000-000000000001';
ALTER TABLE public.deliveries ENABLE TRIGGER trg_delivery_guard;
SET ROLE authenticated; SELECT pg_temp.as_user('38383838-0000-4000-8000-000000000001');
SELECT pg_temp.ok('facture émise : retrait du lien refusé', pg_temp.err($$SELECT public.delivery_unlink_invoice('inv-e')$$) LIKE '%FACTURE_EMISE%');
SELECT pg_temp.ok('numéro officiel reporté (vérifié contre user_data)', (public.delivery_invoice_issued('inv-e', 'FAC-2026-009')->>'updated')::int = 1 AND pg_temp.err($$SELECT public.delivery_invoice_issued('inv-e', 'FAC-2026-999')$$) LIKE '%NUMERO_DIFFERENT%');
SELECT pg_temp.ok('lecture : BL-2026-002 porte le numéro de facture', (SELECT invoice_number FROM public.delivery_list(NULL, NULL, NULL, 50, 0) WHERE number = 'BL-2026-002') = 'FAC-2026-009');
-- Annulation d'un BL non facturé : stock remis au coût de la sortie d'origine
SELECT public.stock_record('[{"product_id":"A","product_name":"Farine","type":"in","qty":10,"unit_cost":80,"date":"2026-11-03","source":"purchase","key":"later"}]'::jsonb);
SELECT pg_temp.ok('annulation de BL1 (non facturé) : 1 ligne remise', (public.delivery_cancel((SELECT (v->>'id')::uuid FROM _b WHERE k = 'b1'), 'livraison refusée')->>'stock_lines')::int = 1);
SELECT pg_temp.ok('remise en stock au coût de la sortie du BL (56) et non au CMUP du moment', (SELECT unit_cost = 56 AND return_of = 'bl:' || (SELECT v->>'id' FROM _b WHERE k = 'b1') || ':0' FROM public.stock_list(NULL, NULL, 50, 0) WHERE idem_key LIKE 'bl-cancel:%'));
SELECT pg_temp.ok('BL annulé : statut et motif ; 2e annulation sans effet', (SELECT status = 'cancelled' AND cancel_reason = 'livraison refusée' FROM public.delivery_list(NULL, NULL, NULL, 50, 0) WHERE number = 'BL-2026-001')
  AND (public.delivery_cancel((SELECT (v->>'id')::uuid FROM _b WHERE k = 'b1'), 'x')->>'already')::boolean);
SELECT pg_temp.ok('BL annulé : ne peut plus être lié', pg_temp.err(format('SELECT public.delivery_link_invoice(ARRAY[%L]::uuid[], %L)', (SELECT v->>'id' FROM _b WHERE k = 'b1'), 'inv-x')) LIKE '%BL_ANNULE%');
-- Immuabilité
RESET ROLE;
SELECT pg_temp.ok('immuabilité : montant non modifiable, même par le propriétaire', pg_temp.err($$UPDATE public.deliveries SET total_ht = 1, total_ttc = 1 + total_tva WHERE number = 'BL-2026-003'$$) LIKE '%non modifiable%');
SELECT pg_temp.ok('immuabilité : lignes non modifiables', pg_temp.err($$UPDATE public.delivery_lines SET qty = 99$$) LIKE '%non modifiable%');
-- Reprise
SET ROLE authenticated; SELECT pg_temp.as_user('38383838-0000-4000-8000-000000000001');
SELECT public.stock_record('[{"product_id":"A","product_name":"Farine","type":"out","qty":3,"date":"2026-09-10","source":"delivery","key":"bl:oldbl:0"}]'::jsonb);
SELECT pg_temp.ok('reprise des BL JSON : 1 repris, numéro conservé, puis rien au 2e appel', (public.fin_import_legacy_deliveries('[{"id":"oldbl","number":"BL-2026-050","date":"2026-09-10","clientId":"c1","clientName":"Épicerie Nour","items":[{"productId":"A","description":"Farine","quantity":3,"price":100,"tva":20}]}]'::jsonb)->>'imported')::int = 1
  AND (public.fin_import_legacy_deliveries('[{"id":"oldbl","number":"BL-2026-050","date":"2026-09-10","clientId":"c1","clientName":"x","items":[{"description":"x","quantity":1,"price":1,"tva":20}]}]'::jsonb)->>'imported')::int = 0);
SELECT pg_temp.ok('BL repris annulé : sa sortie d''origine (clé de l''ancienne version) est remise', (public.delivery_cancel((SELECT id FROM public.delivery_list(NULL, NULL, NULL, 50, 0) WHERE number = 'BL-2026-050'), 'test')->>'stock_lines')::int = 1);
SELECT pg_temp.ok('compteur après reprise : le prochain BL est BL-2026-051', (public.delivery_record('{"key":"kb9","client_id":"c1","client_name":"X","date":"2026-11-05","lines":[{"description":"x","qty":1,"unit_price":1,"tva_rate":20}]}'::jsonb)->>'number') = 'BL-2026-051');
-- Isolation
SELECT pg_temp.as_user('38383838-0000-4000-8000-000000000002');
SELECT pg_temp.ok('isolation : B ne voit aucun BL de A', (SELECT count(*) FROM public.delivery_list(NULL, NULL, NULL, 50, 0)) = 0);
SELECT pg_temp.ok('isolation : B ne peut ni annuler ni lier un BL de A', pg_temp.err(format('SELECT public.delivery_cancel(%L::uuid, %L)', (SELECT v->>'id' FROM _b WHERE k = 'b3'), 'x')) LIKE '%BL_INTROUVABLE%'
  AND pg_temp.err(format('SELECT public.delivery_link_invoice(ARRAY[%L]::uuid[], %L)', (SELECT v->>'id' FROM _b WHERE k = 'b3'), 'z')) LIKE '%BL_INTROUVABLE%');
SELECT pg_temp.ok('isolation : B ne peut pas retirer les liens de A (0 ligne)', (public.delivery_unlink_invoice('inv-e')->>'unlinked')::int = 0);
RESET ROLE;
SELECT pg_temp.ok('isolation : le lien de A vers inv-e est intact', (SELECT invoice_id FROM public.deliveries WHERE number = 'BL-2026-002' AND user_id = '38383838-0000-4000-8000-000000000001') = 'inv-e');
SELECT pg_temp.ok('invariant stock : état = somme des mouvements', NOT EXISTS (SELECT 1 FROM public.stock_cost_state s WHERE s.qty <> (SELECT COALESCE(sum(CASE WHEN m.move_type = 'in' THEN m.qty ELSE -m.qty END), 0) FROM public.stock_movements m WHERE m.user_id = s.user_id AND m.product_id = s.product_id)));
