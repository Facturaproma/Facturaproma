-- Lien client public (sql/30) : table fermée, isolation entre sociétés, jeton, expiration, révocation, liste blanche, limites, droits anon.
\set VERBOSITY terse
SET client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.ok(name text, cond boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS
$$ BEGIN RAISE NOTICE '%', CASE WHEN cond THEN 'PASS '||name ELSE 'FAIL '||name||' '||detail END; END $$;
CREATE OR REPLACE FUNCTION pg_temp.err(sql text) RETURNS text LANGUAGE plpgsql AS
$$ BEGIN EXECUTE sql; RETURN ''; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $$;
CREATE OR REPLACE FUNCTION pg_temp.as_user(u text) RETURNS void LANGUAGE sql AS $$ SELECT set_config('request.jwt.claim.sub', u, false) $$;
CREATE TABLE pg_temp.keep (k text PRIMARY KEY, v text);
GRANT ALL ON pg_temp.keep TO PUBLIC;
INSERT INTO auth.users(id, email, email_confirmed_at) VALUES
  ('c3c3c3c3-0000-0000-0000-000000000002', 'soc-a@test.invalid', now()),
  ('c3c3c3c3-0000-0000-0000-000000000003', 'soc-b@test.invalid', now()),
  ('c3c3c3c3-0000-0000-0000-000000000004', 'nonconfirme@test.invalid', NULL);

-- ===== Droits : table fermée, une seule fonction publique =====
SELECT pg_temp.ok('table invoice_shares : RLS active', (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.invoice_shares'::regclass));
SELECT pg_temp.ok('anon : aucun droit sur la table', NOT has_table_privilege('anon', 'public.invoice_shares', 'SELECT') AND NOT has_table_privilege('anon', 'public.invoice_shares', 'INSERT'));
-- (Un test antérieur de la suite, test_securite.sql, accorde GRANT ALL ON ALL TABLES à « authenticated » : le vrai garde-fou est donc
--  la RLS SANS politique, vérifiée par les contrôles « lecture/insertion directe » plus bas, qui valent quel que soit l'ordre des tests.)
SELECT pg_temp.ok('aucune politique RLS sur invoice_shares (table fermée, accès par fonctions seulement)', NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='invoice_shares'));
SELECT pg_temp.ok('anon : EXECUTE sur get_shared_invoice seulement',
  has_function_privilege('anon', 'public.get_shared_invoice(text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.share_invoice(text,jsonb,int)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.revoke_invoice_share(text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.my_invoice_shares()', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.share_uid()', 'EXECUTE'));
SELECT pg_temp.ok('authenticated : EXECUTE sur les 3 fonctions de gestion, pas sur share_uid',
  has_function_privilege('authenticated', 'public.share_invoice(text,jsonb,int)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.revoke_invoice_share(text)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.my_invoice_shares()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.share_uid()', 'EXECUTE'));

-- ===== Société A partage une facture =====
SET ROLE authenticated; SELECT pg_temp.as_user('c3c3c3c3-0000-0000-0000-000000000002');
CREATE OR REPLACE FUNCTION pg_temp.direct_count() RETURNS int LANGUAGE plpgsql AS
$$ DECLARE n int; BEGIN SELECT count(*) INTO n FROM public.invoice_shares; RETURN n; EXCEPTION WHEN OTHERS THEN RETURN -1; END $$;
GRANT EXECUTE ON FUNCTION pg_temp.direct_count() TO PUBLIC;
SELECT pg_temp.ok('société : insertion directe refusée', pg_temp.err($$INSERT INTO public.invoice_shares(user_id, invoice_id, token, snapshot, expires_at) VALUES ('c3c3c3c3-0000-0000-0000-000000000002','x',repeat('a',64),'{}', now()+interval '1 day')$$) <> '');
INSERT INTO pg_temp.keep SELECT 'tok1', public.share_invoice('inv-1', '{"v":1,"doc":{"number":"F-2026-001"},"totals":{"ttc":1200},"secret":"A-NE-PAS-STOCKER","company":{"name":"Atelier A"}}'::jsonb, 30)->>'token';
SELECT pg_temp.ok('jeton : 64 caractères hexadécimaux', (SELECT v ~ '^[0-9a-f]{64}$' FROM pg_temp.keep WHERE k = 'tok1'));
SELECT pg_temp.ok('liste blanche : la clé « secret » n''est pas conservée', NOT (public.get_shared_invoice((SELECT v FROM pg_temp.keep WHERE k='tok1'))->'snapshot' ? 'secret') );
SELECT pg_temp.ok('société : lecture directe de la table impossible (refusée ou 0 ligne), même avec des liens existants', pg_temp.direct_count() <= 0);
RESET ROLE;

-- ===== Visiteur anonyme =====
SET ROLE anon;
SELECT pg_temp.ok('anon : lecture du lien valide', (public.get_shared_invoice((SELECT v FROM pg_temp.keep WHERE k='tok1'))->'snapshot'->'doc'->>'number') = 'F-2026-001');
SELECT pg_temp.ok('anon : jeton inconnu => NULL', public.get_shared_invoice(repeat('0', 64)) IS NULL);
SELECT pg_temp.ok('anon : jeton mal formé / vide / NULL => NULL (pas d''erreur)', public.get_shared_invoice('abc') IS NULL AND public.get_shared_invoice('') IS NULL AND public.get_shared_invoice(NULL) IS NULL AND public.get_shared_invoice(repeat('G', 64)) IS NULL AND public.get_shared_invoice(''' OR 1=1 --') IS NULL);
SELECT pg_temp.ok('anon : ne peut pas partager', pg_temp.err($$SELECT public.share_invoice('x', '{"v":1}', 10)$$) <> '');
SELECT pg_temp.ok('anon : lecture directe de la table impossible (refusée ou 0 ligne)', pg_temp.direct_count() <= 0);
RESET ROLE;

-- ===== Compteur de consultations (2 lectures valides + 1 en plus au-dessus = 3) =====
SET ROLE authenticated; SELECT pg_temp.as_user('c3c3c3c3-0000-0000-0000-000000000002');
SELECT pg_temp.ok('société A : « consulté » compté (2 lectures valides jusqu''ici)', (SELECT views FROM public.my_invoice_shares() WHERE invoice_id = 'inv-1') = 2);
SELECT pg_temp.ok('société A : date de dernière consultation renseignée', (SELECT last_viewed_at IS NOT NULL FROM public.my_invoice_shares() WHERE invoice_id = 'inv-1'));
-- Actualisation : même jeton, instantané remplacé
SELECT pg_temp.ok('actualisation : même jeton conservé', public.share_invoice('inv-1', '{"v":1,"doc":{"number":"F-2026-001"},"payment":{"remaining":700}}'::jsonb, 30)->>'token' = (SELECT v FROM pg_temp.keep WHERE k='tok1'));
SELECT pg_temp.ok('actualisation : nouvel instantané visible (reste dû 700)', (public.get_shared_invoice((SELECT v FROM pg_temp.keep WHERE k='tok1'))->'snapshot'->'payment'->>'remaining') = '700');
-- Validations
SELECT pg_temp.ok('instantané non objet refusé', pg_temp.err($$SELECT public.share_invoice('i2', '[1,2]'::jsonb, 30)$$) LIKE '%INSTANTANE_INVALIDE%');
SELECT pg_temp.ok('instantané sans clé autorisée refusé', pg_temp.err($$SELECT public.share_invoice('i2', '{"autre":1}'::jsonb, 30)$$) LIKE '%INSTANTANE_INVALIDE%');
SELECT pg_temp.ok('instantané > 64 Ko refusé', pg_temp.err($$SELECT public.share_invoice('i3', jsonb_build_object('v', 1, 'items', (SELECT jsonb_agg(repeat('x', 1000)) FROM generate_series(1, 80))), 30)$$) LIKE '%INSTANTANE_TROP_GROS%');
SELECT pg_temp.ok('durée 0 jour refusée', pg_temp.err($$SELECT public.share_invoice('i4', '{"v":1}', 0)$$) LIKE '%DUREE_INVALIDE%');
SELECT pg_temp.ok('durée 366 jours refusée', pg_temp.err($$SELECT public.share_invoice('i4', '{"v":1}', 366)$$) LIKE '%DUREE_INVALIDE%');
SELECT pg_temp.ok('identifiant de facture vide refusé', pg_temp.err($$SELECT public.share_invoice('  ', '{"v":1}', 30)$$) LIKE '%FACTURE_INVALIDE%');
RESET ROLE;

-- ===== Société B : isolation =====
SET ROLE authenticated; SELECT pg_temp.as_user('c3c3c3c3-0000-0000-0000-000000000003');
SELECT pg_temp.ok('société B : ne voit aucun lien de A', (SELECT count(*) FROM public.my_invoice_shares()) = 0);
SELECT pg_temp.ok('société B : révoquer le lien de A ne fait rien (faux)', public.revoke_invoice_share('inv-1') = false);
INSERT INTO pg_temp.keep SELECT 'tokB', public.share_invoice('inv-1', '{"v":1,"doc":{"number":"B-001"}}'::jsonb, 30)->>'token';
SELECT pg_temp.ok('société B : même identifiant de facture que A => lien distinct', (SELECT v FROM pg_temp.keep WHERE k='tokB') <> (SELECT v FROM pg_temp.keep WHERE k='tok1'));
RESET ROLE;
SET ROLE anon;
SELECT pg_temp.ok('lien de A intact après les actions de B (F-2026-001)', (public.get_shared_invoice((SELECT v FROM pg_temp.keep WHERE k='tok1'))->'snapshot'->'doc'->>'number') = 'F-2026-001');
SELECT pg_temp.ok('lien de B donne B-001', (public.get_shared_invoice((SELECT v FROM pg_temp.keep WHERE k='tokB'))->'snapshot'->'doc'->>'number') = 'B-001');
RESET ROLE;

-- ===== Compte non confirmé =====
SET ROLE authenticated; SELECT pg_temp.as_user('c3c3c3c3-0000-0000-0000-000000000004');
SELECT pg_temp.ok('compte non confirmé : partage refusé', pg_temp.err($$SELECT public.share_invoice('n1', '{"v":1}', 10)$$) LIKE '%NON_AUTHENTIFIE%');
SELECT pg_temp.ok('compte non confirmé : liste refusée', pg_temp.err($$SELECT * FROM public.my_invoice_shares()$$) LIKE '%NON_AUTHENTIFIE%');
RESET ROLE;
SET ROLE authenticated; SELECT pg_temp.as_user('');
SELECT pg_temp.ok('sans identité : partage refusé', pg_temp.err($$SELECT public.share_invoice('n1', '{"v":1}', 10)$$) <> '');
RESET ROLE;

-- ===== Expiration =====
UPDATE public.invoice_shares SET expires_at = now() - interval '1 second' WHERE token = (SELECT v FROM pg_temp.keep WHERE k='tokB');
SET ROLE anon;
SELECT pg_temp.ok('lien expiré => NULL', public.get_shared_invoice((SELECT v FROM pg_temp.keep WHERE k='tokB')) IS NULL);
RESET ROLE;
SET ROLE authenticated; SELECT pg_temp.as_user('c3c3c3c3-0000-0000-0000-000000000003');
INSERT INTO pg_temp.keep SELECT 'tokB2', public.share_invoice('inv-1', '{"v":1,"doc":{"number":"B-001"}}'::jsonb, 30)->>'token';
SELECT pg_temp.ok('relance après expiration : NOUVEAU jeton, compteur remis à zéro', (SELECT v FROM pg_temp.keep WHERE k='tokB2') <> (SELECT v FROM pg_temp.keep WHERE k='tokB') AND (SELECT views FROM public.my_invoice_shares() WHERE invoice_id='inv-1') = 0);
RESET ROLE;
SET ROLE anon;
SELECT pg_temp.ok('ancien jeton expiré reste mort, nouveau fonctionne', public.get_shared_invoice((SELECT v FROM pg_temp.keep WHERE k='tokB')) IS NULL AND public.get_shared_invoice((SELECT v FROM pg_temp.keep WHERE k='tokB2')) IS NOT NULL);
RESET ROLE;

-- ===== Révocation =====
SET ROLE authenticated; SELECT pg_temp.as_user('c3c3c3c3-0000-0000-0000-000000000002');
SELECT pg_temp.ok('société A : révocation (vrai)', public.revoke_invoice_share('inv-1') = true);
SELECT pg_temp.ok('société A : deuxième révocation (faux)', public.revoke_invoice_share('inv-1') = false);
SELECT pg_temp.ok('société A : lien marqué révoqué', (SELECT revoked FROM public.my_invoice_shares() WHERE invoice_id='inv-1'));
RESET ROLE;
SET ROLE anon;
SELECT pg_temp.ok('lien révoqué => NULL immédiatement', public.get_shared_invoice((SELECT v FROM pg_temp.keep WHERE k='tok1')) IS NULL);
RESET ROLE;
SET ROLE authenticated; SELECT pg_temp.as_user('c3c3c3c3-0000-0000-0000-000000000002');
INSERT INTO pg_temp.keep SELECT 'tok1b', public.share_invoice('inv-1', '{"v":1,"doc":{"number":"F-2026-001"}}'::jsonb, 30)->>'token';
SELECT pg_temp.ok('repartage après révocation : nouveau jeton', (SELECT v FROM pg_temp.keep WHERE k='tok1b') <> (SELECT v FROM pg_temp.keep WHERE k='tok1'));
RESET ROLE;
SET ROLE anon;
SELECT pg_temp.ok('ancien jeton révoqué reste mort, nouveau valide', public.get_shared_invoice((SELECT v FROM pg_temp.keep WHERE k='tok1')) IS NULL AND public.get_shared_invoice((SELECT v FROM pg_temp.keep WHERE k='tok1b')) IS NOT NULL);
RESET ROLE;

-- ===== Limite de liens actifs (500) =====
INSERT INTO public.invoice_shares(user_id, invoice_id, token, snapshot, expires_at)
  SELECT 'c3c3c3c3-0000-0000-0000-000000000003', 'bulk-' || g, md5(g::text) || md5((g+1000000)::text), '{"v":1}', now() + interval '10 days' FROM generate_series(1, 500) g;
SET ROLE authenticated; SELECT pg_temp.as_user('c3c3c3c3-0000-0000-0000-000000000003');
SELECT pg_temp.ok('500 liens actifs : le suivant est refusé', pg_temp.err($$SELECT public.share_invoice('trop', '{"v":1}', 10)$$) LIKE '%TROP_DE_LIENS%');
SELECT pg_temp.ok('500 liens actifs : actualiser un lien existant reste possible', pg_temp.err($$SELECT public.share_invoice('bulk-1', '{"v":1,"doc":{"number":"X"}}', 10)$$) = '');
RESET ROLE;

-- ===== Suppression du compte : les liens disparaissent =====
DELETE FROM auth.users WHERE id = 'c3c3c3c3-0000-0000-0000-000000000002';
SELECT pg_temp.ok('suppression du compte : ses liens sont supprimés', (SELECT count(*) FROM public.invoice_shares WHERE user_id = 'c3c3c3c3-0000-0000-0000-000000000002') = 0);
