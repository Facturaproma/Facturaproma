-- Tests SQL : isolation entre comptes, numérotation serveur, verrouillage des factures émises.
-- Les données sont fictives. Chaque test affiche PASS ou FAIL.
\set VERBOSITY terse
SET client_min_messages = notice;

CREATE OR REPLACE FUNCTION pg_temp.ok(name text, cond boolean) RETURNS void LANGUAGE plpgsql AS
$$ BEGIN RAISE NOTICE '%', CASE WHEN cond THEN 'PASS '||name ELSE 'FAIL '||name END; END $$;

-- Deux entreprises fictives avec licence active
INSERT INTO auth.users(id, email) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a@test.invalid'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'b@test.invalid');
INSERT INTO public.licenses(user_id, type, status, expires_at) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'annual', 'active', now() + interval '300 days'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'annual', 'active', now() + interval '300 days');
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;

-- ====== Isolation ======
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
INSERT INTO public.user_data(user_id, key, value) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'clients', '[{"id":"c1","name":"Client secret A"}]'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'invoices',
   '[{"id":"i1","number":"FAC-2026-001","status":"sent","clientId":"c1","items":[{"price":100}],"totalHT":100,"totalTVA":20,"totalTTC":120,"date":"2026-10-01"},{"id":"i2","number":"BRO-x","status":"draft","totalTTC":50}]');

SELECT set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-000000000002', false);
SELECT pg_temp.ok('B ne lit aucune donnée de A', (SELECT count(*) FROM public.user_data) = 0);
UPDATE public.user_data SET value = '[]' WHERE key = 'clients';
SELECT pg_temp.ok('B ne modifie aucune donnée de A', true);
DO $$ BEGIN
  BEGIN
    INSERT INTO public.user_data(user_id, key, value) VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'x', '[]');
    PERFORM pg_temp.ok('B ne peut pas écrire chez A', false);
  EXCEPTION WHEN OTHERS THEN PERFORM pg_temp.ok('B ne peut pas écrire chez A', true);
  END; END $$;
DELETE FROM public.user_data;
RESET ROLE;
SELECT pg_temp.ok('B ne supprime rien chez A', (SELECT count(*) FROM public.user_data WHERE user_id='aaaaaaaa-0000-0000-0000-000000000001') = 2);
SELECT pg_temp.ok('Les clients de A sont intacts', (SELECT value->0->>'name' FROM public.user_data WHERE key='clients') = 'Client secret A');

-- ====== Numérotation serveur ======
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
SELECT pg_temp.ok('1er numéro = 1', public.next_doc_number('invoice', 0) = 1);
SELECT pg_temp.ok('2e numéro = 2', public.next_doc_number('invoice', 0) = 2);
SELECT pg_temp.ok('plancher local 41 => 42', public.next_doc_number('invoice', 41) = 42);
SELECT pg_temp.ok('plancher plus bas ignoré => 43', public.next_doc_number('invoice', 5) = 43);
SELECT pg_temp.ok('compteur des avoirs indépendant', public.next_doc_number('credit', 0) = 1);
SELECT set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-000000000002', false);
SELECT pg_temp.ok('compteur de B indépendant de A', public.next_doc_number('invoice', 0) = 1);
SELECT pg_temp.ok('B ne lit pas les compteurs de A', (SELECT count(*) FROM public.doc_counters) = 1);
DO $$ BEGIN
  BEGIN PERFORM public.next_doc_number('hack', 0); PERFORM pg_temp.ok('type invalide refusé', false);
  EXCEPTION WHEN OTHERS THEN PERFORM pg_temp.ok('type invalide refusé', true); END;
  BEGIN UPDATE public.doc_counters SET last_value = 0; PERFORM pg_temp.ok('B ne remet pas un compteur à zéro', (SELECT min(last_value) FROM public.doc_counters) >= 1);
  EXCEPTION WHEN OTHERS THEN PERFORM pg_temp.ok('B ne remet pas un compteur à zéro', true); END;
END $$;
RESET ROLE;
SET ROLE anon;
DO $$ BEGIN
  BEGIN PERFORM public.next_doc_number('invoice', 0); PERFORM pg_temp.ok('anonyme refusé', false);
  EXCEPTION WHEN OTHERS THEN PERFORM pg_temp.ok('anonyme refusé', true); END; END $$;
RESET ROLE;

-- ====== Verrouillage des factures émises ======
SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
DO $$
DECLARE base jsonb := (SELECT value FROM public.user_data WHERE key='invoices'); v jsonb; r boolean;
BEGIN
  -- suppression d'une facture émise
  BEGIN UPDATE public.user_data SET value = base - 0 WHERE key='invoices'; PERFORM pg_temp.ok('suppression facture émise refusée', false);
  EXCEPTION WHEN OTHERS THEN PERFORM pg_temp.ok('suppression facture émise refusée', SQLERRM LIKE 'FACTURE_VERROUILLEE%'); END;
  -- modification du montant
  v := jsonb_set(base, '{0,totalTTC}', '999');
  BEGIN UPDATE public.user_data SET value = v WHERE key='invoices'; PERFORM pg_temp.ok('modification du montant refusée', false);
  EXCEPTION WHEN OTHERS THEN PERFORM pg_temp.ok('modification du montant refusée', SQLERRM LIKE 'FACTURE_VERROUILLEE%'); END;
  -- modification des lignes
  v := jsonb_set(base, '{0,items,0,price}', '1');
  BEGIN UPDATE public.user_data SET value = v WHERE key='invoices'; PERFORM pg_temp.ok('modification des lignes refusée', false);
  EXCEPTION WHEN OTHERS THEN PERFORM pg_temp.ok('modification des lignes refusée', SQLERRM LIKE 'FACTURE_VERROUILLEE%'); END;
  -- changement de numéro
  v := jsonb_set(base, '{0,number}', '"FAC-2026-999"');
  BEGIN UPDATE public.user_data SET value = v WHERE key='invoices'; PERFORM pg_temp.ok('changement de numéro refusé', false);
  EXCEPTION WHEN OTHERS THEN PERFORM pg_temp.ok('changement de numéro refusé', SQLERRM LIKE 'FACTURE_VERROUILLEE%'); END;
  -- retour au brouillon
  v := jsonb_set(base, '{0,status}', '"draft"');
  BEGIN UPDATE public.user_data SET value = v WHERE key='invoices'; PERFORM pg_temp.ok('retour au brouillon refusé', false);
  EXCEPTION WHEN OTHERS THEN PERFORM pg_temp.ok('retour au brouillon refusé', SQLERRM LIKE 'FACTURE_VERROUILLEE%'); END;
  -- paiement : statut payé + montant réglé = autorisé
  v := jsonb_set(jsonb_set(base, '{0,status}', '"paid"'), '{0,paidAmount}', '120');
  BEGIN UPDATE public.user_data SET value = v WHERE key='invoices'; PERFORM pg_temp.ok('enregistrer un paiement autorisé', true);
  EXCEPTION WHEN OTHERS THEN PERFORM pg_temp.ok('enregistrer un paiement autorisé', false); END;
  -- brouillon modifiable et supprimable
  v := (SELECT value FROM public.user_data WHERE key='invoices');
  BEGIN UPDATE public.user_data SET value = jsonb_set(v, '{1,totalTTC}', '75') WHERE key='invoices'; PERFORM pg_temp.ok('brouillon modifiable', true);
  EXCEPTION WHEN OTHERS THEN PERFORM pg_temp.ok('brouillon modifiable', false); END;
  v := (SELECT value FROM public.user_data WHERE key='invoices');
  BEGIN UPDATE public.user_data SET value = v - 1 WHERE key='invoices'; PERFORM pg_temp.ok('brouillon supprimable', true);
  EXCEPTION WHEN OTHERS THEN PERFORM pg_temp.ok('brouillon supprimable', false); END;
  -- avoir ajouté (nouvel élément émis) autorisé
  v := (SELECT value FROM public.user_data WHERE key='invoices') || '[{"id":"cr1","number":"AVR-2026-001","type":"credit","status":"sent","totalTTC":-120}]'::jsonb;
  BEGIN UPDATE public.user_data SET value = v WHERE key='invoices'; PERFORM pg_temp.ok('création d''un avoir autorisée', true);
  EXCEPTION WHEN OTHERS THEN PERFORM pg_temp.ok('création d''un avoir autorisée', false); END;
END $$;
RESET ROLE;
