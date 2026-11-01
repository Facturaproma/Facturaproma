-- sql/45 : ventes et paiements dans de vraies tables (mode documents) — FacturaPro 2.0 identique avant/après bascule,
-- paiements plafonnés (avoirs compris), annulation d'un paiement, plafond des avoirs, clôture, retour arrière, compte ordinaire autorisé.
\set VERBOSITY terse
SET client_min_messages = notice;
\i sql/17_mode_stockage.sql
\i sql/45_ventes_documents.sql
SET client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.ok(name text, cond boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS
$$ BEGIN RAISE NOTICE '%', CASE WHEN cond THEN 'PASS '||name ELSE 'FAIL '||name||' '||detail END; END $$;
CREATE OR REPLACE FUNCTION pg_temp.err(sql text) RETURNS text LANGUAGE plpgsql AS
$$ BEGIN EXECUTE sql; RETURN ''; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $$;
GRANT EXECUTE ON FUNCTION pg_temp.ok(text, boolean, text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION pg_temp.err(text) TO PUBLIC;
CREATE TEMP TABLE IF NOT EXISTS _b(k text, v jsonb); GRANT ALL ON _b TO PUBLIC;

INSERT INTO auth.users(id, email, email_confirmed_at) VALUES ('45454545-0000-4000-8000-000000000001', 'vt-a@example.com', now());   -- e-mail ORDINAIRE
INSERT INTO public.licenses(user_id, type, status, expires_at) VALUES ('45454545-0000-4000-8000-000000000001', 'annual', 'active', now() + interval '200 days')
  ON CONFLICT (user_id) DO UPDATE SET status = 'active', expires_at = EXCLUDED.expires_at;
INSERT INTO public.doc_counters(user_id, doc_type, last_value) VALUES ('45454545-0000-4000-8000-000000000001', 'invoice', 2), ('45454545-0000-4000-8000-000000000001', 'credit', 1)
  ON CONFLICT DO NOTHING;
ALTER TABLE public.user_data DISABLE TRIGGER USER;
INSERT INTO public.user_data(user_id, key, value, updated_at) VALUES
 ('45454545-0000-4000-8000-000000000001', 'invoices', '[
   {"id":"f1","type":"invoice","number":"FAC-2026-001","status":"sent","date":"2026-10-05","clientId":"c1","clientName":"Client","items":[],"totalHT":1000,"totalTVA":200,"totalTTC":1200},
   {"id":"f2","type":"invoice","number":"FAC-2026-002","status":"sent","date":"2026-10-08","clientId":"c1","clientName":"Client","items":[],"totalHT":500,"totalTVA":100,"totalTTC":600},
   {"id":"a1","type":"credit","number":"AVR-2026-001","status":"sent","date":"2026-10-10","relatedInvoiceId":"f1","clientId":"c1","clientName":"Client","items":[],"totalHT":-250,"totalTVA":-50,"totalTTC":-300},
   {"id":"d1","type":"invoice","number":"BRO-X","status":"draft","date":"2026-10-12","clientId":"c1","clientName":"Client","items":[],"totalHT":10,"totalTVA":2,"totalTTC":12}]', now() - interval '1 hour'),
 ('45454545-0000-4000-8000-000000000001', 'payments', '[{"id":"p1","invoiceId":"f1","date":"2026-10-15","amount":200,"method":"virement","accountId":"acc-1"}]', now() - interval '1 hour');
ALTER TABLE public.user_data ENABLE TRIGGER USER;

SELECT pg_temp.ok('sources internes non exposées', NOT has_function_privilege('authenticated', 'public.fp_sales_array(uuid)', 'EXECUTE') AND NOT has_function_privilege('authenticated', 'public.fp_payments_array(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.fin_documents_guard()', 'EXECUTE') AND has_function_privilege('authenticated', 'public.record_payment(text,jsonb,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.record_payment(text,jsonb,text)', 'EXECUTE'));
-- Référence en mode legacy
INSERT INTO _b SELECT 'fig', public.fin_figures('45454545-0000-4000-8000-000000000001', '2026-10-01', '2026-10-31');
INSERT INTO _b SELECT 'pay', (SELECT jsonb_agg(to_jsonb(x) ORDER BY payment_id) FROM public.fin_customer_payments('45454545-0000-4000-8000-000000000001') x);
SELECT pg_temp.ok('legacy : ventes nettes 1250 (1500 − 250), encaissement 200', (SELECT (v->>'sales_ht')::numeric = 1250 AND (v->>'collections')::numeric = 200 AND (v->>'draft_invoices')::int = 1 FROM _b WHERE k = 'fig'), (SELECT v::text FROM _b WHERE k = 'fig'));

-- Bascule d'un compte à e-mail ordinaire : refusée hors liste, acceptée une fois autorisé
SELECT pg_temp.ok('compte ordinaire non autorisé : bascule refusée', pg_temp.err($$SELECT public.fp_doc_mode_set('45454545-0000-4000-8000-000000000001', 'documents', NULL, 0)$$) LIKE '%COMPTE_NON_AUTORISE%');
INSERT INTO public.doc_store_testers(user_id, note) VALUES ('45454545-0000-4000-8000-000000000001', 'test sql/45');
SELECT public.fp_doc_mode_set('45454545-0000-4000-8000-000000000001', 'documents', NULL, 0) AS sw \gset
SELECT pg_temp.ok('compte ordinaire autorisé : bascule faite (copie vérifiée)', (:'sw'::jsonb->>'ok')::boolean AND public.fp_doc_mode('45454545-0000-4000-8000-000000000001') = 'documents', :'sw');
SELECT pg_temp.ok('mode documents : mêmes chiffres de gestion qu''en legacy', public.fin_figures('45454545-0000-4000-8000-000000000001', '2026-10-01', '2026-10-31') = (SELECT v FROM _b WHERE k = 'fig'),
  public.fin_figures('45454545-0000-4000-8000-000000000001', '2026-10-01', '2026-10-31')::text);
SELECT pg_temp.ok('mode documents : mêmes encaissements (compte de trésorerie conservé)', (SELECT jsonb_agg(to_jsonb(x) ORDER BY payment_id) FROM public.fin_customer_payments('45454545-0000-4000-8000-000000000001') x) = (SELECT v FROM _b WHERE k = 'pay'));
SELECT pg_temp.ok('statut de facture lu dans documents (BL)', public.fin_invoice_status('45454545-0000-4000-8000-000000000001', 'f1') = 'issued' AND public.fin_invoice_status('45454545-0000-4000-8000-000000000001', 'd1') = 'draft');

SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '45454545-0000-4000-8000-000000000001', false);
SELECT pg_temp.ok('Pilotage (utilisateur) : créances 700 + 600 = 1300', (public.fin_summary('2026-10-01', '2026-10-31')->>'receivables')::numeric = 1300, public.fin_summary('2026-10-01', '2026-10-31')::text);
SELECT pg_temp.ok('contrôle de clôture : 1 brouillon, 1 paiement sans compte = 0', (public.period_check('2026-10')->>'draft_invoices')::int = 1);
-- Paiements : plafond avoirs compris
SELECT pg_temp.ok('paiement de 701 (reste 700 = 1200 − 300 avoir − 200) refusé', pg_temp.err($$SELECT public.record_payment('f1', '{"id":"p2","date":"2026-11-01","amount":701,"method":"especes"}'::jsonb, 'op-p2a')$$) LIKE '%PAIEMENT_SUPERIEUR_AU_RESTE%');
SELECT public.record_payment('f1', '{"id":"p2","date":"2026-11-01","amount":700,"method":"especes","accountId":"acc-2"}'::jsonb, 'op-p2') AS rp \gset
SELECT pg_temp.ok('paiement de 700 accepté : facture payée', (:'rp'::jsonb->>'paid_amount')::numeric = 900 AND (SELECT status FROM public.documents WHERE id = 'f1' AND doc_type = 'invoice') = 'paid', :'rp');
SELECT pg_temp.ok('rejeu du même paiement : sans doublon', (public.record_payment('f1', '{"id":"p2","date":"2026-11-01","amount":700}'::jsonb, 'op-p2')->>'replay')::boolean
  AND (SELECT count(*) FROM public.doc_payments WHERE invoice_id = 'f1') = 2);
-- Annulation d'un paiement
SELECT pg_temp.ok('annulation : montant différent refusé', pg_temp.err($$SELECT public.record_payment('f1', '{"id":"r1","date":"2026-11-01","amount":-150,"reversesId":"p1"}'::jsonb)$$) LIKE '%ANNULATION_INVALIDE%');
SELECT pg_temp.ok('annulation : sans paiement d''origine refusée', pg_temp.err($$SELECT public.record_payment('f1', '{"id":"r1","date":"2026-11-01","amount":-200}'::jsonb)$$) LIKE '%ANNULATION_INVALIDE%');
SELECT pg_temp.ok('paiement positif portant reversesId refusé', pg_temp.err($$SELECT public.record_payment('f1', '{"id":"r1","date":"2026-11-01","amount":200,"reversesId":"p1"}'::jsonb)$$) LIKE '%PAIEMENT_INVALIDE%');
SELECT public.record_payment('f1', '{"id":"r1","date":"2026-11-01","amount":-200,"reversesId":"p1","notes":"Annulation : erreur"}'::jsonb) AS rv \gset
SELECT pg_temp.ok('annulation de p1 (−200) : acceptée, facture redevenue à payer', (:'rv'::jsonb->>'paid_amount')::numeric = 700 AND (SELECT status FROM public.documents WHERE id = 'f1' AND doc_type = 'invoice') = 'sent', :'rv');
SELECT pg_temp.ok('double annulation refusée', pg_temp.err($$SELECT public.record_payment('f1', '{"id":"r2","date":"2026-11-01","amount":-200,"reversesId":"p1"}'::jsonb)$$) LIKE '%PAIEMENT_DEJA_ANNULE%');
SELECT pg_temp.ok('après annulation : on peut encaisser à nouveau 200', (public.record_payment('f1', '{"id":"p3","date":"2026-11-01","amount":200}'::jsonb)->>'paid_amount')::numeric = 900);
-- Avoirs : plafond dans documents
SELECT public.next_doc_number('credit', 0) AS c2 \gset
SELECT pg_temp.ok('avoir de 1000 sur f1 (cumul 1300 > 1200) refusé', pg_temp.err(format($$SELECT public.upsert_document('{"id":"a2","type":"credit","number":"AVR-2026-%s","status":"sent","date":"2026-11-01","relatedInvoiceId":"f1","items":[],"totalHT":-833.33,"totalTVA":-166.67,"totalTTC":-1000}'::jsonb, 0, 'op-a2x')$$, lpad(:'c2', 3, '0'))) LIKE '%AVOIR_SUPERIEUR_FACTURE%');
SELECT pg_temp.ok('avoir de 900 sur f1 (cumul 1200) accepté', (public.upsert_document(format('{"id":"a2","type":"credit","number":"AVR-2026-%s","status":"sent","date":"2026-11-01","relatedInvoiceId":"f1","items":[],"totalHT":-750,"totalTVA":-150,"totalTTC":-900}', lpad(:'c2', 3, '0'))::jsonb, 0, 'op-a2')->>'ok')::boolean);
-- Clôture d'octobre : paiement et émission datés d'octobre refusés
SELECT public.period_close('2026-10', 'Relevé pointé') IS NOT NULL AS closed \gset
SELECT pg_temp.ok('période clôturée : paiement daté d''octobre refusé', pg_temp.err($$SELECT public.record_payment('f2', '{"id":"p4","date":"2026-10-20","amount":100}'::jsonb)$$) LIKE '%PERIODE_CLOTUREE%');
SELECT public.next_doc_number('invoice', 0) AS i3 \gset
SELECT pg_temp.ok('période clôturée : émission d''une facture datée d''octobre refusée', pg_temp.err(format($$SELECT public.upsert_document('{"id":"f3","type":"invoice","number":"FAC-2026-%s","status":"sent","date":"2026-10-30","items":[],"totalHT":10,"totalTVA":2,"totalTTC":12}'::jsonb, 0)$$, lpad(:'i3', 3, '0'))) LIKE '%PERIODE_CLOTUREE%');
SELECT pg_temp.ok('brouillon daté d''octobre : toujours possible', (public.upsert_document('{"id":"d2","type":"invoice","number":"BRO-Y","status":"draft","date":"2026-10-30","items":[],"totalHT":1,"totalTVA":0,"totalTTC":1}'::jsonb, 0)->>'ok')::boolean);
SELECT pg_temp.ok('Pilotage de novembre : encaissements 700 − 200 + 200 = 700, avoir 750 HT', (SELECT (s->>'collections')::numeric = 700 AND (s->>'credits_ht')::numeric = 750 FROM (SELECT public.fin_summary('2026-11-01', '2026-11-30') s) x), public.fin_summary('2026-11-01', '2026-11-30')::text);
RESET ROLE;
-- Retour arrière : tout revient dans user_data, mêmes chiffres
INSERT INTO _b SELECT 'fig2', public.fin_figures('45454545-0000-4000-8000-000000000001', '2026-11-01', '2026-11-30');
SELECT public.fp_doc_mode_set('45454545-0000-4000-8000-000000000001', 'legacy') AS rb \gset
SELECT pg_temp.ok('retour arrière vers legacy : accepté', (:'rb'::jsonb->>'ok')::boolean AND public.fp_doc_mode('45454545-0000-4000-8000-000000000001') = 'legacy', :'rb');
SELECT pg_temp.ok('après retour : user_data contient les nouveaux paiements (annulation comprise) et l''avoir', (SELECT jsonb_array_length(value) FROM public.user_data WHERE user_id = '45454545-0000-4000-8000-000000000001' AND key = 'payments') = 4
  AND (SELECT count(*) FROM public.user_data, jsonb_array_elements(value) e WHERE user_id = '45454545-0000-4000-8000-000000000001' AND key = 'invoices' AND e->>'id' = 'a2') = 1);
SELECT pg_temp.ok('après retour : mêmes chiffres de novembre (lus dans user_data)', public.fin_figures('45454545-0000-4000-8000-000000000001', '2026-11-01', '2026-11-30') = (SELECT v FROM _b WHERE k = 'fig2'),
  public.fin_figures('45454545-0000-4000-8000-000000000001', '2026-11-01', '2026-11-30')::text);
DELETE FROM public.doc_store_testers WHERE user_id = '45454545-0000-4000-8000-000000000001';
