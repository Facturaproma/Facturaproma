// Exécute tests/preprod/check.js (garde-fou inclus) contre une simulation LOCALE de l'API (base PostgreSQL jetable
// installée par scripts/preprod-apply.js). Prouve la logique du script ; ne prouve pas le comportement du vrai Supabase.
const { Client } = require('pg'); const { execFileSync, spawn, spawnSync } = require('child_process'); const path = require('path');
const { run } = require('../../scripts/preprod-apply'); const { start } = require('./mock-rest');
const R = path.join(__dirname, '..', '..'), DB = 'fp_mock_' + process.pid;
const ps = (db, a) => execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-d', db, ...a], { stdio: ['ignore', 'pipe', 'pipe'] });
(async () => {
  ps('postgres', ['-c', `DROP DATABASE IF EXISTS ${DB}`, '-c', `CREATE DATABASE ${DB}`]); ps(DB, ['-f', path.join(R, 'tests/sql/stub_supabase.sql')]);
  ps(DB, ['-c', `CREATE EXTENSION IF NOT EXISTS pgcrypto; ALTER TABLE auth.users ADD COLUMN instance_id uuid, ADD COLUMN aud text, ADD COLUMN role text, ADD COLUMN encrypted_password text, ADD COLUMN raw_app_meta_data jsonb, ADD COLUMN updated_at timestamptz, ADD COLUMN confirmation_token text, ADD COLUMN recovery_token text, ADD COLUMN email_change_token_new text, ADD COLUMN email_change text; CREATE TABLE auth.identities (id uuid PRIMARY KEY, user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE, provider_id text, identity_data jsonb, provider text, last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz);`]);
  const c = new Client({ database: DB }); await c.connect(); const ctx = { ref: 'njjaomichdlnoscrnxlz' };
  process.env.TEST_A_PASSWORD = 'Aaaaaaaaaaaa1!'; process.env.TEST_B_PASSWORD = 'Bbbbbbbbbbbb2!';
  await run(c, 'install', ctx);
  await c.query('GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated; REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.doc_counters, public.doc_events FROM authenticated');
  await run(c, 'seed', ctx);
  const m = await start(DB);
  const anon = require('fs').readFileSync(path.join(__dirname, '../../scripts/preprod-target.json'), 'utf8');
  const env = { ...process.env, MOCK_PORT: String(m.port), PREPROD_URL: 'https://njjaomichdlnoscrnxlz.supabase.co', PREPROD_ANON_KEY: process.env.PREPROD_ANON_KEY || JSON.parse(anon).anonKey,
    TEST_A_EMAIL: 'preprod-a@facturapro-test.invalid', TEST_B_EMAIL: 'preprod-b@facturapro-test.invalid' };
  // spawn asynchrone : la simulation tourne dans CE processus et doit pouvoir répondre pendant l'exécution
  const r = await new Promise(res => { const p = spawn('node', ['-r', path.join(__dirname, 'mock-preload.js'), path.join(__dirname, 'check.js')], { env }); let o = ''; p.stdout.on('data', d => o += d); p.stderr.on('data', d => o += d); p.on('close', code => res({ status: code, stdout: o, stderr: '' })); });
  console.log(r.stdout);
  // garde-fous de check.js
  const bad = spawnSync('node', [path.join(__dirname, 'check.js')], { env: { ...env, TEST_A_EMAIL: 'vrai.client@exemple.ma' }, encoding: 'utf8' });
  const g1 = /REFUS/.test(bad.stderr) && bad.status === 1;
  const bad2 = spawnSync('node', [path.join(__dirname, 'check.js')], { env: { ...env, PREPROD_URL: 'https://mdozjptoecygmpkjlohr.supabase.co' }, encoding: 'utf8' });
  const g2 = /PRODUCTION/.test(bad2.stderr) && bad2.status === 1;
  console.log((g1 ? 'PASS' : 'FAIL') + ' check.js refuse un compte qui n\'est pas un compte de test'); console.log((g2 ? 'PASS' : 'FAIL') + ' check.js refuse l\'URL de production');
  await run(c, 'cleanup', ctx);
  await m.close(); await c.end(); ps('postgres', ['-c', `DROP DATABASE ${DB}`]);
  process.exit(r.status === 0 && g1 && g2 ? 0 : 1);
})().catch(e => { console.error('ERREUR', e); process.exit(2); });
