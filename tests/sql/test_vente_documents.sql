-- Documents de vente (sql/33) : facture à la commande, reçu à l'encaissement, numérotation atomique, non supprimables.
\set VERBOSITY terse
SET client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.ok(name text, cond boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS
$$ BEGIN RAISE NOTICE '%', CASE WHEN cond THEN 'PASS '||name ELSE 'FAIL '||name||' '||detail END; END $$;
CREATE OR REPLACE FUNCTION pg_temp.err(sql text) RETURNS text LANGUAGE plpgsql AS
$$ BEGIN EXECUTE sql; RETURN ''; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $$;
CREATE OR REPLACE FUNCTION pg_temp.as_user(u text) RETURNS void LANGUAGE sql AS $$ SELECT set_config('request.jwt.claim.sub', u, false) $$;
INSERT INTO auth.users(id, email, email_confirmed_at) VALUES
  ('c9c9c9c9-0000-0000-0000-000000000001', 'adm-doc@test.invalid', now()),
  ('c9c9c9c9-0000-0000-0000-000000000002', 'client-doc@test.invalid', now());
INSERT INTO public.admins(email, is_master) VALUES ('adm-doc@test.invalid', true) ON CONFLICT (email) DO NOTHING;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
REVOKE UPDATE, DELETE, INSERT ON public.admin_documents FROM authenticated;
INSERT INTO public.admin_settings(key, value) VALUES ('fp_company_config', '{"name":"FacturaPro Test","tvaRate":20,"invPrefix":"fac","receiptPrefix":"R#"}')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
SET ROLE authenticated;
SELECT pg_temp.as_user('c9c9c9c9-0000-0000-0000-000000000001');

INSERT INTO public.admin_codes(code, type, client_email, status) VALUES ('FP-DOC1-AAAA-AAAA', 'monthly', 'dc-a@test.invalid', 'pending'), ('FP-DOC2-BBBB-BBBB', 'annual', 'dc-b@test.invalid', 'pending'), ('FP-DOC3-CCCC-CCCC', 'lifetime', 'dc-c@test.invalid', 'pending');
SELECT pg_temp.ok('code → une facture liée au paiement en attente (montant, client, code, TVA figée)',
  (SELECT count(*) FROM public.admin_documents d JOIN public.admin_payments p ON p.id = d.payment_id JOIN public.admin_codes c ON c.id = p.code_id
    WHERE c.code = 'FP-DOC1-AAAA-AAAA' AND d.doc_type = 'invoice' AND d.status = 'issued' AND d.total_ttc = 49 AND d.client_email = 'dc-a@test.invalid' AND d.code = c.code AND d.tva_rate = 20) = 1);
SELECT pg_temp.ok('préfixe de facture invalide dans les réglages (« fac » → FAC) accepté en majuscules ; reçu « R# » invalide → REC',
  (SELECT number FROM public.admin_documents WHERE code = 'FP-DOC1-AAAA-AAAA' AND doc_type = 'invoice') ~ '^FAC-[0-9]{4}-[0-9]{4}$');
SELECT pg_temp.ok('code offert : ni paiement ni facture', NOT EXISTS (SELECT 1 FROM public.admin_documents WHERE code = 'FP-DOC3-CCCC-CCCC'));
SELECT pg_temp.ok('numéros de facture consécutifs et distincts',
  (SELECT count(DISTINCT number) FROM public.admin_documents WHERE code LIKE 'FP-DOC%') = 2
  AND (SELECT max(substr(number, 10)::int) - min(substr(number, 10)::int) FROM public.admin_documents WHERE code LIKE 'FP-DOC%') = 1);

-- Encaissement → reçu
CREATE TEMP TABLE r AS SELECT public.admin_confirm_payment(p.id, 45, 'cash', CURRENT_DATE, 'remise') AS j FROM public.admin_payments p JOIN public.admin_codes c ON c.id = p.code_id WHERE c.code = 'FP-DOC1-AAAA-AAAA';
SELECT pg_temp.ok('encaissement → un reçu REC lié à la facture, au montant réellement reçu, avec mode et date',
  (SELECT count(*) FROM public.admin_documents r JOIN public.admin_documents i ON i.id = r.ref_id AND i.doc_type = 'invoice'
    WHERE r.code = 'FP-DOC1-AAAA-AAAA' AND r.doc_type = 'receipt' AND r.number ~ '^REC-[0-9]{4}-[0-9]{4}$' AND r.total_ttc = 45 AND r.payment_mode = 'cash' AND r.payment_date = CURRENT_DATE AND i.total_ttc = 49) = 1);
SELECT pg_temp.ok('double encaissement refusé : toujours un seul reçu',
  (SELECT public.admin_confirm_payment(p.id, 49, 'cash', CURRENT_DATE)->>'reason' FROM public.admin_payments p JOIN public.admin_codes c ON c.id = p.code_id WHERE c.code = 'FP-DOC1-AAAA-AAAA') = 'already_paid'
  AND (SELECT count(*) FROM public.admin_documents WHERE code = 'FP-DOC1-AAAA-AAAA' AND doc_type = 'receipt') = 1);

-- Paiement saisi directement « encaissé » (sans code) : facture + reçu
INSERT INTO public.admin_payments(client_email, payment_date, amount, type, payment_mode, status) VALUES ('dc-manuel@test.invalid', CURRENT_DATE, 49, 'monthly', 'virement', 'paid');
SELECT pg_temp.ok('paiement manuel encaissé : facture + reçu émis',
  (SELECT count(*) FROM public.admin_documents WHERE client_email = 'dc-manuel@test.invalid') = 2 AND (SELECT count(DISTINCT doc_type) FROM public.admin_documents WHERE client_email = 'dc-manuel@test.invalid') = 2);

-- Révocation / suppression avant encaissement
UPDATE public.admin_codes SET status = 'revoked' WHERE code = 'FP-DOC2-BBBB-BBBB';
SELECT pg_temp.ok('code révoqué avant encaissement : facture annulée, numéro conservé, aucun reçu',
  (SELECT status FROM public.admin_documents WHERE code = 'FP-DOC2-BBBB-BBBB' AND doc_type = 'invoice') = 'void'
  AND NOT EXISTS (SELECT 1 FROM public.admin_documents WHERE code = 'FP-DOC2-BBBB-BBBB' AND doc_type = 'receipt'));
INSERT INTO public.admin_codes(code, type, client_email, status) VALUES ('FP-DOC4-DDDD-DDDD', 'monthly', 'dc-d@test.invalid', 'pending');
DELETE FROM public.admin_codes WHERE code = 'FP-DOC4-DDDD-DDDD';
SELECT pg_temp.ok('code supprimé avant encaissement : facture annulée (le document reste)',
  (SELECT count(*) FROM public.admin_documents WHERE client_email = 'dc-d@test.invalid' AND status = 'void' AND payment_id IS NULL) = 1);
SELECT pg_temp.ok('suppression d''un paiement encaissé : facture et reçu conservés',
  pg_temp.err($$DELETE FROM public.admin_payments WHERE client_email = 'dc-manuel@test.invalid'$$) = ''
  AND (SELECT count(*) FROM public.admin_documents WHERE client_email = 'dc-manuel@test.invalid' AND status = 'issued') = 2);

-- Inviolabilité
SELECT pg_temp.ok('modification / suppression / insertion directes refusées pour un admin connecté',
  pg_temp.err($$UPDATE public.admin_documents SET total_ttc = 1$$) <> '' AND pg_temp.err($$DELETE FROM public.admin_documents$$) <> ''
  AND pg_temp.err($$INSERT INTO public.admin_documents(doc_type, number, client_email, total_ttc) VALUES ('invoice', 'X-1', 'x@test.invalid', 5)$$) <> '');
RESET ROLE;
SELECT pg_temp.ok('même avec les droits du propriétaire : numéro / montant non modifiables, suppression refusée',
  pg_temp.err($$UPDATE public.admin_documents SET total_ttc = 1$$) ILIKE '%non modifiable%' AND pg_temp.err($$DELETE FROM public.admin_documents$$) ILIKE '%non supprimable%');
SET ROLE authenticated;
SELECT pg_temp.as_user('c9c9c9c9-0000-0000-0000-000000000002');
SELECT pg_temp.ok('un simple client ne voit aucun document', (SELECT count(*) FROM public.admin_documents) = 0);
SELECT pg_temp.ok('un simple client ne peut pas appeler les fonctions d''émission', pg_temp.err($$SELECT public.doc_next_number('invoice')$$) ILIKE '%permission%');
RESET ROLE;
SELECT pg_temp.ok('anon : aucun droit sur les documents ni les compteurs',
  NOT has_table_privilege('anon', 'public.admin_documents', 'SELECT') AND NOT has_table_privilege('anon', 'public.admin_doc_counters', 'SELECT'));
-- Réglages illisibles : TVA absente, émission quand même
UPDATE public.admin_settings SET value = 'pas du json' WHERE key = 'fp_company_config';
INSERT INTO public.admin_codes(code, type, client_email, status) VALUES ('FP-DOC5-EEEE-EEEE', 'monthly', 'dc-e@test.invalid', 'pending');
SELECT pg_temp.ok('réglages illisibles : facture émise sans taux de TVA, préfixe par défaut LIC',
  (SELECT count(*) FROM public.admin_documents WHERE code = 'FP-DOC5-EEEE-EEEE' AND tva_rate IS NULL AND number ~ '^LIC-') = 1);
