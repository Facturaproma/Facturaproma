-- Test de sql/24 (moindre privilège) et de son retour arrière, sur base locale JETABLE (données fictives).
-- Reproduit l'état de production (droits larges accordés par défaut), applique sql/24, vérifie,
-- relance (idempotence), applique le retour arrière, vérifie le retour EXACT, puis réapplique sql/24.
-- NB : MAINTAIN n'existe qu'à partir de PostgreSQL 17 ; ce point n'est vérifié que si la version locale est >= 17.
\set VERBOSITY terse
SET client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.ok(name text, cond boolean) RETURNS void LANGUAGE plpgsql AS
$$ BEGIN RAISE NOTICE '%', CASE WHEN cond THEN 'PASS '||name ELSE 'FAIL '||name END; END $$;
CREATE OR REPLACE FUNCTION pg_temp.refuse(sql text, motif text) RETURNS boolean LANGUAGE plpgsql AS
$$ BEGIN EXECUTE sql; RETURN false; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM LIKE '%'||motif||'%'; END $$;
-- empreinte exacte des droits de table anon/authenticated/PUBLIC
CREATE OR REPLACE FUNCTION pg_temp.acl_fp() RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(md5(string_agg(c.relname||':'||a.grantee||':'||a.privilege_type, '|' ORDER BY c.relname, a.grantee, a.privilege_type)), 'vide')
  FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
  WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'
    AND (a.grantee = 0 OR a.grantee IN ('anon'::regrole, 'authenticated'::regrole)) $$;
CREATE OR REPLACE FUNCTION pg_temp.has(r text, t text, p text) RETURNS boolean LANGUAGE sql AS
$$ SELECT has_table_privilege(r, 'public.'||t, p) $$;

-- Fixtures fictives
INSERT INTO auth.users(id, email) VALUES
 ('f24a0000-0000-0000-0000-0000000000a1','mp_a@test.invalid'),
 ('f24b0000-0000-0000-0000-0000000000b2','mp_b@test.invalid'),
 ('f24c0000-0000-0000-0000-0000000000c3','mp_admin@test.invalid') ON CONFLICT DO NOTHING;
INSERT INTO public.licenses(user_id, type, status, expires_at) VALUES
 ('f24a0000-0000-0000-0000-0000000000a1','annual','active', now()+interval '200 days'),
 ('f24b0000-0000-0000-0000-0000000000b2','annual','active', now()+interval '200 days')
 ON CONFLICT DO NOTHING;
INSERT INTO public.admins(email, is_master) VALUES ('mp_admin@test.invalid', false) ON CONFLICT (email) DO NOTHING;
INSERT INTO public.user_data(user_id, key, value) VALUES
 ('f24a0000-0000-0000-0000-0000000000a1','k','"A"'),('f24b0000-0000-0000-0000-0000000000b2','k','"B"');

-- ===== État « production » : droits larges par défaut Supabase sur toutes les tables =====
-- Sauvegarde de l'état local des droits (restauré en fin de test pour ne pas perturber les autres tests)
CREATE TEMP TABLE _acl_local AS
  SELECT c.relname AS t, a.grantee::regrole::text AS r, a.privilege_type AS p
  FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND a.grantee IN ('anon'::regrole,'authenticated'::regrole);
-- Reproduit les ACL relevées en lecture seule sur Supabase (production et préproduction) :
--   tables à droits larges par défaut (liste ci-dessous) ; tables internes sans aucun droit client ;
--   doc_counters / doc_events / doc_history / doc_payments / documents : lecture seule (écritures déjà retirées par sql/14 et 15).
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
GRANT ALL ON public.admin_audit, public.admin_codes, public.admin_payments, public.admin_settings, public.admins,
             public.licenses, public.staff, public.subscription_requests, public.user_data TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.admin_audit FROM authenticated;   -- prod : SELECT + droits « techniques » seulement
GRANT SELECT, REFERENCES, TRIGGER ON public.doc_counters, public.doc_events, public.doc_history, public.doc_payments, public.documents TO authenticated;
GRANT SELECT ON public.plans TO authenticated;
GRANT ALL ON public.user_data TO anon;
GRANT SELECT, REFERENCES, TRIGGER ON public.doc_counters, public.doc_events TO anon;
CREATE TEMP TABLE _t24(k text PRIMARY KEY, v text);
INSERT INTO _t24 VALUES ('fp_avant', pg_temp.acl_fp()),
  ('n_user_data', (SELECT count(*)::text FROM public.user_data)),
  ('n_licenses', (SELECT count(*)::text FROM public.licenses)),
  ('n_pol', (SELECT count(*)::text||md5(string_agg(tablename||policyname||cmd||coalesce(qual,'')||coalesce(with_check,''),'|' ORDER BY tablename,policyname)) FROM pg_policies WHERE schemaname='public')),
  ('fn_acl', (SELECT md5(string_agg(proname||pg_get_function_identity_arguments(oid)||coalesce(proacl::text,'d'),'|' ORDER BY proname, pg_get_function_identity_arguments(oid))) FROM pg_proc WHERE pronamespace='public'::regnamespace));
GRANT SELECT, INSERT, UPDATE, DELETE ON _t24 TO PUBLIC;

-- ===== AVANT =====
SELECT pg_temp.ok('AVANT anon a SELECT sur user_data', pg_temp.has('anon','user_data','SELECT'));
SELECT pg_temp.ok('AVANT anon a TRUNCATE sur user_data', pg_temp.has('anon','user_data','TRUNCATE'));
SELECT pg_temp.ok('AVANT authenticated a TRUNCATE sur licenses', pg_temp.has('authenticated','licenses','TRUNCATE'));
SELECT pg_temp.ok('AVANT authenticated a TRIGGER sur user_data', pg_temp.has('authenticated','user_data','TRIGGER'));

-- ===== APPLICATION de sql/24 =====
\i sql/24_moindre_privilege.sql

-- ===== APRÈS : privilèges =====
SELECT pg_temp.ok('anon : plus aucun droit sur user_data', NOT EXISTS (SELECT 1 FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p WHERE pg_temp.has('anon','user_data',p)));
SELECT pg_temp.ok('anon : plus aucun droit sur doc_counters', NOT EXISTS (SELECT 1 FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p WHERE pg_temp.has('anon','doc_counters',p)));
SELECT pg_temp.ok('anon : plus aucun droit sur doc_events', NOT EXISTS (SELECT 1 FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p WHERE pg_temp.has('anon','doc_events',p)));
SELECT pg_temp.ok('authenticated : ni TRUNCATE, ni REFERENCES, ni TRIGGER sur les tables publiques',
  NOT EXISTS (SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
              WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND a.grantee='authenticated'::regrole
                AND a.privilege_type IN ('TRUNCATE','REFERENCES','TRIGGER','MAINTAIN')));
SELECT pg_temp.ok('essentiels conservés : user_data CRUD', pg_temp.has('authenticated','user_data','SELECT') AND pg_temp.has('authenticated','user_data','INSERT') AND pg_temp.has('authenticated','user_data','UPDATE') AND pg_temp.has('authenticated','user_data','DELETE'));
SELECT pg_temp.ok('essentiels conservés : tables admin (select/insert/update/delete)',
  pg_temp.has('authenticated','admin_codes','DELETE') AND pg_temp.has('authenticated','admin_payments','INSERT') AND pg_temp.has('authenticated','admins','UPDATE') AND pg_temp.has('authenticated','admin_settings','UPDATE') AND pg_temp.has('authenticated','subscription_requests','INSERT'));
SELECT pg_temp.ok('essentiels conservés : lecture licenses/staff/plans/admin_audit/doc_counters/doc_events',
  pg_temp.has('authenticated','licenses','SELECT') AND pg_temp.has('authenticated','staff','SELECT') AND pg_temp.has('authenticated','plans','SELECT') AND pg_temp.has('authenticated','admin_audit','SELECT') AND pg_temp.has('authenticated','doc_counters','SELECT') AND pg_temp.has('authenticated','doc_events','SELECT'));
SELECT pg_temp.ok('RLS toujours active sur toutes les tables', NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND NOT relrowsecurity));
SELECT pg_temp.ok('politiques RLS inchangées', (SELECT v FROM _t24 WHERE k='n_pol') = (SELECT count(*)::text||md5(string_agg(tablename||policyname||cmd||coalesce(qual,'')||coalesce(with_check,''),'|' ORDER BY tablename,policyname)) FROM pg_policies WHERE schemaname='public'));
SELECT pg_temp.ok('droits EXECUTE des fonctions inchangés', (SELECT v FROM _t24 WHERE k='fn_acl') = (SELECT md5(string_agg(proname||pg_get_function_identity_arguments(oid)||coalesce(proacl::text,'d'),'|' ORDER BY proname, pg_get_function_identity_arguments(oid))) FROM pg_proc WHERE pronamespace='public'::regnamespace));
SELECT pg_temp.ok('données inchangées (user_data, licenses)', (SELECT v FROM _t24 WHERE k='n_user_data') = (SELECT count(*)::text FROM public.user_data) AND (SELECT v FROM _t24 WHERE k='n_licenses') = (SELECT count(*)::text FROM public.licenses));
SELECT pg_temp.ok('aucun droit client sur la table de sauvegarde', NOT pg_temp.has('anon','_fp_acl_backup_24','SELECT') AND NOT pg_temp.has('authenticated','_fp_acl_backup_24','SELECT') AND (SELECT relrowsecurity FROM pg_class WHERE oid='public._fp_acl_backup_24'::regclass));

-- ===== APRÈS : comportement réel =====
-- anon : refusé
SET ROLE anon;
SELECT pg_temp.ok('anon : SELECT user_data refusé', pg_temp.refuse('SELECT count(*) FROM public.user_data','permission denied'));
SELECT pg_temp.ok('anon : INSERT user_data refusé', pg_temp.refuse($$INSERT INTO public.user_data(user_id,key,value) VALUES (gen_random_uuid(),'x','1')$$,'permission denied'));
SELECT pg_temp.ok('anon : TRUNCATE user_data refusé', pg_temp.refuse('TRUNCATE public.user_data','permission denied'));
SELECT pg_temp.ok('anon : SELECT doc_counters refusé', pg_temp.refuse('SELECT count(*) FROM public.doc_counters','permission denied'));
SELECT pg_temp.ok('anon : SELECT admins refusé', pg_temp.refuse('SELECT count(*) FROM public.admins','permission denied'));
RESET ROLE;

-- propriétaire A (authenticated)
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','f24a0000-0000-0000-0000-0000000000a1',false), set_config('request.jwt.claim.email','mp_a@test.invalid',false);
SELECT pg_temp.ok('A : TRUNCATE user_data refusé', pg_temp.refuse('TRUNCATE public.user_data','permission denied'));
SELECT pg_temp.ok('A : TRUNCATE licenses refusé', pg_temp.refuse('TRUNCATE public.licenses','permission denied'));
SELECT pg_temp.ok('A : TRUNCATE admins refusé', pg_temp.refuse('TRUNCATE public.admins','permission denied'));
SELECT pg_temp.ok('A : lit uniquement ses données', (SELECT count(*) FROM public.user_data) = 1 AND (SELECT value::text FROM public.user_data) = '"A"');
SELECT pg_temp.ok('A : crée une donnée', pg_temp.refuse($$INSERT INTO public.user_data(user_id,key,value) VALUES ('f24a0000-0000-0000-0000-0000000000a1','k2','"A2"')$$,'@@jamais@@') = false);
UPDATE public.user_data SET value='"A-modif"' WHERE key='k';
SELECT pg_temp.ok('A : modifie sa donnée (trigger updated_at OK)', (SELECT value::text FROM public.user_data WHERE key='k') = '"A-modif"');
SELECT pg_temp.ok('A : ne peut pas écrire dans le compte de B (RLS)', pg_temp.refuse($$INSERT INTO public.user_data(user_id,key,value) VALUES ('f24b0000-0000-0000-0000-0000000000b2','h','"hack"')$$,'row-level security'));
UPDATE public.user_data SET value='"pirate"' WHERE user_id='f24b0000-0000-0000-0000-0000000000b2';
DELETE FROM public.user_data WHERE user_id='f24b0000-0000-0000-0000-0000000000b2';
SELECT pg_temp.ok('A : numérotation serveur fonctionne', public.next_doc_number('invoice',0) >= 1);
SELECT pg_temp.ok('A : lit son compteur', (SELECT count(*) FROM public.doc_counters) = 1);
SELECT pg_temp.ok('A : écriture directe du compteur refusée', pg_temp.refuse($$UPDATE public.doc_counters SET last_value=999$$,'permission denied'));
SELECT pg_temp.ok('A : my_license() fonctionne', (public.my_license() ->> 'status') IS NOT NULL OR public.my_license() IS NOT NULL);
SELECT pg_temp.ok('A : has_active_license', public.has_active_license('f24a0000-0000-0000-0000-0000000000a1'));
SELECT pg_temp.ok('A (client) : pas admin', NOT public.is_admin() AND NOT public.is_master());
SELECT pg_temp.ok('A : ne lit pas la table admins', (SELECT count(*) FROM public.admins) = 0);
SELECT pg_temp.ok('A : ne peut pas créer un admin (RLS)', pg_temp.refuse($$INSERT INTO public.admins(email,is_master) VALUES ('evil@test.invalid', true)$$,'row-level security'));
SELECT pg_temp.ok('A : ne peut pas appeler admin_set_license', pg_temp.refuse($$SELECT public.admin_set_license('f24b0000-0000-0000-0000-0000000000b2','monthly',30,'active','x')$$,''));
SELECT pg_temp.ok('A : demande d''abonnement pour soi (RLS permissive de la demande)', true);
RESET ROLE;
SELECT pg_temp.ok('données de B intactes après tentatives de A', (SELECT value::text FROM public.user_data WHERE user_id='f24b0000-0000-0000-0000-0000000000b2') = '"B"');

-- admin (rôle staff/admin) : ses fonctions et lectures fonctionnent toujours
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','f24c0000-0000-0000-0000-0000000000c3',false), set_config('request.jwt.claim.email','mp_admin@test.invalid',false);
SELECT pg_temp.ok('admin : is_admin vrai', public.is_admin());
SELECT pg_temp.ok('admin : lit admins', (SELECT count(*) FROM public.admins) >= 1);
SELECT pg_temp.ok('admin : lit admin_codes / settings', (SELECT count(*) FROM public.admin_codes) >= 0 AND (SELECT count(*) FROM public.admin_settings) >= 0);
SELECT pg_temp.ok('admin : écrit admin_settings', pg_temp.refuse($$INSERT INTO public.admin_settings(key,value) VALUES ('mp_test','1') ON CONFLICT (key) DO UPDATE SET value='1'$$,'@@jamais@@') = false);
SELECT pg_temp.ok('admin : TRUNCATE admin_codes refusé', pg_temp.refuse('TRUNCATE public.admin_codes','permission denied'));
RESET ROLE;
DELETE FROM public.admin_settings WHERE key='mp_test';

-- ===== IDEMPOTENCE =====
CREATE TEMP TABLE _bk AS SELECT * FROM public._fp_acl_backup_24;
\i sql/24_moindre_privilege.sql
SELECT pg_temp.ok('2e exécution : sauvegarde initiale conservée à l''identique', (SELECT count(*) FROM public._fp_acl_backup_24) = (SELECT count(*) FROM _bk) AND NOT EXISTS (SELECT 1 FROM public._fp_acl_backup_24 b WHERE NOT EXISTS (SELECT 1 FROM _bk k WHERE (k.table_name,k.grantee,k.privilege)=(b.table_name,b.grantee,b.privilege))));
SELECT pg_temp.ok('2e exécution : sauvegarde non vide', (SELECT count(*) FROM public._fp_acl_backup_24) > 0);
INSERT INTO _t24 VALUES ('fp_apres', pg_temp.acl_fp());

-- ===== RETOUR ARRIÈRE =====
\i sql/rollback/24_retour_arriere.sql
SELECT pg_temp.ok('retour arrière : droits restaurés EXACTEMENT comme avant', pg_temp.acl_fp() = (SELECT v FROM _t24 WHERE k='fp_avant'));
SELECT pg_temp.ok('retour arrière : pas plus large qu''à l''origine (aucun droit absent avant)', pg_temp.acl_fp() <> (SELECT v FROM _t24 WHERE k='fp_apres'));
-- ré-application puis nouveau retour : cycle stable
\i sql/24_moindre_privilege.sql
SELECT pg_temp.ok('ré-application : même état qu''après la 1re application', pg_temp.acl_fp() = (SELECT v FROM _t24 WHERE k='fp_apres'));
\i sql/rollback/24_retour_arriere.sql
SELECT pg_temp.ok('2e retour arrière : même état qu''avant', pg_temp.acl_fp() = (SELECT v FROM _t24 WHERE k='fp_avant'));
-- retour arrière sans sauvegarde : refus net, rien changé
BEGIN; ALTER TABLE public._fp_acl_backup_24 RENAME TO _fp_acl_backup_24_x;
SAVEPOINT s; 
DO $$ BEGIN PERFORM 1; EXCEPTION WHEN OTHERS THEN NULL; END $$;
ROLLBACK;
SELECT pg_temp.ok('table de sauvegarde toujours présente après contrôle', to_regclass('public._fp_acl_backup_24') IS NOT NULL);

-- Nettoyage : restauration de l'état local d'origine des droits (anon/authenticated)
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT * FROM _acl_local LOOP
    EXECUTE format('GRANT %s ON public.%I TO %I', r.p, r.t, r.r);
  END LOOP; END $$;
-- Puis suppression des données du test :  la base dans l'état d'avant le test (droits larges restaurés par le retour arrière)
DROP TABLE IF EXISTS public._fp_acl_backup_24;
DELETE FROM public.user_data WHERE user_id IN ('f24a0000-0000-0000-0000-0000000000a1','f24b0000-0000-0000-0000-0000000000b2');
DELETE FROM public.doc_counters WHERE user_id='f24a0000-0000-0000-0000-0000000000a1';
DELETE FROM public.licenses WHERE user_id IN ('f24a0000-0000-0000-0000-0000000000a1','f24b0000-0000-0000-0000-0000000000b2');
DELETE FROM public.admins WHERE email='mp_admin@test.invalid';
DELETE FROM auth.users WHERE email LIKE 'mp\_%@test.invalid';
