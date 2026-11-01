-- sql/36 : CMUP figé sur chaque mouvement, valeur du stock, retours au coût d'origine, annulation d'achat, concurrence (sérialisation), droits.
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
  ('36363636-0000-4000-8000-000000000001', 'cout-a@test.invalid', now()),
  ('36363636-0000-4000-8000-000000000002', 'cout-b@test.invalid', now());

-- Droits
SELECT pg_temp.ok('stock_cost_state : RLS active et aucune politique (table fermée)',
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.stock_cost_state'::regclass) AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'stock_cost_state'));
SELECT pg_temp.ok('stock_valuation : authenticated oui, anon non', has_function_privilege('authenticated', 'public.stock_valuation(date)', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.stock_valuation(date)', 'EXECUTE'));
SELECT pg_temp.ok('stock_list : toujours exécutable par authenticated (signature conservée)', has_function_privilege('authenticated', 'public.stock_list(date,date,int,int)', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.stock_list(date,date,int,int)', 'EXECUTE'));

SET ROLE authenticated; SELECT pg_temp.as_user('36363636-0000-4000-8000-000000000001');
-- S1 : achat 10 A à 50
SELECT public.stock_record('[{"product_id":"A","product_name":"Farine","unit":"sac","type":"in","qty":10,"unit_cost":50,"date":"2026-10-05","source":"purchase","key":"pur:p1:0"}]'::jsonb);
SELECT pg_temp.ok('S1 : CMUP 50, valeur 500', (SELECT cmup = 50 AND value = 500 AND qty = 10 FROM public.stock_valuation() WHERE product_id = 'A'));
-- S2 : achat 10 A à 62
SELECT public.stock_record('[{"product_id":"A","product_name":"Farine","unit":"sac","type":"in","qty":10,"unit_cost":62,"date":"2026-10-10","source":"purchase","key":"pur:p2:0"}]'::jsonb);
SELECT pg_temp.ok('S2 : CMUP (500 + 620) / 20 = 56', (SELECT cmup = 56 AND value = 1120 FROM public.stock_valuation() WHERE product_id = 'A'));
-- S3 : BL 4 A ; S4 : facture 5 A
SELECT public.stock_record('[{"product_id":"A","product_name":"Farine","type":"out","qty":4,"date":"2026-10-31","source":"delivery","key":"bl:b1:0"}]'::jsonb);
SELECT public.stock_record('[{"product_id":"A","product_name":"Farine","type":"out","qty":5,"date":"2026-11-03","source":"invoice","key":"inv:f4:0"}]'::jsonb);
SELECT pg_temp.ok('S3/S4 : les sorties prennent le CMUP 56 et le stockent', (SELECT bool_and(unit_cost = 56 AND cost_known AND cmup_after = 56) FROM public.stock_list(NULL, NULL, 50, 0) WHERE move_type = 'out'));
-- S6/S7 : facture 3 A (sortie), retour de 3 au coût d'origine
SELECT public.stock_record('[{"product_id":"A","product_name":"Farine","type":"out","qty":3,"date":"2026-11-07","source":"invoice","key":"inv:f6:0"},{"product_id":"A","product_name":"Farine","type":"out","qty":3,"date":"2026-11-08","source":"invoice","key":"inv:f7:0"}]'::jsonb);
SELECT public.stock_record('[{"product_id":"A","product_name":"Farine","type":"in","qty":3,"date":"2026-11-08","source":"credit","key":"cr:a7:0","return_of":"inv:f7:0"}]'::jsonb);
SELECT pg_temp.ok('S7 : retour au coût de la sortie d''origine (56), CMUP inchangé à 56', (SELECT unit_cost = 56 AND cost_known AND cmup_after = 56 FROM public.stock_list(NULL, NULL, 50, 0) WHERE idem_key = 'cr:a7:0'));
SELECT pg_temp.ok('S7 : un 2e retour de 1 sur la même sortie (déjà entièrement retournée) est refusé',
  pg_temp.err($$SELECT public.stock_record('[{"product_id":"A","product_name":"Farine","type":"in","qty":1,"date":"2026-11-09","source":"credit","key":"cr:a7b:0","return_of":"inv:f7:0"}]'::jsonb)$$) LIKE '%RETOUR_SUPERIEUR_A_LA_SORTIE%');
SELECT pg_temp.ok('retour : produit différent de la sortie refusé',
  pg_temp.err($$SELECT public.stock_record('[{"product_id":"B","product_name":"Huile","type":"in","qty":1,"date":"2026-11-09","source":"credit","key":"cr:x:0","return_of":"inv:f6:0"}]'::jsonb)$$) LIKE '%RETOUR_PRODUIT_DIFFERENT%');
SELECT pg_temp.ok('retour : return_of sur une sortie refusé', pg_temp.err($$SELECT public.stock_record('[{"product_id":"A","product_name":"Farine","type":"out","qty":1,"date":"2026-11-09","source":"invoice","key":"x:1","return_of":"inv:f6:0"}]'::jsonb)$$) LIKE '%RETOUR_INVALIDE%');
SELECT pg_temp.ok('stock après S1-S7 : 8 à 56 (valeur 448)', (SELECT qty = 8 AND cmup = 56 AND value = 448 FROM public.stock_valuation() WHERE product_id = 'A'));
-- S8 : achat 8 A à 70, puis vente 2
SELECT public.stock_record('[{"product_id":"A","product_name":"Farine","type":"in","qty":8,"unit_cost":70,"date":"2026-11-10","source":"purchase","key":"pur:p8:0"}]'::jsonb);
SELECT pg_temp.ok('S8 : CMUP (448 + 560) / 16 = 63', (SELECT cmup = 63 FROM public.stock_valuation() WHERE product_id = 'A'));
SELECT public.stock_record('[{"product_id":"A","product_name":"Farine","type":"out","qty":2,"date":"2026-11-10","source":"invoice","key":"inv:f8:0"}]'::jsonb);
SELECT pg_temp.ok('S8 : nouvelle sortie à 63 ; la sortie S4 garde 56', (SELECT unit_cost FROM public.stock_list(NULL, NULL, 50, 0) WHERE idem_key = 'inv:f8:0') = 63 AND (SELECT unit_cost FROM public.stock_list(NULL, NULL, 50, 0) WHERE idem_key = 'inv:f4:0') = 56);
-- S9 : entrée manuelle sans coût
SELECT public.stock_record('[{"product_id":"A","product_name":"Farine","type":"in","qty":5,"date":"2026-11-11","source":"manual","key":"man:9"}]'::jsonb);
SELECT pg_temp.ok('S9 : entrée sans prix valorisée au CMUP (63), signalée, CMUP inchangé', (SELECT unit_cost = 63 AND NOT cost_known AND cmup_after = 63 FROM public.stock_list(NULL, NULL, 50, 0) WHERE idem_key = 'man:9'));
SELECT pg_temp.ok('S9 : stock_valuation compte 1 mouvement à coût non confirmé', (SELECT unknown_moves = 1 AND qty = 19 FROM public.stock_valuation() WHERE product_id = 'A'));
-- Idempotence : rejouer S8 ne change ni le stock ni le CMUP
SELECT pg_temp.ok('rejeu de la même clé : ignoré (skipped = 1)', (public.stock_record('[{"product_id":"A","product_name":"Farine","type":"in","qty":8,"unit_cost":999,"date":"2026-11-10","source":"purchase","key":"pur:p8:0"}]'::jsonb)->>'skipped')::int = 1);
SELECT pg_temp.ok('rejeu : CMUP et quantité inchangés (63 ; 19)', (SELECT cmup = 63 AND qty = 19 FROM public.stock_valuation() WHERE product_id = 'A'));
-- Annulation d'achat : sortie au coût de l'achat, CMUP des unités restantes recalculé
SELECT public.stock_record('[{"product_id":"C","product_name":"Sucre","type":"in","qty":10,"unit_cost":10,"date":"2026-11-01","source":"purchase","key":"pur:c1:0"},{"product_id":"C","product_name":"Sucre","type":"in","qty":10,"unit_cost":20,"date":"2026-11-02","source":"purchase","key":"pur:c2:0"}]'::jsonb);
SELECT pg_temp.ok('C : CMUP 15 après deux achats', (SELECT cmup = 15 FROM public.stock_valuation() WHERE product_id = 'C'));
SELECT public.stock_record('[{"product_id":"C","product_name":"Sucre","type":"out","qty":10,"unit_cost":20,"date":"2026-11-03","source":"purchase","key":"pur-cancel:c2:0"}]'::jsonb);
SELECT pg_temp.ok('annulation de l''achat à 20 : il reste 10 à 10 (valeur 100)', (SELECT qty = 10 AND cmup = 10 AND value = 100 FROM public.stock_valuation() WHERE product_id = 'C'));
-- Stock négatif puis entrée : CMUP = coût de l'entrée
SELECT public.stock_record('[{"product_id":"D","product_name":"Riz","type":"out","qty":2,"date":"2026-11-01","source":"invoice","key":"inv:d:0"},{"product_id":"D","product_name":"Riz","type":"in","qty":5,"unit_cost":30,"date":"2026-11-02","source":"purchase","key":"pur:d:0"}]'::jsonb);
SELECT pg_temp.ok('vente avant tout coût : sortie à coût inconnu (signalée)', (SELECT unit_cost IS NULL AND NOT cost_known FROM public.stock_list(NULL, NULL, 50, 0) WHERE idem_key = 'inv:d:0'));
SELECT pg_temp.ok('entrée sur stock négatif : CMUP = coût de l''entrée (30), stock 3', (SELECT cmup = 30 AND qty = 3 AND value = 90 FROM public.stock_valuation() WHERE product_id = 'D'));
-- Valorisation à une date passée
SELECT pg_temp.ok('valeur au 31/10 : 16 sacs à 56 = 896 (mouvements de novembre exclus)', (SELECT qty = 16 AND cmup = 56 AND value = 896 FROM public.stock_valuation('2026-10-31') WHERE product_id = 'A'));
-- Validation des coûts
SELECT pg_temp.ok('coût négatif refusé', pg_temp.err($$SELECT public.stock_record('[{"product_id":"A","product_name":"x","type":"in","qty":1,"unit_cost":-1,"date":"2026-11-01","source":"purchase"}]'::jsonb)$$) LIKE '%COUT_INVALIDE%');
SELECT pg_temp.ok('coût non numérique refusé', pg_temp.err($$SELECT public.stock_record('[{"product_id":"A","product_name":"x","type":"in","qty":1,"unit_cost":"abc","date":"2026-11-01","source":"purchase"}]'::jsonb)$$) LIKE '%COUT_INVALIDE%');
SELECT pg_temp.ok('tout ou rien : un élément invalide annule l''appel entier (stock A inchangé)',
  pg_temp.err($$SELECT public.stock_record('[{"product_id":"A","product_name":"x","type":"in","qty":100,"unit_cost":1,"date":"2026-11-01","source":"purchase","key":"tor:1"},{"product_id":"A","product_name":"x","type":"in","qty":1,"unit_cost":-5,"date":"2026-11-01","source":"purchase"}]'::jsonb)$$) LIKE '%COUT_INVALIDE%'
  AND (SELECT qty = 19 AND cmup = 63 FROM public.stock_valuation() WHERE product_id = 'A'));
-- Invariant : l'état = Σ des mouvements
RESET ROLE;
SELECT pg_temp.ok('invariant : stock_cost_state.qty = Σ entrées − Σ sorties pour tous les produits',
  NOT EXISTS (SELECT 1 FROM public.stock_cost_state s WHERE s.qty <> (SELECT COALESCE(sum(CASE WHEN m.move_type = 'in' THEN m.qty ELSE -m.qty END), 0) FROM public.stock_movements m WHERE m.user_id = s.user_id AND m.product_id = s.product_id)));
CREATE OR REPLACE FUNCTION pg_temp.direct_state() RETURNS int LANGUAGE plpgsql AS $$ DECLARE n int; BEGIN SELECT count(*) INTO n FROM public.stock_cost_state; RETURN n; EXCEPTION WHEN OTHERS THEN RETURN -1; END $$;
GRANT EXECUTE ON FUNCTION pg_temp.direct_state() TO PUBLIC;
SET ROLE authenticated; SELECT pg_temp.as_user('36363636-0000-4000-8000-000000000001');
SELECT pg_temp.ok('lecture directe de stock_cost_state par un utilisateur : refusée ou 0 ligne', pg_temp.direct_state() <= 0);
SELECT pg_temp.ok('écriture directe de stock_cost_state : sans effet', pg_temp.err($$UPDATE public.stock_cost_state SET cmup = 1$$) <> '' OR (SELECT pg_temp.direct_state()) <= 0);
RESET ROLE;
SELECT pg_temp.ok('après tentative directe : CMUP de A toujours 63', (SELECT cmup FROM public.stock_cost_state WHERE user_id = '36363636-0000-4000-8000-000000000001' AND product_id = 'A') = 63);
SELECT pg_temp.ok('historique toujours non modifiable (UPDATE refusé)', pg_temp.err($$UPDATE public.stock_movements SET unit_cost = 1$$) LIKE '%non modifiable%');
-- Isolation : B ne voit rien de A, et son propre produit A part de zéro
SET ROLE authenticated; SELECT pg_temp.as_user('36363636-0000-4000-8000-000000000002');
SELECT pg_temp.ok('isolation : B ne voit aucune valorisation de A', (SELECT count(*) FROM public.stock_valuation()) = 0);
SELECT public.stock_record('[{"product_id":"A","product_name":"Autre","type":"in","qty":1,"unit_cost":7,"date":"2026-11-01","source":"purchase","key":"pur:p1:0"}]'::jsonb);
SELECT pg_temp.ok('isolation : même identifiant de produit et même clé chez B = indépendants (CMUP 7)', (SELECT cmup = 7 AND qty = 1 FROM public.stock_valuation() WHERE product_id = 'A'));
RESET ROLE;
SELECT pg_temp.ok('isolation : le CMUP de A chez la société A reste 63', (SELECT cmup FROM public.stock_cost_state WHERE user_id = '36363636-0000-4000-8000-000000000001' AND product_id = 'A') = 63);
