-- Paiement lié au code (sql/32) : chaque code a son paiement en attente, atomique, annulé/supprimé avec le code, encaissement unique.
\set VERBOSITY terse
SET client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.ok(name text, cond boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS
$$ BEGIN RAISE NOTICE '%', CASE WHEN cond THEN 'PASS '||name ELSE 'FAIL '||name||' '||detail END; END $$;
CREATE OR REPLACE FUNCTION pg_temp.err(sql text) RETURNS text LANGUAGE plpgsql AS
$$ BEGIN EXECUTE sql; RETURN ''; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $$;
CREATE OR REPLACE FUNCTION pg_temp.as_user(u text) RETURNS void LANGUAGE sql AS $$ SELECT set_config('request.jwt.claim.sub', u, false) $$;
INSERT INTO auth.users(id, email, email_confirmed_at) VALUES
  ('b8b8b8b8-0000-0000-0000-000000000001', 'adm-pay@test.invalid', now()),
  ('b8b8b8b8-0000-0000-0000-000000000002', 'client-pay@test.invalid', now());
INSERT INTO public.admins(email, is_master) VALUES ('adm-pay@test.invalid', true) ON CONFLICT (email) DO NOTHING;
INSERT INTO public.plans(key, label, price_dh, duration_days) VALUES ('p_trim', 'Trimestriel', 129, 90) ON CONFLICT DO NOTHING;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;  -- comme Supabase par défaut ; la RLS reste le vrai garde-fou
SET ROLE authenticated;
SELECT pg_temp.as_user('b8b8b8b8-0000-0000-0000-000000000001');

INSERT INTO public.admin_codes(code, type, client_email, status) VALUES ('FP-AAAA-AAAA-AAAA', 'monthly', 'PC-Client@Test.Invalid', 'pending'),
  ('FP-BBBB-BBBB-BBBB', 'annual', 'pc-b@test.invalid', 'pending'), ('FP-CCCC-CCCC-CCCC', 'lifetime', 'pc-c@test.invalid', 'pending'),
  ('FP-DDDD-DDDD-DDDD', 'p_trim', 'pc-d@test.invalid', 'pending');
INSERT INTO public.admin_codes(code, type, client_email, note, status) VALUES ('FP-EEEE-EEEE-EEEE', 'annual', 'pc-e@test.invalid', 'FONDATEUR 299 DH/an', 'pending');
SELECT pg_temp.ok('code mensuel → paiement en attente de 49 DH lié, e-mail normalisé',
  (SELECT count(*) FROM public.admin_payments p JOIN public.admin_codes c ON c.id = p.code_id WHERE c.code = 'FP-AAAA-AAAA-AAAA' AND p.status = 'pending' AND p.amount = 49 AND p.client_email = 'pc-client@test.invalid') = 1);
SELECT pg_temp.ok('code annuel → 449 DH ; formule personnalisée → prix de la table plans (129) ; fondateur → 299',
  (SELECT amount FROM public.admin_payments p JOIN public.admin_codes c ON c.id = p.code_id WHERE c.code = 'FP-BBBB-BBBB-BBBB') = 449
  AND (SELECT amount FROM public.admin_payments p JOIN public.admin_codes c ON c.id = p.code_id WHERE c.code = 'FP-DDDD-DDDD-DDDD') = 129
  AND (SELECT amount FROM public.admin_payments p JOIN public.admin_codes c ON c.id = p.code_id WHERE c.code = 'FP-EEEE-EEEE-EEEE') = 299);
SELECT pg_temp.ok('code offert (à vie) : aucun paiement', NOT EXISTS (SELECT 1 FROM public.admin_payments p JOIN public.admin_codes c ON c.id = p.code_id WHERE c.code = 'FP-CCCC-CCCC-CCCC'));
SELECT pg_temp.ok('aucun code (non offert) sans paiement lié', NOT EXISTS (SELECT 1 FROM public.admin_codes c WHERE c.client_email ILIKE 'pc-%' AND c.type <> 'lifetime' AND NOT EXISTS (SELECT 1 FROM public.admin_payments p WHERE p.code_id = c.id)));

-- Atomicité : si le paiement ne peut pas être créé, le code n'existe pas non plus (aucun orphelin)
SELECT pg_temp.ok('doublon de code refusé sans laisser de paiement orphelin',
  pg_temp.err($$INSERT INTO public.admin_codes(code, type, client_email, status) VALUES ('FP-AAAA-AAAA-AAAA', 'monthly', 'pc-x@test.invalid', 'pending')$$) <> ''
  AND NOT EXISTS (SELECT 1 FROM public.admin_payments WHERE client_email = 'pc-x@test.invalid'));

-- Encaissement
SELECT pg_temp.as_user('b8b8b8b8-0000-0000-0000-000000000002');
SELECT pg_temp.ok('un simple client ne peut pas encaisser', pg_temp.err($$SELECT public.admin_confirm_payment((SELECT id FROM public.admin_payments LIMIT 1), 49, 'cash', CURRENT_DATE)$$) ILIKE '%forbidden%');
SELECT pg_temp.as_user('b8b8b8b8-0000-0000-0000-000000000001');
SELECT pg_temp.ok('encaissement : montant / mode / date invalides refusés',
  (SELECT public.admin_confirm_payment(p.id, 0, 'cash', CURRENT_DATE)->>'reason' FROM public.admin_payments p JOIN public.admin_codes c ON c.id = p.code_id WHERE c.code = 'FP-AAAA-AAAA-AAAA') = 'bad_amount'
  AND (SELECT public.admin_confirm_payment(p.id, 49, 'bitcoin', CURRENT_DATE)->>'reason' FROM public.admin_payments p JOIN public.admin_codes c ON c.id = p.code_id WHERE c.code = 'FP-AAAA-AAAA-AAAA') = 'bad_mode'
  AND (SELECT public.admin_confirm_payment(p.id, 49, 'cash', CURRENT_DATE + 30)->>'reason' FROM public.admin_payments p JOIN public.admin_codes c ON c.id = p.code_id WHERE c.code = 'FP-AAAA-AAAA-AAAA') = 'bad_date');
CREATE TEMP TABLE r AS SELECT public.admin_confirm_payment(p.id, 45, 'cash', CURRENT_DATE, 'remise') AS j FROM public.admin_payments p JOIN public.admin_codes c ON c.id = p.code_id WHERE c.code = 'FP-AAAA-AAAA-AAAA';
SELECT pg_temp.ok('encaissement par l''admin : passe à paid avec le montant réel', (SELECT (j->>'ok')::bool FROM r)
  AND (SELECT p.status || p.amount::text || p.payment_mode FROM public.admin_payments p JOIN public.admin_codes c ON c.id = p.code_id WHERE c.code = 'FP-AAAA-AAAA-AAAA') = 'paid45.00cash');
SELECT pg_temp.ok('double encaissement refusé', (SELECT public.admin_confirm_payment(p.id, 45, 'cash', CURRENT_DATE)->>'reason' FROM public.admin_payments p JOIN public.admin_codes c ON c.id = p.code_id WHERE c.code = 'FP-AAAA-AAAA-AAAA') = 'already_paid');
SELECT pg_temp.ok('encaissement journalisé', EXISTS (SELECT 1 FROM public.admin_audit WHERE action = 'payment_confirmed' AND target_email = 'pc-client@test.invalid'));

-- Révocation / suppression
UPDATE public.admin_codes SET status = 'revoked' WHERE code = 'FP-BBBB-BBBB-BBBB';
SELECT pg_temp.ok('code révoqué → paiement annulé (conservé)', (SELECT p.status FROM public.admin_payments p JOIN public.admin_codes c ON c.id = p.code_id WHERE c.code = 'FP-BBBB-BBBB-BBBB') = 'cancelled');
SELECT pg_temp.ok('un paiement annulé ne peut plus être encaissé', (SELECT public.admin_confirm_payment(p.id, 449, 'cash', CURRENT_DATE)->>'reason' FROM public.admin_payments p JOIN public.admin_codes c ON c.id = p.code_id WHERE c.code = 'FP-BBBB-BBBB-BBBB') = 'cancelled');
UPDATE public.admin_codes SET status = 'revoked' WHERE code = 'FP-AAAA-AAAA-AAAA';
SELECT pg_temp.ok('révoquer un code déjà encaissé ne touche pas au paiement encaissé', (SELECT p.status FROM public.admin_payments p WHERE p.client_email = 'pc-client@test.invalid') = 'paid');
DELETE FROM public.admin_codes WHERE code = 'FP-DDDD-DDDD-DDDD';
SELECT pg_temp.ok('code supprimé (en attente) → son paiement disparaît (pas d''orphelin)', NOT EXISTS (SELECT 1 FROM public.admin_payments WHERE client_email = 'pc-d@test.invalid'));
DELETE FROM public.admin_codes WHERE code = 'FP-AAAA-AAAA-AAAA';
SELECT pg_temp.ok('code supprimé après encaissement → le paiement encaissé est CONSERVÉ, détaché', (SELECT count(*) FROM public.admin_payments WHERE client_email = 'pc-client@test.invalid' AND status = 'paid' AND code_id IS NULL) = 1);

-- Un seul paiement par code
SELECT pg_temp.ok('un seul paiement par code (index unique)', pg_temp.err($$INSERT INTO public.admin_payments(client_email, payment_date, amount, type, payment_mode, code_id) SELECT 'pc-e@test.invalid', CURRENT_DATE, 1, 'annual', 'cash', id FROM public.admin_codes WHERE code = 'FP-EEEE-EEEE-EEEE'$$) <> '');
INSERT INTO public.admin_payments(client_email, payment_date, amount, type, payment_mode) VALUES ('pc-m@test.invalid', CURRENT_DATE, 10, 'monthly', 'cash');
SELECT pg_temp.ok('saisie manuelle / historique : statut paid par défaut', (SELECT status FROM public.admin_payments WHERE client_email = 'pc-m@test.invalid') = 'paid');
SELECT pg_temp.ok('fonctions internes non appelables par authenticated', NOT has_function_privilege('authenticated', 'public.code_prix_attendu(text,text)', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'public.code_creer_paiement()', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.admin_confirm_payment(uuid,numeric,text,date,text)', 'EXECUTE'));
