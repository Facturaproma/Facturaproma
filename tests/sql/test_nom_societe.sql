-- Nom de société côté admin (sql/28) : réservé aux administrateurs, ne renvoie que user_id + nom, valeurs non texte ignorées.
\set VERBOSITY terse
SET client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.ok(name text, cond boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS
$$ BEGIN RAISE NOTICE '%', CASE WHEN cond THEN 'PASS '||name ELSE 'FAIL '||name||' '||detail END; END $$;
CREATE OR REPLACE FUNCTION pg_temp.refuse(sql text) RETURNS boolean LANGUAGE plpgsql AS
$$ BEGIN EXECUTE sql; RETURN false; EXCEPTION WHEN OTHERS THEN RETURN true; END $$;
GRANT ALL ON public.user_data, public.admins TO authenticated;
INSERT INTO auth.users(id, email) VALUES
  ('a8a8a8a8-0000-0000-0000-000000000001', 'adm28@test.invalid'),
  ('a8a8a8a8-0000-0000-0000-000000000002', 'cli28a@test.invalid'),
  ('a8a8a8a8-0000-0000-0000-000000000003', 'cli28b@test.invalid'),
  ('a8a8a8a8-0000-0000-0000-000000000004', 'cli28c@test.invalid');
INSERT INTO public.admins(email, password_hash, is_master) VALUES ('adm28@test.invalid', 'x', false);
INSERT INTO public.user_data(user_id, key, value) VALUES
  ('a8a8a8a8-0000-0000-0000-000000000002', 'company', '{"name":"  Atelier Atlas SARL ","ice":"001234567000089","rib":"SECRET"}'),
  ('a8a8a8a8-0000-0000-0000-000000000003', 'company', '{"name":123}'),
  ('a8a8a8a8-0000-0000-0000-000000000004', 'company', '{"name":"   "}');
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','a8a8a8a8-0000-0000-0000-000000000002',false), set_config('request.jwt.claim.email','cli28a@test.invalid',false);
SELECT pg_temp.ok('non-admin : admin_account_companies refusé', pg_temp.refuse($$SELECT * FROM public.admin_account_companies()$$));
SELECT set_config('request.jwt.claim.sub','a8a8a8a8-0000-0000-0000-000000000001',false), set_config('request.jwt.claim.email','adm28@test.invalid',false);
SELECT pg_temp.ok('admin : nom de société renvoyé, espaces retirés', (SELECT company_name FROM public.admin_account_companies() WHERE user_id='a8a8a8a8-0000-0000-0000-000000000002') = 'Atelier Atlas SARL');
SELECT pg_temp.ok('admin : nom non texte ou vide ignoré', (SELECT count(*) FROM public.admin_account_companies() WHERE user_id IN ('a8a8a8a8-0000-0000-0000-000000000003','a8a8a8a8-0000-0000-0000-000000000004')) = 0);
SELECT pg_temp.ok('la fonction ne renvoie que user_id et company_name (pas d''ICE ni de RIB)', (SELECT count(*) FROM information_schema.parameters WHERE specific_schema='public' AND specific_name LIKE 'admin_account_companies%' AND parameter_mode='OUT') = 2);
RESET ROLE;
SELECT pg_temp.ok('anon n''a pas le droit d''exécuter la fonction', NOT has_function_privilege('anon', 'public.admin_account_companies()', 'EXECUTE'));
