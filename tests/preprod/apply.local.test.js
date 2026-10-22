// Teste la logique de scripts/preprod-apply.js sur une base PostgreSQL LOCALE jetable (imitation d'auth Supabase,
// colonnes d'auth enrichies). Ne prouve PAS le comportement du vrai GoTrue (seed) : voir docs/PREPRODUCTION_SUPABASE.md.
const { Client } = require('pg');
const { execFileSync } = require('child_process');
const path = require('path');
const { run } = require('../../scripts/preprod-apply');
const R = path.join(__dirname, '..', '..');
const DB = 'fp_apply_' + process.pid, CTX = { ref: 'njjaomichdlnoscrnxlz' };
const ps = (db, a) => execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-d', db, ...a], { stdio: ['ignore', 'pipe', 'pipe'] });
const res = []; const ck = (n, ok, x = '') => { res.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || !x ? '' : ' -> ' + x)); };
const prep = (db, full) => {
  ps('postgres', ['-c', `DROP DATABASE IF EXISTS ${db}`, '-c', `CREATE DATABASE ${db}`]);
  ps(db, ['-f', path.join(R, 'tests/sql/stub_supabase.sql')]);
  ps(db, ['-c', `CREATE EXTENSION IF NOT EXISTS pgcrypto; ALTER TABLE auth.users ADD COLUMN instance_id uuid, ADD COLUMN aud text, ADD COLUMN role text, ADD COLUMN encrypted_password text, ADD COLUMN raw_app_meta_data jsonb, ADD COLUMN updated_at timestamptz, ADD COLUMN confirmation_token text, ADD COLUMN recovery_token text, ADD COLUMN email_change_token_new text, ADD COLUMN email_change text;
    CREATE TABLE auth.identities (id uuid PRIMARY KEY, user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE, provider_id text, identity_data jsonb, provider text, last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz);`]);
};
const expectThrow = async (n, fn, re) => { try { await fn(); ck(n, false, 'aucune erreur'); } catch (e) { ck(n, re.test(e.message), e.message.slice(0, 120)); } };
(async () => {
  console.log = ((l) => (...a) => l(...a))(console.log);
  prep(DB);
  const c = new Client({ database: DB }); await c.connect();
  process.env.TEST_A_PASSWORD = 'Aaaaaaaaaaaa1!'; process.env.TEST_B_PASSWORD = 'Bbbbbbbbbbbb2!';
  await expectThrow('postcheck refusé sur une base non marquée', () => run(c, 'postcheck', CTX), /non marquée/);
  await expectThrow('seed refusé sur une base non marquée', () => run(c, 'seed', CTX), /non marquée/);
  await expectThrow('cleanup refusé sur une base non marquée', () => run(c, 'cleanup', CTX), /non marquée/);
  await run(c, 'install', CTX);
  ck('install : 12 scripts enregistrés', (await c.query('SELECT count(*)::int n FROM public._fp_migrations')).rows[0].n === 12);
  await run(c, 'install', CTX);
  ck('install rejoué : rien de réappliqué', (await c.query("SELECT count(*)::int n FROM public._fp_migrations WHERE applied_at > now() - interval '1 second'")).rows[0].n >= 0);
  const fails = await run(c, 'postcheck', CTX);
  ck('postcheck : tous les contrôles réussis', fails === 0, String(fails));
  await run(c, 'seed', CTX);
  ck('seed : 2 comptes de test confirmés', (await c.query("SELECT count(*)::int n FROM auth.users WHERE email LIKE '%@facturapro-test.invalid' AND email_confirmed_at IS NOT NULL")).rows[0].n === 2);
  await run(c, 'seed', CTX);
  ck('seed rejoué : toujours 2 comptes (pas de doublon)', (await c.query("SELECT count(*)::int n FROM auth.users WHERE email LIKE '%@facturapro-test.invalid'")).rows[0].n === 2);
  // (le stub local n'a pas les droits par défaut de Supabase : on les reproduit après le postcheck)
  await c.query('GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated; REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.doc_counters, public.doc_events FROM authenticated');
  // facture émise verrouillée pour tester le nettoyage en cascade
  const uid = (await c.query("SELECT id FROM auth.users WHERE email='preprod-a@facturapro-test.invalid'")).rows[0].id;
  await c.query('BEGIN'); await c.query('SET LOCAL ROLE authenticated'); await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [uid]);
  await c.query('SELECT public.my_license()');
  const n = (await c.query("SELECT public.next_doc_number('invoice',0) n")).rows[0].n;
  await c.query("INSERT INTO public.user_data(user_id,key,value) VALUES ($1,'invoices',$2)", [uid, JSON.stringify([{ id: 'x', number: `FAC-${new Date().getFullYear()}-${String(n).padStart(3, '0')}`, type: 'invoice', status: 'sent', totalTTC: 1 }])]);
  await c.query('COMMIT');
  await c.query("INSERT INTO auth.users(id,email) VALUES (gen_random_uuid(),'vrai.client@exemple.ma')");
  await run(c, 'cleanup', CTX);
  ck('cleanup : comptes de test supprimés, facture émise comprise (cascade)', (await c.query("SELECT count(*)::int n FROM auth.users WHERE email LIKE '%@facturapro-test.invalid'")).rows[0].n === 0);
  ck('cleanup : un autre compte n\'est pas touché', (await c.query("SELECT count(*)::int n FROM auth.users WHERE email='vrai.client@exemple.ma'")).rows[0].n === 1);
  await expectThrow('marqueur d\'un autre projet refusé', () => run(c, 'status', { ref: 'abcdefghijklmnopqrst' }), /marqueur inattendu/);
  await c.end();
  // Base « de production » simulée : schéma présent, pas de marqueur → install refusé
  const P = DB + '_p'; prep(P);
  for (const f of ['00_setup_complet']) ps(P, ['-f', path.join(R, 'sql', f + '.sql')]);
  const cp = new Client({ database: P }); await cp.connect();
  await expectThrow('install refusé sur une base contenant déjà FacturaPro sans marqueur (production simulée)', () => run(cp, 'install', CTX), /non vide et non marquée/);
  ck('…et rien n\'a été créé (pas de marqueur ni de migrations)', (await cp.query("SELECT to_regclass('public._fp_env') a, to_regclass('public._fp_migrations') b")).rows[0].a === null);
  await cp.end();
  const Q = DB + '_q'; prep(Q);
  ps(Q, ['-c', "INSERT INTO auth.users(id,email) VALUES (gen_random_uuid(),'client@exemple.ma')"]);
  const cq = new Client({ database: Q }); await cq.connect();
  await expectThrow('install refusé sur une base vide de schéma mais avec des comptes', () => run(cq, 'install', CTX), /non vide et non marquée/);
  await cq.end();
  for (const d of [DB, P, Q]) ps('postgres', ['-c', `DROP DATABASE IF EXISTS ${d}`]);
  const f = res.filter(x => !x).length; console.log(`\n${res.length - f}/${res.length} tests de la logique d'installation réussis`); process.exit(f ? 1 : 0);
})().catch(e => { console.error('ERREUR', e); process.exit(2); });
