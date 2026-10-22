#!/usr/bin/env node
// Sauvegarde (pg_dump) de la PRÉPRODUCTION puis restauration dans une base PostgreSQL LOCALE propre, avec contrôles d'intégrité.
//   PREPROD_DB_URL  : chaîne de connexion de la préproduction (secret d'environnement, jamais écrite ni affichée)
//   LOCAL_PGHOST / LOCAL_PGPORT / LOCAL_PGUSER / LOCAL_PGPASSWORD : serveur PostgreSQL local jetable (superutilisateur)
//   REPORT_PATH     : fichier Markdown où ajouter le rapport (défaut : reports/backup.md)
//   KEEP_DUMP=1     : conserve le fichier de sauvegarde (par défaut : supprimé après le test ; il n'est JAMAIS publié)
// Garde-fous : même contrôle de cible que les autres scripts (preprod-db.js : jamais la production) ; aucun identifiant
// ne figure dans les arguments des commandes ni dans la sortie (tout est filtré par redact()) ; le fichier de sauvegarde
// reste dans un dossier temporaire privé (mode 0700) et n'est pas ajouté au dépôt.
// Mode répétition (REHEARSAL=1) : source = base LOCALE (SRC_PGHOST socket/localhost, SRC_PGDATABASE) pour tester l'outil
// sans réseau ; le rapport le dit explicitement (SIMULÉ).
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { execFile } = require('child_process');
const { Client } = require('pg');

const REHEARSAL = process.env.REHEARSAL === '1';
const ALLOW_EMPTY = process.env.BACKUP_ALLOW_EMPTY === '1';   // sauvegarde de référence d'une base sans compte (aucune facture attendue)
const secrets = new Set();
const addSecret = (s) => { if (s && String(s).length >= 4) secrets.add(String(s)); };
function redact(t) {
  let s = String(t);
  for (const x of secrets) s = s.split(x).join('***');
  s = s.replace(/postgres(ql)?:\/\/[^\s'"]*/gi, 'postgres://***');           // aucune URL de connexion, jamais
  s = s.replace(/eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{5,}/g, '***jwt***');
  return s;
}
const lines = [];
const out = (s = '') => { const r = redact(s); lines.push(r); console.log(r); };
const hr = () => Number(process.hrtime.bigint() / 1000000n);   // ms
const secs = (ms) => (ms / 1000).toFixed(2) + ' s';

function sourceParams() {
  if (REHEARSAL) {
    const h = process.env.SRC_PGHOST || '';
    if (!(h.startsWith('/') || h === 'localhost' || h === '127.0.0.1')) throw new Error('REFUS : REHEARSAL n\'accepte qu\'une source locale.');
    return { host: h, port: process.env.SRC_PGPORT || '5432', user: process.env.SRC_PGUSER || 'postgres', password: '', database: process.env.SRC_PGDATABASE, ssl: false, label: 'SIMULÉ — base locale de répétition (pas Supabase)', ref: 'local-rehearsal' };
  }
  const p = require('./preprod-db').parseDbUrl(process.env.PREPROD_DB_URL);   // refuse tout sauf le projet de préproduction
  addSecret(process.env.PREPROD_DB_URL); addSecret(p.password); addSecret(p.user); addSecret(p.host);
  return { host: p.host, port: p.port, user: p.user, password: p.password, database: p.database, ssl: true, label: `RÉEL — Supabase préproduction (${p.ref}), via le pooleur en mode session`, ref: p.ref };
}
const local = () => ({ host: process.env.LOCAL_PGHOST || '127.0.0.1', port: process.env.LOCAL_PGPORT || '5432', user: process.env.LOCAL_PGUSER || 'postgres', password: process.env.LOCAL_PGPASSWORD || '' });
const clientOf = (p, database) => new Client({ host: p.host, port: Number(p.port), user: p.user, password: p.password || undefined, database: database || p.database, ssl: p.ssl ? { rejectUnauthorized: false } : false, statement_timeout: 300000 });
const envOf = (p, database) => ({ PATH: process.env.PATH, PGHOST: p.host, PGPORT: String(p.port), PGUSER: p.user, PGPASSWORD: p.password || '', PGDATABASE: database || p.database, PGSSLMODE: p.ssl ? 'require' : 'disable' });
function run(cmd, args, env) {
  const t0 = hr();
  return new Promise((resolve) => execFile(cmd, args, { env, maxBuffer: 256 * 1024 * 1024 }, (err, so, se) =>
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: redact(so), stderr: redact(se), ms: hr() - t0 })));
}

// ---------- instantané (S) : tout ce qui doit être identique avant/après ----------
const TABLE_SQL = `
SELECT n.nspname AS s, c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r','p') AND n.nspname IN ('public','auth') ORDER BY 1, 2`;
async function snapshot(c) {
  const S = { tables: {}, cat: {}, invoices: {}, counters: [] };
  for (const r of (await c.query(TABLE_SQL)).rows) {
    const q = await c.query(`SELECT count(*)::int n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text COLLATE "C"), '')) h FROM ${'"' + r.s + '"."' + r.t + '"'} x`);
    S.tables[`${r.s}.${r.t}`] = { n: q.rows[0].n, h: q.rows[0].h };
  }
  const cat = async (k, sql) => { S.cat[k] = (await c.query(sql)).rows[0]; };
  await cat('tables', `SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname IN ('public','auth')`);
  await cat('rls', `SELECT count(*)::int n, md5(coalesce(string_agg(n.nspname||'.'||c.relname||':'||c.relrowsecurity::text||c.relforcerowsecurity::text, ',' ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C"),'')) h FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname IN ('public','auth') AND c.relrowsecurity`);
  await cat('policies', `SELECT count(*)::int n, md5(coalesce(string_agg(schemaname||'.'||tablename||'.'||policyname||'|'||cmd||'|'||permissive||'|'||roles::text||'|'||coalesce(qual,'')||'|'||coalesce(with_check,''), E'\\n' ORDER BY schemaname COLLATE "C", tablename COLLATE "C", policyname COLLATE "C"),'')) h FROM pg_policies WHERE schemaname IN ('public','auth')`);
  await cat('functions_public', `SELECT count(*)::int n, md5(coalesce(string_agg(p.oid::regprocedure::text||p.prosecdef::text||coalesce(p.proconfig::text,'')||md5(pg_get_functiondef(p.oid)), E'\\n' ORDER BY p.oid::regprocedure::text COLLATE "C"),'')) h FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind IN ('f','p') AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.deptype='e')`);
  await cat('functions_auth', `SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='auth' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.deptype='e')`);
  await cat('triggers', `SELECT count(*)::int n, md5(coalesce(string_agg(c.relname||'.'||t.tgname||'|'||pg_get_triggerdef(t.oid), E'\\n' ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C", t.tgname COLLATE "C"),'')) h FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname IN ('public','auth')`);
  await cat('constraints', `SELECT count(*)::int n, md5(coalesce(string_agg(n.nspname||'.'||c.relname||'.'||k.conname||'|'||k.contype::text||'|'||pg_get_constraintdef(k.oid), E'\\n' ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C", k.conname COLLATE "C"),'')) h FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','auth')`);
  await cat('indexes', `SELECT count(*)::int n, md5(coalesce(string_agg(schemaname||'.'||indexname||'|'||indexdef, E'\\n' ORDER BY schemaname COLLATE "C", indexname COLLATE "C"),'')) h FROM pg_indexes WHERE schemaname IN ('public','auth')`);
  await cat('sequences', `SELECT count(*)::int n, md5(coalesce(string_agg(schemaname||'.'||sequencename||':'||coalesce(last_value::text,'null'), ',' ORDER BY schemaname COLLATE "C", sequencename COLLATE "C"),'')) h FROM pg_sequences WHERE schemaname IN ('public','auth')`);
  await cat('table_privileges', `SELECT count(*)::int n, md5(coalesce(string_agg(table_schema||'.'||table_name||':'||grantee||':'||privilege_type, ',' ORDER BY table_schema COLLATE "C", table_name COLLATE "C", grantee COLLATE "C", privilege_type COLLATE "C"),'')) h FROM information_schema.role_table_grants WHERE table_schema IN ('public','auth') AND grantee IN ('anon','authenticated','service_role')`);
  await cat('function_privileges', `SELECT md5(coalesce(string_agg(p.oid::regprocedure::text||':'||r||':'||has_function_privilege(r, p.oid, 'EXECUTE'), ',' ORDER BY p.oid::regprocedure::text COLLATE "C", r COLLATE "C"),'')) h FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN (VALUES ('anon'),('authenticated'),('service_role')) v(r) WHERE n.nspname='public' AND p.prokind='f' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.deptype='e')`);
  S.fn = {};   // détail par fonction (nom, empreinte de la définition, droits d'exécution) : sert à nommer précisément un écart
  for (const r of (await c.query(`SELECT p.oid::regprocedure::text AS f, md5(pg_get_functiondef(p.oid)) AS d, p.prosecdef::text||coalesce(p.proconfig::text,'') AS c,
      (SELECT string_agg(r||'='||has_function_privilege(r, p.oid, 'EXECUTE')::text, ',' ORDER BY r COLLATE "C") FROM (VALUES ('anon'),('authenticated'),('service_role')) v(r)) AS x
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.deptype='e')`)).rows) S.fn[r.f] = { d: r.d, c: r.c, x: r.x };
  S.counters = (await c.query(`SELECT left(user_id::text,8) u, doc_type t, last_value v FROM public.doc_counters ORDER BY user_id, doc_type`)).rows;
  const inv = await c.query(`SELECT left(d.user_id::text,8) u, jsonb_agg(e->>'number' ORDER BY e->>'number' COLLATE "C") nums, jsonb_agg(e->>'status' ORDER BY e->>'number' COLLATE "C") sts
                               FROM public.user_data d, jsonb_array_elements(d.value) e WHERE d.key='invoices' AND jsonb_typeof(d.value)='array' GROUP BY d.user_id ORDER BY 1`);
  for (const r of inv.rows) S.invoices[r.u] = { numbers: r.nums, statuses: r.sts };
  return S;
}
function diff(a, b) {
  const d = [];
  const keys = new Set([...Object.keys(a.tables), ...Object.keys(b.tables)]);
  for (const k of keys) {
    const x = a.tables[k], y = b.tables[k];
    if (!x || !y) d.push(`table ${k} : ${x ? 'absente après restauration' : 'apparue après restauration'}`);
    else if (x.n !== y.n) d.push(`table ${k} : ${x.n} lignes avant, ${y.n} après`);
    else if (x.h !== y.h) d.push(`table ${k} : contenu différent (empreinte)`);
  }
  for (const k of Object.keys(a.cat)) if (JSON.stringify(a.cat[k]) !== JSON.stringify(b.cat[k])) d.push(`catalogue « ${k} » : ${JSON.stringify(a.cat[k])} → ${JSON.stringify(b.cat[k])}`);
  for (const f of new Set([...Object.keys(a.fn || {}), ...Object.keys(b.fn || {})])) {
    const x = (a.fn || {})[f], y = (b.fn || {})[f];
    if (!x || !y) d.push(`fonction ${f} : ${x ? 'absente' : 'ajoutée'} après restauration`);
    else { if (x.d !== y.d) d.push(`fonction ${f} : définition différente`); if (x.c !== y.c) d.push(`fonction ${f} : SECURITY DEFINER/search_path différent`); if (x.x !== y.x) d.push(`fonction ${f} : droits d'exécution ${x.x} → ${y.x}`); }
  }
  if (JSON.stringify(a.counters) !== JSON.stringify(b.counters)) d.push('compteurs de facturation (doc_counters) différents');
  if (JSON.stringify(a.invoices) !== JSON.stringify(b.invoices)) d.push('numéros de factures différents');
  return d;
}

// ---------- sommaire de la sauvegarde (preuve du contenu) ----------
const TYPES = ['ACL', 'AGGREGATE', 'CAST', 'COLLATION', 'COMMENT', 'CONSTRAINT', 'DEFAULT ACL', 'DEFAULT', 'DOMAIN', 'EVENT TRIGGER', 'EXTENSION', 'FK CONSTRAINT', 'FOREIGN TABLE', 'FUNCTION', 'INDEX ATTACH', 'INDEX', 'MATERIALIZED VIEW', 'POLICY', 'PROCEDURE', 'PUBLICATION', 'ROW SECURITY', 'RULE', 'SCHEMA', 'SEQUENCE OWNED BY', 'SEQUENCE SET', 'SEQUENCE', 'TABLE ATTACH', 'TABLE DATA', 'TABLE', 'TRIGGER', 'TYPE', 'VIEW', 'SECURITY LABEL', 'STATISTICS', 'OPERATOR'].sort((a, b) => b.length - a.length);
function parseToc(txt) {
  const items = [];
  for (const l of txt.split('\n')) {
    const m = /^\d+; \d+ \d+ (.*)$/.exec(l); if (!m) continue;
    const t = TYPES.find((x) => m[1].startsWith(x + ' ')); if (!t) continue;
    items.push({ type: t, rest: m[1].slice(t.length + 1) });
  }
  return items;
}
const BENIGN = [/schema "public" already exists/i, /extension .* already exists/i];
function classifyErrors(stderr) {
  const errs = stderr.split('\n').filter((l) => /^pg_restore: error:/.test(l));
  const uniq = [...new Set(errs.map((e) => e.replace(/^pg_restore: error: /, '').slice(0, 220)))];
  return { total: errs.length, benign: uniq.filter((e) => BENIGN.some((b) => b.test(e))), unexpected: uniq.filter((e) => !BENIGN.some((b) => b.test(e))) };
}

(async () => {
  const T = { start: hr() };
  const results = []; const ck = (n, ok, x = '') => { results.push({ n, ok }); out(`- ${ok ? 'RÉUSSI' : '**ÉCHEC**'} — ${n}${ok || !x ? '' : ' — ' + x}`); };
  const src = sourceParams(), L = local();
  addSecret(L.password);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fpbk-')); fs.chmodSync(tmp, 0o700);
  const dump = path.join(tmp, 'preprod.dump');
  const rdb = 'fp_restore_' + crypto.randomBytes(4).toString('hex');
  const rep = process.env.REPORT_PATH || 'reports/backup.md';
  out(`## Sauvegarde / restauration de la préproduction — ${new Date().toISOString()}`);
  out(`- Source : ${src.label}`);
  const pgv = (await run('pg_dump', ['--version'], { PATH: process.env.PATH })).stdout.trim();
  out(`- Outil : ${pgv} ; serveur local de restauration : PostgreSQL local jetable (base « ${rdb} », supprimée à la fin)`);
  let failedEarly = null;
  try {
    // 1) état de la source avant sauvegarde
    const sc = clientOf(src); await sc.connect();
    const ver = (await sc.query('SHOW server_version')).rows[0].server_version;
    out(`- Version du serveur source : PostgreSQL ${ver}`);
    if (!REHEARSAL) {   // la base source doit porter le marqueur « préproduction » du bon projet (sinon : rien n'est sauvegardé)
      const mk = await sc.query("SELECT to_regclass('public._fp_env') t").then((x) => x.rows[0].t ? sc.query('SELECT env, project_ref FROM public._fp_env WHERE id=1') : { rows: [] });
      if (!mk.rows[0] || mk.rows[0].env !== 'preprod' || mk.rows[0].project_ref !== src.ref) throw new Error('REFUS : la base source ne porte pas le marqueur « préproduction » attendu.');
      out(`- Marqueur de la base source vérifié : préproduction / ${src.ref}.`);
    }
    const t1 = hr(); const S1 = await snapshot(sc); const tSnap = hr() - t1;
    out(`- Instantané « avant » pris en ${secs(tSnap)} : ${Object.keys(S1.tables).length} tables, ${Object.values(S1.tables).reduce((a, b) => a + b.n, 0)} lignes au total.`);

    // 2) sauvegarde
    const dumpArgs = ['--format=custom', '--compress=6', '--no-owner', '--schema=public', '--schema=auth', '--file=' + dump];
    out('\n### 1. Méthode de sauvegarde');
    out('Commande exécutée (les paramètres de connexion passent par les variables d\'environnement PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE, PGSSLMODE — aucune URL, aucun mot de passe dans la ligne de commande ni dans ce rapport) :');
    out('```\npg_dump ' + dumpArgs.map((a) => a.startsWith('--file=') ? '--file=<fichier temporaire privé>' : a).join(' ') + '\n```');
    const d = await run('pg_dump', dumpArgs, envOf(src));
    out(`- Code de sortie : ${d.code} ; durée réelle de la sauvegarde : **${secs(d.ms)}**`);
    if (d.stderr.trim()) out('- Messages de pg_dump (filtrés) : `' + d.stderr.trim().split('\n').slice(0, 8).join(' / ').slice(0, 600) + '`');
    ck('pg_dump terminé sans erreur', d.code === 0, d.stderr.slice(0, 300));
    if (d.code !== 0) throw new Error('sauvegarde échouée');
    const st = fs.statSync(dump); const sha = crypto.createHash('sha256').update(fs.readFileSync(dump)).digest('hex');
    out(`- Fichier : ${(st.size / 1024).toFixed(1)} Kio, empreinte SHA-256 ${sha.slice(0, 16)}… (le fichier n'est ni publié ni commité).`);
    const S1b = await snapshot(sc); await sc.end();
    const stable = diff(S1, S1b).length === 0;
    out(`- Source inchangée pendant la sauvegarde : ${stable ? 'oui' : 'NON (la comparaison finale peut différer pour cette raison)'}.`);

    // 3) preuve du contenu
    out('\n### 2. Contenu de la sauvegarde (sommaire pg_restore --list)');
    const tocR = await run('pg_restore', ['--list', dump], { PATH: process.env.PATH });
    const toc = parseToc(tocR.stdout);
    const cnt = {}; toc.forEach((i) => { cnt[i.type] = (cnt[i.type] || 0) + 1; });
    out('| Type d\'objet | Nombre dans la sauvegarde |\n|---|---|\n' + Object.keys(cnt).sort().map((k) => `| ${k} | ${cnt[k]} |`).join('\n'));
    const has = (type, re) => toc.some((i) => i.type === type && re.test(i.rest));
    const need = [['TABLE DATA', /public user_data /], ['TABLE DATA', /public doc_counters /], ['TABLE DATA', /public doc_events /], ['TABLE DATA', /public licenses /], ['TABLE DATA', /public admins /], ['TABLE DATA', /auth users /],
      ['TABLE', /public user_data /], ['FUNCTION', /public next_doc_number\(/], ['FUNCTION', /public has_active_license\(/], ['FUNCTION', /public guard_issued_invoices\(/], ['TRIGGER', /trg_guard_issued_invoices /], ['POLICY', /public user_data /], ['ROW SECURITY', /public user_data/], ['ACL', /.*/]];
    for (const [t, re] of need) ck(`la sauvegarde contient : ${t} ${re.source === '.*' ? '(droits GRANT/REVOKE)' : re.source.replace(/\\/g, '').replace(/\|.*$/, '').trim()}`, has(t, re));
    ck(`politiques RLS : ${cnt.POLICY || 0} dans la sauvegarde = ${S1.cat.policies.n} en base`, (cnt.POLICY || 0) === S1.cat.policies.n);
    ck(`déclencheurs : ${cnt.TRIGGER || 0} dans la sauvegarde = ${S1.cat.triggers.n} en base`, (cnt.TRIGGER || 0) === S1.cat.triggers.n);
    ck(`tables avec données : ${cnt['TABLE DATA'] || 0} = ${S1.cat.tables.n} tables`, (cnt['TABLE DATA'] || 0) === S1.cat.tables.n);
    const fnCount = toc.filter((i) => i.type === 'FUNCTION' || i.type === 'PROCEDURE').length;
    ck(`fonctions : ${fnCount} dans la sauvegarde = ${S1.cat.functions_public.n} (public) + ${S1.cat.functions_auth.n} (auth) en base`, fnCount === S1.cat.functions_public.n + S1.cat.functions_auth.n);
    out('\n**Exclusions volontaires (non couvertes par cette sauvegarde)** : schémas gérés par Supabase autres que `public` et `auth` (storage, realtime, vault, extensions, graphql, pgsodium, cron…) ; rôles et mots de passe de rôles ; binaires des extensions ; fichiers du Storage (non utilisé) ; réglages du tableau de bord (SMTP, fournisseurs d\'authentification, URL de redirection, captcha) ; fonctions Edge et leurs secrets. Les propriétaires d\'objets ne sont pas conservés (`--no-owner`), les droits (ACL) le sont.');

    // 4) restauration
    out('\n### 3. Restauration dans une base locale propre');
    const adm = clientOf({ ...L, ssl: false }, 'postgres'); await adm.connect();
    await adm.query(`DO $$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role','authenticator','supabase_auth_admin','supabase_admin','dashboard_user','pgbouncer','supabase_read_only_user'] LOOP IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF; END LOOP; END $$`);
    await adm.query(`CREATE DATABASE ${rdb} TEMPLATE template0`); await adm.end();
    out('- Rôles Supabase de base (anon, authenticated, service_role…) créés à vide côté local, base de destination créée vide (modèle template0).');
    const r = await run('pg_restore', ['--no-owner', '--dbname=' + rdb, dump], envOf({ ...L, ssl: false }, rdb));
    const ce = classifyErrors(r.stderr);
    out(`- Code de sortie : ${r.code} ; durée réelle de la restauration : **${secs(r.ms)}**`);
    out(`- Erreurs rapportées par pg_restore : ${ce.total} (bénignes : ${ce.benign.length} motif(s) ; inattendues : ${ce.unexpected.length} motif(s))`);
    ce.benign.forEach((e) => out('  - bénin : `' + e + '`')); ce.unexpected.forEach((e) => out('  - **inattendu** : `' + e + '`'));
    ck('restauration sans erreur inattendue', ce.unexpected.length === 0, ce.unexpected.slice(0, 3).join(' | '));

    // 5) contrôles d'intégrité
    out('\n### 4. Contrôles d\'intégrité (avant sauvegarde ↔ après restauration)');
    const rc = clientOf({ ...L, ssl: false }, rdb); await rc.connect();
    if (REHEARSAL && process.env.FP_BACKUP_TAMPER === '1') { await rc.query(`DELETE FROM public.doc_counters WHERE ctid IN (SELECT ctid FROM public.doc_counters LIMIT 1)`); out('- (répétition) corruption volontaire de la copie restaurée pour vérifier que le contrôle la détecte.'); }
    const S2 = await snapshot(rc);
    const df = diff(S1, S2);
    out('| Table | Lignes avant | Lignes après | Empreinte identique |\n|---|---|---|---|\n' + Object.keys(S1.tables).map((k) => `| ${k} | ${S1.tables[k].n} | ${(S2.tables[k] || {}).n ?? '—'} | ${S2.tables[k] && S2.tables[k].h === S1.tables[k].h ? 'oui' : '**non**'} |`).join('\n'));
    for (const k of ['rls', 'policies', 'functions_public', 'triggers', 'constraints', 'indexes', 'sequences', 'table_privileges', 'function_privileges']) {
      const same = JSON.stringify(S1.cat[k]) === JSON.stringify(S2.cat[k]);
      ck(`${k.replace('_', ' ')} identiques${S1.cat[k].n !== undefined ? ' (' + S1.cat[k].n + ')' : ''}`, same);
    }
    ck('compteurs de facturation (doc_counters) identiques : ' + JSON.stringify(S1.counters), JSON.stringify(S1.counters) === JSON.stringify(S2.counters));
    ck('numéros de factures identiques, sans perte ni ajout : ' + JSON.stringify(Object.fromEntries(Object.entries(S1.invoices).map(([u, v]) => [u, v.numbers]))), JSON.stringify(S1.invoices) === JSON.stringify(S2.invoices));
    const dupes = Object.entries(S2.invoices).filter(([, v]) => new Set(v.numbers).size !== v.numbers.length).map(([u]) => u);
    ck('aucun numéro de facture en double après restauration', dupes.length === 0, dupes.join(','));
    const nInv = Object.values(S2.invoices).reduce((a, v) => a + v.numbers.length, 0);
    if (ALLOW_EMPTY && nInv === 0) out('- (base de référence sans compte ni facture : le contrôle « des factures sont présentes » ne s\'applique pas à cette sauvegarde)');
    else ck(`le test contient bien des factures (${nInv}) — sinon la preuve serait vide`, nInv > 0);
    const low = [];
    for (const [u, v] of Object.entries(S2.invoices)) for (const n of v.numbers) {
      const m = /^(FAC|DEV|AVR)-\d{4}-(\d+)$/.exec(n || ''); if (!m) continue;
      const ty = { FAC: 'invoice', DEV: 'quote', AVR: 'credit' }[m[1]]; const c = S2.counters.find((x) => x.u === u && x.t === ty);
      if (!c || c.v < Number(m[2])) low.push(`${u}:${n}`);
    }
    ck('chaque compteur est ≥ au plus grand numéro émis (aucun numéro ne sera réattribué)', low.length === 0, low.join(','));
    if (df.length) df.forEach((x) => out('  - écart : ' + x));
    ck('comparaison globale avant/après : aucun écart', df.length === 0);

    // 6) tests fonctionnels sur la copie restaurée
    out('\n### 5. Tests fonctionnels sur la copie restaurée (sans toucher à la source)');
    const uids = (await rc.query(`SELECT id::text id, left(id::text,8) u, email FROM auth.users WHERE email LIKE '%@facturapro-test.invalid' ORDER BY email LIMIT 2`)).rows;
    if (ALLOW_EMPTY && uids.length === 0) out('- (aucun compte de test dans cette sauvegarde de référence : tests fonctionnels sur comptes non applicables ; ils sont faits sur la sauvegarde suivante)');
    else ck('les 2 comptes de test sont présents dans la copie restaurée', uids.length === 2);
    if (uids.length === 2) {
      const [A, B] = uids;
      const as = async (u, fn) => {   // exécute fn en tant que rôle authenticated avec l'identité u, dans une transaction annulée
        await rc.query('BEGIN'); await rc.query('SET LOCAL ROLE authenticated');
        await rc.query(`SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`, [u.id, JSON.stringify({ sub: u.id, role: 'authenticated', email: u.email })]);
        try { return await fn(); } finally { await rc.query('ROLLBACK'); }
      };
      const tryq = async (sql, args) => { await rc.query('SAVEPOINT s'); try { await rc.query(sql, args); await rc.query('RELEASE SAVEPOINT s'); return null; } catch (e) { await rc.query('ROLLBACK TO SAVEPOINT s'); return e.message; } };
      await as(A, async () => {
        ck('licence (A → A) : visible', (await rc.query('SELECT public.has_active_license($1::uuid) v', [A.id])).rows[0].v === true);
        ck('licence (A → B) : NULL, aucune information sur le compte de B', (await rc.query('SELECT public.has_active_license($1::uuid) v', [B.id])).rows[0].v === null);
        ck('RLS : A ne voit aucune ligne user_data de B', (await rc.query('SELECT count(*)::int n FROM public.user_data WHERE user_id = $1::uuid', [B.id])).rows[0].n === 0);
        const own = (await rc.query(`SELECT value FROM public.user_data WHERE key='invoices'`)).rows[0];
        ck('RLS : A retrouve ses propres factures', !!own && Array.isArray(own.value) && own.value.length === (S1.invoices[A.u] || { numbers: [] }).numbers.length);
        const last = (await rc.query(`SELECT coalesce(max(last_value),0)::int v FROM public.doc_counters WHERE doc_type='invoice'`)).rows[0].v;
        const n1 = (await rc.query(`SELECT public.next_doc_number('invoice', 0) v`)).rows[0].v, n2 = (await rc.query(`SELECT public.next_doc_number('invoice', 0) v`)).rows[0].v;
        ck(`numérotation après restauration : dernier ${last} → prochains numéros ${n1} puis ${n2} (continuité, aucun doublon)`, n1 === last + 1 && n2 === last + 2);
        const taken = new Set((S1.invoices[A.u] || { numbers: [] }).numbers);
        ck('le prochain numéro n\'existe pas déjà dans les factures restaurées', !taken.has(`FAC-${new Date().getFullYear()}-${String(n1).padStart(3, '0')}`));
        if (own && Array.isArray(own.value)) {
          const idx = own.value.findIndex((x) => x && x.status !== 'draft');
          if (idx >= 0) {
            const e1 = await tryq(`UPDATE public.user_data SET value = jsonb_set(value, '{${idx},totalTTC}', '1') WHERE key='invoices'`);
            ck('verrouillage conservé : modifier le montant d\'une facture émise est refusé', !!e1 && /VERROUILLEE/.test(e1), String(e1));
            const e2 = await tryq(`DELETE FROM public.user_data WHERE key='invoices'`);
            ck('verrouillage conservé : supprimer la liste de factures émises est refusé', !!e2 && /VERROUILLEE|SUPPRESSION/i.test(e2), String(e2));
          } else ck('une facture émise est disponible pour tester le verrouillage', false, 'aucune facture émise');
        }
        const e3 = await tryq(`INSERT INTO public.doc_counters(user_id, doc_type, last_value) VALUES ($1::uuid, 'quote', 1)`, [A.id]);
        ck('droits conservés : écriture directe dans doc_counters refusée', !!e3 && /permission|policy/i.test(e3), String(e3));
      });
      await as(B, async () => {
        ck('licence (B → A) : NULL', (await rc.query('SELECT public.has_active_license($1::uuid) v', [A.id])).rows[0].v === null);
        ck('RLS : B ne voit aucune ligne user_data de A', (await rc.query('SELECT count(*)::int n FROM public.user_data WHERE user_id = $1::uuid', [A.id])).rows[0].n === 0);
      });
      const anon = (await rc.query(`SELECT has_function_privilege('anon','public.has_active_license(uuid)','EXECUTE') a, has_function_privilege('anon','public.next_doc_number(text,integer)','EXECUTE') b`)).rows[0];
      ck('droits conservés : anon ne peut exécuter ni has_active_license ni next_doc_number', !anon.a && !anon.b);
    }
    await rc.end();
  } catch (e) { failedEarly = e; out(`\n**ARRÊT : ${redact(e.message).slice(0, 400)}**`); }
  finally {
    try { const adm = clientOf({ ...L, ssl: false }, 'postgres'); await adm.connect(); await adm.query(`DROP DATABASE IF EXISTS ${rdb} WITH (FORCE)`); await adm.end(); out(`\n- Base locale de restauration « ${rdb} » supprimée.`); } catch (e) { out('- Suppression de la base locale non confirmée : ' + redact(e.message).slice(0, 100)); }
    if (process.env.KEEP_DUMP !== '1') { try { fs.rmSync(tmp, { recursive: true, force: true }); out('- Fichier de sauvegarde et dossier temporaire supprimés (aucun fichier de données dans le rapport ni dans Git).'); } catch { /* ignoré */ } }
  }
  const bad = results.filter((x) => !x.ok).length;
  out(`\n**Bilan : ${results.length - bad}/${results.length} contrôles réussis${failedEarly ? ', exécution interrompue' : ''} — durée totale ${secs(hr() - T.start)}.**`);
  fs.mkdirSync(path.dirname(rep), { recursive: true }); fs.appendFileSync(rep, lines.join('\n') + '\n');
  process.exit(bad || failedEarly ? 1 : 0);
})().catch((e) => { console.error(redact(e.message)); process.exit(2); });
