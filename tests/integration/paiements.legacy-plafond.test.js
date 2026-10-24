/* Répétition LOCALE de sql/26 (plafond des paiements pour les comptes legacy). PostgreSQL local jetable, données fictives.
 * Ce n'est PAS une validation sur Supabase. */
'use strict';
const { execFileSync, spawnSync } = require('child_process'); const path = require('path'); const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const env = { ...process.env, PGHOST: process.env.PGHOST || '/tmp', PGPORT: process.env.PGPORT || '5599', PGUSER: process.env.PGUSER || 'postgres' };
const db = 'leg_' + crypto.randomBytes(3).toString('hex');
const R = []; const ok = (n, c, x = '') => { R.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? ' ' + x : '')); };
const sql = (d, q) => spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At', '-d', d, '-c', q], { env, encoding: 'utf8' });
const must = (d, q) => { const r = sql(d, q); if (r.status !== 0) throw new Error(r.stderr.slice(0, 200)); return r.stdout.trim(); };
const U = '22222222-2222-2222-2222-222222222222';
const pay = (id, inv, amt) => ({ id, invoiceId: inv, amount: amt, method: 'cash', date: '2026-10-24' });
const put = (arr) => sql(db, `INSERT INTO public.user_data(user_id,key,value) VALUES ('${U}','payments','${JSON.stringify(arr)}'::jsonb) ON CONFLICT (user_id,key) DO UPDATE SET value=EXCLUDED.value`);
try {
  must('postgres', `CREATE DATABASE ${db}`);
  must(db, `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF; END $$;
    CREATE SCHEMA IF NOT EXISTS auth; CREATE TABLE auth.users(id uuid primary key,email text);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true),'')::uuid $f$;
    INSERT INTO auth.users VALUES ('${U}','fictif@facturapro-test.invalid')`);
  for (const f of ['00_setup_complet', '14_numerotation_et_verrouillage', '15_documents']) { const r = spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', path.join(ROOT, 'sql', f + '.sql')], { env, encoding: 'utf8' }); if (r.status) throw new Error(f + ' ' + r.stderr.slice(0, 200)); }
  const inv = [{ id: 'i1', status: 'draft', totalTTC: 1000 }, { id: 'i0', status: 'draft', totalTTC: 0 }];
  must(db, `INSERT INTO public.user_data(user_id,key,value) VALUES ('${U}','invoices','${JSON.stringify(inv)}'::jsonb)`);
  // Avant installation : le trop-perçu passe (preuve de la lacune)
  ok('SANS sql/26 : un paiement de 1500 sur 1000 est accepté (lacune des comptes legacy)', put([pay('p1', 'i1', 1500)]).status === 0);
  must(db, `DELETE FROM public.user_data WHERE key='payments'`);
  const r0 = spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', path.join(ROOT, 'sql', '26_plafond_paiements_legacy.sql')], { env, encoding: 'utf8' });
  ok('sql/26 s\'installe sans erreur', r0.status === 0, r0.stderr.slice(0, 120));
  let r = put([pay('p1', 'i1', 400)]); ok('premier paiement partiel 400/1000 accepté', r.status === 0, r.stderr.slice(0, 100));
  r = put([pay('p1', 'i1', 400), pay('p2', 'i1', 600)]); ok('solde exact 400+600 = 1000 accepté', r.status === 0);
  r = put([pay('p1', 'i1', 400), pay('p2', 'i1', 600), pay('p3', 'i1', 0.01)]); ok('0,01 de plus : accepté (tolérance centime)', r.status === 0, r.stderr.slice(0, 100));
  r = put([pay('p1', 'i1', 400), pay('p2', 'i1', 600), pay('p3', 'i1', 0.01), pay('p4', 'i1', 50)]); ok('trop-perçu cumulé refusé (PAIEMENT_SUPERIEUR_AU_RESTE)', r.status !== 0 && /PAIEMENT_SUPERIEUR_AU_RESTE/.test(r.stderr));
  const kept = must(db, `SELECT jsonb_array_length(value) FROM public.user_data WHERE key='payments'`); ok('après refus : la valeur précédente est intacte (3 paiements)', kept === '3', kept);
  r = put([pay('p1', 'i1', 400), pay('p2', 'i1', 600), pay('p3', 'i1', 0.01), pay('q1', 'i0', 10)]); ok('facture à 0 : nouveau paiement refusé (PAIEMENT_FACTURE_NULLE)', r.status !== 0 && /PAIEMENT_FACTURE_NULLE/.test(r.stderr));
  r = put([pay('p1', 'i1', 400), pay('p2', 'i1', 600), pay('p3', 'i1', 0.01), pay('z1', 'inconnue', 99999)]); ok('facture inconnue du serveur : accepté (rien à comparer, limite documentée)', r.status === 0);
  // Ancien trop-perçu déjà présent : ne bloque pas une écriture qui n'ajoute aucun paiement ni ne touche cette facture
  must(db, `ALTER TABLE public.user_data DISABLE TRIGGER trg_10_payments_cap`); put([pay('o1', 'i1', 5000)]); must(db, `ALTER TABLE public.user_data ENABLE TRIGGER trg_10_payments_cap`);
  r = put([pay('o1', 'i1', 5000)]); ok('ancien trop-perçu : réécriture identique acceptée (pas de blocage rétroactif)', r.status === 0);
  r = put([pay('o1', 'i1', 5000), pay('n1', 'i1', 1)]); ok('ancien trop-perçu : un NOUVEAU paiement sur cette facture est refusé', r.status !== 0);
  must(db, `DELETE FROM public.user_data WHERE key='payments'`);
  // Concurrence : deux écritures simultanées de 600 sur 1000 (deux onglets) → pas de dépassement dans la base
  const a = spawnSync('bash', ['-c', `psql -X -q -d ${db} -c "INSERT INTO public.user_data(user_id,key,value) VALUES ('${U}','payments','[{\\"id\\":\\"a\\",\\"invoiceId\\":\\"i1\\",\\"amount\\":600}]') ON CONFLICT (user_id,key) DO UPDATE SET value=EXCLUDED.value" & psql -X -q -d ${db} -c "INSERT INTO public.user_data(user_id,key,value) VALUES ('${U}','payments','[{\\"id\\":\\"b\\",\\"invoiceId\\":\\"i1\\",\\"amount\\":600}]') ON CONFLICT (user_id,key) DO UPDATE SET value=EXCLUDED.value" ; wait`], { env, encoding: 'utf8' });
  const tot = must(db, `SELECT COALESCE(sum((e->>'amount')::numeric),0) FROM public.user_data u, jsonb_array_elements(u.value) e WHERE u.key='payments'`); ok('deux écritures simultanées (blobs distincts) : le total stocké reste <= 1000', Number(tot) <= 1000, 'total=' + tot + ' (dernier écrivain gagne : limite connue du mode legacy)');
  const tg = must(db, `SELECT count(*) FROM pg_trigger WHERE tgname='trg_10_payments_cap'`); ok('retour arrière documenté : le déclencheur se supprime proprement', (sql(db, 'DROP TRIGGER trg_10_payments_cap ON public.user_data').status === 0) && tg === '1');
} catch (e) { console.log('ERREUR', e.message); R.push(false); }
finally { try { must('postgres', `DROP DATABASE IF EXISTS ${db}`); } catch (e) {} }
if (R.includes(false)) { console.log('\nÉCHEC : ' + R.filter((x) => !x).length); process.exit(1); } else console.log('\nOK : ' + R.length + ' contrôles (sql/26 legacy, PostgreSQL local jetable, données fictives)');
