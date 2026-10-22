-- Point 6 : un compte ne peut pas consulter la licence d'un autre compte via has_active_license(uuid).
\set VERBOSITY terse
SET client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.ok(name text, cond boolean) RETURNS void LANGUAGE plpgsql AS
$$ BEGIN RAISE NOTICE '%', CASE WHEN cond THEN 'PASS '||name ELSE 'FAIL '||name END; END $$;

INSERT INTO auth.users(id, email) VALUES
  ('a1a1a1a1-0000-0000-0000-00000000000a', 'la@test.invalid'),
  ('b2b2b2b2-0000-0000-0000-00000000000b', 'lb@test.invalid'),
  ('c3c3c3c3-0000-0000-0000-00000000000c', 'ladmin@test.invalid');
INSERT INTO public.licenses(user_id, type, status, expires_at) VALUES
  ('a1a1a1a1-0000-0000-0000-00000000000a', 'annual', 'active', now() + interval '100 days'),
  ('b2b2b2b2-0000-0000-0000-00000000000b', 'annual', 'suspended', now() + interval '100 days');
INSERT INTO public.admins(email, password_hash, is_master) VALUES ('ladmin@test.invalid', 'x', false);

SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', 'a1a1a1a1-0000-0000-0000-00000000000a', false);
SELECT pg_temp.ok('A lit sa propre licence', public.has_active_license('a1a1a1a1-0000-0000-0000-00000000000a') IS TRUE);
SELECT pg_temp.ok('A lit sa licence via la valeur par défaut', public.has_active_license() IS TRUE);
SELECT pg_temp.ok('A ne peut PAS consulter la licence de B (NULL)', public.has_active_license('b2b2b2b2-0000-0000-0000-00000000000b') IS NULL);
SELECT pg_temp.ok('A ne peut pas sonder un UUID inexistant (NULL, pas FALSE)', public.has_active_license(gen_random_uuid()) IS NULL);
RESET ROLE;

SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', 'b2b2b2b2-0000-0000-0000-00000000000b', false);
SELECT pg_temp.ok('B (suspendu) voit sa propre licence inactive', public.has_active_license() IS FALSE);
SELECT pg_temp.ok('B ne peut PAS consulter la licence de A (NULL)', public.has_active_license('a1a1a1a1-0000-0000-0000-00000000000a') IS NULL);
RESET ROLE;

SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', 'c3c3c3c3-0000-0000-0000-00000000000c', false);
SELECT pg_temp.ok('administrateur : peut consulter la licence de A (autorisation explicite)', public.has_active_license('a1a1a1a1-0000-0000-0000-00000000000a') IS TRUE);
SELECT pg_temp.ok('administrateur : peut consulter la licence de B', public.has_active_license('b2b2b2b2-0000-0000-0000-00000000000b') IS FALSE);
RESET ROLE;

SET ROLE anon;
SELECT pg_temp.ok('anon : exécution refusée', NOT has_function_privilege('anon', 'public.has_active_license(uuid)', 'EXECUTE'));
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', false);
SELECT pg_temp.ok('sans identité de session (éditeur SQL / service_role) : appel libre', public.has_active_license('b2b2b2b2-0000-0000-0000-00000000000b') IS FALSE);
