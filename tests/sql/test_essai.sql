-- Durée de l'essai (décision du 12/11/2026) : 30 jours pour les comptes créés après l'activation ; comptes antérieurs inchangés (14 jours).
\set VERBOSITY terse
SET client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.ok(name text, cond boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS
$$ BEGIN RAISE NOTICE '%', CASE WHEN cond THEN 'PASS '||name ELSE 'FAIL '||name||' '||detail END; END $$;
CREATE OR REPLACE FUNCTION pg_temp.as_user(u text) RETURNS void LANGUAGE sql AS $$ SELECT set_config('request.jwt.claim.sub', u, false) $$;
CREATE OR REPLACE FUNCTION pg_temp.err(sql text) RETURNS text LANGUAGE plpgsql AS
$$ BEGIN EXECUTE sql; RETURN ''; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $$;
GRANT EXECUTE ON FUNCTION pg_temp.ok(text, boolean, text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION pg_temp.err(text) TO PUBLIC;

-- Comptes sans ligne de licence : ancien (40 jours), récent (20 jours), nouveau (aujourd'hui) ; un compte avec une licence d'essai déjà écrite
INSERT INTO auth.users(id, email, created_at, email_confirmed_at) VALUES
  ('30303030-0000-4000-8000-000000000001', 'essai-ancien@test.invalid',  now() - interval '40 days', now()),
  ('30303030-0000-4000-8000-000000000002', 'essai-recent@test.invalid',  now() - interval '20 days', now()),
  ('30303030-0000-4000-8000-000000000003', 'essai-nouveau@test.invalid', now(), now()),
  ('30303030-0000-4000-8000-000000000004', 'essai-ecrit@test.invalid',   now() - interval '20 days', now());
INSERT INTO public.licenses(user_id, type, status, started_at, expires_at)
  VALUES ('30303030-0000-4000-8000-000000000004', 'trial', 'active', now() - interval '20 days', now() - interval '6 days');

SELECT pg_temp.ok('réglage fermé : RLS sans politique, aucun droit direct',
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.trial_config'::regclass)
  AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'trial_config'));
-- (test_droits.sql accorde plus tôt GRANT ALL ON ALL TABLES à authenticated : le vrai verrou est RLS sans politique, vérifié ici)
SET ROLE authenticated;
SELECT pg_temp.ok('réglage invisible pour un utilisateur connecté (refusé ou vide)',
  pg_temp.err('DO $x$ BEGIN IF (SELECT count(*) FROM public.trial_config) > 0 THEN RAISE EXCEPTION ''VISIBLE''; END IF; END $x$') NOT LIKE '%VISIBLE%');
SELECT pg_temp.err('UPDATE public.trial_config SET trial30_from = now()') AS tentative \gset
RESET ROLE;
SELECT pg_temp.ok('tentative de modification sans effet', (SELECT trial30_from IS NULL FROM public.trial_config));
SELECT pg_temp.ok('installation : nouveau système non activé (date d''activation vide)', (SELECT trial30_from IS NULL FROM public.trial_config));
SELECT pg_temp.ok('non activé : 14 jours pour tous, comportement identique à avant',
  public.fp_trial_days(now()) = 14 AND public.fp_trial_days(now() - interval '400 days') = 14
  AND public.fp_trial_end(TIMESTAMPTZ '2026-11-01 10:00+00') = TIMESTAMPTZ '2026-11-15 10:00+00');
SELECT pg_temp.ok('non activé : compte de 20 jours sans licence toujours expiré',
  public.has_active_license('30303030-0000-4000-8000-000000000002') = false
  AND public.has_active_license('30303030-0000-4000-8000-000000000003') = true);

-- Activation simulée il y a 25 jours (dans ce test seulement)
UPDATE public.trial_config SET trial30_from = now() - interval '25 days';
SELECT pg_temp.ok('activé : 30 jours pour un compte créé après l''activation',
  public.fp_trial_days(now() - interval '20 days') = 30 AND public.has_active_license('30303030-0000-4000-8000-000000000002') = true);
SELECT pg_temp.ok('activé : compte créé AVANT l''activation inchangé (14 jours, toujours expiré)',
  public.fp_trial_days(now() - interval '40 days') = 14 AND public.has_active_license('30303030-0000-4000-8000-000000000001') = false);
SELECT pg_temp.ok('activé : une licence d''essai déjà écrite n''est jamais prolongée',
  public.has_active_license('30303030-0000-4000-8000-000000000004') = false
  AND (SELECT expires_at < now() FROM public.licenses WHERE user_id = '30303030-0000-4000-8000-000000000004'));
SET ROLE authenticated; SELECT pg_temp.as_user('30303030-0000-4000-8000-000000000003');
SELECT public.my_license() IS NOT NULL AS cree \gset
RESET ROLE;
SELECT pg_temp.ok('activé : licence d''essai créée au premier accès = création + 30 jours',
  :'cree'::boolean AND (SELECT type = 'trial' AND expires_at = (SELECT created_at FROM auth.users WHERE id = '30303030-0000-4000-8000-000000000003') + interval '30 days'
                        FROM public.licenses WHERE user_id = '30303030-0000-4000-8000-000000000003'));
-- même instruction que sql/07 lors d'une réexécution
INSERT INTO public.trial_config (id, trial30_from) VALUES (true, NULL) ON CONFLICT (id) DO NOTHING;
SELECT pg_temp.ok('réexécuter sql/07 ne désactive pas (la date d''activation est conservée)', (SELECT trial30_from IS NOT NULL FROM public.trial_config));
UPDATE public.trial_config SET trial30_from = NULL;
DELETE FROM public.licenses WHERE user_id::text LIKE '30303030-%';
DELETE FROM auth.users WHERE id::text LIKE '30303030-%';
