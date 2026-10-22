-- get_contact_info() : seules les coordonnées de contact sont exposées, aux comptes connectés uniquement.
\set VERBOSITY terse
SET client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.ok(name text, cond boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS
$$ BEGIN RAISE NOTICE '%', CASE WHEN cond THEN 'PASS '||name ELSE 'FAIL '||name||' '||detail END; END $$;

-- 1. Non configuré : chaînes vides (l'application n'affiche alors aucun faux numéro)
DELETE FROM public.admin_settings WHERE key IN ('whatsapp_number','contact_email','bank_rib','bank_name','bank_beneficiary');
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', 'd4d4d4d4-0000-0000-0000-00000000000d', false);
SELECT pg_temp.ok('contact non configuré : valeurs vides', public.get_contact_info() = '{"whatsapp":"","email":""}'::jsonb, public.get_contact_info()::text);
RESET ROLE;

-- 2. Configuré (réglages écrits par l'administrateur) : les deux coordonnées sont renvoyées, rien d'autre
INSERT INTO public.admin_settings(key, value) VALUES
  ('whatsapp_number', ' +212 600 00 00 01 '), ('contact_email', 'support@exemple.test'),
  ('bank_rib', '000 000 0000000000000000 00'), ('bank_name', 'Banque test'), ('bank_beneficiary', 'Société test');
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', 'd4d4d4d4-0000-0000-0000-00000000000d', false);
SELECT pg_temp.ok('contact configuré : WhatsApp et e-mail renvoyés (espaces de bord retirés)',
  public.get_contact_info() = '{"whatsapp":"+212 600 00 00 01","email":"support@exemple.test"}'::jsonb, public.get_contact_info()::text);
SELECT pg_temp.ok('le RIB, la banque et le bénéficiaire ne sont JAMAIS renvoyés',
  public.get_contact_info()::text !~ '(rib|0000000000000000|Banque|Société|bank)', public.get_contact_info()::text);
SELECT pg_temp.ok('seules deux clés sont exposées', (SELECT count(*) FROM jsonb_object_keys(public.get_contact_info())) = 2);
-- Un compte connecté ordinaire ne peut toujours PAS lire la table des réglages
DO $$ DECLARE refused boolean := false; n int; BEGIN
  BEGIN SELECT count(*) INTO n FROM public.admin_settings; refused := (n = 0);
  EXCEPTION WHEN insufficient_privilege THEN refused := true; END;
  PERFORM pg_temp.ok('un compte ordinaire ne lit pas admin_settings (droit refusé ou 0 ligne)', refused);
END $$;
RESET ROLE;

-- 3. Aucun accès pour un visiteur non connecté
SELECT pg_temp.ok('anon : EXECUTE refusé', NOT has_function_privilege('anon', 'public.get_contact_info()', 'EXECUTE'));
SELECT pg_temp.ok('authenticated : EXECUTE accordé', has_function_privilege('authenticated', 'public.get_contact_info()', 'EXECUTE'));
SELECT pg_temp.ok('fonction SECURITY DEFINER avec search_path fixé',
  EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = 'get_contact_info' AND p.prosecdef AND EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig,'{}')) c WHERE c LIKE 'search_path=%')));

DELETE FROM public.admin_settings WHERE key IN ('whatsapp_number','contact_email','bank_rib','bank_name','bank_beneficiary');
