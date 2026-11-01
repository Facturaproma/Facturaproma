-- sql/43 : avoirs partiels — plusieurs avoirs par facture, cumul plafonné au TTC de la facture (serveur).
\set VERBOSITY terse
SET client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.ok(name text, cond boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS
$$ BEGIN RAISE NOTICE '%', CASE WHEN cond THEN 'PASS '||name ELSE 'FAIL '||name||' '||detail END; END $$;
CREATE OR REPLACE FUNCTION pg_temp.err(sql text) RETURNS text LANGUAGE plpgsql AS
$$ BEGIN EXECUTE sql; RETURN ''; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $$;
GRANT EXECUTE ON FUNCTION pg_temp.ok(text, boolean, text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION pg_temp.err(text) TO PUBLIC;
GRANT ALL ON public.user_data TO authenticated;
INSERT INTO auth.users(id, email) VALUES ('43434343-0000-4000-8000-000000000001', 'avp@test.invalid');
CREATE TEMP TABLE IF NOT EXISTS _v(arr jsonb); GRANT ALL ON _v TO PUBLIC;
CREATE OR REPLACE FUNCTION pg_temp.doc(p_id text, p_num text, p_type text, p_ttc numeric, p_rel text DEFAULT NULL, p_status text DEFAULT 'sent') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', p_id, 'number', p_num, 'status', p_status, 'type', p_type, 'date', '2026-11-01', 'clientId', 'c1', 'clientName', 'Client',
                            'items', '[]'::jsonb, 'totalHT', round(p_ttc / 1.2, 2), 'totalTVA', p_ttc - round(p_ttc / 1.2, 2), 'totalTTC', p_ttc)
         || CASE WHEN p_rel IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('relatedInvoiceId', p_rel) END
$$;
CREATE OR REPLACE FUNCTION pg_temp.save(p jsonb) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.user_data(user_id, key, value) VALUES ('43434343-0000-4000-8000-000000000001', 'invoices', p)
  ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
$$;
GRANT EXECUTE ON FUNCTION pg_temp.doc(text, text, text, numeric, text, text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION pg_temp.save(jsonb) TO PUBLIC;

SELECT pg_temp.ok('garde-fou interne non exposé', NOT has_function_privilege('authenticated', 'public.guard_credit_cap()', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.guard_credit_cap()', 'EXECUTE'));
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','43434343-0000-4000-8000-000000000001',false), set_config('request.jwt.claim.email','avp@test.invalid',false);
SELECT public.next_doc_number('invoice', 0) AS i1 \gset
SELECT public.next_doc_number('invoice', 0) AS i2 \gset
INSERT INTO _v SELECT jsonb_build_array(pg_temp.doc('f1', 'FAC-2026-000' || :i1, 'invoice', 1200), pg_temp.doc('f2', 'FAC-2026-000' || :i2, 'invoice', 600));
SELECT pg_temp.save(arr) FROM _v;
SELECT public.next_doc_number('credit', 0) AS c1 \gset
UPDATE _v SET arr = arr || jsonb_build_array(pg_temp.doc('a1', 'AVR-2026-000' || :c1, 'credit', -400, 'f1'));
SELECT pg_temp.ok('1er avoir partiel (400 sur 1200) accepté', pg_temp.err($$SELECT pg_temp.save(arr) FROM _v$$) = '');
SELECT public.next_doc_number('credit', 0) AS c2 \gset
UPDATE _v SET arr = arr || jsonb_build_array(pg_temp.doc('a2', 'AVR-2026-000' || :c2, 'credit', -800, 'f1'));
SELECT pg_temp.ok('2e avoir partiel (cumul 1200 = TTC) accepté', pg_temp.err($$SELECT pg_temp.save(arr) FROM _v$$) = '');
SELECT public.next_doc_number('credit', 0) AS c3 \gset
SELECT pg_temp.ok('3e avoir (cumul 1200,50 > 1200) refusé',
  pg_temp.err(format($$SELECT pg_temp.save(arr || jsonb_build_array(pg_temp.doc('a3', 'AVR-2026-000%s', 'credit', -0.5, 'f1'))) FROM _v$$, :c3)) LIKE '%AVOIR_SUPERIEUR_FACTURE%');
SELECT pg_temp.ok('avoir unique supérieur au TTC refusé (700 sur 600)',
  pg_temp.err(format($$SELECT pg_temp.save(arr || jsonb_build_array(pg_temp.doc('a3', 'AVR-2026-000%s', 'credit', -700, 'f2'))) FROM _v$$, :c3)) LIKE '%AVOIR_SUPERIEUR_FACTURE%');
SELECT pg_temp.ok('arrondi toléré (600,01 sur 600) accepté',
  pg_temp.err(format($$SELECT pg_temp.save(arr || jsonb_build_array(pg_temp.doc('a3', 'AVR-2026-000%s', 'credit', -600.01, 'f2'))) FROM _v$$, :c3)) = '');
SELECT pg_temp.ok('un brouillon d''avoir n''est pas compté',
  pg_temp.err($$SELECT pg_temp.save((SELECT value FROM public.user_data WHERE key = 'invoices') || jsonb_build_array(pg_temp.doc('d1', '', 'credit', -5000, 'f1', 'draft')))$$) = '');
SELECT pg_temp.ok('réécriture identique (aucune augmentation) acceptée', pg_temp.err($$SELECT pg_temp.save((SELECT value FROM public.user_data WHERE key = 'invoices'))$$) = '');
SELECT pg_temp.ok('cumul enregistré : 1200 sur f1, 600,01 sur f2', (SELECT sum(abs((e->>'totalTTC')::numeric)) FILTER (WHERE e->>'relatedInvoiceId' = 'f1' AND e->>'status' <> 'draft') = 1200
   AND sum(abs((e->>'totalTTC')::numeric)) FILTER (WHERE e->>'relatedInvoiceId' = 'f2') = 600.01 FROM public.user_data, jsonb_array_elements(value) e WHERE key = 'invoices'));
RESET ROLE;
