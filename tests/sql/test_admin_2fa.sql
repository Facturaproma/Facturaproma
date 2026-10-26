-- Double authentification admin (sql/31) : un compte avec facteur TOTP vérifié n'est admin QUE si la session est aal2.
\set VERBOSITY terse
SET client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.ok(name text, cond boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS
$$ BEGIN RAISE NOTICE '%', CASE WHEN cond THEN 'PASS '||name ELSE 'FAIL '||name||' '||detail END; END $$;
CREATE OR REPLACE FUNCTION pg_temp.as_user(u text, aal text) RETURNS void LANGUAGE sql AS
$$ SELECT set_config('request.jwt.claim.sub', u, false), set_config('request.jwt.claim.aal', aal, false) $$;
INSERT INTO auth.users(id, email, email_confirmed_at) VALUES
  ('e5e5e5e5-0000-0000-0000-000000000001', 'adm2fa@test.invalid', now()),
  ('e5e5e5e5-0000-0000-0000-000000000002', 'adm-sans2fa@test.invalid', now()),
  ('e5e5e5e5-0000-0000-0000-000000000003', 'staff2fa@test.invalid', now()),
  ('e5e5e5e5-0000-0000-0000-000000000004', 'client@test.invalid', now());
INSERT INTO public.admins(email, is_master) VALUES ('adm2fa@test.invalid', true), ('adm-sans2fa@test.invalid', false) ON CONFLICT (email) DO NOTHING;
INSERT INTO public.staff(email) VALUES ('staff2fa@test.invalid') ON CONFLICT DO NOTHING;
INSERT INTO auth.mfa_factors(user_id, status) VALUES
  ('e5e5e5e5-0000-0000-0000-000000000001', 'verified'),
  ('e5e5e5e5-0000-0000-0000-000000000003', 'verified'),
  ('e5e5e5e5-0000-0000-0000-000000000004', 'unverified');
SET ROLE authenticated;

SELECT pg_temp.as_user('e5e5e5e5-0000-0000-0000-000000000001', 'aal1');
SELECT pg_temp.ok('admin avec 2FA, session aal1 (mot de passe seul) : refusé', NOT public.is_admin() AND NOT public.is_master());
SELECT pg_temp.ok('admin avec 2FA, aal1 : admin_whoami ne le reconnaît pas', (public.admin_whoami()->>'is_admin')::bool IS NOT TRUE);
SELECT pg_temp.as_user('e5e5e5e5-0000-0000-0000-000000000001', 'aal2');
SELECT pg_temp.ok('admin avec 2FA, session aal2 : admin et master', public.is_admin() AND public.is_master());
SELECT pg_temp.as_user('e5e5e5e5-0000-0000-0000-000000000003', 'aal1');
SELECT pg_temp.ok('assistant avec 2FA, aal1 : refusé', NOT public.is_staff());
SELECT pg_temp.as_user('e5e5e5e5-0000-0000-0000-000000000003', 'aal2');
SELECT pg_temp.ok('assistant avec 2FA, aal2 : accepté', public.is_staff());
SELECT pg_temp.as_user('e5e5e5e5-0000-0000-0000-000000000002', 'aal1');
SELECT pg_temp.ok('admin sans 2FA enrôlée : comportement inchangé (pas de verrouillage)', public.is_admin());
SELECT pg_temp.as_user('e5e5e5e5-0000-0000-0000-000000000004', 'aal1');
SELECT pg_temp.ok('simple client (facteur non vérifié) : jamais admin', NOT public.is_admin() AND NOT public.is_master() AND NOT public.is_staff());
SELECT pg_temp.ok('fp_mfa_ok non appelable directement par authenticated', NOT has_function_privilege('authenticated', 'public.fp_mfa_ok(uuid)', 'EXECUTE'));
SELECT pg_temp.ok('anon : pas d''EXECUTE sur is_admin / is_master / is_staff', NOT has_function_privilege('anon', 'public.is_admin()', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.is_master()', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.is_staff()', 'EXECUTE'));
