-- Anti double abonnement : pas de second code ni de seconde demande, sauf formule plus longue.
\set VERBOSITY terse
SET client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.ok(name text, cond boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS
$$ BEGIN RAISE NOTICE '%', CASE WHEN cond THEN 'PASS '||name ELSE 'FAIL '||name||' '||detail END; END $$;
CREATE OR REPLACE FUNCTION pg_temp.refused(sql text) RETURNS boolean LANGUAGE plpgsql AS
$$ BEGIN EXECUTE sql; RETURN false; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM LIKE 'already_subscribed%'; END $$;
GRANT ALL ON public.admin_codes, public.admins, public.licenses, public.subscription_requests TO authenticated;
INSERT INTO auth.users(id, email) VALUES
  ('d1d1d1d1-0000-0000-0000-000000000001', 'mensuel@test.invalid'),
  ('d2d2d2d2-0000-0000-0000-000000000002', 'expire@test.invalid'),
  ('d3d3d3d3-0000-0000-0000-000000000003', 'essai@test.invalid'),
  ('d4d4d4d4-0000-0000-0000-000000000004', 'viager@test.invalid'),
  ('d5d5d5d5-0000-0000-0000-000000000005', 'adm5@test.invalid');
INSERT INTO public.admins(email, password_hash, is_master) VALUES ('adm5@test.invalid', 'x', true);
INSERT INTO public.licenses(user_id, type, status, started_at, expires_at) VALUES
  ('d1d1d1d1-0000-0000-0000-000000000001', 'monthly', 'active', now(), now() + interval '20 days'),
  ('d2d2d2d2-0000-0000-0000-000000000002', 'monthly', 'active', now() - interval '40 days', now() - interval '10 days'),
  ('d3d3d3d3-0000-0000-0000-000000000003', 'trial', 'active', now(), now() + interval '5 days'),
  ('d4d4d4d4-0000-0000-0000-000000000004', 'lifetime', 'active', now(), NULL);
INSERT INTO public.plans(key, label, price_dh, duration_days) VALUES ('p_trim5', 'Trimestriel', 129, 91), ('p_court5', 'Court', 20, 10);

SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','d5d5d5d5-0000-0000-0000-000000000005',false), set_config('request.jwt.claim.email','adm5@test.invalid',false);
SELECT pg_temp.ok('abonné Mensuel actif : code Mensuel refusé (même pour l''admin)', pg_temp.refused($q$INSERT INTO public.admin_codes(code,type,client_email,status) VALUES ('FP-AD-0001','monthly','mensuel@test.invalid','pending')$q$));
SELECT pg_temp.ok('abonné Mensuel actif : formule configurée plus courte refusée', pg_temp.refused($q$INSERT INTO public.admin_codes(code,type,client_email,status) VALUES ('FP-AD-0002','p_court5','mensuel@test.invalid','pending')$q$));
INSERT INTO public.admin_codes(code,type,client_email,status) VALUES ('FP-AD-0003','annual','mensuel@test.invalid','pending');
INSERT INTO public.admin_codes(code,type,client_email,status) VALUES ('FP-AD-0004','p_trim5','mensuel@test.invalid','pending');
SELECT pg_temp.ok('abonné Mensuel actif : Annuel et formule plus longue (91 j) autorisés', (SELECT count(*) FROM public.admin_codes WHERE code IN ('FP-AD-0003','FP-AD-0004')) = 2);
INSERT INTO public.admin_codes(code,type,client_email,status) VALUES ('FP-AD-0005','monthly','expire@test.invalid','pending');
SELECT pg_temp.ok('abonnement expiré : renouvellement autorisé', (SELECT count(*) FROM public.admin_codes WHERE code='FP-AD-0005') = 1);
INSERT INTO public.admin_codes(code,type,client_email,status) VALUES ('FP-AD-0006','monthly','essai@test.invalid','pending');
SELECT pg_temp.ok('essai en cours : code autorisé', (SELECT count(*) FROM public.admin_codes WHERE code='FP-AD-0006') = 1);
SELECT pg_temp.ok('accès à vie : tout code refusé', pg_temp.refused($q$INSERT INTO public.admin_codes(code,type,client_email,status) VALUES ('FP-AD-0007','annual','viager@test.invalid','pending')$q$) AND pg_temp.refused($q$INSERT INTO public.admin_codes(code,type,client_email,status) VALUES ('FP-AD-0008','lifetime','viager@test.invalid','pending')$q$));
INSERT INTO public.admin_codes(code,type,client_email,status) VALUES ('FP-AD-0009','monthly',NULL,'pending');
SELECT pg_temp.ok('code libre sans e-mail : non concerné', (SELECT count(*) FROM public.admin_codes WHERE code='FP-AD-0009') = 1);
INSERT INTO public.admin_codes(code,type,client_email,status) VALUES ('FP-AD-0010','lifetime','mensuel@test.invalid','pending');
SELECT pg_temp.ok('abonné Mensuel actif : accès à vie (plus généreux) autorisé', (SELECT count(*) FROM public.admin_codes WHERE code='FP-AD-0010') = 1);
RESET ROLE;

-- Demandes du client
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','d1d1d1d1-0000-0000-0000-000000000001',false), set_config('request.jwt.claim.email','mensuel@test.invalid',false);
SELECT pg_temp.ok('client abonné : demande de la même formule refusée', pg_temp.refused($q$INSERT INTO public.subscription_requests(client_email,tier,base_price,final_price,status) VALUES ('mensuel@test.invalid','monthly',49,49,'pending')$q$));
INSERT INTO public.subscription_requests(client_email,tier,base_price,final_price,status) VALUES ('mensuel@test.invalid','annual',449,449,'pending');
SELECT pg_temp.ok('client abonné : demande d''une formule plus longue autorisée', (SELECT count(*) FROM public.subscription_requests WHERE client_email='mensuel@test.invalid') = 1);
-- Un client qui a déjà un code émis plus tôt peut toujours l'activer (jamais bloqué après avoir payé)
SELECT pg_temp.ok('activation d''un code déjà émis : toujours possible', (public.activate_license('FP-AD-0003'))->>'ok' = 'true');
RESET ROLE;
SELECT pg_temp.ok('fonctions d''aide non exécutables par les comptes connectés', NOT has_function_privilege('authenticated', 'public.current_paid_days(text)', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.plan_days(text)', 'EXECUTE'));
-- Nettoyage : ne pas polluer les autres tests (demandes et formules de ce fichier)
DELETE FROM public.subscription_requests WHERE client_email = 'mensuel@test.invalid';
DELETE FROM public.plans WHERE key IN ('p_trim5', 'p_court5');
