-- Stock côté serveur (sql/34) : table fermée, isolation, immuabilité, idempotence, validation, calcul des niveaux et des périodes, licence.
\set VERBOSITY terse
SET client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.ok(name text, cond boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS
$$ BEGIN RAISE NOTICE '%', CASE WHEN cond THEN 'PASS '||name ELSE 'FAIL '||name||' '||detail END; END $$;
CREATE OR REPLACE FUNCTION pg_temp.err(sql text) RETURNS text LANGUAGE plpgsql AS
$$ BEGIN EXECUTE sql; RETURN ''; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $$;
CREATE OR REPLACE FUNCTION pg_temp.as_user(u text) RETURNS void LANGUAGE sql AS $$ SELECT set_config('request.jwt.claim.sub', u, false) $$;
INSERT INTO auth.users(id, email, email_confirmed_at) VALUES
  ('d4d4d4d4-0000-0000-0000-000000000001', 'stock-a@test.invalid', now()),
  ('d4d4d4d4-0000-0000-0000-000000000002', 'stock-b@test.invalid', now()),
  ('d4d4d4d4-0000-0000-0000-000000000003', 'stock-nc@test.invalid', NULL);

-- ===== Droits =====
SELECT pg_temp.ok('table stock_movements : RLS active, aucune politique (table fermée)', (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.stock_movements'::regclass) AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='stock_movements'));
SELECT pg_temp.ok('anon : aucune fonction de stock exécutable',
  NOT has_function_privilege('anon', 'public.stock_record(jsonb)', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.stock_levels()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.stock_period(date,date)', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.stock_list(date,date,int,int)', 'EXECUTE'));
SELECT pg_temp.ok('authenticated : 4 fonctions publiques, pas stock_uid ni stock_guard',
  has_function_privilege('authenticated', 'public.stock_record(jsonb)', 'EXECUTE') AND has_function_privilege('authenticated', 'public.stock_levels()', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.stock_period(date,date)', 'EXECUTE') AND has_function_privilege('authenticated', 'public.stock_list(date,date,int,int)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.stock_uid()', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'public.stock_guard()', 'EXECUTE'));

-- ===== Société A : enregistrement =====
SET ROLE authenticated; SELECT pg_temp.as_user('d4d4d4d4-0000-0000-0000-000000000001');
CREATE OR REPLACE FUNCTION pg_temp.direct_count() RETURNS int LANGUAGE plpgsql AS
$$ DECLARE n int; BEGIN SELECT count(*) INTO n FROM public.stock_movements; RETURN n; EXCEPTION WHEN OTHERS THEN RETURN -1; END $$;
GRANT EXECUTE ON FUNCTION pg_temp.direct_count() TO PUBLIC;
SELECT pg_temp.ok('insertion directe refusée', pg_temp.err($$INSERT INTO public.stock_movements(user_id, product_id, product_name, move_type, qty, move_date, source) VALUES ('d4d4d4d4-0000-0000-0000-000000000001','p1','Farine','in',5,current_date,'manual')$$) <> '');
SELECT pg_temp.ok('entrée initiale 10 + vente 3 enregistrées',
  (public.stock_record('[{"product_id":"p1","product_name":"Farine","unit":"kg","type":"in","qty":10,"date":"2026-09-10","source":"manual","note":"Fournisseur"},
                         {"product_id":"p1","product_name":"Farine","unit":"kg","type":"out","qty":3,"date":"2026-10-05","source":"invoice","ref":"FAC-2026-001","ref_id":"f1","key":"inv:f1:0"}]'::jsonb)->>'inserted') = '2');
SELECT pg_temp.ok('niveau = 7', (SELECT level FROM public.stock_levels() WHERE product_id = 'p1') = 7);
SELECT pg_temp.ok('idempotence : même clé rejouée = aucun effet (skipped)',
  (public.stock_record('[{"product_id":"p1","product_name":"Farine","unit":"kg","type":"out","qty":3,"date":"2026-10-05","source":"invoice","key":"inv:f1:0"}]'::jsonb)->>'skipped') = '1'
  AND (SELECT level FROM public.stock_levels() WHERE product_id = 'p1') = 7);
SELECT pg_temp.ok('avoir : entrée de 3 enregistrée', (public.stock_record('[{"product_id":"p1","product_name":"Farine","unit":"kg","type":"in","qty":3,"date":"2026-10-20","source":"credit","ref":"AVR-1","key":"cr:a1:0"}]'::jsonb)->>'inserted') = '1');
SELECT pg_temp.ok('avoir : niveau 10', (SELECT level FROM public.stock_levels() WHERE product_id = 'p1') = 10);
SELECT pg_temp.ok('quantités décimales enregistrées', (public.stock_record('[{"product_id":"p2","product_name":"Huile","unit":"litre","type":"in","qty":2.5,"date":"2026-10-21","source":"manual"},{"product_id":"p2","product_name":"Huile","unit":"litre","type":"out","qty":0.25,"date":"2026-10-22","source":"manual"}]'::jsonb)->>'inserted') = '2');
SELECT pg_temp.ok('quantités décimales : niveau 2,25', (SELECT level FROM public.stock_levels() WHERE product_id = 'p2') = 2.25);
SELECT pg_temp.ok('vente avant réception enregistrée', (public.stock_record('[{"product_id":"p3","product_name":"Sucre","unit":"kg","type":"out","qty":4,"date":"2026-10-22","source":"manual"}]'::jsonb)->>'inserted') = '1');
SELECT pg_temp.ok('stock négatif possible (−4)', (SELECT level FROM public.stock_levels() WHERE product_id = 'p3') = -4);

-- ===== Période =====
SELECT pg_temp.ok('période octobre : ouverture 10 (septembre), entrées 3 (avoir), sorties 3, clôture 10',
  (SELECT (opening, entries, exits, closing) = (10, 3, 3, 10) FROM public.stock_period('2026-10-01', '2026-10-31') WHERE product_id = 'p1'),
  (SELECT (opening, entries, exits, closing)::text FROM public.stock_period('2026-10-01', '2026-10-31') WHERE product_id = 'p1'));
SELECT pg_temp.ok('période septembre : ouverture 0, entrées 10, sorties 0, clôture 10', (SELECT (opening, entries, exits, closing) = (0, 10, 0, 10) FROM public.stock_period('2026-09-01', '2026-09-30') WHERE product_id = 'p1'));
SELECT pg_temp.ok('période sans borne : tout l''historique', (SELECT (entries, exits) = (13, 3) FROM public.stock_period(NULL, NULL) WHERE product_id = 'p1'));
SELECT pg_temp.ok('bornes incluses (5 octobre exact)', (SELECT exits FROM public.stock_period('2026-10-05', '2026-10-05') WHERE product_id = 'p1') = 3);
SELECT pg_temp.ok('liste : 3 mouvements p1 du plus récent au plus ancien', (SELECT array_agg(move_date::text ORDER BY ord) FROM (SELECT move_date, row_number() OVER () ord FROM public.stock_list(NULL, NULL, 50, 0) WHERE product_id = 'p1') t) = ARRAY['2026-10-20','2026-10-05','2026-09-10']);
SELECT pg_temp.ok('liste : pagination (limite 1)', (SELECT count(*) FROM public.stock_list(NULL, NULL, 1, 0)) = 1);

-- ===== Validation =====
SELECT pg_temp.ok('quantité nulle refusée', pg_temp.err($$SELECT public.stock_record('[{"product_id":"p1","product_name":"x","type":"in","qty":0,"date":"2026-10-01","source":"manual"}]'::jsonb)$$) LIKE '%QUANTITE_INVALIDE%');
SELECT pg_temp.ok('quantité négative refusée', pg_temp.err($$SELECT public.stock_record('[{"product_id":"p1","product_name":"x","type":"in","qty":-2,"date":"2026-10-01","source":"manual"}]'::jsonb)$$) LIKE '%QUANTITE_INVALIDE%');
SELECT pg_temp.ok('type invalide refusé', pg_temp.err($$SELECT public.stock_record('[{"product_id":"p1","product_name":"x","type":"adjust","qty":1,"date":"2026-10-01","source":"manual"}]'::jsonb)$$) LIKE '%TYPE_INVALIDE%');
SELECT pg_temp.ok('source invalide refusée', pg_temp.err($$SELECT public.stock_record('[{"product_id":"p1","product_name":"x","type":"in","qty":1,"date":"2026-10-01","source":"admin"}]'::jsonb)$$) LIKE '%SOURCE_INVALIDE%');
SELECT pg_temp.ok('date invalide refusée', pg_temp.err($$SELECT public.stock_record('[{"product_id":"p1","product_name":"x","type":"in","qty":1,"date":"pas-une-date","source":"manual"}]'::jsonb)$$) LIKE '%DATE_INVALIDE%');
SELECT pg_temp.ok('date très lointaine refusée', pg_temp.err($$SELECT public.stock_record('[{"product_id":"p1","product_name":"x","type":"in","qty":1,"date":"2099-01-01","source":"manual"}]'::jsonb)$$) LIKE '%DATE_INVALIDE%');
SELECT pg_temp.ok('produit vide refusé', pg_temp.err($$SELECT public.stock_record('[{"product_id":"","product_name":"x","type":"in","qty":1,"date":"2026-10-01","source":"manual"}]'::jsonb)$$) LIKE '%PRODUIT_INVALIDE%');
SELECT pg_temp.ok('tout ou rien : un élément invalide annule les autres', pg_temp.err($$SELECT public.stock_record('[{"product_id":"pz","product_name":"Z","type":"in","qty":5,"date":"2026-10-01","source":"manual"},{"product_id":"pz","product_name":"Z","type":"in","qty":-1,"date":"2026-10-01","source":"manual"}]'::jsonb)$$) <> '' AND NOT EXISTS (SELECT 1 FROM public.stock_levels() WHERE product_id = 'pz'));
SELECT pg_temp.ok('trop de mouvements en un appel refusé (> 200)', pg_temp.err($$SELECT public.stock_record((SELECT jsonb_agg('{"product_id":"p1","product_name":"x","type":"in","qty":1,"date":"2026-10-01","source":"manual"}'::jsonb) FROM generate_series(1,201)))$$) LIKE '%TROP_DE_MOUVEMENTS%');
SELECT pg_temp.ok('JSON non tableau refusé', pg_temp.err($$SELECT public.stock_record('{"a":1}'::jsonb)$$) LIKE '%MOUVEMENTS_INVALIDES%' AND pg_temp.err($$SELECT public.stock_record(NULL)$$) LIKE '%MOUVEMENTS_INVALIDES%');
SELECT pg_temp.ok('texte trop long accepté puis tronqué (note 200) : enregistrement', public.stock_record(jsonb_build_array(jsonb_build_object('product_id','p4','product_name','N','type','in','qty',1,'date','2026-10-01','source','manual','note',repeat('x',500))))->>'inserted' = '1');
SELECT pg_temp.ok('texte trop long : note tronquée à 200', (SELECT max(length(note)) FROM public.stock_list(NULL,NULL,5000,0) WHERE product_id = 'p4') = 200);
SELECT pg_temp.ok('lecture directe de la table impossible (refusée ou 0 ligne)', pg_temp.direct_count() <= 0);
RESET ROLE;

-- ===== Immuabilité (même pour le propriétaire de la table) =====
SELECT pg_temp.ok('UPDATE refusé par le garde-fou', pg_temp.err($$UPDATE public.stock_movements SET qty = 999$$) LIKE '%non modifiable%');
CREATE TEMP TABLE _stk_n AS SELECT count(*) AS n, coalesce(sum(qty),0) AS q FROM public.stock_movements;
GRANT ALL ON _stk_n TO PUBLIC;
SET ROLE authenticated; SELECT pg_temp.as_user('d4d4d4d4-0000-0000-0000-000000000001');
SELECT pg_temp.err($$UPDATE public.stock_movements SET qty = 1$$) AS e1, pg_temp.err($$DELETE FROM public.stock_movements$$) AS e2 \gset
RESET ROLE;
SELECT pg_temp.ok('société : UPDATE / DELETE directs sans effet (refusés ou 0 ligne)', (SELECT count(*) FROM public.stock_movements) = (SELECT n FROM _stk_n) AND (SELECT coalesce(sum(qty),0) FROM public.stock_movements) = (SELECT q FROM _stk_n));
SET ROLE authenticated; SELECT pg_temp.as_user('d4d4d4d4-0000-0000-0000-000000000001');
RESET ROLE;

-- ===== Isolation : société B ne voit rien de A, et ses propres mouvements restent à elle =====
SET ROLE authenticated; SELECT pg_temp.as_user('d4d4d4d4-0000-0000-0000-000000000002');
SELECT pg_temp.ok('société B : aucun niveau de A', (SELECT count(*) FROM public.stock_levels()) = 0 AND (SELECT count(*) FROM public.stock_list(NULL, NULL, 5000, 0)) = 0 AND (SELECT count(*) FROM public.stock_period(NULL, NULL)) = 0);
SELECT pg_temp.ok('société B : même clé d''idempotence et même produit que A acceptés (clés par compte)', (public.stock_record('[{"product_id":"p1","product_name":"Farine B","unit":"kg","type":"in","qty":1,"date":"2026-10-01","source":"invoice","key":"inv:f1:0"}]'::jsonb)->>'inserted') = '1');
SELECT pg_temp.ok('société B : son niveau = 1 (indépendant de A)', (SELECT level FROM public.stock_levels() WHERE product_id = 'p1') = 1);
RESET ROLE;
SET ROLE authenticated; SELECT pg_temp.as_user('d4d4d4d4-0000-0000-0000-000000000001');
SELECT pg_temp.ok('société A : niveau toujours 10 après l''activité de B', (SELECT level FROM public.stock_levels() WHERE product_id = 'p1') = 10);
RESET ROLE;

-- ===== Compte non confirmé / non connecté =====
SET ROLE authenticated; SELECT pg_temp.as_user('d4d4d4d4-0000-0000-0000-000000000003');
SELECT pg_temp.ok('e-mail non confirmé : refusé', pg_temp.err($$SELECT public.stock_record('[{"product_id":"p1","product_name":"x","type":"in","qty":1,"date":"2026-10-01","source":"manual"}]'::jsonb)$$) LIKE '%NON_AUTHENTIFIE%' AND pg_temp.err($$SELECT * FROM public.stock_levels()$$) LIKE '%NON_AUTHENTIFIE%');
RESET ROLE;
SET ROLE anon;
SELECT pg_temp.ok('anon : refusé', pg_temp.err($$SELECT public.stock_record('[]'::jsonb)$$) <> '' AND pg_temp.err($$SELECT * FROM public.stock_levels()$$) <> '');
RESET ROLE;

-- ===== Licence : écriture refusée si la licence n'est plus active, lecture toujours possible =====
INSERT INTO auth.users(id, email, email_confirmed_at) VALUES ('5a5a5a5a-3400-4000-8000-000000000004', 'stock-exp@test.invalid', now());
INSERT INTO public.licenses(user_id, status, expires_at) VALUES ('5a5a5a5a-3400-4000-8000-000000000004', 'active', now() - interval '1 day');
SET ROLE authenticated; SELECT pg_temp.as_user('5a5a5a5a-3400-4000-8000-000000000004');
SELECT pg_temp.ok('licence expirée : écriture refusée', pg_temp.err($$SELECT public.stock_record('[{"product_id":"p1","product_name":"x","type":"in","qty":1,"date":"2026-10-01","source":"manual"}]'::jsonb)$$) LIKE '%LICENCE_INACTIVE%');
SELECT pg_temp.ok('licence expirée : lecture toujours possible', (SELECT count(*) FROM public.stock_levels()) = 0);
RESET ROLE;

-- ===== Suppression du compte : les mouvements disparaissent avec lui =====
DELETE FROM auth.users WHERE id = 'd4d4d4d4-0000-0000-0000-000000000001';
SELECT pg_temp.ok('suppression du compte A : plus aucun mouvement de A', (SELECT count(*) FROM public.stock_movements WHERE user_id = 'd4d4d4d4-0000-0000-0000-000000000001') = 0);
SELECT pg_temp.ok('suppression du compte A : les mouvements de B sont intacts', (SELECT count(*) FROM public.stock_movements WHERE user_id = 'd4d4d4d4-0000-0000-0000-000000000002') = 1);
