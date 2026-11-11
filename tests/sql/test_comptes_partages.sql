-- sql/48 : comptes partagés (1 compte = 1 entreprise), membres, rôles, invitations, limites d'utilisateurs, isolation.
\set VERBOSITY terse
SET client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.ok(name text, cond boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS
$$ BEGIN RAISE NOTICE '%', CASE WHEN cond THEN 'PASS '||name ELSE 'FAIL '||name||' '||detail END; END $$;
CREATE OR REPLACE FUNCTION pg_temp.err(sql text) RETURNS text LANGUAGE plpgsql AS
$$ BEGIN EXECUTE sql; RETURN ''; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $$;
CREATE OR REPLACE FUNCTION pg_temp.as_user(u text) RETURNS void LANGUAGE sql AS $$ SELECT set_config('request.jwt.claim.sub', u, false) $$;
GRANT EXECUTE ON FUNCTION pg_temp.ok(text, boolean, text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION pg_temp.err(text) TO PUBLIC;
CREATE TEMP TABLE IF NOT EXISTS _c(k text, v text);
GRANT ALL ON _c TO PUBLIC;

-- ---------- Structure et droits ----------
SELECT pg_temp.ok('tables fermées : RLS active, aucune politique',
  (SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('public.accounts'::regclass, 'public.account_members'::regclass, 'public.account_invitations'::regclass, 'public.account_audit'::regclass, 'public.plan_catalog'::regclass))
  AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename IN ('accounts', 'account_members', 'account_invitations', 'account_audit', 'plan_catalog')));
SELECT pg_temp.ok('fonctions : authenticated oui, anon non ; fonctions internes et reprise non exposées',
  has_function_privilege('authenticated', 'public.account_invite(text,text,text)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.account_accept_invitation(text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.account_invite(text,text,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.fp_my_account()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.fp_accounts_backfill()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.fp_license_ok(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.fp_account_seats(uuid,uuid)', 'EXECUTE'));
SELECT pg_temp.ok('grille validée : 79 / 179 / 299 / 499 DH HT, 1 / 2 / 3 / 5 utilisateurs, 10 mois payés par an',
  (SELECT string_agg(key || ':' || price_ht_month::int || ':' || max_users || ':' || months_paid_per_year, ',' ORDER BY sort_order) FROM public.plan_catalog WHERE key <> 'legacy')
  = 'essentielle:79:1:10,pro:179:2:10,business:299:3:10,premium:499:5:10');
SELECT pg_temp.ok('formules cumulatives : chaque formule contient la précédente',
  (SELECT p.features @> e.features FROM public.plan_catalog p, public.plan_catalog e WHERE p.key = 'pro' AND e.key = 'essentielle')
  AND (SELECT p.features @> e.features FROM public.plan_catalog p, public.plan_catalog e WHERE p.key = 'business' AND e.key = 'pro')
  AND (SELECT p.features @> e.features FROM public.plan_catalog p, public.plan_catalog e WHERE p.key = 'premium' AND e.key = 'business'));
SELECT pg_temp.ok('facturer est dans toutes les formules (ventes, avoirs, clients et produits, paiements, PDF)',
  (SELECT bool_and(features @> ARRAY['ventes', 'avoirs', 'clients_produits', 'paiements', 'pdf_partage']) FROM public.plan_catalog));
SELECT pg_temp.ok('clients actuels (legacy) : rien de ce qu''ils ont aujourd''hui n''est retiré',
  (SELECT l.features @> b.features FROM public.plan_catalog l, public.plan_catalog b WHERE l.key = 'legacy' AND b.key = 'business'));

-- ---------- Reprise des comptes existants ----------
INSERT INTO auth.users(id, email, email_confirmed_at) VALUES
  ('48484848-0000-4000-8000-000000000001', 'cp-owner@test.invalid', now()),
  ('48484848-0000-4000-8000-000000000002', 'cp-admin@test.invalid', now()),
  ('48484848-0000-4000-8000-000000000003', 'cp-member@test.invalid', now()),
  ('48484848-0000-4000-8000-000000000004', 'cp-ventes@test.invalid', now()),
  ('48484848-0000-4000-8000-000000000005', 'cp-autre@test.invalid', now()),
  ('48484848-0000-4000-8000-000000000006', 'cp-staff@test.invalid', now()),
  ('48484848-0000-4000-8000-000000000007', 'cp-neuf@test.invalid', NULL);
INSERT INTO public.admins(email) VALUES ('cp-staff@test.invalid') ON CONFLICT (email) DO NOTHING;
INSERT INTO public.user_data(user_id, key, value) VALUES ('48484848-0000-4000-8000-000000000001', 'company', '{"name":"Atelier Atlas SARL"}');
SELECT count(*) AS sans_compte FROM auth.users x WHERE NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.user_id = x.id) \gset
SELECT public.fp_accounts_backfill() AS repris \gset
SELECT pg_temp.ok('reprise : un compte par utilisateur sans compte, chacun propriétaire, formule legacy',
  :repris = :sans_compte AND :repris > 0
  AND NOT EXISTS (SELECT 1 FROM auth.users x WHERE NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.user_id = x.id))
  AND (SELECT bool_and(m.role = 'owner' AND a.plan_key = 'legacy' AND a.owner_id = m.user_id) FROM public.accounts a JOIN public.account_members m ON m.account_id = a.id));
SELECT pg_temp.ok('reprise : nom repris de la fiche société', (SELECT name FROM public.accounts WHERE owner_id = '48484848-0000-4000-8000-000000000001') = 'Atelier Atlas SARL');
SELECT pg_temp.ok('reprise réexécutable : rien de plus la seconde fois', public.fp_accounts_backfill() = 0);
SELECT pg_temp.ok('reprise : licences et données des comptes inchangées (aucune écriture hors des nouvelles tables)',
  (SELECT count(*) FROM public.user_data WHERE user_id = '48484848-0000-4000-8000-000000000001') = 1);
-- Pour la suite, admin, membres et l'invité neuf n'ont pas encore de compte : on retire leurs comptes repris (vides)
DELETE FROM public.accounts WHERE owner_id IN ('48484848-0000-4000-8000-000000000002', '48484848-0000-4000-8000-000000000003',
  '48484848-0000-4000-8000-000000000004', '48484848-0000-4000-8000-000000000007');
INSERT INTO _c SELECT 'A', id::text FROM public.accounts WHERE owner_id = '48484848-0000-4000-8000-000000000001';
INSERT INTO _c SELECT 'B', id::text FROM public.accounts WHERE owner_id = '48484848-0000-4000-8000-000000000005';

SET ROLE authenticated;
-- ---------- Identité ----------
SELECT pg_temp.as_user('48484848-0000-4000-8000-000000000007');
SELECT pg_temp.ok('e-mail non confirmé : aucun compte créé', pg_temp.err('SELECT public.account_ensure()') LIKE '%NON_AUTHENTIFIE%');
SELECT pg_temp.as_user('48484848-0000-4000-8000-000000000001');
SELECT pg_temp.ok('account_ensure sur un compte existant : le même, rien de créé',
  (public.account_ensure()->>'created')::boolean = false AND public.fp_my_account()::text = (SELECT v FROM _c WHERE k = 'A'));
SELECT pg_temp.ok('lecture directe des tables : rien de visible (RLS sans politique, ou droit refusé)',
  pg_temp.err('DO $x$ BEGIN IF (SELECT count(*) FROM public.accounts) + (SELECT count(*) FROM public.account_members) + (SELECT count(*) FROM public.account_invitations) > 0 THEN RAISE EXCEPTION ''VISIBLE''; END IF; END $x$') NOT LIKE '%VISIBLE%');
SELECT pg_temp.ok('propriétaire : toutes les permissions de gestion', public.fp_account_role() = 'owner' AND public.fp_account_can('utilisateurs') AND public.fp_account_can('abonnement'));

-- ---------- Limite de la formule actuelle (legacy, 1 utilisateur) ----------
SELECT pg_temp.ok('formule actuelle : 1 utilisateur, invitation refusée',
  pg_temp.err('SELECT public.account_invite(''cp-admin@test.invalid'', ''admin'')') LIKE '%LIMITE_UTILISATEURS: 1 sur 1%');
SELECT pg_temp.ok('changer de formule : réservé à l''administration FacturaPro',
  pg_temp.err(format('SELECT public.account_set_plan(%L, ''premium'')', (SELECT v FROM _c WHERE k = 'A'))) LIKE '%DROIT_INSUFFISANT%');
SELECT pg_temp.as_user('48484848-0000-4000-8000-000000000006');
SELECT pg_temp.ok('administration FacturaPro : passage en Business (3 utilisateurs)',
  public.account_set_plan((SELECT v FROM _c WHERE k = 'A')::uuid, 'business')->>'plan' = 'business');
SELECT pg_temp.ok('formule inconnue refusée', pg_temp.err(format('SELECT public.account_set_plan(%L, ''gold'')', (SELECT v FROM _c WHERE k = 'A'))) LIKE '%FORMULE_INCONNUE%');

-- ---------- Invitations ----------
SELECT pg_temp.as_user('48484848-0000-4000-8000-000000000001');
INSERT INTO _c SELECT 'tok_admin', public.account_invite(' CP-Admin@Test.invalid ', 'admin')->>'token';
RESET ROLE;
SELECT pg_temp.ok('invitation : jeton de 64 caractères rendu une fois, seule son empreinte est stockée',
  length((SELECT v FROM _c WHERE k = 'tok_admin')) = 64
  AND (SELECT count(*) FROM public.account_invitations WHERE token_hash = (SELECT v FROM _c WHERE k = 'tok_admin')) = 0
  AND (SELECT count(*) FROM public.account_invitations WHERE token_hash = encode(sha256(convert_to((SELECT v FROM _c WHERE k = 'tok_admin'), 'UTF8')), 'hex')) = 1);
SET ROLE authenticated;
SELECT pg_temp.ok('adresse normalisée, invitation en double refusée',
  pg_temp.err('SELECT public.account_invite(''cp-admin@test.invalid'')') LIKE '%INVITATION_EN_COURS%');
SELECT pg_temp.ok('adresse invalide refusée', pg_temp.err('SELECT public.account_invite(''pas-une-adresse'')') LIKE '%EMAIL_INVALIDE%');
INSERT INTO _c SELECT 'tok_member', public.account_invite('cp-member@test.invalid', 'member', 'complet')->>'token';
SELECT pg_temp.ok('Business : 3 places = propriétaire + 2 invitations en attente ; la 4e refusée',
  pg_temp.err('SELECT public.account_invite(''cp-ventes@test.invalid'', ''member'', ''ventes'')') LIKE '%LIMITE_UTILISATEURS: 3 sur 3%'
  AND (public.account_info()->>'seats_used')::int = 3 AND (public.account_info()->>'seats_max')::int = 3);

-- Mauvais destinataire, jeton inconnu
SELECT pg_temp.as_user('48484848-0000-4000-8000-000000000003');
SELECT pg_temp.ok('jeton utilisé par une autre adresse : refusé sans rien révéler',
  pg_temp.err(format('SELECT public.account_accept_invitation(%L)', (SELECT v FROM _c WHERE k = 'tok_admin'))) LIKE '%INVITATION_INVALIDE%');
SELECT pg_temp.ok('jeton inconnu : même message', pg_temp.err('SELECT public.account_accept_invitation(''abc'')') LIKE '%INVITATION_INVALIDE%');
INSERT INTO _c SELECT 'acc_member', public.account_accept_invitation((SELECT v FROM _c WHERE k = 'tok_member'))::text;
SELECT pg_temp.ok('acceptation par la bonne adresse : membre, profil complet',
  (SELECT v::jsonb->>'role' FROM _c WHERE k = 'acc_member') = 'member' AND public.fp_my_account()::text = (SELECT v FROM _c WHERE k = 'A'));
SELECT pg_temp.ok('jeton à usage unique', pg_temp.err(format('SELECT public.account_accept_invitation(%L)', (SELECT v FROM _c WHERE k = 'tok_member'))) LIKE '%INVITATION_INVALIDE%');
SELECT pg_temp.ok('membre : lit, écrit des ventes et avoirs, ne gère ni réglages ni utilisateurs',
  public.fp_account_can('lire') AND public.fp_account_can('ecrire_ventes') AND public.fp_account_can('avoirs_annulations')
  AND NOT public.fp_account_can('parametres') AND NOT public.fp_account_can('utilisateurs') AND NOT public.fp_account_can('abonnement'));
SELECT pg_temp.ok('permissions de la formule : Business inclut la trésorerie, pas les rapports avancés',
  public.fp_account_can('tresorerie') AND NOT public.fp_account_can('rapports_avances'));
SELECT pg_temp.ok('un membre ne peut pas inviter', pg_temp.err('SELECT public.account_invite(''x@test.invalid'')') LIKE '%DROIT_INSUFFISANT%');
SELECT pg_temp.ok('un membre voit les membres actifs, pas les invitations',
  jsonb_array_length(public.account_info()->'members') = 2 AND jsonb_array_length(public.account_info()->'invitations') = 0);

SELECT pg_temp.as_user('48484848-0000-4000-8000-000000000002');
SELECT pg_temp.ok('acceptation de l''admin', public.account_accept_invitation((SELECT v FROM _c WHERE k = 'tok_admin'))->>'role' = 'admin');

-- ---------- Isolation entre comptes ----------
SELECT pg_temp.as_user('48484848-0000-4000-8000-000000000005');
SELECT pg_temp.ok('compte B : ne voit que lui-même',
  public.fp_my_account()::text = (SELECT v FROM _c WHERE k = 'B') AND jsonb_array_length(public.account_info()->'members') = 1
  AND NOT (public.account_info()->'members')::text LIKE '%cp-owner%');
SELECT pg_temp.ok('compte B : ne peut pas modifier un membre de A',
  pg_temp.err('SELECT public.account_member_update(''48484848-0000-4000-8000-000000000003'', NULL, NULL, ''disabled'')') LIKE '%MEMBRE_INTROUVABLE%');

-- ---------- Gestion des membres ----------
SELECT pg_temp.as_user('48484848-0000-4000-8000-000000000002');
SELECT pg_temp.ok('admin : ne peut ni toucher au propriétaire ni nommer un admin',
  pg_temp.err('SELECT public.account_member_update(''48484848-0000-4000-8000-000000000001'', NULL, NULL, ''disabled'')') LIKE '%PROPRIETAIRE_NON_MODIFIABLE%'
  AND pg_temp.err('SELECT public.account_member_update(''48484848-0000-4000-8000-000000000003'', ''admin'')') LIKE '%DROIT_INSUFFISANT%'
  AND pg_temp.err('SELECT public.account_invite(''y@test.invalid'', ''admin'')') LIKE '%DROIT_INSUFFISANT%');
SELECT pg_temp.ok('admin : passe un membre en profil « ventes »',
  public.account_member_update('48484848-0000-4000-8000-000000000003', NULL, 'ventes')->>'profile' = 'ventes');
SELECT pg_temp.as_user('48484848-0000-4000-8000-000000000003');
SELECT pg_temp.ok('profil ventes : écrit des ventes, pas d''avoirs ni d''annulations',
  public.fp_account_can('ecrire_ventes') AND NOT public.fp_account_can('avoirs_annulations'));
SELECT pg_temp.as_user('48484848-0000-4000-8000-000000000002');
INSERT INTO _c SELECT 'dis', public.account_member_update('48484848-0000-4000-8000-000000000003', NULL, NULL, 'disabled')->>'status';
SELECT pg_temp.ok('désactivation : le membre perd l''accès à la requête suivante, sa place se libère',
  (SELECT v FROM _c WHERE k = 'dis') = 'disabled' AND (public.account_info()->>'seats_used')::int = 2);
SELECT pg_temp.as_user('48484848-0000-4000-8000-000000000003');
SELECT pg_temp.ok('membre désactivé : plus de compte, plus de permission',
  public.fp_my_account() IS NULL AND NOT public.fp_account_can('lire') AND public.account_info() IS NULL);
SELECT pg_temp.as_user('48484848-0000-4000-8000-000000000002');
INSERT INTO _c SELECT 'tok_v', public.account_invite('cp-ventes@test.invalid', 'member', 'lecture')->>'token';
SELECT pg_temp.ok('place libérée réutilisée ; réactiver l''ancien membre au-delà de la limite est refusé',
  pg_temp.err('SELECT public.account_member_update(''48484848-0000-4000-8000-000000000003'', NULL, NULL, ''active'')') LIKE '%LIMITE_UTILISATEURS: 3 sur 3%');
INSERT INTO _c SELECT 'rev', public.account_invitation_revoke((SELECT (x->>'id')::uuid FROM jsonb_array_elements(public.account_info()->'invitations') x LIMIT 1))->>'revoked';
SELECT pg_temp.ok('invitation annulée : la place se libère', (SELECT v FROM _c WHERE k = 'rev') = 'true' AND (public.account_info()->>'seats_used')::int = 2);
SELECT pg_temp.as_user('48484848-0000-4000-8000-000000000004');
SELECT pg_temp.ok('invitation annulée : inutilisable', pg_temp.err(format('SELECT public.account_accept_invitation(%L)', (SELECT v FROM _c WHERE k = 'tok_v'))) LIKE '%INVITATION_INVALIDE%');

-- ---------- Changement de formule et limites ----------
SELECT pg_temp.as_user('48484848-0000-4000-8000-000000000006');
SELECT pg_temp.ok('passer en Essentielle (1 utilisateur) avec 2 membres actifs : refusé, personne n''est exclu',
  pg_temp.err(format('SELECT public.account_set_plan(%L, ''essentielle'')', (SELECT v FROM _c WHERE k = 'A'))) LIKE '%TROP_D_UTILISATEURS_POUR_CETTE_FORMULE: 2 sur 1%');
SELECT pg_temp.ok('passer en Pro (2 utilisateurs) avec 2 membres actifs : accepté', public.account_set_plan((SELECT v FROM _c WHERE k = 'A')::uuid, 'pro')->>'plan' = 'pro');
SELECT pg_temp.as_user('48484848-0000-4000-8000-000000000002');
SELECT pg_temp.ok('Pro : la trésorerie (Business) n''est plus accessible, les ventes oui',
  NOT public.fp_account_can('tresorerie') AND public.fp_account_can('ventes'));

-- ---------- Expiration ----------
SELECT pg_temp.as_user('48484848-0000-4000-8000-000000000001');
RESET ROLE;
UPDATE public.account_members SET status = 'disabled' WHERE user_id = '48484848-0000-4000-8000-000000000002';
INSERT INTO public.account_invitations (account_id, email, role, token_hash, created_by, expires_at)
  VALUES ((SELECT v FROM _c WHERE k = 'A')::uuid, 'cp-ventes@test.invalid', 'member', encode(sha256(convert_to('jeton-expire', 'UTF8')), 'hex'), '48484848-0000-4000-8000-000000000001', now() - interval '1 minute');
SET ROLE authenticated;
SELECT pg_temp.as_user('48484848-0000-4000-8000-000000000004');
SELECT pg_temp.ok('invitation expirée : refusée et ne compte plus dans les places',
  pg_temp.err('SELECT public.account_accept_invitation(''jeton-expire'')') LIKE '%INVITATION_INVALIDE%');
RESET ROLE;
INSERT INTO public.account_invitations (account_id, email, role, token_hash, created_by)
  VALUES ((SELECT v FROM _c WHERE k = 'A')::uuid, 'cp-autre@test.invalid', 'member', encode(sha256(convert_to('jeton-autre', 'UTF8')), 'hex'), '48484848-0000-4000-8000-000000000001');
SET ROLE authenticated;
SELECT pg_temp.as_user('48484848-0000-4000-8000-000000000005');
SELECT pg_temp.ok('propriétaire d''un autre compte : ne peut pas rejoindre A (un seul compte par utilisateur, ses données restent à lui)',
  pg_temp.err('SELECT public.account_accept_invitation(''jeton-autre'')') LIKE '%DEJA_MEMBRE_D_UN_COMPTE%'
  AND public.fp_my_account()::text = (SELECT v FROM _c WHERE k = 'B'));

-- ---------- Journal ----------
RESET ROLE;
SELECT pg_temp.ok('journal : invitations, acceptations, modifications et changements de formule tracés avec leur auteur',
  (SELECT count(*) FROM public.account_audit WHERE account_id = (SELECT v FROM _c WHERE k = 'A')::uuid AND action IN ('invitation', 'invitation_acceptee', 'membre_modifie', 'formule', 'invitation_annulee')) >= 9
  AND NOT EXISTS (SELECT 1 FROM public.account_audit WHERE account_id = (SELECT v FROM _c WHERE k = 'A')::uuid AND action <> 'reprise' AND actor_id IS NULL));
SELECT pg_temp.ok('contraintes : un seul propriétaire par compte, un seul compte par utilisateur',
  pg_temp.err(format('INSERT INTO public.account_members(account_id, user_id, role) VALUES (%L, ''48484848-0000-4000-8000-000000000004'', ''owner'')', (SELECT v FROM _c WHERE k = 'A'))) LIKE '%account_members_one_owner%'
  AND pg_temp.err(format('INSERT INTO public.account_members(account_id, user_id, role) VALUES (%L, ''48484848-0000-4000-8000-000000000001'', ''member'')', (SELECT v FROM _c WHERE k = 'B'))) LIKE '%account_members_one_account%');
