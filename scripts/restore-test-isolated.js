#!/usr/bin/env node
/* Test de restauration ISOLÉ d'une sauvegarde chiffrée (artifact « sauvegarde-supabase »).
 *
 * Cible : une base PostgreSQL JETABLE et LOCALE uniquement. Le script refuse :
 *   - tout hôte qui n'est pas local (localhost, 127.0.0.1, ::1, socket Unix) ;
 *   - toute chaîne contenant l'identifiant du projet de production ou « supabase » ;
 *   - une base cible qui existe déjà (il en crée une nouvelle, au nom aléatoire, puis la supprime).
 * Il ne lit jamais la base de production et n'écrit rien ailleurs que dans la base jetable.
 *
 * Usage (aucun secret en argument : la phrase secrète vient de l'environnement) :
 *   RESTORE_PASSPHRASE=… PGHOST=/tmp PGPORT=5432 PGUSER=postgres \
 *     node scripts/restore-test-isolated.js backup-2026-10-19.tar.gz.gpg [--keep]
 * Sortie : rapport de comptages et de contrôles (jamais de contenu de factures ni d'e-mails).
 */
'use strict';
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const crypto = require('crypto');

const PROD_REF = 'mdozjptoecygmpkjlohr';
const LOCAL = new Set(['localhost', '127.0.0.1', '::1']);

function assertIsolatedTarget(env) {
  const host = env.PGHOST || '';
  const all = Object.entries(env).filter(([k]) => /^PG|DATABASE_URL/.test(k)).map(([, v]) => String(v)).join(' ');
  if (all.includes(PROD_REF) || /supabase/i.test(all)) throw new Error('REFUS : la cible ressemble à Supabase/production.');
  if (!(host === '' || host.startsWith('/') || LOCAL.has(host))) throw new Error('REFUS : hôte non local (' + host.replace(/[^\w.:-]/g, '?') + '). Seule une base locale jetable est autorisée.');
}

// Les messages d'erreur PostgreSQL peuvent citer des valeurs (e-mails, identifiants) : on n'en garde que la forme générale.
function redact(msg) { return String(msg || '').split('\n')[0].replace(/'[^']*'/g, "'…'").replace(/"[^"]*"/g, '"…"').replace(/\([^)]*\)=\([^)]*\)/g, '(…)=(…)').replace(/[\w.+-]+@[\w.-]+/g, '…@…').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '…uuid…').slice(0, 120); }

function psql(env, db, sql, extra = []) {
  return execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At', '-d', db, ...extra, '-c', sql], { env, encoding: 'utf8' }).trim();
}

function run(file, opts = {}) {
  const env = { ...process.env };
  assertIsolatedTarget(env);
  if (!file || !fs.existsSync(file)) throw new Error('Fichier de sauvegarde introuvable.');
  const pass = env.RESTORE_PASSPHRASE; if (!pass) throw new Error('RESTORE_PASSPHRASE absente de l\'environnement.');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-'));
  const db = 'restore_test_' + crypto.randomBytes(4).toString('hex');
  const report = { db, checks: [], warnings: [] };
  const check = (n, ok, x = '') => { report.checks.push({ n, ok: !!ok, x }); console.log((ok ? 'OK   ' : 'ECHEC') + ' ' + n + (x ? ' — ' + x : '')); };
  try {
    // 1. Déchiffrement (la phrase secrète passe par un descripteur, jamais par la ligne de commande)
    const tarball = path.join(work, 'backup.tar.gz');
    const pf = path.join(work, '.pp'); fs.writeFileSync(pf, pass, { mode: 0o600 });
    const g = spawnSync('gpg', ['--batch', '--yes', '--pinentry-mode', 'loopback', '--passphrase-file', pf, '-o', tarball, '-d', file], { encoding: 'utf8' });
    fs.rmSync(pf, { force: true });
    check('déchiffrement AES-256 (gpg)', g.status === 0, g.status === 0 ? '' : 'phrase secrète ou fichier invalide');
    if (g.status !== 0) return report;
    const dir = path.join(work, 'out'); fs.mkdirSync(dir);
    execFileSync('tar', ['xzf', tarball, '-C', dir]);
    const files = fs.readdirSync(dir);
    const pub = files.find((f) => /^public-.*\.sql$/.test(f)); const auth = files.find((f) => /^auth-.*\.sql$/.test(f));
    check('archive : dump du schéma public présent', !!pub, files.join(', '));
    if (!pub) return report;
    check('archive : dump des comptes (auth) présent', !!auth, auth ? '' : 'absent : restauration partielle');

    // 2. Base jetable neuve + socle minimal Supabase (rôles, schéma auth factice)
    psql(env, 'postgres', `CREATE DATABASE ${db}`);
    const base = `
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
      END $$;
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text);
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;`;
    psql(env, db, base);
    // Le dump « -n public » recrée le schéma public : on repart d'une base sans schéma public (base jetable uniquement)
    psql(env, db, 'DROP SCHEMA IF EXISTS public CASCADE');

    // 3. Comptes d'abord (les données publiques référencent auth.users), puis schéma public (arrêt à la première erreur)
    let authOk = false;
    if (auth) {
      // Les colonnes réelles de auth.users / auth.identities (Supabase) sont lues dans l'EN-TÊTE des instructions COPY du dump (noms de colonnes seulement,
      // jamais les données) : tables factices de même forme (id/user_id en uuid, le reste en texte) pour que les clés étrangères du schéma public
      // vers auth.users soient réellement vérifiées avec les vrais identifiants de comptes.
      const authSql = fs.readFileSync(path.join(dir, auth), 'utf8');
      const ddl = [];
      for (const m of authSql.matchAll(/^COPY auth\.([a-z_]+) \(([^)]*)\) FROM stdin;$/gm)) {
        const cols = m[2].split(',').map((c) => c.trim().replace(/^"|"$/g, '')).filter((c) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(c));
        if (!cols.length) continue;
        const def = cols.map((c) => `"${c}" ${c === 'id' ? 'uuid PRIMARY KEY' : (c === 'user_id' ? 'uuid' : 'text')}`).join(', ');
        ddl.push(`DROP TABLE IF EXISTS auth."${m[1]}" CASCADE; CREATE TABLE auth."${m[1]}" (${def});`);
      }
      if (ddl.length) psql(env, db, ddl.join('\n'));
      const a = spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', path.join(dir, auth)], { env, encoding: 'utf8' });
      authOk = a.status === 0;
      if (!authOk) report.warnings.push('comptes auth non rechargés : les clés étrangères vers auth.users ne peuvent pas être vérifiées par ce test');
    }
    const envR = authOk ? env : { ...env, PGOPTIONS: '-c session_replication_role=replica' };
    const r = spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', path.join(dir, pub)], { env: envR, encoding: 'utf8' });
    check('restauration du schéma public sans erreur', r.status === 0, r.status === 0 ? '' : redact(r.stderr));
    if (r.status !== 0) return report;

    // 4. Contrôles d'intégrité (comptages seulement)
    const tables = psql(env, db, "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1").split('\n').filter(Boolean);
    check('tables publiques restaurées', tables.length > 0, tables.length + ' tables');
    const noRls = psql(env, db, "SELECT string_agg(c.relname, ',') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity");
    check('RLS activée sur toutes les tables publiques', !noRls, noRls ? 'sans RLS : ' + noRls : '');
    for (const t of tables) {
      const n = psql(env, db, `SELECT count(*) FROM public."${t}"`);
      report[t] = Number(n); console.log('     ' + t + ' : ' + n + ' ligne(s)');
    }
    for (const fn of ['has_active_license', 'next_doc_number', 'record_payment']) {
      const ex = psql(env, db, `SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='${fn}'`);
      if (Number(ex) === 0) report.warnings.push(`fonction ${fn} absente (normal si la migration correspondante n'est pas installée)`);
      else check(`fonction ${fn} présente`, true);
    }
    // Numérotation : le compteur ne doit pas être inférieur au plus grand numéro émis
    if (tables.includes('doc_counters') && tables.includes('documents')) {
      const bad = psql(env, db, `SELECT count(*) FROM public.doc_counters c WHERE c.last_value < COALESCE((SELECT max(NULLIF(substring(d.number from '(\\d+)$'),'')::int) FROM public.documents d WHERE d.user_id=c.user_id AND d.doc_type=c.doc_type AND d.number IS NOT NULL),0)`);
      check('numérotation : aucun compteur inférieur au plus grand numéro émis', Number(bad) === 0, bad + ' anomalie(s)');
    } else report.warnings.push('contrôle de numérotation ignoré (tables doc_counters/documents absentes)');
    return report;
  } finally {
    if (!opts.keep) { try { psql(env, 'postgres', `DROP DATABASE IF EXISTS ${db}`); } catch (e) {} }
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    const keep = process.argv.includes('--keep'); const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
    const rep = run(file, { keep });
    rep.warnings.forEach((w) => console.log('AVERTISSEMENT : ' + w));
    const ko = rep.checks.filter((c) => !c.ok).length;
    console.log(ko ? `\nÉCHEC : ${ko} contrôle(s)` : `\nOK : ${rep.checks.length} contrôles (restauration dans une base jetable LOCALE)`);
    process.exit(ko ? 1 : 0);
  } catch (e) { console.error(e.message); process.exit(2); }
}
module.exports = { run, assertIsolatedTarget, redact };
