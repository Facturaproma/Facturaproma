-- Codes de licence : auteur imposé par la base, journal, verrouillage.
\set VERBOSITY terse
SET client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.ok(name text, cond boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS
$$ BEGIN RAISE NOTICE '%', CASE WHEN cond THEN 'PASS '||name ELSE 'FAIL '||name||' '||detail END; END $$;
GRANT ALL ON public.admin_codes, public.admins, public.licenses TO authenticated;
INSERT INTO auth.users(id, email) VALUES
  ('c1c1c1c1-0000-0000-0000-000000000001', 'adm-a@test.invalid'),
  ('c2c2c2c2-0000-0000-0000-000000000002', 'client3@test.invalid');
INSERT INTO public.admins(email, password_hash, is_master) VALUES ('adm-a@test.invalid', 'x', false);

SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','c1c1c1c1-0000-0000-0000-000000000001',false), set_config('request.jwt.claim.email','adm-a@test.invalid',false);
INSERT INTO public.admin_codes(code, type, client_email, note, status, created_by) VALUES ('FP-TRAC-AAAA-0001','monthly','client3@test.invalid','Auto-généré depuis demande ab12cd34','pending','usurpation@x.com');
INSERT INTO public.admin_codes(code, type, client_email, note, status) VALUES ('FP-TRAC-AAAA-0002','annual','client3@test.invalid','cadeau','pending');
SELECT pg_temp.ok('auteur = login de l''admin connecté (valeur fournie par le navigateur écrasée)', (SELECT created_by FROM public.admin_codes WHERE code='FP-TRAC-AAAA-0001') = 'adm-a@test.invalid');
SELECT pg_temp.ok('journal : 2 créations avec le login, origine demande / manuel',
  (SELECT count(*) FROM public.admin_audit WHERE action='code_generated' AND admin_email='adm-a@test.invalid') = 2
  AND (SELECT count(*) FROM public.admin_audit WHERE action='code_generated' AND admin_email='adm-a@test.invalid' AND details->>'source'='demande') = 1
  AND (SELECT count(*) FROM public.admin_audit WHERE action='code_generated' AND admin_email='adm-a@test.invalid' AND details->>'source'='manuel') = 1);
SELECT pg_temp.ok('journal : jamais le code complet', (SELECT bool_and(details::text NOT LIKE '%FP-TRAC-AAAA%') FROM public.admin_audit WHERE action='code_generated') AND (SELECT details->>'code_end' FROM public.admin_audit WHERE action='code_generated' AND admin_email='adm-a@test.invalid' ORDER BY at, id LIMIT 1) = '0001');
DO $$ DECLARE r boolean := false; BEGIN
  BEGIN UPDATE public.admin_codes SET client_email='pirate@x.com' WHERE code='FP-TRAC-AAAA-0002'; EXCEPTION WHEN insufficient_privilege THEN r := true; END;
  PERFORM pg_temp.ok('verrouillé : l''e-mail du client ne peut plus changer', r); END $$;
DO $$ DECLARE r boolean := false; BEGIN
  BEGIN UPDATE public.admin_codes SET type='lifetime' WHERE code='FP-TRAC-AAAA-0002'; EXCEPTION WHEN insufficient_privilege THEN r := true; END;
  PERFORM pg_temp.ok('verrouillé : la formule ne peut plus changer', r); END $$;
DO $$ DECLARE r boolean := false; BEGIN
  BEGIN UPDATE public.admin_codes SET created_by='autre@x.com' WHERE code='FP-TRAC-AAAA-0002'; EXCEPTION WHEN insufficient_privilege THEN r := true; END;
  PERFORM pg_temp.ok('verrouillé : l''auteur ne peut plus changer', r); END $$;
UPDATE public.admin_codes SET status='revoked' WHERE code='FP-TRAC-AAAA-0002';
SELECT pg_temp.ok('révocation autorisée et journalisée', (SELECT status FROM public.admin_codes WHERE code='FP-TRAC-AAAA-0002') = 'revoked' AND (SELECT count(*) FROM public.admin_audit WHERE action='code_revoked' AND admin_email='adm-a@test.invalid') = 1);
RESET ROLE;
-- Le client active son code : statut et date modifiables (pas bloqués par le verrou)
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','c2c2c2c2-0000-0000-0000-000000000002',false), set_config('request.jwt.claim.email','client3@test.invalid',false);
SELECT pg_temp.ok('activation par le client toujours possible', (public.activate_license('FP-TRAC-AAAA-0001'))->>'ok' = 'true');
RESET ROLE;
SELECT pg_temp.ok('code activé : statut « used »', (SELECT status FROM public.admin_codes WHERE code='FP-TRAC-AAAA-0001') = 'used');
