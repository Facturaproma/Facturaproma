#!/usr/bin/env node
// INSTALLATION et VALIDATION de sql/17_mode_stockage.sql sur la PRÉPRODUCTION Supabase (njjaomichdlnoscrnxlz) — jamais la production.
//   guardtests : refus de la production (aucune connexion)
//   baseline   : cible + marqueur, inventaire des objets, empreinte des données préexistantes
//   install    : applique sql/17 (une transaction, hors installateur), contrôles du catalogue RÉEL, refus anon via l'API réelle
//   test       : comptes de test jetables : autorisation, bascules, API, conflits, paiements rejoués, concurrence, isolation, retour
//   cleanup    : supprime UNIQUEMENT les comptes de test de cette opération ; vérifie orphelins et empreinte inchangée
// Variables : PREPROD_DB_URL (secret), PREPROD_URL, PREPROD_ANON_KEY, MODE_PASSWORDS (JSON, jamais affichées), REPORT_PATH.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const T = require('./preprod-target.json');
const DOMAIN = '@facturapro-test.invalid';
const KEYS = ['a', 'b', 'c', 'd', 'e', 'o', 'x', 'y'];
const EMAIL = (k) => k === 'o' ? 'mode-o@facturapro-ordinary.invalid' : `mode-${k}${DOMAIN}`;   // « o » : compte NON test (e-mail ordinaire)
const EMAILS = KEYS.map(EMAIL);
const lines = [], res = [];
const out = (s = '') => { lines.push(s); console.log(s); };
const ck = (n, ok, x = '') => { res.push(!!ok); out(`- ${ok ? 'RÉUSSI' : '**ÉCHEC**'} — ${n}${ok || !x ? '' : ' — ' + String(x).slice(0, 500)}`); };
const jstr = (o) => JSON.stringify(o);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SQL17 = path.join(ROOT, 'sql', '17_mode_stockage.sql');
const Y = new Date().getFullYear();

async function db() {
  const { connect } = require('./preprod-db');
  const { client, ref } = await connect();
  if (ref !== T.preprodRef) throw new Error('REFUS : cible inattendue.');
  const m = await client.query("SELECT to_regclass('public._fp_env') t").then((x) => x.rows[0].t ? client.query('SELECT env, project_ref FROM public._fp_env WHERE id=1') : { rows: [] });
  if (!m.rows[0] || m.rows[0].env !== 'preprod' || m.rows[0].project_ref !== T.preprodRef) throw new Error('REFUS : marqueur « préproduction » absent ou inattendu.');
  return client;
}
let REST;
const restCfg = () => require('./preprod-guard').guard(process.env.PREPROD_URL, process.env.PREPROD_ANON_KEY);
async function api(method, p, tok, body, extra = {}) {
  const r = await fetch(REST.url + p, { method, headers: { apikey: REST.key, 'content-type': 'application/json', authorization: 'Bearer ' + (tok || REST.key), ...extra }, body: body === undefined ? undefined : jstr(body) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
}
const rpc = (tok, fn, args) => api('POST', '/rest/v1/rpc/' + fn, tok, args || {});
async function login(k) {
  const pw = JSON.parse(process.env.MODE_PASSWORDS || '{}')[k];
  const r = await api('POST', '/auth/v1/token?grant_type=password', null, { email: EMAIL(k), password: pw });
  if (r.status !== 200 || r.body.user.email !== EMAIL(k)) throw new Error('connexion impossible pour mode-' + k);
  return { tok: r.body.access_token, id: r.body.user.id, k };
}
const uidsOf = async (c) => (await c.query('SELECT id::text id, email FROM auth.users WHERE email = ANY($1) ORDER BY email', [EMAILS])).rows;
const denied = (r) => r.status >= 400 && !(Array.isArray(r.body) && r.body.length > 0);

// ---------- empreinte des données préexistantes (tout sauf les comptes de test et les tables propres à la migration) ----------
const EXCLUDED = new Set(['public._fp_migrations', 'public._fp_rehearsal', 'public._mig_runs', 'public._mig_source_backup', 'public._mig_conflicts',
  'public.documents', 'public.doc_payments', 'public.doc_history', 'public.doc_deleted', 'public.doc_store_mode', 'public.doc_store_testers']);
async function foreignHash(c) {
  const uids = (await uidsOf(c)).map((x) => x.id);
  const tabs = (await c.query(`SELECT n.nspname s, c.relname t FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname IN ('public','auth') ORDER BY 1, 2`)).rows;
  const parts = {};
  for (const { s, t } of tabs) {
    const fq = `${s}.${t}`; if (EXCLUDED.has(fq)) continue;
    const cols = (await c.query('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2', [s, t])).rows.map((r) => r.column_name);
    let where = 'TRUE';
    if (fq === 'auth.users') where = 'NOT (email = ANY($1::text[]))';
    else if (fq === 'public.admin_codes') where = "code NOT LIKE 'MODE-TEST-%'";
    else if (fq === 'auth.audit_log_entries') where = `COALESCE(payload->>'actor_username','') NOT LIKE '%@facturapro-%.invalid'`;
    else if (fq === 'auth.mfa_amr_claims') where = 'NOT (session_id IN (SELECT id FROM auth.sessions WHERE user_id::text = ANY($1::text[])))';
    else if (cols.includes('user_id')) where = 'user_id IS NULL OR NOT (user_id::text = ANY($1::text[]))';
    const r = await c.query(`SELECT count(*)::int n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text COLLATE "C"), '')) h FROM "${s}"."${t}" x WHERE ${where}`,
      fq === 'auth.users' ? [EMAILS] : where.includes('$1') ? [uids] : []);
    parts[fq] = `${r.rows[0].n}:${r.rows[0].h}`;
  }
  return { hash: sha(jstr(parts)), parts };
}
async function ensureTable(c) {
  await c.query('CREATE TABLE IF NOT EXISTS public._fp_rehearsal (name text PRIMARY KEY, sha256 text NOT NULL, detail jsonb, at timestamptz DEFAULT now())');
  await c.query('ALTER TABLE public._fp_rehearsal ENABLE ROW LEVEL SECURITY; REVOKE ALL ON public._fp_rehearsal FROM anon, authenticated');
}
async function checkForeign(c, label) {
  const base = (await c.query("SELECT sha256, detail FROM public._fp_rehearsal WHERE name='mode_baseline_foreign'")).rows[0];
  if (!base) throw new Error('référence « mode_baseline_foreign » absente : lancer baseline.');
  const now = await foreignHash(c);
  const diff = Object.keys(now.parts).filter((k) => now.parts[k] !== base.detail[k]).concat(Object.keys(base.detail).filter((k) => !(k in now.parts)));
  ck(`données préexistantes inchangées (${label}) — empreinte ${now.hash.slice(0, 12)} = référence ${base.sha256.slice(0, 12)}`, now.hash === base.sha256, diff.join(','));
}
const inventory = async (c) => ({
  tables: (await c.query("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p') ORDER BY 1")).rows.map((r) => r.relname),
  functions: (await c.query("SELECT p.oid::regprocedure::text f FROM pg_proc p WHERE p.pronamespace='public'::regnamespace ORDER BY 1")).rows.map((r) => r.f),
  triggers: (await c.query("SELECT c.relname||'.'||t.tgname n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace IN ('public'::regnamespace,'auth'::regnamespace) ORDER BY 1")).rows.map((r) => r.n),
  policies: (await c.query("SELECT tablename||'.'||policyname n FROM pg_policies WHERE schemaname='public' ORDER BY 1")).rows.map((r) => r.n),
});

// ---------- 1. cibles ----------
async function guardtests() {
  out('### 1. Contrôles de cible (exécutés, sans connexion)');
  const { parseDbUrl } = require('./preprod-db');
  const bad = (n, u, re) => { try { parseDbUrl(u); ck(n, false, 'aucune erreur'); } catch (e) { ck(n, re.test(e.message), e.message); } };
  bad('URL du pooleur de la PRODUCTION refusée', `postgresql://postgres.${T.prodRef}:FAKEPW@aws-0-eu-west-3.pooler.supabase.com:5432/postgres`, /PRODUCTION/);
  bad('URL directe de la PRODUCTION refusée', `postgresql://postgres:FAKEPW@db.${T.prodRef}.supabase.co:5432/postgres`, /PRODUCTION/);
  bad('projet inconnu refusé', 'postgresql://postgres.abcdefghijklmnopqrst:FAKEPW@aws-0-eu-west-3.pooler.supabase.com:5432/postgres', /non autorisé/);
  bad('URL absente refusée', '', /absent/);
  const g = (url, key) => spawnSync('node', ['-e', "require('./scripts/preprod-guard').guard(process.argv[1], process.argv[2])", url, key], { cwd: ROOT, encoding: 'utf8' });
  ck('API : URL de la PRODUCTION refusée', g(`https://${T.prodRef}.supabase.co`, T.anonKey).status === 1);
  const b64 = (o) => Buffer.from(jstr(o)).toString('base64url');
  const svc = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'service_role', ref: T.preprodRef })}.x`;
  ck('API : clé de rôle service_role (factice) refusée', g(`https://${T.preprodRef}.supabase.co`, svc).status === 1);
  const real = parseDbUrl(process.env.PREPROD_DB_URL);
  ck(`cible réelle (secret) = préproduction ${T.preprodRef}`, real.ref === T.preprodRef && real.ref !== T.prodRef);
  REST = restCfg(); ck('API : URL et clé anon de la préproduction acceptées', REST.ref === T.preprodRef);
}

// ---------- 2. référence ----------
async function baseline() {
  const c = await db();
  out('### 2. État de référence avant toute modification');
  await ensureTable(c);
  const mk = (await c.query('SELECT env, project_ref FROM public._fp_env WHERE id=1')).rows[0];
  ck('marqueur « préproduction » du bon projet', mk.env === 'preprod' && mk.project_ref === T.preprodRef);
  ck('sql/17 pas encore installé (aucune table doc_store_*)', !(await c.query("SELECT to_regclass('public.doc_store_mode') a, to_regclass('public.doc_store_testers') b")).rows[0].a);
  ck('sql/15 et sql/16 présents (prérequis)', !!(await c.query("SELECT to_regclass('public.documents') t")).rows[0].t && !!(await c.query("SELECT to_regprocedure('public.fp_mig_run(uuid,boolean)') t")).rows[0].t);
  const users = (await c.query('SELECT email FROM auth.users')).rows.map((r) => r.email);
  ck('aucun compte de test de cette opération ne préexiste', users.filter((e) => EMAILS.includes(e)).length === 0);
  out(`- Comptes préexistants (hors test) : ${users.filter((e) => !EMAILS.includes(e)).length}.`);
  const mr = (await c.query('SELECT count(*)::int n FROM public._mig_runs')).rows[0].n;
  out(`- Lignes _mig_runs préexistantes : ${mr} (le nettoyage final n'y touche que si ce nombre est 0).`);
  const inv = await inventory(c), h = await foreignHash(c);
  const prev = (await c.query("SELECT 1 FROM public._fp_rehearsal WHERE name='mode_baseline_foreign'")).rows[0];
  if (prev) { await c.query("DELETE FROM public._fp_rehearsal WHERE name IN ('mode_baseline_foreign','mode_inventory','mode_mig_runs')"); }
  await c.query("INSERT INTO public._fp_rehearsal(name, sha256, detail) VALUES ('mode_baseline_foreign', $1, $2::jsonb), ('mode_inventory', $3, $4::jsonb), ('mode_mig_runs', $5, $6::jsonb)",
    [h.hash, jstr(h.parts), sha(jstr(inv)), jstr(inv), String(mr), jstr({ n: mr })]);
  out(`- Référence enregistrée : empreinte ${h.hash.slice(0, 16)}… (${Object.keys(h.parts).length} tables), inventaire ${inv.tables.length} tables / ${inv.functions.length} fonctions / ${inv.triggers.length} déclencheurs / ${inv.policies.length} politiques.`);
  await c.end();
}

// ---------- 3. installation ----------
async function install() {
  const c = await db();
  out('### 5. Installation de sql/17 (préproduction uniquement, une transaction, hors installateur)');
  await ensureTable(c);
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'sql', 'MANIFEST.json'), 'utf8'));
  ck('sql/17 N\'EST PAS dans le manifeste de l\'installateur', !JSON.stringify(man).includes('17_mode_stockage'));
  const sql = fs.readFileSync(SQL17, 'utf8'), h = sha(sql);
  out(`- Script : sql/17_mode_stockage.sql — sha256 ${h} (${sql.length} octets).`);
  const before = (await c.query("SELECT detail FROM public._fp_rehearsal WHERE name='mode_inventory'")).rows[0].detail;
  const t0 = Date.now();
  try { await c.query('BEGIN'); await c.query(sql);
    await c.query("INSERT INTO public._fp_rehearsal(name, sha256) VALUES ('install:17_mode_stockage.sql', $1) ON CONFLICT (name) DO UPDATE SET sha256 = EXCLUDED.sha256, at = now()", [h]);
    await c.query('COMMIT'); }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); ck('sql/17 appliqué', false, e.message); await c.end(); return; }
  ck(`sql/17 appliqué en ${Date.now() - t0} ms (transaction validée)`, true);
  await c.query("NOTIFY pgrst, 'reload schema'");
  // --- objets ajoutés = exactement ceux attendus ---
  const after = await inventory(c);
  const added = (k) => after[k].filter((x) => !before[k].includes(x)), removed = (k) => before[k].filter((x) => !after[k].includes(x));
  ck('aucun objet existant supprimé ni renommé (tables, fonctions, déclencheurs, politiques)', ['tables', 'functions', 'triggers', 'policies'].every((k) => removed(k).length === 0), jstr(['tables', 'functions', 'triggers', 'policies'].map(removed)));
  ck('tables ajoutées = doc_store_mode, doc_store_testers', jstr(added('tables')) === jstr(['doc_store_mode', 'doc_store_testers']), jstr(added('tables')));
  const expFn = ['append_history(jsonb,text)', 'fp_doc_mode(uuid)', 'fp_doc_mode_set(uuid,text,text,integer)', 'get_doc_mode()', 'guard_doc_store_mode()', 'guard_mode_documents()', 'guard_mode_user_data()'];
  ck('fonctions ajoutées = les 7 attendues', jstr(added('functions').map((f) => f.replace(/^public\./, '')).sort()) === jstr(expFn), jstr(added('functions')));
  ck('déclencheurs ajoutés = les 4 attendus', jstr(added('triggers')) === jstr(['doc_payments.trg_00_mode_doc_payments', 'doc_store_mode.trg_doc_store_mode_check', 'documents.trg_00_mode_documents', 'user_data.trg_00_mode_user_data']), jstr(added('triggers')));
  // --- catalogue RÉEL : privilèges, RLS, déclencheurs ---
  const fn = (await c.query(`SELECT p.proname n, p.prosecdef sd, has_function_privilege('anon', p.oid, 'EXECUTE') a, has_function_privilege('authenticated', p.oid, 'EXECUTE') u,
        EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee = 0) pub
      FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN ('fp_doc_mode_set','fp_doc_mode','guard_mode_user_data','guard_mode_documents','guard_doc_store_mode','get_doc_mode','append_history')`)).rows;
  const by = Object.fromEntries(fn.map((f) => [f.n, f]));
  ck('fonctions internes (fp_doc_mode_set, fp_doc_mode, 3 gardes) : ni anon, ni authenticated, ni PUBLIC', ['fp_doc_mode_set', 'fp_doc_mode', 'guard_mode_user_data', 'guard_mode_documents', 'guard_doc_store_mode'].every((n) => by[n] && !by[n].a && !by[n].u && !by[n].pub), jstr(fn));
  ck('get_doc_mode et append_history : authenticated oui, anon non, PUBLIC non', ['get_doc_mode', 'append_history'].every((n) => by[n] && by[n].u && !by[n].a && !by[n].pub), jstr(fn));
  ck('toutes ces fonctions sont SECURITY DEFINER', fn.length === 7 && fn.every((f) => f.sd));
  const tb = (await c.query(`SELECT c.relname t, c.relrowsecurity rls, bool_or(has_table_privilege(r, c.oid, p)) any_priv FROM pg_class c,
      unnest(ARRAY['anon','authenticated']) r, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
      WHERE c.relnamespace='public'::regnamespace AND c.relname IN ('doc_store_mode','doc_store_testers') GROUP BY c.relname, c.relrowsecurity`)).rows;
  ck('doc_store_mode et doc_store_testers : RLS active, aucun privilège pour anon ni authenticated', tb.length === 2 && tb.every((t) => t.rls && !t.any_priv), jstr(tb));
  const tg = (await c.query(`SELECT c.relname t, g.tgname n, g.tgenabled e, g.tgtype FROM pg_trigger g JOIN pg_class c ON c.oid=g.tgrelid WHERE g.tgname IN ('trg_00_mode_user_data','trg_00_mode_documents','trg_00_mode_doc_payments','trg_doc_store_mode_check')`)).rows;
  ck('4 déclencheurs de garde présents et actifs', tg.length === 4 && tg.every((t) => t.e === 'O'), jstr(tg));
  const order = (await c.query("SELECT string_agg(tgname, ',' ORDER BY tgname) o FROM pg_trigger WHERE tgrelid='public.user_data'::regclass AND NOT tgisinternal AND tgtype & 2 = 2")).rows[0].o;
  ck('sur user_data, trg_00_mode_user_data s\'exécute AVANT les déclencheurs de sql/14', /^trg_00_mode_user_data,/.test(order), order);
  ck('aucune ligne dans doc_store_mode ni doc_store_testers (tous les comptes restent en legacy)', (await c.query('SELECT (SELECT count(*) FROM public.doc_store_mode)::int a, (SELECT count(*) FROM public.doc_store_testers)::int b')).rows.every((r) => r.a === 0 && r.b === 0));
  ck('ré-application du même script : sans erreur (idempotence sur le vrai Supabase)', await (async () => { try { await c.query('BEGIN'); await c.query(sql); await c.query('COMMIT'); return true; } catch (e) { await c.query('ROLLBACK').catch(() => {}); return false; } })());
  await checkForeign(c, 'après installation');
  await c.end();
  // --- API réelle : accès anonyme refusé ---
  await sleep(4000);
  REST = restCfg();
  out('\n### 6. Refus d\'accès sur l\'API Supabase réelle (visiteur non connecté)');
  const A = [await rpc(null, 'get_doc_mode'), await rpc(null, 'append_history', { p_entries: [] }), await rpc(null, 'fp_doc_mode_set', { p_user: '00000000-0000-0000-0000-000000000000', p_mode: 'documents' }),
    await rpc(null, 'fp_doc_mode', { p_uid: '00000000-0000-0000-0000-000000000000' }), await api('GET', '/rest/v1/doc_store_mode?select=*', null), await api('GET', '/rest/v1/doc_store_testers?select=*', null),
    await api('POST', '/rest/v1/doc_store_mode', null, { user_id: '00000000-0000-0000-0000-000000000000', mode: 'documents' })];
  ck('anon : get_doc_mode, append_history, fp_doc_mode_set, fp_doc_mode, lecture et écriture des 2 tables : tous refusés', A.every(denied), jstr(A.map((x) => x.status)));
}

// ---------- 4. comptes de test ----------
async function createAccounts(c) {
  const pws = JSON.parse(process.env.MODE_PASSWORDS || '{}');
  for (const k of KEYS) {
    if (!pws[k] || pws[k].length < 12) throw new Error('MODE_PASSWORDS incomplet.');
    const email = EMAIL(k);
    const ex = await c.query('SELECT id FROM auth.users WHERE email=$1', [email]);
    if (ex.rows[0]) { await c.query("UPDATE auth.users SET encrypted_password = crypt($2, gen_salt('bf')), updated_at = now() WHERE email = $1", [email, pws[k]]); continue; }
    const id = crypto.randomUUID();
    await c.query(`INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
      VALUES ('00000000-0000-0000-0000-000000000000', $1::uuid, 'authenticated', 'authenticated', $2, crypt($3, gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '')`, [id, email, pws[k]]);
    await c.query(`INSERT INTO auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
      VALUES (gen_random_uuid(), $1::uuid, $1::text, jsonb_build_object('sub', $1::text, 'email', $2::text, 'email_verified', true), 'email', now(), now(), now())`, [id, email]);
  }
}
const put = (tok, uid, key, value) => api('POST', '/rest/v1/user_data?on_conflict=user_id,key', tok, { user_id: uid, key, value }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
const getUD = async (tok, uid, key) => { const r = await api('GET', `/rest/v1/user_data?select=value&user_id=eq.${uid}&key=eq.${key}`, tok); return r.status === 200 && r.body[0] ? r.body[0].value : null; };
const getDocs = (tok, uid) => api('GET', `/rest/v1/documents?select=id,doc_type,version,status&user_id=eq.${uid}`, tok);

async function test() {
  REST = restCfg();
  const c = await db();
  const q = async (s, p = []) => (await c.query(s, p)).rows, q1 = async (s, p = []) => (await q(s, p))[0];
  const flip = async (uid, mode, resol = null, idle = 0) => { try { return (await q1('SELECT public.fp_doc_mode_set($1::uuid,$2,$3,$4) r', [uid, mode, resol, idle])).r; } catch (e) { return { error: e.message }; } };
  const tryq = async (s, p = []) => { try { await c.query(s, p); return null; } catch (e) { return e; } };
  if (!(await q1("SELECT to_regclass('public.doc_store_mode') t")).t) throw new Error('REFUS : sql/17 non installé.');
  await ensureTable(c);
  out('### 7. Comptes de test jetables (8) et données');
  await createAccounts(c);
  await checkForeign(c, 'avant les tests');
  const us = Object.fromEntries((await uidsOf(c)).map((r) => [Object.keys(Object.fromEntries(KEYS.map((k) => [k, EMAIL(k)]))).find((k) => EMAIL(k) === r.email), r.id]));
  ck('8 comptes de test créés (7 en @facturapro-test.invalid + 1 compte « ordinaire » @facturapro-ordinary.invalid)', Object.keys(us).length === 8);
  // données « ancien format » par l'API réelle pour a et b ; par SQL pour c, d, x, y, e, o (compteurs d'abord : verrou serveur)
  const A = await login('a'), B = await login('b');
  for (const S of [A, B]) await rpc(S.tok, 'my_license');
  const nextNum = async (S, type) => (await rpc(S.tok, 'next_doc_number', { p_type: type, p_floor: 0 })).body;
  for (const S of [A, B]) {
    const n = FN(await nextNum(S, 'invoice'));
    const inv = [{ id: 'i1', type: 'invoice', number: n, status: 'sent', date: `${Y}-02-01`, clientName: 'Client test', items: [], totalHT: 100, totalTVA: 20, totalTTC: 120, paidAmount: 0 },
      { id: 'd1', type: 'invoice', number: 'BRO-AAAAAA', status: 'draft', clientName: 'brouillon 1', totalTTC: 5 }, { id: 'd2', type: 'invoice', number: 'BRO-BBBBBB', status: 'draft', clientName: 'brouillon 2', totalTTC: 6 }];
    const w = [await put(S.tok, S.id, 'invoices', inv), await put(S.tok, S.id, 'docLog', [{ ts: `${Y}-02-01T09:00:00Z`, action: 'emission', docId: 'i1', number: n, detail: 'Facture émise' }]), await put(S.tok, S.id, 'company', { name: 'Société de test' })];
    if (w.some((x) => x.status >= 300)) throw new Error('écriture ancien format refusée ' + jstr(w.map((x) => x.status)));
  }
  for (const k of ['c', 'd', 'x', 'y', 'e', 'o']) {
    await c.query(`INSERT INTO public.doc_counters(user_id, doc_type, last_value) VALUES ($1::uuid,'invoice',1) ON CONFLICT (user_id, doc_type) DO UPDATE SET last_value = GREATEST(public.doc_counters.last_value, 1)`, [us[k]]);
    await c.query(`INSERT INTO public.licenses(user_id, type, status, expires_at) VALUES ($1::uuid,'annual','active', now() + interval '100 days') ON CONFLICT (user_id) DO NOTHING`, [us[k]]);
    await c.query(`INSERT INTO public.user_data(user_id, key, value) VALUES ($1::uuid,'invoices',$2::jsonb), ($1::uuid,'docLog',$3::jsonb) ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [us[k], jstr([{ id: 'i1', type: 'invoice', number: FN(1), status: 'sent', date: `${Y}-03-01`, clientName: 'Client', items: [], totalHT: 10, totalTVA: 2, totalTTC: 12 },
        { id: 'd1', type: 'invoice', number: 'BRO-CCCCCC', status: 'draft', totalTTC: 5 }, { id: 'd2', type: 'invoice', number: 'BRO-DDDDDD', status: 'draft', totalTTC: 6 }]),
        jstr([{ ts: `${Y}-03-01T09:00:00Z`, action: 'emission', docId: 'i1', number: FN(1), detail: 'ok' }])]);
  }
  ck('données « ancien format » prêtes pour les 8 comptes (a, b par l\'API réelle)', (await q1('SELECT count(*)::int n FROM public.user_data WHERE user_id::text = ANY($1) AND key=\'invoices\'', [Object.values(us)])).n === 8);
  const ud0 = async () => Object.fromEntries(await Promise.all(Object.entries(us).map(async ([k, id]) => [k, (await q1("SELECT md5(coalesce(string_agg(key||value::text,'|' ORDER BY key COLLATE \"C\"),'')) h FROM public.user_data WHERE user_id=$1::uuid AND key IN ('invoices','quotes','payments','docLog')", [id])).h])));
  const legacyHash0 = await ud0();
  const noMode = async () => (await q1('SELECT count(*)::int n FROM public.doc_store_mode')).n;

  // ---------- licences ----------
  out('\n### 7b. Licences : audit sur le vrai Supabase (comptes jetables)');
  const pk = await q1("SELECT array_agg(a.attname::text ORDER BY a.attnum) cols FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum = ANY(c.conkey) WHERE c.conrelid='public.licenses'::regclass AND c.contype='p'");
  ck('licenses : clé primaire réelle = (user_id) seule → une seule licence par utilisateur, garantie par la base', jstr(pk.cols) === jstr(['user_id']), jstr(pk.cols));
  const uq = await q("SELECT i.indexrelid::regclass::text n, i.indisunique u, pg_get_indexdef(i.indexrelid) d FROM pg_index i WHERE i.indrelid='public.licenses'::regclass");
  out('- index réels de licenses : ' + uq.map((x) => x.d.replace(/^CREATE (UNIQUE )?INDEX /, (m, u) => (u ? 'unique ' : '') + 'index ')).join(' ; '));
  const fk = await q1("SELECT count(*)::int n FROM pg_constraint WHERE conrelid='public.licenses'::regclass AND contype='f' AND confrelid='auth.users'::regclass AND confdeltype='c'");
  ck('licenses.user_id → auth.users ON DELETE CASCADE (suppression de compte sans licence orpheline)', fk.n === 1);
  const chk = (await q("SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conrelid='public.licenses'::regclass AND contype='c'")).map((x) => x.d).join(' ');
  ck("types de licence valides (CHECK) : trial, monthly, semestrial, annual, business, lifetime — « annual » conservé", ['trial', 'monthly', 'semestrial', 'annual', 'business', 'lifetime'].every((t) => chk.includes("'" + t + "'")), chk.slice(0, 300));
  const rl = await q1("SELECT c.relrowsecurity rls, (SELECT string_agg(policyname, ',' ORDER BY policyname) FROM pg_policies WHERE schemaname='public' AND tablename='licenses') pol, has_table_privilege('anon','public.licenses','SELECT') a1, has_table_privilege('anon','public.licenses','INSERT') a2 FROM pg_class c WHERE c.oid='public.licenses'::regclass");
  ck('licenses : RLS active, politiques = licenses_admin_all + licenses_select_own, aucun accès pour anon', rl.rls && rl.pol === 'licenses_admin_all,licenses_select_own' && !rl.a1 && !rl.a2, jstr(rl));
  const dup = await tryq("INSERT INTO public.licenses(user_id, type) VALUES ($1::uuid,'monthly')", [us.a]);
  ck('2e licence pour le même utilisateur (INSERT direct) : refusée par la base (23505)', dup && dup.code === '23505', dup && (dup.code + ' ' + dup.message));
  const badT = await tryq("INSERT INTO public.licenses(user_id, type) VALUES ($1::uuid,'inconnu')", [us.e]);
  ck('type de licence invalide : refusé (23514)', badT && badT.code === '23514', badT && (badT.code + ' ' + badT.message));
  await c.query("INSERT INTO public.licenses(user_id, type) VALUES ($1::uuid,'monthly') ON CONFLICT (user_id) DO NOTHING", [us.c]);
  ck('insertions répétées avec ON CONFLICT DO NOTHING : 1 seule ligne, la licence « annual » existante est conservée', (await q1("SELECT count(*)::int n, min(type) t FROM public.licenses WHERE user_id=$1::uuid", [us.c])).n === 1 && (await q1("SELECT type t FROM public.licenses WHERE user_id=$1::uuid", [us.c])).t === 'annual');
  const E = await login('e');
  await c.query('DELETE FROM public.licenses WHERE user_id=$1::uuid', [us.e]);   // compte jetable créé par cette opération
  const ml = await Promise.all(Array.from({ length: 6 }, () => rpc(E.tok, 'my_license')));
  ck('my_license appelée 6 fois en parallèle sur un compte sans licence : 6 réponses ok, 1 seule ligne créée (essai)', ml.every((x) => x.status === 200 && x.body.ok) && (await q1('SELECT count(*)::int n FROM public.licenses WHERE user_id=$1::uuid', [us.e])).n === 1 && (await q1('SELECT type t FROM public.licenses WHERE user_id=$1::uuid', [us.e])).t === 'trial', jstr(ml.map((x) => x.status)));
  const snap = async (id) => (await q1("SELECT md5(l::text) h FROM public.licenses l WHERE user_id=$1::uuid", [id])).h;
  const sA = await snap(us.a), sB = await snap(us.b);
  const own = await api('GET', `/rest/v1/licenses?select=user_id,type&user_id=eq.${A.id}`, A.tok), oth = await api('GET', `/rest/v1/licenses?select=user_id&user_id=eq.${B.id}`, A.tok), allv = await api('GET', '/rest/v1/licenses?select=user_id', A.tok);
  ck('RLS licences (API réelle) : a lit sa licence (1), pas celle de b, et la liste complète ne contient que la sienne', own.body.length === 1 && oth.body.length === 0 && allv.body.length === 1, jstr([own.body.length, oth.body.length, allv.body.length]));
  const w1 = await api('POST', '/rest/v1/licenses', A.tok, { user_id: A.id, type: 'lifetime' }, { Prefer: 'resolution=merge-duplicates' });
  const w2 = await api('PATCH', `/rest/v1/licenses?user_id=eq.${A.id}`, A.tok, { type: 'lifetime', expires_at: null }, { Prefer: 'return=representation' });
  const w3 = await api('PATCH', `/rest/v1/licenses?user_id=eq.${B.id}`, A.tok, { type: 'lifetime' }, { Prefer: 'return=representation' });
  const w4 = await api('DELETE', `/rest/v1/licenses?user_id=eq.${A.id}`, A.tok, undefined, { Prefer: 'return=representation' });
  ck('un utilisateur ne peut ni créer, ni modifier (sa licence ou celle d\'un autre), ni supprimer une licence par l\'API ; les lignes sont inchangées', denied(w1) && !(Array.isArray(w2.body) && w2.body.length) && !(Array.isArray(w3.body) && w3.body.length) && !(Array.isArray(w4.body) && w4.body.length) && (await snap(us.a)) === sA && (await snap(us.b)) === sB, jstr([w1.status, w2.status, w3.status, w4.status]));
  await c.query("DELETE FROM public.admin_codes WHERE code LIKE 'MODE-TEST-%'");
  await c.query("INSERT INTO public.admin_codes(code, type, client_email, status) VALUES ('MODE-TEST-AAAA01','annual',$1,'pending'), ('MODE-TEST-BBBB02','annual',$2,'pending'), ('MODE-TEST-CCCC03','monthly',NULL,'pending')", [EMAIL('a'), EMAIL('b')]);
  const inv = await rpc(A.tok, 'activate_license', { p_code: 'code-inexistant' }), wrong = await rpc(A.tok, 'activate_license', { p_code: 'MODE-TEST-BBBB02' });
  ck('activate_license : code inexistant → invalid ; code destiné à un autre e-mail → wrong_email ; licence inchangée', inv.body.reason === 'invalid' && wrong.body.reason === 'wrong_email' && (await snap(us.a)) === sA, jstr([inv.body, wrong.body]));
  const act = await Promise.all(Array.from({ length: 5 }, () => rpc(A.tok, 'activate_license', { p_code: 'MODE-TEST-AAAA01' })));
  const okAct = act.filter((x) => x.body.ok), la = await q1("SELECT type, status, code, (expires_at - now()) > interval '364 days' AND (expires_at - now()) < interval '366 days' ok365 FROM public.licenses WHERE user_id=$1::uuid", [us.a]);
  ck('activate_license : même code activé 5 fois en parallèle → 1 seule réussite, les autres « used » ; licence « annual » ~365 jours, 1 seule ligne', okAct.length === 1 && act.filter((x) => x.body.reason === 'used').length === 4 && la.type === 'annual' && la.status === 'active' && la.ok365 === true && (await q1('SELECT count(*)::int n FROM public.licenses WHERE user_id=$1::uuid', [us.a])).n === 1, jstr(act.map((x) => x.body.reason || 'ok')) + jstr(la));
  const act2 = await rpc(B.tok, 'activate_license', { p_code: 'MODE-TEST-BBBB02' });
  ck('activate_license : code « annual » valide pour b → licence annual de b, 1 seule ligne ; la licence de a n\'a pas bougé', act2.body.ok === true && (await q1("SELECT type t FROM public.licenses WHERE user_id=$1::uuid", [us.b])).t === 'annual' && (await q1('SELECT count(*)::int n FROM public.licenses WHERE user_id=$1::uuid', [us.b])).n === 1);
  ck('licences : exactement une ligne par compte de test (8 comptes, 8 lignes)', (await q1('SELECT count(*)::int n, count(DISTINCT user_id)::int d FROM public.licenses WHERE user_id::text = ANY($1)', [Object.values(us)])).n === 8);
  await checkForeign(c, 'après les contrôles de licences');

  // ---------- autorisation ----------
  out('\n### 8. Autorisation (contrôles côté serveur sur le vrai Supabase)');
  ck('mode par défaut = legacy pour les 8 comptes (aucune ligne doc_store_mode)', (await noMode()) === 0);
  for (const k of ['a', 'b', 'c', 'd', 'x', 'y', 'o']) await c.query('INSERT INTO public.doc_store_testers(user_id) VALUES ($1::uuid) ON CONFLICT DO NOTHING', [us[k]]);   // « o » autorisé exprès : l'e-mail doit le refuser ; « e » volontairement absent
  let r = await flip(us.o, 'documents'); ck('compte ordinaire (même autorisé dans la liste) : COMPTE_NON_TEST', /COMPTE_NON_TEST/.test(r.error || ''), jstr(r));
  r = await flip(us.e, 'documents'); ck('e-mail de test mais absent de la liste : COMPTE_NON_AUTORISE', /COMPTE_NON_AUTORISE/.test(r.error || ''), jstr(r));
  const ins = await tryq("INSERT INTO public.doc_store_mode(user_id, mode) VALUES ($1::uuid,'documents')", [us.e]);
  ck('écriture SQL directe en mode documents pour le compte non autorisé : refusée par le déclencheur de la table', /COMPTE_NON_AUTORISE/.test(ins ? ins.message : ''), ins && ins.message);
  const ins2 = await tryq("INSERT INTO public.doc_store_mode(user_id, mode) VALUES ($1::uuid,'documents')", [us.o]);
  ck('idem pour le compte ordinaire (liste OK, e-mail non test)', /COMPTE_NON_AUTORISE/.test(ins2 ? ins2.message : ''), ins2 && ins2.message);
  r = await flip(us.a, 'autre'); ck('mode invalide refusé', /MODE_INVALIDE/.test(r.error || ''));
  r = await flip(crypto.randomUUID(), 'documents'); ck('compte inconnu refusé', /COMPTE_INTROUVABLE/.test(r.error || ''));
  ck('aucune ligne doc_store_mode créée par ces refus', (await noMode()) <= 0 || (await q1("SELECT count(*)::int n FROM public.doc_store_mode WHERE mode='documents'")).n === 0);
  // via l'API avec un jeton utilisateur
  const O = await login('o');
  const ap = [await rpc(A.tok, 'fp_doc_mode_set', { p_user: us.a, p_mode: 'documents', p_resolution: null, p_min_idle_seconds: 0 }), await rpc(A.tok, 'fp_doc_mode', { p_uid: us.a }), await rpc(A.tok, 'guard_mode_user_data'),
    await api('GET', '/rest/v1/doc_store_mode?select=*', A.tok), await api('GET', '/rest/v1/doc_store_testers?select=*', A.tok),
    await api('POST', '/rest/v1/doc_store_mode', A.tok, { user_id: us.a, mode: 'documents' }), await api('POST', '/rest/v1/doc_store_testers', A.tok, { user_id: us.a }),
    await api('PATCH', `/rest/v1/doc_store_mode?user_id=eq.${us.a}`, A.tok, { mode: 'documents' }), await rpc(O.tok, 'fp_doc_mode_set', { p_user: us.o, p_mode: 'documents' })];
  ck('API, jeton utilisateur : fp_doc_mode_set, fp_doc_mode, fonction de garde, lecture/écriture des 2 tables : tous refusés', ap.every(denied), jstr(ap.map((x) => x.status)));
  ck('API : get_doc_mode renvoie « legacy » pour a, b et le compte ordinaire', (await rpc(A.tok, 'get_doc_mode')).body === 'legacy' && (await rpc(B.tok, 'get_doc_mode')).body === 'legacy' && (await rpc(O.tok, 'get_doc_mode')).body === 'legacy');
  const lg = [await rpc(A.tok, 'upsert_document', { p_doc: { id: 'zz', type: 'invoice', number: 'BRO-ZZZZZZ', status: 'draft' }, p_expected_version: 0, p_op_id: 'leg1' }), await rpc(A.tok, 'append_history', { p_entries: [{ id: 'e', action: 'x' }] }),
    await rpc(A.tok, 'record_payment', { p_invoice_id: 'i1', p_payment: { id: 'zz', amount: 1 } }), await api('POST', '/rest/v1/documents', A.tok, { user_id: us.a, doc_type: 'invoice', id: 'zz', body: {}, body_sha: 'x' })];
  ck('mode legacy : upsert_document, append_history, record_payment (API) et écriture directe dans documents : tous refusés (MODE_ANCIEN_STOCKAGE / droits)', lg.every(denied) && /MODE_ANCIEN_STOCKAGE/.test(jstr(lg[0].body)) && /MODE_ANCIEN_STOCKAGE/.test(jstr(lg[1].body)), jstr(lg.map((x) => x.status)) + jstr(lg[0].body).slice(0, 120));
  ck('l\'ancien chemin (API) fonctionne toujours en legacy', (await put(A.tok, A.id, 'company', { name: 'Société de test 2' })).status < 300);
  ck('rien n\'a changé dans les données (empreinte ancien stockage) après tous ces refus', jstr(await ud0()) === jstr(legacyHash0) && (await q1('SELECT count(*)::int n FROM public.documents WHERE user_id::text = ANY($1)', [Object.values(us)])).n === 0);

  // ---------- protection ancienne activité ----------
  out('\n### 9. Bascule vers « documents »');
  await put(A.tok, A.id, 'docLog', [{ ts: `${Y}-02-01T09:00:00Z`, action: 'emission', docId: 'i1', detail: 'Facture émise' }]);   // écriture « récente » d'un ancien appareil
  const bnum = (await getUD(A.tok, A.id, 'invoices'))[0].number;
  r = await flip(us.a, 'documents', null, 600);
  ck('écriture récente sur l\'ancien stockage : bascule REFUSÉE (ACTIVITE_RECENTE_ANCIEN_APPAREIL), mode inchangé, rien copié', r.reason === 'ACTIVITE_RECENTE_ANCIEN_APPAREIL' && (await rpc(A.tok, 'get_doc_mode')).body === 'legacy' && (await q1('SELECT count(*)::int n FROM public.documents WHERE user_id=$1::uuid', [us.a])).n === 0, jstr(r));
  r = await flip(us.a, 'documents', null, 0);
  ck('mode documents pour a (autorisé, compte de test), après rattrapage et vérification', r.ok === true && r.mode === 'documents', jstr(r).slice(0, 300));
  r = await flip(us.a, 'documents'); ck('bascule rejouée : sans effet', r.unchanged === true);
  ck('API : get_doc_mode(a) = documents ; get_doc_mode(b) = legacy (isolation du mode)', (await rpc(A.tok, 'get_doc_mode')).body === 'documents' && (await rpc(B.tok, 'get_doc_mode')).body === 'legacy');
  ck('a : 3 documents copiés, 1 entrée de journal', (await getDocs(A.tok, A.id)).body.length === 3 && (await q1('SELECT count(*)::int n FROM public.doc_history WHERE user_id=$1::uuid', [us.a])).n === 1);
  ck('ancien stockage de a : lisible et intact (3 éléments)', (await getUD(A.tok, A.id, 'invoices')).length === 3);
  const ow = [await put(A.tok, A.id, 'invoices', []), await put(A.tok, A.id, 'quotes', []), await put(A.tok, A.id, 'payments', []), await put(A.tok, A.id, 'docLog', []), await api('DELETE', `/rest/v1/user_data?user_id=eq.${A.id}&key=eq.invoices`, A.tok)];
  ck('mode documents : écritures sur l\'ancien chemin (invoices, quotes, payments, docLog, suppression) REFUSÉES par l\'API réelle', ow.every((x) => x.status >= 400), jstr(ow.map((x) => x.status)));
  ck('refus avec SQLSTATE 42501 et MODE_NOUVEAU_STOCKAGE (les anciennes versions ne réessaient pas)', ow.slice(0, 4).every((x) => x.body && x.body.code === '42501' && /MODE_NOUVEAU_STOCKAGE/.test(x.body.message || '')), jstr(ow[0].body).slice(0, 200));
  ck('autres clés (company) : toujours écrivables', (await put(A.tok, A.id, 'company', { name: 'Société de test 3' })).status < 300);
  ck('rien n\'a changé dans l\'ancien stockage de a', (await getUD(A.tok, A.id, 'invoices')).length === 3 && (await getUD(A.tok, A.id, 'docLog')).length === 1);

  // ---------- isolation entre comptes ----------
  out('\n### 10. Isolation entre comptes (API réelle)');
  const bd = [await getDocs(B.tok, A.id), await api('GET', `/rest/v1/doc_payments?select=id&user_id=eq.${A.id}`, B.tok), await api('GET', `/rest/v1/doc_history?select=entry_sha&user_id=eq.${A.id}`, B.tok)];
  ck('b (legacy) ne lit ni documents, ni paiements, ni journal de a', bd.every((x) => x.status === 200 && x.body.length === 0), jstr(bd.map((x) => x.status)));
  const bw = [await rpc(B.tok, 'upsert_document', { p_doc: { id: 'zz', type: 'invoice', number: 'BRO-ZZZZZZ', status: 'draft' }, p_expected_version: 0, p_op_id: 'b1' }), await rpc(B.tok, 'append_history', { p_entries: [{ id: 'e', action: 'x' }] })];
  ck('b (legacy) ne peut pas utiliser le nouveau chemin (même avec les mêmes identifiants que a)', bw.every(denied) && /MODE_ANCIEN_STOCKAGE/.test(jstr(bw[0].body)));
  ck('a ne lit rien de b', (await getDocs(A.tok, B.id)).body.length === 0 && (await api('GET', `/rest/v1/user_data?select=key&user_id=eq.${B.id}`, A.tok)).body.length === 0);
  ck('les documents de a sont inchangés après ces tentatives', (await getDocs(A.tok, A.id)).body.length === 3);

  // ---------- parcours du nouveau chemin ----------
  out('\n### 11. Parcours du nouveau chemin (compte a), conflits, paiements rejoués, concurrence');
  const A2 = await login('a');   // 2e appareil
  let u = await rpc(A.tok, 'upsert_document', { p_doc: { id: 'n1', type: 'invoice', number: 'BRO-NEW111', status: 'draft', clientName: 'v1', totalTTC: 9 }, p_expected_version: 0, p_op_id: 'op-n1' });
  ck('création d\'un brouillon (n1) : acceptée, version 1', u.body.ok === true && u.body.version === 1, jstr(u.body));
  u = await rpc(A.tok, 'upsert_document', { p_doc: { id: 'n1', type: 'invoice', number: 'BRO-NEW111', status: 'draft', clientName: 'v1', totalTTC: 9 }, p_expected_version: 0, p_op_id: 'op-n1' });
  ck('même opération rejouée (coupure réseau) : reconnue, aucun doublon', u.body.replay === true && (await getDocs(A.tok, A.id)).body.filter((d) => d.id === 'n1').length === 1, jstr(u.body));
  const [x1, x2] = await Promise.all([rpc(A.tok, 'upsert_document', { p_doc: { id: 'n1', type: 'invoice', number: 'BRO-NEW111', status: 'draft', clientName: 'appareil 1', totalTTC: 9 }, p_expected_version: 1, p_op_id: 'd1' }),
    rpc(A2.tok, 'upsert_document', { p_doc: { id: 'n1', type: 'invoice', number: 'BRO-NEW111', status: 'draft', clientName: 'appareil 2', totalTTC: 9 }, p_expected_version: 1, p_op_id: 'd2' })]);
  ck('2 appareils modifient n1 depuis la version 1 : 1 accepté, 1 CONFLIT explicite avec la version serveur', [x1, x2].filter((x) => x.body.ok).length === 1 && [x1, x2].filter((x) => x.body.conflict).length === 1 && [x1, x2].find((x) => x.body.conflict).body.server_version === 2, jstr([x1.body, x2.body]).slice(0, 300));
  const iss = await rpc(A.tok, 'upsert_document', { p_doc: { id: 'i1', type: 'invoice', number: bnum, status: 'sent', totalTTC: 1 }, p_expected_version: (await getDocs(A.tok, A.id)).body.find((d) => d.id === 'i1').version, p_op_id: 'lock1' });
  ck('facture émise : modification de montant refusée (FACTURE_VERROUILLEE)', denied(iss) && /FACTURE_VERROUILLEE/.test(jstr(iss.body)));
  const pr = await Promise.all(Array.from({ length: 6 }, () => rpc(A.tok, 'record_payment', { p_invoice_id: 'i1', p_payment: { id: 'p-replay', amount: 20, date: `${Y}-04-01`, method: 'virement' }, p_op_id: 'pay-op' })));
  ck('paiement envoyé 6 fois en parallèle : toutes réponses ok, 1 seule ligne, facture payée 20 une seule fois', pr.every((x) => x.status === 200 && x.body.ok) && (await q1("SELECT count(*)::int n FROM public.doc_payments WHERE user_id=$1::uuid AND id='p-replay'", [us.a])).n === 1 && Number((await q1("SELECT paid_amount FROM public.documents WHERE user_id=$1::uuid AND id='i1'", [us.a])).paid_amount) === 20, jstr(pr.map((x) => x.status)));
  const pd = await Promise.all(Array.from({ length: 5 }, (_, i) => rpc(A.tok, 'record_payment', { p_invoice_id: 'i1', p_payment: { id: 'p-par' + i, amount: 10, date: `${Y}-04-02` }, p_op_id: 'pp' + i })));
  ck('5 paiements distincts simultanés : tous enregistrés, total exact 20 + 50 = 70', pd.every((x) => x.status === 200 && x.body.ok) && Number((await q1("SELECT paid_amount FROM public.documents WHERE user_id=$1::uuid AND id='i1'", [us.a])).paid_amount) === 70);
  const hs = [await rpc(A.tok, 'append_history', { p_entries: [{ id: 'e-1', ts: `${Y}-04-03T10:00:00Z`, action: 'creation', docId: 'n1', detail: 'brouillon' }, { action: 'plain', detail: 'x' }, { action: 'plain', detail: 'x' }] }),
    await rpc(A.tok, 'append_history', { p_entries: [{ id: 'e-1', ts: `${Y}-04-03T10:00:00Z`, action: 'creation', docId: 'n1', detail: 'brouillon' }] })];
  ck('journal : 3 entrées ajoutées (dont 2 identiques), la même entrée rejouée n\'ajoute rien', hs[0].body.added === 3 && hs[1].body.added === 0, jstr(hs.map((x) => x.body)));
  let race = { del: 0, upd: 0, bad: 0 };
  for (let k = 0; k < 4; k++) {
    const id = 'x' + k; await rpc(A.tok, 'upsert_document', { p_doc: { id, type: 'invoice', number: 'BRO-X' + k, status: 'draft', totalTTC: 1 }, p_expected_version: 0, p_op_id: 'xi' + k });
    const [d, up] = await Promise.all([rpc(A.tok, 'delete_document', { p_type: 'invoice', p_id: id, p_expected_version: 1, p_op_id: 'xd' + k }), rpc(A2.tok, 'upsert_document', { p_doc: { id, type: 'invoice', number: 'BRO-X' + k, status: 'draft', totalTTC: 1, clientName: 'édité' }, p_expected_version: 1, p_op_id: 'xu' + k })]);
    const n = await q('SELECT body->>\'clientName\' c FROM public.documents WHERE user_id=$1::uuid AND id=$2', [us.a, id]);
    if (d.body.ok && !d.body.conflict && up.body.conflict && n.length === 0) race.del++; else if (up.body.ok && d.body.conflict && n.length === 1 && n[0].c === 'édité') race.upd++; else race.bad++;
  }
  ck(`suppression vs modification simultanées (4 essais, 2 appareils) : toujours un seul gagnant, l'autre reçoit un conflit — ${jstr(race)}`, race.bad === 0 && race.del + race.upd === 4);
  const NB = 8;
  const em = await Promise.all(Array.from({ length: NB }, async (_, i) => { const num = (await rpc(A.tok, 'next_doc_number', { p_type: 'invoice', p_floor: 0 })).body; const number = FN(num);
    return { num, x: await rpc(A.tok, 'upsert_document', { p_doc: { id: 'par' + i, type: 'invoice', number, status: 'sent', date: `${Y}-06-01`, clientName: 'Concurrent', totalHT: 10, totalTVA: 2, totalTTC: 12 }, p_expected_version: 0, p_op_id: 'par-' + i }) }; }));
  ck(`${NB} émissions simultanées : ${NB} numéros distincts attribués par le serveur, ${NB} documents acceptés`, new Set(em.map((e) => e.num)).size === NB && em.every((e) => e.x.status === 200 && e.x.body.ok), jstr(em.map((e) => e.x.status)));
  ck('fp_mig_verify (compte a, mode documents) : sans écart', (await q1('SELECT public.fp_mig_verify($1::uuid) v', [us.a])).v.ok === true);
  await checkForeign(c, 'après le parcours du nouveau chemin');

  // ---------- retour vers legacy ----------
  out('\n### 12. Retour vers « legacy » après créations, modifications, suppressions, paiements et journal');
  const nDocs = (await getDocs(A.tok, A.id)).body.map((d) => d.id).sort();
  const hLegBefore = jstr(await getUD(A.tok, A.id, 'invoices'));
  r = await flip(us.a, 'legacy');
  ck('retour au mode ancien accepté (retour arrière + journal + resynchronisation)', r.ok === true && r.mode === 'legacy', jstr(r).slice(0, 400));
  ck('API : get_doc_mode(a) = legacy', (await rpc(A.tok, 'get_doc_mode')).body === 'legacy');
  const invA = await getUD(A.tok, A.id, 'invoices'), ids = new Set(invA.map((e) => e.id));
  ck('toutes les factures du nouveau chemin sont dans user_data.invoices (i1, d1, d2, n1, par0…par7) ; les x* supprimés/édités cohérents', ['i1', 'd1', 'd2', 'n1'].concat(Array.from({ length: NB }, (_, i) => 'par' + i)).every((x) => ids.has(x)), [...ids].join(','));
  const gone = nDocs.filter((id) => !ids.has(id));
  ck('aucun document du nouveau stockage n\'est absent de l\'ancien (0 perdu)', gone.length === 0, gone.join(','));
  ck('n1 : dernière version (gagnant du conflit) reprise', ['appareil 1', 'appareil 2'].includes(invA.find((e) => e.id === 'n1').clientName));
  ck('i1 : payée 70 (paiements rejoués une seule fois)', Number(invA.find((e) => e.id === 'i1').paidAmount) === 70);
  const pays = await getUD(A.tok, A.id, 'payments');
  ck('paiements : 6 présents (p-replay + 5 distincts), sans doublon', pays && pays.length === 6 && new Set(pays.map((p) => p.id)).size === 6, jstr(pays && pays.map((p) => p.id)));
  const lg2 = await getUD(A.tok, A.id, 'docLog');
  ck('journal : 1 entrée d\'origine + 3 du nouveau chemin = 4 dans docLog', lg2 && lg2.length === 4, lg2 && lg2.length);
  ck('l\'état précédent de l\'ancien tableau est conservé dans _mig_source_backup', !!(await q1("SELECT 1 x FROM public._mig_source_backup WHERE user_id=$1::uuid AND key='invoices' AND sha256=public.fp_sha($2::jsonb)", [us.a, hLegBefore])));
  ck('les nouvelles tables sont conservées (rien supprimé)', (await q1('SELECT count(*)::int n FROM public.documents WHERE user_id=$1::uuid', [us.a])).n >= nDocs.length);
  const lb = [await rpc(A.tok, 'upsert_document', { p_doc: { id: 'zz', type: 'invoice', number: 'BRO-ZZZZZZ', status: 'draft' }, p_expected_version: 0, p_op_id: 'back1' }), await rpc(A.tok, 'record_payment', { p_invoice_id: 'i1', p_payment: { id: 'zz', amount: 1 } })];
  ck('après retour : nouveau chemin de nouveau refusé', lb.every(denied));
  const legw = await put(A.tok, A.id, 'invoices', invA.map((e) => e.id === 'd1' ? { ...e, clientName: 'modifié sur ancien appareil' } : e).filter((e) => e.id !== 'n1'));
  ck('ancien appareil : modifie d1 et SUPPRIME le brouillon n1 (créé en mode documents) — accepté (mode legacy)', legw.status < 300, jstr(legw));
  r = await flip(us.a, 'documents', null, 0);
  ck('re-bascule : la suppression de n1 sur l\'ancien appareil est SIGNALÉE (ARBITRAGE_REQUIS), liste = [n1] ; rien n\'est supprimé en silence', r.reason === 'ARBITRAGE_REQUIS' && r.drafts.length === 1 && r.drafts[0].id === 'n1' && (await q1("SELECT count(*)::int n FROM public.documents WHERE user_id=$1::uuid AND id='n1'", [us.a])).n === 1, jstr(r).slice(0, 300));
  ck('re-bascule : la modification de d1 faite sur l\'ancien appareil a été rattrapée sans faux conflit', (await q1("SELECT body->>'clientName' c FROM public.documents WHERE user_id=$1::uuid AND id='d1'", [us.a])).c === 'modifié sur ancien appareil' && (await q1("SELECT count(*)::int n FROM public._mig_conflicts WHERE user_id=$1::uuid AND kind='document'", [us.a])).n === 0);
  r = await flip(us.a, 'documents', 'keep', 0);
  ck('décision « keep » : bascule faite, n1 conservé, décision notée', r.ok === true && (await q1("SELECT count(*)::int n FROM public._mig_conflicts WHERE user_id=$1::uuid AND kind='brouillon_supprime_ancien_appareil' AND legacy->>'decision'='keep'", [us.a])).n === 1, jstr(r).slice(0, 300));
  ck('aucune donnée dupliquée après l\'aller-retour (paiements 6, journal 4, pas de doublon de documents)', (await q1('SELECT count(*)::int n FROM public.doc_payments WHERE user_id=$1::uuid', [us.a])).n === 6 && (await q1('SELECT count(*)::int n FROM public.doc_history WHERE user_id=$1::uuid', [us.a])).n === 4
    && (await q1('SELECT count(*)::int n FROM (SELECT id, doc_type FROM public.documents WHERE user_id=$1::uuid GROUP BY 1,2 HAVING count(*)>1) z', [us.a])).n === 0);
  await checkForeign(c, 'après l\'aller-retour');

  // ---------- brouillon supprimé sur un ancien appareil (avant bascule) : comptes c et d ----------
  out('\n### 13. Brouillon supprimé sur un ancien appareil avant la bascule (comptes c et d)');
  const C = await login('c'), D = await login('d');
  for (const k of ['c', 'd']) { const m = (await q1('SELECT public.fp_mig_run($1::uuid, true) r', [us[k]])).r; ck(`${k} : copie préalable appliquée (fp_mig_run)`, m.status === 'applied', jstr(m).slice(0, 200)); }
  for (const S of [C, D]) { const inv = await getUD(S.tok, S.id, 'invoices'); const w = await put(S.tok, S.id, 'invoices', inv.filter((e) => e.id !== 'd1')); ck(`${S.k} : d1 supprimé sur l'ancien appareil (API)`, w.status < 300, jstr(w)); }
  r = await flip(us.c, 'documents', null, 0);
  ck('c : bascule ARRÊTÉE (ARBITRAGE_REQUIS) avec d1 listé, mode inchangé, d1 toujours présent dans documents', r.reason === 'ARBITRAGE_REQUIS' && r.drafts[0].id === 'd1' && (await rpc(C.tok, 'get_doc_mode')).body === 'legacy' && (await q1("SELECT count(*)::int n FROM public.documents WHERE user_id=$1::uuid AND id='d1'", [us.c])).n === 1, jstr(r).slice(0, 300));
  r = await flip(us.c, 'documents', null, 0); ck('c : 2e essai sans décision : toujours arrêté (arbitrage recalculé)', r.reason === 'ARBITRAGE_REQUIS');
  r = await flip(us.c, 'documents', 'keep', 0); ck('c : décision « keep » → bascule faite, d1 conservé', r.ok === true && (await q1("SELECT count(*)::int n FROM public.documents WHERE user_id=$1::uuid AND id='d1'", [us.c])).n === 1, jstr(r).slice(0, 200));
  r = await flip(us.d, 'documents', 'delete', 0);
  ck('d : décision « delete » → bascule faite, d1 supprimé avec pierre tombale, autres documents intacts', r.ok === true && (await q1("SELECT count(*)::int n FROM public.documents WHERE user_id=$1::uuid AND id='d1'", [us.d])).n === 0
    && (await q1("SELECT count(*)::int n FROM public.doc_deleted WHERE user_id=$1::uuid AND id='d1'", [us.d])).n === 1 && (await q1('SELECT count(*)::int n FROM public.documents WHERE user_id=$1::uuid', [us.d])).n === 2, jstr(r).slice(0, 200));
  ck('décisions notées dans _mig_conflicts (keep pour c, delete pour d)', (await q1("SELECT count(*)::int n FROM public._mig_conflicts WHERE kind='brouillon_supprime_ancien_appareil' AND user_id::text = ANY($1)", [[us.c, us.d]])).n === 2);
  ck('c et d (documents) : écriture ancien chemin refusée (API)', denied(await put(C.tok, C.id, 'invoices', [])) && denied(await put(D.tok, D.id, 'docLog', [])));
  await checkForeign(c, 'après les arbitrages');

  // ---------- concurrence réelle : bascules pendant des écritures ----------
  out('\n### 14. Concurrence réelle sur Supabase : bascules pendant des écritures');
  const flipRetry = async (uid, mode) => { for (let i = 0; i < 6; i++) { const x = await flip(uid, mode); if (!x.error || !/deadlock/i.test(x.error)) return x; } return { error: 'trop de blocages' }; };
  const W = 24;
  // x : legacy → documents pendant des écritures concurrentes d'un ancien appareil. Chaque écrivain garde UNE connexion (limite du pooleur) ; SQLSTATE et message de chaque erreur sont enregistrés.
  const INFRA_RE = /max clients|pool|too many|terminat|timeout|timed out|ECONN|EMAXCONN|connection|reset|socket/i;
  const classify = (e) => {
    if (e.code === '42501' && /MODE_NOUVEAU_STOCKAGE/.test(e.message)) return 'refus_attendu';
    if (e.code === '40P01' || e.code === '40001') return 'sql_rejouable';
    if (['53300', '08006', '08003', '08001', '57P01', '57P03', '08000'].includes(e.code) || INFRA_RE.test(e.message || '')) return 'infrastructure';
    return 'inattendu';
  };
  const raceX = async (level, writers) => {
    const { connect } = require('./preprod-db');
    const conns = [], recs = [];
    let stop = false;
    try {
      for (let i = 0; i < writers; i++) conns.push((await connect()).client);
      const run = conns.map(async (cl, w) => {
        for (let s = 0; s < 60 && !stop; s++) {
          const id = `L${level}w${w}s${s}`;
          try {
            await cl.query('BEGIN'); await cl.query('SET LOCAL ROLE authenticated');
            await cl.query("SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)", [us.x, jstr({ sub: us.x, role: 'authenticated' })]);
            await cl.query("UPDATE public.user_data SET value = value || $1::jsonb WHERE user_id=$2::uuid AND key='invoices'", [jstr([{ id, type: 'invoice', number: 'BRO-' + id.toUpperCase(), status: 'draft', totalTTC: s }]), us.x]);
            await cl.query('COMMIT'); recs.push({ id, ok: true });
          } catch (e) { await cl.query('ROLLBACK').catch(() => {}); recs.push({ id, ok: false, code: e.code || '', message: String(e.message).slice(0, 160), kind: classify({ code: e.code, message: String(e.message) }) }); }
          await sleep(15);
        }
      });
      await sleep(500);
      const f = await flipRetry(us.x, 'documents');
      await sleep(400); stop = true; await Promise.all(run);
      return { recs, flip: f, opened: conns.length };
    } catch (e) { stop = true; return { recs, flip: null, opened: conns.length, setupError: `${e.code || ''} ${String(e.message).slice(0, 160)}` }; }
    finally { for (const cl of conns) await cl.end().catch(() => {}); }
  };
  for (const [level, writers] of [[1, 2], [2, 4], [3, 8]]) {
    const R = await raceX(level, writers);
    const acc = R.recs.filter((z) => z.ok), ref = R.recs.filter((z) => !z.ok);
    const dist = {}; for (const z of ref) { const k = `${z.kind} ${z.code} ${z.message.replace(/\s+/g, ' ').slice(0, 90)}`; dist[k] = (dist[k] || 0) + 1; }
    out(`- (palier ${level}, ${writers} écrivains, connexions ouvertes ${R.opened}) acceptées ${acc.length}, refusées ${ref.length}. Détail des refus (type SQLSTATE message) : ${Object.entries(dist).map(([k, n]) => n + '× ' + k).join(' ; ') || 'aucun'}`);
    if (R.setupError) { ck(`x palier ${level} : connexions parallèles ouvertes (infrastructure)`, false, R.setupError); break; }
    const inD = new Set((await q('SELECT id FROM public.documents WHERE user_id=$1::uuid', [us.x])).map((z) => z.id));
    const lost = acc.filter((z) => !inD.has(z.id)).map((z) => z.id);
    const bad = ref.filter((z) => z.kind === 'infrastructure' || z.kind === 'inattendu');
    ck(`x palier ${level} (${writers} écrivains) : bascule legacy → documents ${R.flip && R.flip.ok ? 'faite' : 'NON faite ' + jstr(R.flip).slice(0, 150)} ; ${acc.length} écritures acceptées, toutes retrouvées dans documents (${lost.length} perdue)`, R.flip && R.flip.ok === true && acc.length > 0 && lost.length === 0, `perdues: ${lost.slice(0, 5).join(',')}`);
    ck(`x palier ${level} : refus tous explicites et attendus (42501 MODE_NOUVEAU_STOCKAGE) — ${ref.length} refus ; erreurs d'infrastructure ou inattendues : ${bad.length}`, ref.length > 0 && bad.length === 0, bad.slice(0, 3).map((z) => z.kind + ' ' + z.code + ' ' + z.message).join(' | '));
    const back = await flipRetry(us.x, 'legacy');
    const inL = new Set(((await q1("SELECT value v FROM public.user_data WHERE user_id=$1::uuid AND key='invoices'", [us.x])).v || []).map((e) => e.id));
    const lost2 = acc.filter((z) => !inL.has(z.id)).map((z) => z.id);
    ck(`x palier ${level} : retour vers legacy fait, les ${acc.length} écritures acceptées sont dans user_data.invoices (${lost2.length} perdue)`, back.ok === true && lost2.length === 0, jstr(back).slice(0, 150) + ' ' + lost2.slice(0, 5).join(','));
    if (bad.length || lost.length || lost2.length || !(R.flip && R.flip.ok)) break;   // arrêt : ne pas augmenter la charge sur un échec
  }
  r = await flipRetry(us.x, 'documents'); ck('x : état final en documents (aucun écrivain)', r.ok === true || r.unchanged === true, jstr(r).slice(0, 150));
  // y : documents → legacy, pendant 24 upsert_document par l'API réelle
  const Y_ = await login('y');
  r = await flip(us.y, 'documents'); ck('y : bascule initiale vers documents', r.ok === true, jstr(r).slice(0, 200));
  const dw = Promise.allSettled(Array.from({ length: W }, async (_, i) => { await sleep(i * 40); const x = await rpc(Y_.tok, 'upsert_document', { p_doc: { id: 'n' + i, type: 'invoice', number: 'BRO-N' + i, status: 'draft', totalTTC: i }, p_expected_version: 0, p_op_id: 'yw' + i }); if (x.status !== 200) throw Object.assign(new Error(jstr(x.body)), { st: x.status }); return x.body; }));
  await sleep(450);
  const fy = await flipRetry(us.y, 'legacy'); const wy = await dw;
  const okN = wy.map((x, i) => ({ x, i })).filter((z) => z.x.status === 'fulfilled' && z.x.value.ok).map((z) => 'n' + z.i), refN = wy.filter((x) => x.status === 'rejected');
  const inL = new Set(((await q1("SELECT value v FROM public.user_data WHERE user_id=$1::uuid AND key='invoices'", [us.y])).v || []).map((e) => e.id));
  const lost2 = okN.filter((id) => !inL.has(id));
  ck(`y : documents → legacy pendant ${W} écritures (API) : ${okN.length} acceptées avant le verrou, ${refN.length} refusées après ; retour ${fy.ok ? 'fait' : 'arrêté'}`, fy.ok === true && lost2.length === 0 && okN.length > 0 && refN.length > 0, `perdues: ${lost2.join(',')} ${jstr(fy).slice(0, 200)}`);
  { const d = {}; for (const z of refN) { const k = (z.reason.st || '') + ' ' + z.reason.message.replace(/\s+/g, ' ').slice(0, 110); d[k] = (d[k] || 0) + 1; } out('- (y) détail des refus : ' + (Object.entries(d).map(([k, n]) => n + '× ' + k).join(' ; ') || 'aucun')); }
  ck('y : écritures refusées = MODE_ANCIEN_STOCKAGE (ou interblocage rejouable) ; 0 acceptée perdue', refN.every((z) => /MODE_ANCIEN_STOCKAGE|deadlock/i.test(z.reason.message)) && lost2.length === 0, refN.map((z) => z.reason.message.slice(0, 60)).join('|').slice(0, 300));
  const dd = await Promise.all([flip(us.b, 'documents'), flip(us.b, 'documents'), flip(us.b, 'documents')]);
  ck('b : 3 bascules simultanées : une seule effective (les autres : unchanged ou en attente), pas de doublon', dd.filter((x) => x.ok && !x.unchanged).length === 1 && dd.every((x) => x.ok) && (await q1('SELECT count(*)::int n FROM public.documents WHERE user_id=$1::uuid', [us.b])).n === 3, jstr(dd).slice(0, 300));
  for (const k of ['a', 'b', 'c', 'd', 'x', 'y']) {
    const v = (await q1('SELECT public.fp_mig_verify($1::uuid) v', [us[k]])).v;
    out(`- vérification ${k} : ${v.ok ? 'aucun écart' : 'écarts signalés : ' + jstr(v.mismatches).slice(0, 200)}`);
  }
  // mode final de chaque compte et état des tables
  const modes = await q('SELECT u.email, m.mode FROM public.doc_store_mode m JOIN auth.users u ON u.id=m.user_id WHERE u.email = ANY($1) ORDER BY 1', [EMAILS]);
  out('| Compte de test | Mode final |\n|---|---|\n' + modes.map((m) => `| ${m.email.replace('@facturapro-test.invalid', '').replace('@facturapro-ordinary.invalid', ' (ordinaire)')} | ${m.mode} |`).join('\n'));
  ck('aucun compte ordinaire ni non autorisé en mode documents', !modes.some((m) => /ordinary|mode-e@/.test(m.email) && m.mode === 'documents'));
  ck('aucune ligne de test hors des 8 comptes dans les tables du nouveau stockage', (await q1(`SELECT (SELECT count(*) FROM public.documents WHERE NOT (user_id::text = ANY($1)))::int + (SELECT count(*) FROM public.doc_store_mode WHERE NOT (user_id::text = ANY($1)))::int
     + (SELECT count(*) FROM public.doc_store_testers WHERE NOT (user_id::text = ANY($1)))::int n`, [Object.values(us)])).n === 0);
  await checkForeign(c, 'fin des tests');
  await c.end();
}
const FN = (n) => `FAC-${Y}-${String(n).padStart(3, '0')}`;

// ---------- 5. nettoyage ----------
async function cleanup() {
  const c = await db();
  out('### 15. État final des données de test, puis nettoyage (comptes de cette opération uniquement)');
  const us = await uidsOf(c), uids = us.map((x) => x.id);
  const st = await c.query(`SELECT u.email, (SELECT mode FROM public.doc_store_mode m WHERE m.user_id=u.id) mode, (SELECT count(*) FROM public.documents d WHERE d.user_id=u.id)::int docs, (SELECT count(*) FROM public.doc_payments d WHERE d.user_id=u.id)::int pays,
      (SELECT count(*) FROM public.doc_history d WHERE d.user_id=u.id)::int hist, (SELECT count(*) FROM public.user_data d WHERE d.user_id=u.id)::int ud FROM auth.users u WHERE u.id::text = ANY($1) ORDER BY 1`, [uids]);
  out('| Compte | mode | documents | paiements | journal | lignes user_data |\n|---|---|---|---|---|---|\n' + st.rows.map((r) => `| ${r.email.split('@')[0]} | ${r.mode || 'legacy'} | ${r.docs} | ${r.pays} | ${r.hist} | ${r.ud} |`).join('\n'));
  const strange = await c.query(`SELECT (SELECT count(*) FROM public.documents WHERE NOT (user_id::text = ANY($1)))::int d, (SELECT count(*) FROM public.doc_payments WHERE NOT (user_id::text = ANY($1)))::int p,
      (SELECT count(*) FROM public.doc_history WHERE NOT (user_id::text = ANY($1)))::int h, (SELECT count(*) FROM public.doc_store_mode WHERE NOT (user_id::text = ANY($1)))::int m, (SELECT count(*) FROM public.doc_store_testers WHERE NOT (user_id::text = ANY($1)))::int t,
      (SELECT count(*) FROM public._mig_source_backup WHERE NOT (user_id::text = ANY($1)))::int b, (SELECT count(*) FROM public._mig_conflicts WHERE NOT (user_id::text = ANY($1)))::int cf`, [uids]);
  ck('les tables du nouveau stockage ne contiennent AUCUNE ligne étrangère aux comptes de test', Object.values(strange.rows[0]).every((v) => v === 0), jstr(strange.rows[0]));
  await checkForeign(c, 'avant nettoyage');
  const baseRuns = Number((await c.query("SELECT sha256 FROM public._fp_rehearsal WHERE name='mode_mig_runs'")).rows[0].sha256);
  const runs = (await c.query('SELECT count(*)::int n FROM public._mig_runs')).rows[0].n;
  out(`- _mig_runs : ${runs} ligne(s) (référence avant l'opération : ${baseRuns}).`);
  ck('_mig_runs ne contenait aucune ligne avant l\'opération : toutes les lignes actuelles sont celles de cette opération', baseRuns === 0);
  if (baseRuns !== 0) { await c.end(); return; }
  await c.query('BEGIN');
  await c.query('DELETE FROM public._mig_source_backup WHERE user_id::text = ANY($1)', [uids]);
  await c.query('DELETE FROM public._mig_conflicts WHERE user_id::text = ANY($1)', [uids]);
  await c.query('DELETE FROM public.code_attempts WHERE user_id::text = ANY($1)', [uids]);   // pas de clé étrangère : à supprimer explicitement
  await c.query("DELETE FROM public.admin_codes WHERE code LIKE 'MODE-TEST-%'");
  await c.query('DELETE FROM public._mig_runs');
  const del = await c.query('DELETE FROM auth.users WHERE id::text = ANY($1) AND email = ANY($2)', [uids, EMAILS]);
  await c.query('COMMIT');
  ck(`${del.rowCount} compte(s) de test supprimé(s) (et eux seuls, par e-mail exact)`, del.rowCount === us.length);
  const left = await c.query(`SELECT (SELECT count(*) FROM auth.users WHERE email = ANY($1))::int u, (SELECT count(*) FROM public.documents)::int d, (SELECT count(*) FROM public.doc_payments)::int p, (SELECT count(*) FROM public.doc_history)::int h,
      (SELECT count(*) FROM public.doc_deleted)::int g, (SELECT count(*) FROM public.doc_store_mode)::int m, (SELECT count(*) FROM public.doc_store_testers)::int t, (SELECT count(*) FROM public._mig_source_backup)::int b,
      (SELECT count(*) FROM public._mig_conflicts)::int cf, (SELECT count(*) FROM public.user_data WHERE user_id NOT IN (SELECT id FROM auth.users))::int orphan_ud,
      (SELECT count(*) FROM public.doc_counters WHERE user_id NOT IN (SELECT id FROM auth.users))::int orphan_dc, (SELECT count(*) FROM public.licenses WHERE user_id NOT IN (SELECT id FROM auth.users))::int orphan_lic,
      (SELECT count(*) FROM public.code_attempts WHERE user_id NOT IN (SELECT id FROM auth.users))::int orphan_att, (SELECT count(*) FROM public.admin_codes WHERE code LIKE 'MODE-TEST-%')::int test_codes`, [EMAILS]);
  ck('plus aucun compte de test ni ligne résiduelle ou orpheline (documents, paiements, journal, tombes, modes, liste, sauvegardes, conflits, user_data, compteurs, licences)', Object.values(left.rows[0]).every((v) => v === 0), jstr(left.rows[0]));
  await checkForeign(c, 'après nettoyage');
  const sha17 = (await c.query("SELECT sha256 FROM public._fp_rehearsal WHERE name='install:17_mode_stockage.sql'")).rows[0];
  ck('statut du script : sql/17 reste installé en préproduction (empreinte enregistrée = fichier du dépôt), tous les comptes en legacy (aucune ligne doc_store_mode)', sha17 && sha17.sha256 === sha(fs.readFileSync(SQL17, 'utf8')));
  out(`- Comptes restants dans la préproduction : ${(await c.query('SELECT count(*)::int n FROM auth.users')).rows[0].n}.`);
  await c.end();
}

const CMDS = { guardtests, baseline, install, test, cleanup };
(async () => {
  const cmd = process.argv[2];
  if (!CMDS[cmd]) { console.error('Commande : ' + Object.keys(CMDS).join(' | ')); process.exit(2); }
  out(`## Installation/validation de sql/17 — commande « ${cmd} » — ${new Date().toISOString()}`);
  try { await CMDS[cmd](); } catch (e) { ck('exécution sans erreur', false, String(e.message).replace(/postgres(ql)?:\/\/\S+/gi, 'postgres://***')); }
  const bad = res.filter((x) => !x).length;
  out(`\n**Bilan « ${cmd} » : ${res.length - bad}/${res.length} contrôles réussis.**`);
  if (process.env.REPORT_PATH) { fs.mkdirSync(path.dirname(process.env.REPORT_PATH), { recursive: true }); fs.appendFileSync(process.env.REPORT_PATH, lines.join('\n') + '\n'); }
  process.exit(bad ? 1 : 0);
})();
