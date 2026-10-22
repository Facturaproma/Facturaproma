-- Parcours client : demande d'abonnement (RLS) -> code créé par l'admin -> activation par le client (RPC activate_license).
\set VERBOSITY terse
SET client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.ok(name text, cond boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS
$$ BEGIN RAISE NOTICE '%', CASE WHEN cond THEN 'PASS '||name ELSE 'FAIL '||name||' '||detail END; END $$;

-- Supabase accorde par défaut tous les droits aux rôles connectés : on l'imite (06 ne révoque que anon), la protection réelle est la RLS testée ici
GRANT ALL ON public.subscription_requests, public.admin_codes, public.licenses, public.admins TO authenticated;

INSERT INTO auth.users(id, email) VALUES
  ('e1e1e1e1-0000-0000-0000-000000000001', 'client@test.invalid'),
  ('e2e2e2e2-0000-0000-0000-000000000002', 'autre@test.invalid'),
  ('e3e3e3e3-0000-0000-0000-000000000003', 'boss@test.invalid');
INSERT INTO public.admins(email, password_hash, is_master) VALUES ('boss@test.invalid', 'x', true);
INSERT INTO public.licenses(user_id, type, status, expires_at) VALUES
  ('e1e1e1e1-0000-0000-0000-000000000001', 'trial', 'active', now() - interval '1 day');   -- essai de 14 jours terminé

-- 1. Le client crée sa demande (virement) ; il ne peut pas en créer une au nom d'un autre ni la marquer « traitée »
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','e1e1e1e1-0000-0000-0000-000000000001',false), set_config('request.jwt.claim.email','client@test.invalid',false);
INSERT INTO public.subscription_requests(client_email, tier, base_price, final_price, status) VALUES ('client@test.invalid','annual',449,449,'pending');
SELECT pg_temp.ok('le client crée sa propre demande', (SELECT count(*) FROM public.subscription_requests) = 1);
DO $$ DECLARE r boolean := false; BEGIN
  BEGIN INSERT INTO public.subscription_requests(client_email, tier, base_price, final_price, status) VALUES ('autre@test.invalid','annual',449,449,'pending');
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN r := true; END;
  PERFORM pg_temp.ok('le client ne peut pas créer une demande au nom d''un autre e-mail', r); END $$;
DO $$ DECLARE r boolean := false; BEGIN
  BEGIN INSERT INTO public.subscription_requests(client_email, tier, base_price, final_price, status, license_code) VALUES ('client@test.invalid','annual',449,449,'processed','FP-XXXX');
  EXCEPTION WHEN OTHERS THEN r := true; END;   -- refus par la RLS ou par l'anti-abus (une demande en attente par client)
  PERFORM pg_temp.ok('le client ne peut pas se déclarer « traité » ni s''attribuer un code', r); END $$;
DO $$ DECLARE r boolean := false; n int; BEGIN
  BEGIN SELECT count(*) INTO n FROM public.admin_codes; r := (n = 0); EXCEPTION WHEN insufficient_privilege THEN r := true; END;
  PERFORM pg_temp.ok('le client ne voit aucun code (admin_codes)', r); END $$;
-- Sans code valide, impossible de s'attribuer une licence directement (pas d'écriture sur sa propre licence payante)
DO $$ DECLARE r boolean := false; n int; BEGIN
  BEGIN UPDATE public.licenses SET type='lifetime', expires_at=NULL, status='active' WHERE user_id='e1e1e1e1-0000-0000-0000-000000000001'; GET DIAGNOSTICS n = ROW_COUNT; r := (n = 0);
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN r := true; END;
  PERFORM pg_temp.ok('le client ne peut pas modifier lui-même sa licence', r, 'lignes modifiées='||coalesce(n,-1)); END $$;
RESET ROLE;

-- 2. L'autre client ne voit pas la demande
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','e2e2e2e2-0000-0000-0000-000000000002',false), set_config('request.jwt.claim.email','autre@test.invalid',false);
SELECT pg_temp.ok('un autre client ne voit pas la demande', (SELECT count(*) FROM public.subscription_requests) = 0);
RESET ROLE;

-- 3. L'admin voit la demande et crée le code (comme admin.html : insertion admin_codes puis demande « processed »)
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','e3e3e3e3-0000-0000-0000-000000000003',false), set_config('request.jwt.claim.email','boss@test.invalid',false);
SELECT pg_temp.ok('l''admin voit la demande en attente', (SELECT count(*) FROM public.subscription_requests WHERE status='pending') = 1);
INSERT INTO public.admin_codes(code, type, client_email, note, status) VALUES ('FP-TEST-AAAA-0001','annual','client@test.invalid','FONDATEUR 299 DH/an','pending'),
                                                                              ('FP-TEST-AAAA-0002','monthly',NULL,'code libre','pending');
UPDATE public.subscription_requests SET status='processed', processed_at=now(), license_code='FP-TEST-AAAA-0001' WHERE client_email='client@test.invalid';
SELECT pg_temp.ok('l''admin crée le code et marque la demande traitée', (SELECT status FROM public.subscription_requests) = 'processed');
RESET ROLE;

-- 4. Activation par le client
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','e2e2e2e2-0000-0000-0000-000000000002',false), set_config('request.jwt.claim.email','autre@test.invalid',false);
SELECT pg_temp.ok('code attribué à un autre e-mail : refusé (wrong_email)', public.activate_license('FP-TEST-AAAA-0001')->>'reason' = 'wrong_email');
RESET ROLE;
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','e1e1e1e1-0000-0000-0000-000000000001',false), set_config('request.jwt.claim.email','client@test.invalid',false);
SELECT pg_temp.ok('code inexistant : refusé (invalid)', public.activate_license('FP-NOPE')->>'reason' = 'invalid');
SELECT pg_temp.ok('avant activation : licence inactive (essai terminé)', public.has_active_license() IS FALSE);
SELECT pg_temp.ok('activation avec espaces et minuscules : acceptée', (public.activate_license('  fp-test-aaaa-0001 ')->>'ok')::boolean IS TRUE);
SELECT pg_temp.ok('après activation : licence active', public.has_active_license() IS TRUE);
SELECT pg_temp.ok('licence annuelle : environ 365 jours', (SELECT expires_at BETWEEN now() + interval '364 days' AND now() + interval '366 days' FROM public.licenses WHERE user_id = auth.uid()));
SELECT pg_temp.ok('le même code ne peut pas être réutilisé (used)', public.activate_license('FP-TEST-AAAA-0001')->>'reason' = 'used');
-- Renouvellement : un second code mensuel s'ajoute à la fin actuelle (rien n'est perdu)
SELECT pg_temp.ok('code libre mensuel : accepté', (public.activate_license('FP-TEST-AAAA-0002')->>'ok')::boolean IS TRUE);
SELECT pg_temp.ok('renouvellement : la durée s''ajoute à la fin actuelle (≈ 395 jours)', (SELECT expires_at BETWEEN now() + interval '393 days' AND now() + interval '396 days' FROM public.licenses WHERE user_id = auth.uid()));
RESET ROLE;

-- 5. Code révoqué et visiteur anonyme
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','e3e3e3e3-0000-0000-0000-000000000003',false), set_config('request.jwt.claim.email','boss@test.invalid',false);
INSERT INTO public.admin_codes(code, type, client_email, status) VALUES ('FP-TEST-AAAA-0003','annual',NULL,'revoked');
RESET ROLE;
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','e2e2e2e2-0000-0000-0000-000000000002',false), set_config('request.jwt.claim.email','autre@test.invalid',false);
SELECT pg_temp.ok('code révoqué : refusé (revoked)', public.activate_license('FP-TEST-AAAA-0003')->>'reason' = 'revoked');
RESET ROLE;
SELECT pg_temp.ok('anon ne peut pas exécuter activate_license', NOT has_function_privilege('anon','public.activate_license(text)','EXECUTE'));
