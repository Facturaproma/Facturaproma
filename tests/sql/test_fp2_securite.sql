-- FacturaPro 2.0 — contrôle de sécurité transversal des scripts sql/36 à sql/41 :
-- tables fermées (RLS sans politique, aucun accès direct), fonctions SECURITY DEFINER à search_path fixé, rien d'exécutable par anon,
-- fonctions internes non exposées, suppression d'un compte = suppression en cascade de ses données financières.
\set VERBOSITY terse
SET client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.ok(name text, cond boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS
$$ BEGIN RAISE NOTICE '%', CASE WHEN cond THEN 'PASS '||name ELSE 'FAIL '||name||' '||detail END; END $$;
CREATE OR REPLACE FUNCTION pg_temp.err(sql text) RETURNS text LANGUAGE plpgsql AS
$$ BEGIN EXECUTE sql; RETURN ''; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $$;
GRANT EXECUTE ON FUNCTION pg_temp.ok(text, boolean, text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION pg_temp.err(text) TO PUBLIC;
CREATE TEMP TABLE _fp2_tables(t text);
INSERT INTO _fp2_tables VALUES ('stock_cost_state'), ('fin_counters'), ('fin_audit'), ('purchases'), ('purchase_lines'), ('deliveries'), ('delivery_lines'),
  ('cash_accounts'), ('cash_movements'), ('period_closures');
GRANT SELECT ON _fp2_tables TO PUBLIC;

SELECT pg_temp.ok('10 tables FP2 : RLS activée, aucune politique',
  (SELECT count(*) FROM pg_class c JOIN _fp2_tables x ON c.relname = x.t AND c.relnamespace = 'public'::regnamespace WHERE c.relrowsecurity) = 10
  AND NOT EXISTS (SELECT 1 FROM pg_policies p JOIN _fp2_tables x ON p.tablename = x.t));
SELECT pg_temp.ok('fonctions SECURITY DEFINER FP2 : toutes avec search_path fixé',
  NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
     AND (p.proname LIKE 'fin\_%' OR p.proname LIKE 'purchase\_%' OR p.proname LIKE 'delivery\_%' OR p.proname LIKE 'cash\_%' OR p.proname LIKE 'period\_%' OR p.proname LIKE 'stock\_%' OR p.proname = 'supplier_settle')
     AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%')),
  (SELECT string_agg(proname, ',') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef AND p.proname LIKE 'fin\_%' AND p.proconfig IS NULL));
SELECT pg_temp.ok('aucune fonction FP2 exécutable par anon',
  NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
     AND (p.proname LIKE 'fin\_%' OR p.proname LIKE 'purchase\_%' OR p.proname LIKE 'delivery\_%' OR p.proname LIKE 'cash\_%' OR p.proname LIKE 'period\_%' OR p.proname = 'supplier_settle' OR p.proname = 'stock_valuation')
     AND has_function_privilege('anon', p.oid, 'EXECUTE')),
  (SELECT string_agg(proname, ',') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'fin\_%' OR p.proname LIKE 'cash\_%' OR p.proname LIKE 'period\_%') AND has_function_privilege('anon', p.oid, 'EXECUTE')));
SELECT pg_temp.ok('fonctions internes fin_* non exposées à authenticated (seules fin_summary / fin_monthly / fin_import_* le sont)',
  NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'fin\_%'
     AND p.proname NOT IN ('fin_summary', 'fin_monthly', 'fin_import_legacy_purchases', 'fin_import_legacy_deliveries')
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE')),
  (SELECT string_agg(proname, ',') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'fin\_%' AND p.proname NOT IN ('fin_summary', 'fin_monthly', 'fin_import_legacy_purchases', 'fin_import_legacy_deliveries') AND has_function_privilege('authenticated', p.oid, 'EXECUTE')));
SET ROLE anon;
SELECT pg_temp.ok('anon : aucune lecture directe des tables FP2',
  (SELECT bool_and(pg_temp.err(format('SELECT 1 FROM public.%I LIMIT 1', t)) LIKE '%permission denied%') FROM _fp2_tables));
RESET ROLE;
SET ROLE authenticated;
SELECT pg_temp.ok('authenticated : aucune lecture ni écriture directe des tables FP2 (tout passe par les fonctions)',
  (SELECT bool_and(pg_temp.err(format('SELECT 1 FROM public.%I LIMIT 1', t)) LIKE '%permission denied%') FROM _fp2_tables)
  AND pg_temp.err($$DELETE FROM public.cash_movements$$) LIKE '%permission denied%' AND pg_temp.err($$UPDATE public.purchases SET total_ttc = 0$$) LIKE '%permission denied%');
RESET ROLE;
SELECT pg_temp.ok('suppression d''un compte : toutes ses données FP2 suivent (ON DELETE CASCADE vers auth.users)',
  (SELECT count(*) FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN _fp2_tables x ON x.t = c.relname
     WHERE k.contype = 'f' AND k.confrelid = 'auth.users'::regclass AND k.confdeltype = 'c') = 10);
