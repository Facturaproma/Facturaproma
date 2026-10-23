-- admin_set_license : pas de changement de formule sur un abonnement payant actif vers une formule non plus longue.
\set VERBOSITY terse
SET client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.ok(name text, cond boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS
$$ BEGIN RAISE NOTICE '%', CASE WHEN cond THEN 'PASS '||name ELSE 'FAIL '||name||' '||detail END; END $$;
INSERT INTO auth.users(id, email) VALUES
  ('a1a1a1a1-0000-0000-0000-0000000000a1', 'annuel-l@test.invalid'),
  ('a2a2a2a2-0000-0000-0000-0000000000a2', 'mensuel-l@test.invalid'),
  ('a3a3a3a3-0000-0000-0000-0000000000a3', 'vie-l@test.invalid'),
  ('a4a4a4a4-0000-0000-0000-0000000000a4', 'adm-l@test.invalid');
INSERT INTO public.admins(email, password_hash, is_master) VALUES ('adm-l@test.invalid', 'x', true);
INSERT INTO public.licenses(user_id, type, status, started_at, expires_at) VALUES
  ('a1a1a1a1-0000-0000-0000-0000000000a1', 'annual', 'active', now(), now() + interval '300 days'),
  ('a2a2a2a2-0000-0000-0000-0000000000a2', 'monthly', 'active', now(), now() + interval '10 days'),
  ('a3a3a3a3-0000-0000-0000-0000000000a3', 'lifetime', 'active', now(), NULL);
GRANT ALL ON public.licenses TO authenticated;
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','a4a4a4a4-0000-0000-0000-0000000000a4',false), set_config('request.jwt.claim.email','adm-l@test.invalid',false);
SELECT pg_temp.ok('Annuel actif -> Mensuel : refusé', (public.admin_set_license('a1a1a1a1-0000-0000-0000-0000000000a1','monthly',30))->>'reason' = 'already_subscribed');
SELECT pg_temp.ok('Annuel actif -> essai : refusé', (public.admin_set_license('a1a1a1a1-0000-0000-0000-0000000000a1','trial',7))->>'reason' = 'already_subscribed');
SELECT pg_temp.ok('la licence Annuel n''a pas changé', (SELECT type FROM public.licenses WHERE user_id='a1a1a1a1-0000-0000-0000-0000000000a1') = 'annual');
SELECT public.admin_set_license('a1a1a1a1-0000-0000-0000-0000000000a1',NULL,30);
SELECT pg_temp.ok('Annuel actif : prolongation (p_type NULL, 30 j) autorisée = programmation à la suite', (SELECT type = 'annual' AND expires_at > now() + interval '329 days' FROM public.licenses WHERE user_id='a1a1a1a1-0000-0000-0000-0000000000a1'));
SELECT pg_temp.ok('Annuel actif : suspension autorisée', (public.admin_set_license('a1a1a1a1-0000-0000-0000-0000000000a1',NULL,NULL,'suspended'))->>'ok' = 'true');
SELECT pg_temp.ok('Mensuel actif -> Annuel : autorisé (plus long)', (public.admin_set_license('a2a2a2a2-0000-0000-0000-0000000000a2','annual',365))->>'ok' = 'true');
SELECT pg_temp.ok('Annuel (après changement) -> retour au Mensuel : refusé', (public.admin_set_license('a2a2a2a2-0000-0000-0000-0000000000a2','monthly',30))->>'reason' = 'already_subscribed');
SELECT pg_temp.ok('accès à vie : l''admin peut le corriger (offert, pas un abonnement payé)', (public.admin_set_license('a3a3a3a3-0000-0000-0000-0000000000a3','monthly',30))->>'ok' = 'true');
RESET ROLE;
UPDATE public.licenses SET expires_at = now() - interval '1 day', status = 'active' WHERE user_id='a2a2a2a2-0000-0000-0000-0000000000a2';
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','a4a4a4a4-0000-0000-0000-0000000000a4',false), set_config('request.jwt.claim.email','adm-l@test.invalid',false);
SELECT pg_temp.ok('abonnement expiré : changement libre', (public.admin_set_license('a2a2a2a2-0000-0000-0000-0000000000a2','monthly',30))->>'ok' = 'true');
RESET ROLE;
