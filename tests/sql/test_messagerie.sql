-- Messagerie support (sql/29) : isolation entre sociétés, limites, droits, non-lus, rôle admin.
\set VERBOSITY terse
SET client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.ok(name text, cond boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS
$$ BEGIN RAISE NOTICE '%', CASE WHEN cond THEN 'PASS '||name ELSE 'FAIL '||name||' '||detail END; END $$;
CREATE OR REPLACE FUNCTION pg_temp.err(sql text) RETURNS text LANGUAGE plpgsql AS
$$ BEGIN EXECUTE sql; RETURN ''; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $$;
GRANT ALL ON public.user_data, public.admins TO authenticated;
INSERT INTO auth.users(id, email, email_confirmed_at) VALUES
  ('b9b9b9b9-0000-0000-0000-000000000001', 'adm29@test.invalid', now()),
  ('b9b9b9b9-0000-0000-0000-000000000002', 'soc-a@test.invalid', now()),
  ('b9b9b9b9-0000-0000-0000-000000000003', 'soc-b@test.invalid', now()),
  ('b9b9b9b9-0000-0000-0000-000000000004', 'nonconfirme@test.invalid', NULL);
INSERT INTO public.admins(email, password_hash, is_master) VALUES ('adm29@test.invalid', 'x', false);
INSERT INTO public.user_data(user_id, key, value) VALUES ('b9b9b9b9-0000-0000-0000-000000000002', 'company', '{"name":"Atelier A"}');
CREATE OR REPLACE FUNCTION pg_temp.direct_count() RETURNS int LANGUAGE plpgsql AS
$$ DECLARE n int; BEGIN SELECT count(*) INTO n FROM public.support_messages; RETURN n; EXCEPTION WHEN OTHERS THEN RETURN -1; END $$;
CREATE OR REPLACE FUNCTION pg_temp.as_user(u text) RETURNS void LANGUAGE sql AS $$ SELECT set_config('request.jwt.claim.sub', u, false) $$;

-- La table n'est pas accessible directement
SET ROLE authenticated; SELECT pg_temp.as_user('b9b9b9b9-0000-0000-0000-000000000002');
SELECT pg_temp.ok('société : écriture directe dans la table refusée', pg_temp.err($$INSERT INTO public.support_messages(user_id, sender, body) VALUES ('b9b9b9b9-0000-0000-0000-000000000002','admin','faux')$$) <> '');
-- Société A écrit
SELECT public.support_send('  Bonjour, comment changer mon RIB ?  ');
SELECT pg_temp.ok('société A : message enregistré (espaces retirés)', (SELECT body FROM public.support_my_messages() LIMIT 1) = 'Bonjour, comment changer mon RIB ?');
SELECT pg_temp.ok('société A : message vide refusé', pg_temp.err($$SELECT public.support_send('   ')$$) LIKE '%MESSAGE_VIDE%');
SELECT pg_temp.ok('société A : message de 2 001 caractères refusé', pg_temp.err($$SELECT public.support_send(repeat('x', 2001))$$) LIKE '%MESSAGE_TROP_LONG%');
SELECT pg_temp.ok('société A : message de 2 000 caractères accepté', pg_temp.err($$SELECT public.support_send(repeat('x', 2000))$$) = '');
-- Lecture directe : refusée (droits retirés) ou 0 ligne visible (RLS sans politique) ; jamais les messages
SELECT pg_temp.ok('société : lecture directe de la table impossible (refusée ou 0 ligne)', pg_temp.direct_count() <= 0);
-- Société B ne voit rien de A
SELECT pg_temp.as_user('b9b9b9b9-0000-0000-0000-000000000003');
SELECT pg_temp.ok('société B : ne voit aucun message de A', (SELECT count(*) FROM public.support_my_messages()) = 0);
SELECT public.support_send('Message de B');
SELECT pg_temp.ok('société B : voit uniquement son message', (SELECT count(*) FROM public.support_my_messages()) = 1 AND (SELECT body FROM public.support_my_messages()) = 'Message de B');
SELECT pg_temp.ok('société : fonctions admin refusées', pg_temp.err('SELECT * FROM public.admin_support_threads()') LIKE '%forbidden%' AND pg_temp.err($$SELECT public.admin_support_reply('b9b9b9b9-0000-0000-0000-000000000002','x')$$) LIKE '%forbidden%'
    AND pg_temp.err('SELECT public.admin_support_unread_total()') LIKE '%forbidden%');
-- Compte non confirmé
SELECT pg_temp.as_user('b9b9b9b9-0000-0000-0000-000000000004');
SELECT pg_temp.ok('compte non confirmé : envoi refusé', pg_temp.err($$SELECT public.support_send('salut')$$) LIKE '%NON_AUTHENTIFIE%');
-- Anti-abus : 20 par heure (A en a déjà 2)
SELECT pg_temp.as_user('b9b9b9b9-0000-0000-0000-000000000002');
DO $$ BEGIN FOR i IN 1..18 LOOP PERFORM public.support_send('msg ' || i); END LOOP; END $$;
SELECT pg_temp.ok('société A : le 21e message dans l''heure est refusé', pg_temp.err($$SELECT public.support_send('trop')$$) LIKE '%TROP_DE_MESSAGES%');
RESET ROLE;
-- Administration
SET ROLE authenticated; SELECT pg_temp.as_user('b9b9b9b9-0000-0000-0000-000000000001'), set_config('request.jwt.claim.email', 'adm29@test.invalid', false);
SELECT pg_temp.ok('admin : 2 fils, total non lus = 21 (20 de A + 1 de B)', (SELECT count(*) FROM public.admin_support_threads()) = 2 AND public.admin_support_unread_total() = 21);
SELECT pg_temp.ok('admin : le fil de A porte la société et l''e-mail', (SELECT company_name FROM public.admin_support_threads() WHERE email = 'soc-a@test.invalid') = 'Atelier A');
SELECT pg_temp.ok('admin : lit les messages de A (20)', (SELECT count(*) FROM public.admin_support_messages('b9b9b9b9-0000-0000-0000-000000000002')) = 20);
SELECT public.admin_support_reply('b9b9b9b9-0000-0000-0000-000000000002', 'Bonjour, voici la marche à suivre.');
SELECT pg_temp.ok('admin : la réponse marque les messages de A comme lus (non lus = 1)', public.admin_support_unread_total() = 1);
SELECT pg_temp.ok('admin : réponse à un compte inexistant refusée', pg_temp.err($$SELECT public.admin_support_reply(gen_random_uuid(), 'x')$$) LIKE '%COMPTE_INTROUVABLE%');
SELECT public.admin_support_mark_read('b9b9b9b9-0000-0000-0000-000000000003');
SELECT pg_temp.ok('admin : marquer le fil de B lu → plus aucun non-lu', public.admin_support_unread_total() = 0);
RESET ROLE;
-- Retour société A
SET ROLE authenticated; SELECT pg_temp.as_user('b9b9b9b9-0000-0000-0000-000000000002');
SELECT pg_temp.ok('société A : 1 non-lu (la réponse), puis 0 après lecture', public.support_unread_count() = 1 AND (SELECT count(*) FROM public.support_my_messages() WHERE sender = 'admin' AND NOT is_read) = 1);
SELECT public.support_mark_read();
SELECT pg_temp.ok('société A : après lecture, 0 non-lu', public.support_unread_count() = 0);
SELECT pg_temp.ok('société A : ne peut pas se faire passer pour l''admin (sender)', (SELECT count(*) FROM public.support_my_messages() WHERE sender = 'admin') = 1);
RESET ROLE;
-- Droits des fonctions, suppression de compte
SELECT pg_temp.ok('anon : aucune fonction de messagerie exécutable', NOT has_function_privilege('anon', 'public.support_send(text)', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.admin_support_threads()', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.support_my_messages()', 'EXECUTE'));
SELECT pg_temp.ok('la fonction interne support_uid() n''est pas exécutable par les clients', NOT has_function_privilege('authenticated', 'public.support_uid()', 'EXECUTE'));
DELETE FROM auth.users WHERE id = 'b9b9b9b9-0000-0000-0000-000000000003';
SELECT pg_temp.ok('suppression du compte B : son fil disparaît avec lui', (SELECT count(*) FROM public.support_messages WHERE user_id = 'b9b9b9b9-0000-0000-0000-000000000003') = 0 AND (SELECT count(*) FROM public.support_messages WHERE user_id = 'b9b9b9b9-0000-0000-0000-000000000002') > 0);
