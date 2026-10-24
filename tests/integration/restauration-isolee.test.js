/* Répétition LOCALE du test de restauration isolée : fabrique une fausse sauvegarde (données fictives),
 * la chiffre comme backup.yml, la restaure avec scripts/restore-test-isolated.js dans une base jetable,
 * puis vérifie les refus (hôte distant, projet de production, mauvaise phrase secrète, compteur incohérent).
 * Ce n'est PAS une restauration de la sauvegarde réelle. */
'use strict';
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..'); const SCRIPT = path.join(ROOT, 'scripts', 'restore-test-isolated.js');
const env = { ...process.env, PGHOST: process.env.PGHOST || '/tmp', PGPORT: process.env.PGPORT || '5599', PGUSER: process.env.PGUSER || 'postgres' };
const R = []; const ok = (n, c, x = '') => { R.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? ' ' + x : '')); };
const ps = (db, sql) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At', '-d', db, '-c', sql], { env, encoding: 'utf8' }).trim();
const psf = (db, f) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', f], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const src = 'src_' + crypto.randomBytes(3).toString('hex'); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
const PASS = crypto.randomBytes(24).toString('hex');
const uid = '11111111-1111-1111-1111-111111111111';
function makeBackup(counterValue) {
  ps('postgres', `DROP DATABASE IF EXISTS ${src}`); ps('postgres', `CREATE DATABASE ${src}`);
  ps(src, `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF; END $$;
    CREATE SCHEMA IF NOT EXISTS auth; CREATE TABLE auth.users(instance_id uuid, id uuid primary key, aud text, email text, encrypted_password text, raw_user_meta_data jsonb, created_at timestamptz DEFAULT now()); CREATE TABLE auth.identities(id uuid primary key, user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE, provider_id text, identity_data jsonb);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true),'')::uuid $f$;`);
  for (const f of ['00_setup_complet', '14_numerotation_et_verrouillage', '15_documents']) psf(src, path.join(ROOT, 'sql', f + '.sql'));
  ps(src, `INSERT INTO auth.users(id,aud,email,encrypted_password,raw_user_meta_data) VALUES ('${uid}','authenticated','fictif@facturapro-test.invalid','x','{"a":1}')`); ps(src, `INSERT INTO auth.identities VALUES ('${uid}','${uid}','fictif@facturapro-test.invalid','{"sub":"1"}')`);
  ps(src, `INSERT INTO public.documents(user_id,doc_type,id,number,status,total_ttc,body,body_sha) VALUES ('${uid}','invoice','i1','FAC-2026-0028','sent',120,'{"number":"FAC-2026-0028"}','x')`);
  ps(src, `INSERT INTO public.doc_counters VALUES ('${uid}','invoice',${counterValue})`);
  const out = path.join(tmp, 'out'); fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out);
  execFileSync('pg_dump', ['--no-owner', '--no-privileges', '-n', 'public', '-f', path.join(out, 'public-2026-10-19.sql'), src], { env });
  execFileSync('pg_dump', ['--no-owner', '--no-privileges', '--data-only', '-t', 'auth.users', '-t', 'auth.identities', '-f', path.join(out, 'auth-2026-10-19.sql'), src], { env });
  const tgz = path.join(tmp, `backup-${counterValue}.tar.gz`); execFileSync('tar', ['czf', tgz, '-C', out, '.']);
  const pf = path.join(tmp, '.pp'); fs.writeFileSync(pf, PASS, { mode: 0o600 });
  execFileSync('gpg', ['--batch', '--yes', '--pinentry-mode', 'loopback', '--passphrase-file', pf, '--symmetric', '--cipher-algo', 'AES256', '-o', tgz + '.gpg', tgz]);
  return tgz + '.gpg';
}
const go = (file, e = {}, pass = PASS) => spawnSync('node', [SCRIPT, file], { env: { ...env, RESTORE_PASSPHRASE: pass, ...e }, encoding: 'utf8' });
const leftovers = () => ps('postgres', "SELECT count(*) FROM pg_database WHERE datname LIKE 'restore_test_%'");
try {
  const good = makeBackup(28);
  let r = go(good); ok('sauvegarde saine : restaurée, tous les contrôles OK', r.status === 0 && /OK : \d+ contrôles/.test(r.stdout), (r.stdout + r.stderr).split('\n').filter((l) => /ECHEC|REFUS/.test(l)).join(' | '));
  ok('la restauration affiche des comptages, jamais de contenu', /documents : 1 ligne/.test(r.stdout) && !/fictif@|FAC-2026-0028/.test(r.stdout + r.stderr));
  ok('la base jetable est supprimée après le test', leftovers() === '0');
  r = go(good, { PGHOST: 'db.mdozjptoecygmpkjlohr.supabase.co' }); ok('hôte distant / projet de production : refusé (code 2)', r.status === 2 && /REFUS/.test(r.stderr));
  r = go(good, { PGHOST: '10.0.0.5' }); ok('hôte non local : refusé', r.status === 2 && /REFUS/.test(r.stderr));
  r = go(good, { PGDATABASE: 'postgres.mdozjptoecygmpkjlohr' }); ok('identifiant du projet de production dans l\'environnement : refusé', r.status === 2);
  r = go(good, {}, 'mauvaise-phrase-secrete-0000'); ok('mauvaise phrase secrète : échec propre, rien de restauré', r.status === 1 && /déchiffrement/.test(r.stdout) && leftovers() === '0');
  r = spawnSync('node', [SCRIPT, good], { env: { ...env, RESTORE_PASSPHRASE: '' }, encoding: 'utf8' }); ok('phrase secrète absente : refusé', r.status === 2);
  const { redact } = require(SCRIPT);
  const red = redact('ERROR:  invalid input syntax for type uuid: "x" Key (user_id)=(11111111-1111-1111-1111-111111111111) a@b.ma \'secret\'');
  ok('messages d\'erreur expurgés (e-mail, uuid, valeurs entre quotes)', !/a@b\.ma|1111-1111|secret|user_id|"x"/.test(red), red);
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'restore-test.yml'), 'utf8');
  ok('workflow : manuel seulement, branche principale, délai, nettoyage, pas de jeton persistant', /workflow_dispatch/.test(wf) && !/\n\s+(push|pull_request|schedule):/.test(wf) && /github\.ref == 'refs\/heads\/main'/.test(wf) && /timeout-minutes/.test(wf) && /if: always\(\)/.test(wf) && /persist-credentials: false/.test(wf));
  ok('workflow : job soumis à l\'environnement protégé « restauration » (approbation requise avant exécution)', /\n\s+environment: restauration\s*\n/.test(wf));
  ok('workflow : la sauvegarde téléchargée vient d\'une exécution de la branche main', /gh run list --workflow backup\.yml --branch main/.test(wf));
  ok('workflow : aucune URL ni identifiant de projet Supabase', !/supabase\.co|pooler|mdozjptoecygmpkjlohr|njjaomichdlnoscrnxlz/.test(wf));
  const bad = makeBackup(10);
  r = go(bad); ok('compteur de numérotation inférieur au plus grand numéro : détecté (échec)', r.status === 1 && /numérotation/.test(r.stdout + r.stderr), '');
  ok('aucune base jetable résiduelle', leftovers() === '0');
} catch (e) { console.log('ERREUR', e.message.slice(0, 300)); R.push(false); }
finally { try { ps('postgres', `DROP DATABASE IF EXISTS ${src}`); } catch (e) {} fs.rmSync(tmp, { recursive: true, force: true }); }
if (R.includes(false)) { console.log('\nÉCHEC : ' + R.filter((x) => !x).length); process.exit(1); } else console.log('\nOK : ' + R.length + ' contrôles (répétition locale de la restauration isolée, données fictives)');
