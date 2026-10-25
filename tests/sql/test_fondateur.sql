-- Offre Fondateur (sql/27) : plafond de 30 codes, interrupteur Master, révocation, aucun effet sur les autres codes.
\set VERBOSITY terse
SET client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.ok(name text, cond boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS
$$ BEGIN RAISE NOTICE '%', CASE WHEN cond THEN 'PASS '||name ELSE 'FAIL '||name||' '||detail END; END $$;
-- Les autres scripts de test laissent des codes fondateurs : on repart de zéro (base de test jetable)
DELETE FROM public.admin_codes WHERE note ~ '^FONDATEUR';
DELETE FROM public.admin_settings WHERE key = 'founder_open';
GRANT ALL ON public.admin_codes, public.admin_settings, public.admins TO authenticated;
INSERT INTO auth.users(id, email) VALUES
  ('a7a7a7a7-0000-0000-0000-000000000001', 'boss27@test.invalid'),
  ('a7a7a7a7-0000-0000-0000-000000000002', 'adm27@test.invalid');
INSERT INTO public.admins(email, password_hash, is_master) VALUES ('boss27@test.invalid', 'x', true), ('adm27@test.invalid', 'x', false);

-- Administrateur simple : 30 codes fondateurs acceptés, le 31e refusé
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','a7a7a7a7-0000-0000-0000-000000000002',false), set_config('request.jwt.claim.email','adm27@test.invalid',false);
INSERT INTO public.admin_codes(code, type, client_email, note, status) SELECT 'FP-F27-'||lpad(g::text,4,'0'), 'annual', 'c'||g||'@test.invalid', 'FONDATEUR 299 DH/an', 'pending' FROM generate_series(1,30) g;
SELECT pg_temp.ok('30 codes fondateurs acceptés', (SELECT count(*) FROM public.admin_codes WHERE note ~ '^FONDATEUR') = 30);
DO $$ DECLARE r text := ''; BEGIN
  BEGIN INSERT INTO public.admin_codes(code, type, client_email, note, status) VALUES ('FP-F27-9999','annual','c31@test.invalid','FONDATEUR 299 DH/an','pending'); EXCEPTION WHEN OTHERS THEN r := SQLERRM; END;
  PERFORM pg_temp.ok('le 31e code fondateur est refusé par la base', r LIKE 'LIMITE_FONDATEUR_ATTEINTE%', r); END $$;
-- Un code ordinaire (annuel sans la note FONDATEUR) n'est pas concerné
INSERT INTO public.admin_codes(code, type, client_email, note, status) VALUES ('FP-ORD-0001','annual','ord@test.invalid','','pending');
SELECT pg_temp.ok('un code annuel ordinaire reste possible, plafond atteint', (SELECT count(*) FROM public.admin_codes WHERE code='FP-ORD-0001') = 1);
-- Modifier un code déjà compté (activation) reste possible
UPDATE public.admin_codes SET status='activated', activated_at=now() WHERE code='FP-F27-0001';
SELECT pg_temp.ok('l''activation d''un code fondateur existant n''est pas bloquée', (SELECT status FROM public.admin_codes WHERE code='FP-F27-0001') = 'activated');
-- Révocation : libère une place
UPDATE public.admin_codes SET status='revoked' WHERE code='FP-F27-0002';
INSERT INTO public.admin_codes(code, type, client_email, note, status) VALUES ('FP-F27-9998','annual','c32@test.invalid','FONDATEUR 299 DH/an','pending');
SELECT pg_temp.ok('une révocation libère une place', (SELECT count(*) FROM public.admin_codes WHERE note ~ '^FONDATEUR' AND status <> 'revoked') = 30);
DO $$ DECLARE r text := ''; BEGIN
  BEGIN UPDATE public.admin_codes SET status='pending' WHERE code='FP-F27-0002'; EXCEPTION WHEN OTHERS THEN r := SQLERRM; END;
  PERFORM pg_temp.ok('remettre en vigueur un code révoqué compte comme une émission (plafond)', r LIKE 'LIMITE_FONDATEUR_ATTEINTE%', r); END $$;
-- Un administrateur simple ne peut pas fermer l'offre
DO $$ DECLARE r text := ''; BEGIN
  BEGIN INSERT INTO public.admin_settings(key, value) VALUES ('founder_open', 'false'); EXCEPTION WHEN OTHERS THEN r := SQLERRM; END;
  PERFORM pg_temp.ok('un administrateur non-Master ne peut pas fermer l''offre', r LIKE 'MASTER_REQUIS%', r); END $$;
RESET ROLE;

-- Master : ferme l'offre ; les nouveaux codes fondateurs sont refusés même sous le plafond
DELETE FROM public.admin_codes WHERE code LIKE 'FP-F27-%' AND code <> 'FP-F27-0001';
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','a7a7a7a7-0000-0000-0000-000000000001',false), set_config('request.jwt.claim.email','boss27@test.invalid',false);
INSERT INTO public.admin_settings(key, value) VALUES ('founder_open', 'false') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
SELECT pg_temp.ok('le Master ferme l''offre Fondateur', (SELECT value FROM public.admin_settings WHERE key='founder_open') = 'false');
DO $$ DECLARE r text := ''; BEGIN
  BEGIN INSERT INTO public.admin_codes(code, type, client_email, note, status) VALUES ('FP-F27-5001','annual','n1@test.invalid','FONDATEUR 299 DH/an','pending'); EXCEPTION WHEN OTHERS THEN r := SQLERRM; END;
  PERFORM pg_temp.ok('offre fermée : nouveau code fondateur refusé (même sous 30)', r LIKE 'OFFRE_FONDATEUR_FERMEE%', r); END $$;
INSERT INTO public.admin_codes(code, type, client_email, note, status) VALUES ('FP-ORD-0002','annual','ord2@test.invalid','','pending');
SELECT pg_temp.ok('offre fermée : un code annuel ordinaire reste possible', (SELECT count(*) FROM public.admin_codes WHERE code='FP-ORD-0002') = 1);
UPDATE public.admin_codes SET status='activated' WHERE code='FP-F27-0001';
SELECT pg_temp.ok('offre fermée : les codes fondateurs déjà émis restent utilisables', (SELECT status FROM public.admin_codes WHERE code='FP-F27-0001') = 'activated');
UPDATE public.admin_settings SET value = 'true' WHERE key = 'founder_open';
INSERT INTO public.admin_codes(code, type, client_email, note, status) VALUES ('FP-F27-5002','annual','n2@test.invalid','FONDATEUR 299 DH/an','pending');
SELECT pg_temp.ok('le Master rouvre l''offre : un code fondateur est de nouveau possible', (SELECT count(*) FROM public.admin_codes WHERE code='FP-F27-5002') = 1);
-- Les autres réglages restent modifiables par un administrateur (WhatsApp, e-mail…) : le déclencheur ne vise que founder_open
RESET ROLE;
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','a7a7a7a7-0000-0000-0000-000000000002',false), set_config('request.jwt.claim.email','adm27@test.invalid',false);
INSERT INTO public.admin_settings(key, value) VALUES ('whatsapp_number', '+212600000000') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
SELECT pg_temp.ok('un administrateur simple modifie toujours les autres réglages', (SELECT value FROM public.admin_settings WHERE key='whatsapp_number') = '+212600000000');
RESET ROLE;

-- Nettoyage : ne laisse aucun code fondateur ni interrupteur aux tests suivants
DELETE FROM public.admin_codes WHERE note ~ '^FONDATEUR' OR code LIKE 'FP-ORD-%';
DELETE FROM public.admin_settings WHERE key IN ('founder_open', 'whatsapp_number');
