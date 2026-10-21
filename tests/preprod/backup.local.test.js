// Répétition LOCALE (SIMULÉE) de scripts/preprod-backup.js : base source = PostgreSQL local avec les scripts du dépôt et des données fictives.
// Prouve la logique de l'outil (sommaire, restauration, comparaison, détection d'une corruption), PAS le comportement du vrai Supabase.
const { Client } = require('pg');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs'), path = require('path');
const { run } = require('../../scripts/preprod-apply');
const R = path.join(__dirname, '..', '..');
const SRC = 'fp_bksrc_' + process.pid, CTX = { ref: 'njjaomichdlnoscrnxlz' };
const ps = (db, a) => execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-d', db, ...a], { stdio: ['ignore', 'pipe', 'pipe'] });
const res = []; const ck = (n, ok, x = '') => { res.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || !x ? '' : ' -> ' + x)); };
(async () => {
  ps('postgres', ['-c', `DROP DATABASE IF EXISTS ${SRC}`, '-c', `CREATE DATABASE ${SRC}`]);
  ps(SRC, ['-f', path.join(R, 'tests/sql/stub_supabase.sql')]);
  ps(SRC, ['-c', `CREATE EXTENSION IF NOT EXISTS pgcrypto; ALTER TABLE auth.users ADD COLUMN instance_id uuid, ADD COLUMN aud text, ADD COLUMN role text, ADD COLUMN encrypted_password text, ADD COLUMN raw_app_meta_data jsonb, ADD COLUMN updated_at timestamptz, ADD COLUMN confirmation_token text, ADD COLUMN recovery_token text, ADD COLUMN email_change_token_new text, ADD COLUMN email_change text;
    CREATE TABLE auth.identities (id uuid PRIMARY KEY, user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE, provider_id text, identity_data jsonb, provider text, last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz);`]);
  const c = new Client({ database: SRC }); await c.connect();
  process.env.TEST_A_PASSWORD = 'Aaaaaaaaaaaa1!'; process.env.TEST_B_PASSWORD = 'Bbbbbbbbbbbb2!';
  const log = console.log; console.log = () => {};
  await run(c, 'install', CTX); await run(c, 'seed', CTX);
  console.log = log;
  // comme Supabase : droits par défaut accordés à authenticated (la sécurité repose sur RLS + REVOKE explicites)
  await c.query('GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated; GRANT SELECT ON auth.users TO authenticated; REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.doc_counters, public.doc_events FROM authenticated');
  const us = (await c.query(`SELECT id, email FROM auth.users WHERE email LIKE 'preprod-%' ORDER BY email`)).rows;
  for (const [i, u] of us.entries()) {
    await c.query('BEGIN'); await c.query('SET LOCAL ROLE authenticated');
    await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`, [u.id, JSON.stringify({ sub: u.id, email: u.email })]);
    await c.query('SELECT public.my_license()');
    const items = [];
    for (let k = 0; k < 3 + i; k++) { const n = (await c.query(`SELECT public.next_doc_number('invoice',0) v`)).rows[0].v; items.push({ id: 'f' + k, number: `FAC-${new Date().getFullYear()}-${String(n).padStart(3, '0')}`, type: 'invoice', status: k === 0 ? 'paid' : 'sent', totalTTC: 120 + k }); }
    items.push({ id: 'dr', number: 'BRO-1', type: 'invoice', status: 'draft', totalTTC: 1 });
    await c.query(`INSERT INTO public.user_data(user_id,key,value) VALUES ($1::uuid,'invoices',$2::jsonb)`, [u.id, JSON.stringify(items)]);
    await c.query('COMMIT');
  }
  await c.end();
  const base = { ...process.env, REHEARSAL: '1', SRC_PGHOST: process.env.PGHOST, SRC_PGPORT: process.env.PGPORT, SRC_PGUSER: process.env.PGUSER, SRC_PGDATABASE: SRC, LOCAL_PGHOST: process.env.PGHOST, LOCAL_PGPORT: process.env.PGPORT, LOCAL_PGUSER: process.env.PGUSER, REPORT_PATH: '/tmp/fp_backup_report_' + process.pid + '.md' };
  const ok = spawnSync('node', [path.join(R, 'scripts/preprod-backup.js')], { env: base, encoding: 'utf8' });
  const rep = fs.existsSync(base.REPORT_PATH) ? fs.readFileSync(base.REPORT_PATH, 'utf8') : '';
  if (process.env.SHOW_REPORT) log(rep);
  ck('sauvegarde + restauration + contrôles : tout réussi (code 0)', ok.status === 0, (ok.stdout + ok.stderr).split('\n').filter((l) => /ÉCHEC|ARRÊT|inattendu/.test(l)).slice(0, 6).join(' | '));
  ck('le rapport contient les durées et la commande pg_dump', /durée réelle de la sauvegarde/.test(rep) && /pg_dump --format=custom/.test(rep) && /durée réelle de la restauration/.test(rep));
  ck('le rapport ne contient aucune URL de connexion', !/postgres(ql)?:\/\//i.test(rep));
  ck('la base de restauration temporaire est supprimée', execFileSync('psql', ['-At', '-d', 'postgres', '-c', "SELECT count(*) FROM pg_database WHERE datname LIKE 'fp_restore_%'"]).toString().trim() === '0');
  const bad = spawnSync('node', [path.join(R, 'scripts/preprod-backup.js')], { env: { ...base, FP_BACKUP_TAMPER: '1', REPORT_PATH: base.REPORT_PATH + '.t' }, encoding: 'utf8' });
  ck('une copie restaurée corrompue est DÉTECTÉE (code ≠ 0)', bad.status === 1 && /ÉCHEC/.test(bad.stdout));
  const refus = spawnSync('node', [path.join(R, 'scripts/preprod-backup.js')], { env: { PATH: process.env.PATH, PREPROD_DB_URL: 'postgresql://postgres.mdozjptoecygmpkjlohr:FAKEPASSWORD@aws-0-eu-west-3.pooler.supabase.com:5432/postgres' }, encoding: 'utf8' });
  ck('refuse la production sans se connecter', refus.status !== 0 && /REFUS/.test(refus.stdout + refus.stderr) && !/FAKEPASSWORD/.test(refus.stdout + refus.stderr));
  const refus2 = spawnSync('node', [path.join(R, 'scripts/preprod-backup.js')], { env: { ...base, SRC_PGHOST: 'db.example.com' }, encoding: 'utf8' });
  ck('le mode répétition refuse une source distante', refus2.status !== 0 && /REFUS/.test(refus2.stdout + refus2.stderr));
  execFileSync('psql', ['-q', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${SRC}`]);
  for (const f of [base.REPORT_PATH, base.REPORT_PATH + '.t']) try { fs.unlinkSync(f); } catch {}
  const n = res.filter(Boolean).length; console.log(`\n${n}/${res.length} tests de l'outil de sauvegarde réussis`); process.exit(n === res.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
