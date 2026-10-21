-- Audit automatique des droits : RLS, fonctions SECURITY DEFINER, exécution par anon.
\set VERBOSITY terse
SET client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.ok(name text, cond boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS
$$ BEGIN RAISE NOTICE '%', CASE WHEN cond THEN 'PASS '||name ELSE 'FAIL '||name||' '||detail END; END $$;

-- 1. Toute table du schéma public a la RLS activée
SELECT pg_temp.ok('RLS activée sur toutes les tables publiques',
  NOT EXISTS (SELECT 1 FROM pg_tables t WHERE schemaname='public' AND NOT rowsecurity),
  (SELECT string_agg(tablename, ',') FROM pg_tables WHERE schemaname='public' AND NOT rowsecurity));

-- 2. Toute fonction SECURITY DEFINER fixe son search_path (protection contre le détournement de schéma)
SELECT pg_temp.ok('fonctions SECURITY DEFINER avec search_path fixé',
  NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.prosecdef AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig,'{}')) c WHERE c LIKE 'search_path=%')),
  (SELECT string_agg(p.proname, ',') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.prosecdef AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig,'{}')) c WHERE c LIKE 'search_path=%')));

-- 3. Aucune fonction SECURITY DEFINER n'est exécutable par un visiteur non connecté (anon)
SELECT pg_temp.ok('aucune fonction SECURITY DEFINER exécutable par anon',
  NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.prosecdef AND has_function_privilege('anon', p.oid, 'EXECUTE')),
  (SELECT string_agg(p.proname, ',') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.prosecdef AND has_function_privilege('anon', p.oid, 'EXECUTE')));

-- 4. Les fonctions de déclencheur ne sont pas appelables directement par les utilisateurs
SELECT pg_temp.ok('fonctions de déclencheur non exécutables par authenticated',
  NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.prorettype = 'trigger'::regtype AND p.prosecdef
                AND has_function_privilege('authenticated', p.oid, 'EXECUTE')),
  (SELECT string_agg(p.proname, ',') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.prorettype = 'trigger'::regtype AND p.prosecdef AND has_function_privilege('authenticated', p.oid, 'EXECUTE')));

-- 5. anon n'a aucun droit sur les tables
SELECT pg_temp.ok('anon : aucun droit sur les tables publiques',
  NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE grantee='anon' AND table_schema='public'));

-- Inventaire lisible (revue humaine) : fonctions exécutables par authenticated
SELECT 'INVENTAIRE fonction exécutable par authenticated : ' || p.proname || CASE WHEN p.prosecdef THEN ' (SECURITY DEFINER)' ELSE '' END
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND p.prorettype <> 'trigger'::regtype
ORDER BY p.proname;

-- 6. Un utilisateur ordinaire ne peut appeler aucune fonction d'administration
INSERT INTO auth.users(id, email) VALUES ('dddddddd-0000-0000-0000-000000000004', 'plain@test.invalid');
INSERT INTO auth.users(id, email) VALUES ('eeeeeeee-0000-0000-0000-000000000005', 'victime@test.invalid');
INSERT INTO public.licenses(user_id, type, status, expires_at) VALUES ('dddddddd-0000-0000-0000-000000000004','annual','active', now()+interval '100 days');
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
CREATE OR REPLACE FUNCTION pg_temp.refuse(sql text) RETURNS boolean LANGUAGE plpgsql AS
$$ BEGIN EXECUTE sql; RETURN false; EXCEPTION WHEN OTHERS THEN RETURN true; END $$;
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', 'dddddddd-0000-0000-0000-000000000004', false);
SELECT pg_temp.ok('non-admin : admin_list_accounts refusé', pg_temp.refuse($$SELECT * FROM public.admin_list_accounts()$$));
SELECT pg_temp.ok('non-admin : admin_set_license refusé', pg_temp.refuse($$SELECT public.admin_set_license(gen_random_uuid(), 'lifetime', NULL)$$));
SELECT pg_temp.ok('non-admin : admin_delete_account refusé', pg_temp.refuse($$SELECT public.admin_delete_account('eeeeeeee-0000-0000-0000-000000000005')$$));
SELECT pg_temp.ok('non-admin : admin_add_staff refusé', pg_temp.refuse($$SELECT public.admin_add_staff('x@y.z')$$));
SELECT pg_temp.ok('non-admin : admin_remove_staff refusé', pg_temp.refuse($$SELECT public.admin_remove_staff('x@y.z')$$));
SELECT pg_temp.ok('non-admin : staff_open_requests refusé', pg_temp.refuse($$SELECT * FROM public.staff_open_requests()$$));
SELECT pg_temp.ok('non-admin : staff_cancel_payment refusé', pg_temp.refuse($$SELECT public.staff_cancel_payment('eeeeeeee-0000-0000-0000-000000000005')$$));
SELECT pg_temp.ok('non-admin : lecture des codes de licence impossible', (SELECT count(*) FROM public.admin_codes) = 0);
SELECT pg_temp.ok('non-admin : lecture des paiements admin impossible', (SELECT count(*) FROM public.admin_payments) = 0);
SELECT pg_temp.ok('non-admin : modification de sa propre licence refusée', pg_temp.refuse($$UPDATE public.licenses SET type='lifetime', expires_at=NULL$$) OR NOT EXISTS (SELECT 1 FROM public.licenses WHERE type='lifetime'));
SELECT pg_temp.ok('non-admin : insertion d''une licence refusée', pg_temp.refuse($$INSERT INTO public.licenses(user_id,type) VALUES ('eeeeeeee-0000-0000-0000-000000000005','lifetime')$$));
RESET ROLE;
SELECT pg_temp.ok('la licence de l''utilisateur n''a pas changé', (SELECT type FROM public.licenses WHERE user_id='dddddddd-0000-0000-0000-000000000004') = 'annual');
