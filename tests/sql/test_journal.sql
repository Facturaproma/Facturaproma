-- Journal serveur (doc_events) : une seule trace par événement, même quand l'application sauvegarde par upsert
-- (INSERT ... ON CONFLICT DO UPDATE). Vérifie aussi que le verrouillage, la numérotation et les paiements restent intacts.
\set VERBOSITY terse
SET client_min_messages = notice;
CREATE OR REPLACE FUNCTION pg_temp.ok(name text, cond boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS
$$ BEGIN RAISE NOTICE '%', CASE WHEN cond THEN 'PASS '||name ELSE 'FAIL '||name||' '||detail END; END $$;

GRANT ALL ON public.user_data TO authenticated;   -- seule table que le client écrit ici ; doc_events et doc_counters gardent les droits retirés par le script 14
INSERT INTO auth.users(id, email) VALUES ('f1f1f1f1-0000-0000-0000-0000000000a1', 'journal@test.invalid');

-- Compte de test : numéro attribué par le serveur, puis sauvegarde « comme l'application » (upsert)
CREATE OR REPLACE FUNCTION pg_temp.save(p_value jsonb) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.user_data(user_id, key, value) VALUES ('f1f1f1f1-0000-0000-0000-0000000000a1', 'invoices', p_value)
  ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
$$;
CREATE OR REPLACE FUNCTION pg_temp.inv(p_id text, p_num text, p_status text, p_ttc numeric DEFAULT 120, p_paid numeric DEFAULT 0, p_type text DEFAULT 'invoice') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('id', p_id, 'number', p_num, 'status', p_status, 'type', p_type, 'date', '2026-10-22', 'clientId', 'c1', 'clientName', 'Client',
                            'items', jsonb_build_array(jsonb_build_object('d','x','q',1,'p',100)), 'totalHT', 100, 'totalTVA', 20, 'totalTTC', p_ttc, 'paidAmount', p_paid)
$$;
CREATE OR REPLACE FUNCTION pg_temp.n_ev(p_action text, p_number text) RETURNS int LANGUAGE sql SECURITY DEFINER AS $$
  SELECT count(*)::int FROM public.doc_events WHERE user_id = 'f1f1f1f1-0000-0000-0000-0000000000a1' AND action = p_action AND number = p_number
$$;
CREATE OR REPLACE FUNCTION pg_temp.detail_of(p_action text, p_number text) RETURNS text LANGUAGE sql SECURITY DEFINER AS $$
  SELECT detail FROM public.doc_events WHERE user_id = 'f1f1f1f1-0000-0000-0000-0000000000a1' AND action = p_action AND number = p_number LIMIT 1
$$;
CREATE OR REPLACE FUNCTION pg_temp.n_all() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$
  SELECT count(*)::int FROM public.doc_events WHERE user_id = 'f1f1f1f1-0000-0000-0000-0000000000a1'
$$;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','f1f1f1f1-0000-0000-0000-0000000000a1',false), set_config('request.jwt.claim.email','journal@test.invalid',false);

-- 1. Première émission, sans ligne existante (INSERT simple dans le chemin upsert)
SELECT public.next_doc_number('invoice', 0) AS n1 \gset
SELECT pg_temp.ok('le serveur attribue le numéro 1', :n1 = 1);
SELECT pg_temp.save(jsonb_build_array(pg_temp.inv('i1', 'FAC-2026-0001', 'sent')));
SELECT pg_temp.ok('1re émission (insertion) : exactement 1 événement « emission »', pg_temp.n_ev('emission','FAC-2026-0001') = 1);

-- 2. Plusieurs sauvegardes successives par upsert, contenu identique : plus de doublon
SELECT pg_temp.save(jsonb_build_array(pg_temp.inv('i1', 'FAC-2026-0001', 'sent')));
SELECT pg_temp.save(jsonb_build_array(pg_temp.inv('i1', 'FAC-2026-0001', 'sent')));
SELECT pg_temp.save(jsonb_build_array(pg_temp.inv('i1', 'FAC-2026-0001', 'sent')));
SELECT pg_temp.save(jsonb_build_array(pg_temp.inv('i1', 'FAC-2026-0001', 'sent')));
SELECT pg_temp.ok('5 sauvegardes par upsert : toujours 1 seul « emission »', pg_temp.n_ev('emission','FAC-2026-0001') = 1, 'trouvé='||pg_temp.n_ev('emission','FAC-2026-0001'));
SELECT pg_temp.ok('aucun autre événement parasite', pg_temp.n_all() = 1, 'total='||pg_temp.n_all());

-- 3. Paiement : le statut change légitimement, il est journalisé UNE fois ; l'émission n'est pas rejournalisée
SELECT pg_temp.save(jsonb_build_array(pg_temp.inv('i1', 'FAC-2026-0001', 'paid', 120, 120)));
SELECT pg_temp.ok('paiement : 1 événement « statut » (sent -> paid)', pg_temp.n_ev('statut','FAC-2026-0001') = 1);
SELECT pg_temp.ok('paiement : l''émission reste à 1', pg_temp.n_ev('emission','FAC-2026-0001') = 1);
SELECT pg_temp.save(jsonb_build_array(pg_temp.inv('i1', 'FAC-2026-0001', 'paid', 120, 120)));
SELECT pg_temp.save(jsonb_build_array(pg_temp.inv('i1', 'FAC-2026-0001', 'paid', 120, 120)));
SELECT pg_temp.ok('re-sauvegardes après paiement : pas de nouveau « statut »', pg_temp.n_ev('statut','FAC-2026-0001') = 1);
SELECT pg_temp.ok('le détail du statut est correct', pg_temp.detail_of('statut','FAC-2026-0001') = 'sent -> paid');

-- 4. Une 2e facture et un avoir : événements légitimes conservés, une fois chacun
SELECT public.next_doc_number('invoice', 0) AS n2 \gset
SELECT pg_temp.save(jsonb_build_array(pg_temp.inv('i1', 'FAC-2026-0001', 'paid', 120, 120), pg_temp.inv('i2', format('FAC-2026-%s', lpad(:n2::text, 4, '0')), 'sent')));
SELECT pg_temp.save(jsonb_build_array(pg_temp.inv('i1', 'FAC-2026-0001', 'paid', 120, 120), pg_temp.inv('i2', format('FAC-2026-%s', lpad(:n2::text, 4, '0')), 'sent')));
SELECT pg_temp.ok('2e facture : numéro 2 et 1 événement « emission »', :n2 = 2 AND pg_temp.n_ev('emission', 'FAC-2026-0002') = 1);
SELECT pg_temp.ok('la 1re facture n''est pas rejournalisée', pg_temp.n_ev('emission','FAC-2026-0001') = 1);
SELECT public.next_doc_number('credit', 0) AS c1 \gset
SELECT pg_temp.save(jsonb_build_array(pg_temp.inv('i1', 'FAC-2026-0001', 'paid', 120, 120), pg_temp.inv('i2', 'FAC-2026-0002', 'sent'), pg_temp.inv('a1', format('AVR-2026-%s', lpad(:c1::text, 4, '0')), 'sent', -120, 0, 'credit')));
SELECT pg_temp.ok('avoir : 1 événement « avoir »', pg_temp.n_ev('avoir', 'AVR-2026-0001') = 1);
SELECT pg_temp.ok('total d''événements : 2 émissions + 1 avoir + 1 statut = 4', pg_temp.n_all() = 4, 'total='||pg_temp.n_all());

-- 5. Verrouillage inchangé : modifications et suppressions interdites, sans nouvel événement ni changement de données
CREATE OR REPLACE FUNCTION pg_temp.refuse(p_name text, p_value jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r boolean := false; msg text; BEGIN
  BEGIN PERFORM pg_temp.save(p_value); EXCEPTION WHEN OTHERS THEN r := true; msg := SQLERRM; END;
  PERFORM pg_temp.ok(p_name, r, 'accepté à tort'); END $$;
SELECT pg_temp.refuse('montant d''une facture émise : modification refusée (upsert)', jsonb_build_array(pg_temp.inv('i1', 'FAC-2026-0001', 'paid', 999, 120), pg_temp.inv('i2', 'FAC-2026-0002', 'sent'), pg_temp.inv('a1', 'AVR-2026-0001', 'sent', -120, 0, 'credit')));
SELECT pg_temp.refuse('numéro d''une facture émise : modification refusée (upsert)', jsonb_build_array(pg_temp.inv('i1', 'FAC-2026-0099', 'paid', 120, 120), pg_temp.inv('i2', 'FAC-2026-0002', 'sent'), pg_temp.inv('a1', 'AVR-2026-0001', 'sent', -120, 0, 'credit')));
SELECT pg_temp.refuse('suppression d''une facture émise : refusée (upsert)', jsonb_build_array(pg_temp.inv('i2', 'FAC-2026-0002', 'sent'), pg_temp.inv('a1', 'AVR-2026-0001', 'sent', -120, 0, 'credit')));
SELECT pg_temp.refuse('retour au brouillon : refusé (upsert)', jsonb_build_array(pg_temp.inv('i1', 'FAC-2026-0001', 'draft', 120, 120), pg_temp.inv('i2', 'FAC-2026-0002', 'sent'), pg_temp.inv('a1', 'AVR-2026-0001', 'sent', -120, 0, 'credit')));
SELECT pg_temp.refuse('numéro non attribué par le serveur : refusé (upsert)', jsonb_build_array(pg_temp.inv('i1', 'FAC-2026-0001', 'paid', 120, 120), pg_temp.inv('i2', 'FAC-2026-0002', 'sent'), pg_temp.inv('a1', 'AVR-2026-0001', 'sent', -120, 0, 'credit'), pg_temp.inv('i9', 'FAC-2026-0077', 'sent')));
SELECT pg_temp.refuse('numéro en double : refusé (upsert)', jsonb_build_array(pg_temp.inv('i1', 'FAC-2026-0001', 'paid', 120, 120), pg_temp.inv('i2', 'FAC-2026-0002', 'sent'), pg_temp.inv('a1', 'AVR-2026-0001', 'sent', -120, 0, 'credit'), pg_temp.inv('i8', 'FAC-2026-0002', 'sent')));
DO $$ DECLARE r boolean := false; BEGIN
  BEGIN DELETE FROM public.user_data WHERE key = 'invoices'; EXCEPTION WHEN OTHERS THEN r := true; END;
  PERFORM pg_temp.ok('suppression directe de la ligne contenant des factures émises : refusée', r); END $$;
RESET ROLE;
SELECT pg_temp.ok('les refus n''ont créé aucun événement', pg_temp.n_all() = 4, 'total='||pg_temp.n_all());
SELECT pg_temp.ok('données inchangées après les refus (montant 120, payé 120)', (SELECT (value->0->>'totalTTC')::numeric = 120 AND (value->0->>'paidAmount')::numeric = 120 AND jsonb_array_length(value) = 3 FROM public.user_data WHERE user_id='f1f1f1f1-0000-0000-0000-0000000000a1' AND key='invoices'));
SELECT pg_temp.ok('compteurs serveur inchangés (facture 2, avoir 1)', (SELECT last_value FROM public.doc_counters WHERE user_id='f1f1f1f1-0000-0000-0000-0000000000a1' AND doc_type='invoice') = 2
                                                                   AND (SELECT last_value FROM public.doc_counters WHERE user_id='f1f1f1f1-0000-0000-0000-0000000000a1' AND doc_type='credit') = 1);
