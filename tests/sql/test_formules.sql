-- Formules configurables : seul le Master écrit ; lecture par les comptes connectés ; activation d'un code de formule configurée.
\set VERBOSITY terse
SET client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.ok(name text, cond boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS
$$ BEGIN RAISE NOTICE '%', CASE WHEN cond THEN 'PASS '||name ELSE 'FAIL '||name||' '||detail END; END $$;
GRANT ALL ON public.admin_codes, public.licenses, public.admins TO authenticated;
INSERT INTO auth.users(id, email) VALUES
  ('f1f1f1f1-0000-0000-0000-000000000001', 'client2@test.invalid'),
  ('f3f3f3f3-0000-0000-0000-000000000003', 'boss2@test.invalid'),
  ('f4f4f4f4-0000-0000-0000-000000000004', 'adm2@test.invalid');
INSERT INTO public.admins(email, password_hash, is_master) VALUES ('boss2@test.invalid', 'x', true), ('adm2@test.invalid', 'x', false);

-- Master : crée une formule
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','f3f3f3f3-0000-0000-0000-000000000003',false), set_config('request.jwt.claim.email','boss2@test.invalid',false);
SELECT pg_temp.ok('le Master crée une formule', (public.owner_save_plan('p_trimestriel','Trimestriel',129,91,'3 mois',true,50))->>'ok' = 'true');
SELECT public.owner_save_plan('p_trimestriel','Trimestriel',119,91,'3 mois',true,50);
SELECT pg_temp.ok('le Master la modifie (prix)', (SELECT price_dh FROM public.plans WHERE key='p_trimestriel') = 119);
SELECT pg_temp.ok('clé invalide refusée', (public.owner_save_plan('annual','X',10,30))->>'reason' = 'bad_key');
SELECT pg_temp.ok('prix nul refusé', (public.owner_save_plan('p_gratuit','Gratuit',0,30))->>'reason' = 'bad_price');
SELECT pg_temp.ok('durée absurde refusée', (public.owner_save_plan('p_long','Long',10,99999))->>'reason' = 'bad_days');
SELECT pg_temp.ok('modification journalisée', (SELECT count(*) FROM public.admin_audit WHERE action='plan_save') = 2);
INSERT INTO public.admin_codes(code, type, client_email, status) VALUES ('FP-PLAN-AAAA-0001','p_trimestriel','client2@test.invalid','pending');
RESET ROLE;

-- Administrateur simple : refusé
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','f4f4f4f4-0000-0000-0000-000000000004',false), set_config('request.jwt.claim.email','adm2@test.invalid',false);
DO $$ DECLARE r boolean := false; BEGIN
  BEGIN PERFORM public.owner_save_plan('p_pirate','Pirate',1,1); EXCEPTION WHEN insufficient_privilege THEN r := true; END;
  PERFORM pg_temp.ok('un administrateur non-Master ne peut pas créer de formule', r); END $$;
RESET ROLE;

-- Client : lit les formules actives, n'écrit pas, active le code
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','f1f1f1f1-0000-0000-0000-000000000001',false), set_config('request.jwt.claim.email','client2@test.invalid',false);
SELECT pg_temp.ok('le client voit la formule active', (SELECT count(*) FROM public.plans WHERE key='p_trimestriel') = 1);
DO $$ DECLARE r boolean := false; BEGIN
  BEGIN INSERT INTO public.plans(key,label,price_dh,duration_days) VALUES ('p_fraude','Fraude',1,1); EXCEPTION WHEN insufficient_privilege THEN r := true; END;
  PERFORM pg_temp.ok('le client ne peut pas écrire dans plans', r); END $$;
DO $$ DECLARE r boolean := false; BEGIN
  BEGIN UPDATE public.plans SET price_dh = 1; EXCEPTION WHEN OTHERS THEN r := true; END; r := r OR (SELECT price_dh FROM public.plans LIMIT 1) <> 1;
  PERFORM pg_temp.ok('le client ne peut pas modifier un prix', r); END $$;
SELECT pg_temp.ok('activation du code de la formule', (public.activate_license('FP-PLAN-AAAA-0001'))->>'ok' = 'true');
SELECT pg_temp.ok('licence = payante standard (monthly), expirant dans ~91 jours', (SELECT type = 'monthly' AND expires_at BETWEEN now() + interval '90 days' AND now() + interval '92 days' FROM public.licenses WHERE user_id='f1f1f1f1-0000-0000-0000-000000000001'));
SELECT pg_temp.ok('licence active', public.has_active_license() IS TRUE);
SELECT pg_temp.ok('my_license renvoie la formule', (public.my_license())->>'plan_key' = 'p_trimestriel' AND (public.my_license())->>'plan_label' = 'Trimestriel');
RESET ROLE;

-- Désactivation : invisible pour le client, mais le code déjà vendu reste valable
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','f3f3f3f3-0000-0000-0000-000000000003',false), set_config('request.jwt.claim.email','boss2@test.invalid',false);
SELECT public.owner_save_plan('p_trimestriel','Trimestriel',119,91,'3 mois',false,50);
INSERT INTO public.admin_codes(code, type, client_email, status) VALUES ('FP-PLAN-AAAA-0002','p_trimestriel',NULL,'pending');
RESET ROLE;
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','f1f1f1f1-0000-0000-0000-000000000001',false), set_config('request.jwt.claim.email','client2@test.invalid',false);
SELECT pg_temp.ok('formule désactivée : invisible pour le client', (SELECT count(*) FROM public.plans) = 0);
SELECT pg_temp.ok('code d''une formule désactivée : toujours activable (déjà vendu)', (public.activate_license('FP-PLAN-AAAA-0002'))->>'ok' = 'true');
RESET ROLE;
