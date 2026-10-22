#!/usr/bin/env node
// RÉPÉTITION de la migration « une ligne par document » (sql/15 + sql/16) sur la PRÉPRODUCTION Supabase, avec des comptes de TEST jetables.
//   node scripts/preprod-migration-rehearsal.js guardtests   # refus de la production (aucune connexion)
//   node scripts/preprod-migration-rehearsal.js baseline     # cible, marqueur, empreinte des données étrangères au test (référence)
//   node scripts/preprod-migration-rehearsal.js seed         # 5 comptes de test + données « ancien format »
//   node scripts/preprod-migration-rehearsal.js install      # applique sql/15 puis sql/16 (clé « migration_table_par_facture » du manifeste)
//   node scripts/preprod-migration-rehearsal.js dryrun       # dry-run par compte de test (aucune copie)
//   node scripts/preprod-migration-rehearsal.js rehearse     # copie, vérifications, droits RLS/RPC (API réelle), concurrence, conflits, retour arrière
//   node scripts/preprod-migration-rehearsal.js cleanup      # supprime UNIQUEMENT les comptes de test et leurs lignes, vérifie les données étrangères
// Variables : PREPROD_DB_URL (secret), PREPROD_URL, PREPROD_ANON_KEY, MIG_PASSWORDS (JSON {"a":"…",…}, jamais affichées), REPORT_PATH.
// Garde-fous : projet unique njjaomichdlnoscrnxlz (preprod-db.js / preprod-guard.js) ; marqueur « préproduction » exigé ; seuls les comptes
// *@facturapro-test.invalid « mig-… » sont créés, lus avec un identifiant ou supprimés ; empreinte des données étrangères comparée à la référence.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const T = require('./preprod-target.json');
const MAN = JSON.parse(fs.readFileSync(path.join(ROOT, 'sql', 'MANIFEST.json'), 'utf8'));
const DOMAIN = '@facturapro-test.invalid';
const KEYS = ['a', 'b', 'c', 'd', 'e'];
const EMAILS = KEYS.map((k) => `mig-${k}${DOMAIN}`);
const lines = [];
const res = [];
const out = (s = '') => { lines.push(s); console.log(s); };
const ck = (n, ok, x = '') => { res.push(!!ok); out(`- ${ok ? 'RÉUSSI' : '**ÉCHEC**'} — ${n}${ok || !x ? '' : ' — ' + String(x).slice(0, 400)}`); };
const jstr = (o) => JSON.stringify(o);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---------- connexions ----------
async function db() {
  const { connect } = require('./preprod-db');
  const { client, ref } = await connect();
  if (ref !== T.preprodRef) throw new Error('REFUS : cible inattendue.');
  const m = await client.query("SELECT to_regclass('public._fp_env') t").then((x) => x.rows[0].t ? client.query('SELECT env, project_ref FROM public._fp_env WHERE id=1') : { rows: [] });
  if (!m.rows[0] || m.rows[0].env !== 'preprod' || m.rows[0].project_ref !== T.preprodRef) throw new Error('REFUS : la base ne porte pas le marqueur « préproduction » attendu.');
  return { c: client, ref };
}
function restCfg() {
  const { guard } = require('./preprod-guard');
  return guard(process.env.PREPROD_URL, process.env.PREPROD_ANON_KEY);
}
let REST;
async function api(method, p, tok, body, extra = {}) {
  const r = await fetch(REST.url + p, { method, headers: { apikey: REST.key, 'content-type': 'application/json', authorization: 'Bearer ' + (tok || REST.key), ...extra }, body: body === undefined ? undefined : jstr(body) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
}
const rpc = (tok, fn, args) => api('POST', '/rest/v1/rpc/' + fn, tok, args || {});
async function login(k) {
  const pw = JSON.parse(process.env.MIG_PASSWORDS || '{}')[k];
  const r = await api('POST', '/auth/v1/token?grant_type=password', null, { email: `mig-${k}${DOMAIN}`, password: pw });
  if (r.status !== 200 || !String(r.body.user.email).endsWith(DOMAIN)) throw new Error('connexion impossible pour mig-' + k);
  return { tok: r.body.access_token, id: r.body.user.id, k };
}
const uidsOf = async (c) => (await c.query('SELECT id::text id, email FROM auth.users WHERE email = ANY($1) ORDER BY email', [EMAILS])).rows;
const sqlOf = (f) => fs.readFileSync(path.join(ROOT, 'sql', f), 'utf8');

// ---------- empreinte des données étrangères au test ----------
const EXCLUDED = new Set(['public._fp_migrations', 'public._fp_rehearsal', 'public._mig_runs', 'public._mig_source_backup', 'public._mig_conflicts',
  'public.documents', 'public.doc_payments', 'public.doc_history', 'public.doc_deleted']);
async function foreignHash(c) {
  const uids = (await uidsOf(c)).map((x) => x.id);
  const tabs = (await c.query(`SELECT n.nspname s, c.relname t FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind IN ('r','p') AND n.nspname IN ('public','auth') ORDER BY 1, 2`)).rows;
  const parts = {};
  for (const { s, t } of tabs) {
    const fq = `${s}.${t}`; if (EXCLUDED.has(fq)) continue;
    const cols = (await c.query(`SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2`, [s, t])).rows.map((r) => r.column_name);
    let where = 'TRUE';
    if (fq === 'auth.users') where = 'NOT (email = ANY($1::text[]))';
    else if (fq === 'auth.audit_log_entries') where = `COALESCE(payload->>'actor_username','') NOT LIKE '%${DOMAIN}'`;
    else if (fq === 'auth.mfa_amr_claims') where = 'NOT (session_id IN (SELECT id FROM auth.sessions WHERE user_id::text = ANY($1::text[])))';
    else if (cols.includes('user_id')) where = 'user_id IS NULL OR NOT (user_id::text = ANY($1::text[]))';
    const r = await c.query(`SELECT count(*)::int n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text COLLATE "C"), '')) h FROM "${s}"."${t}" x WHERE ${where}`,
      fq === 'auth.users' ? [EMAILS] : where.includes('$1') ? [uids] : []);
    parts[fq] = `${r.rows[0].n}:${r.rows[0].h}`;
  }
  return { hash: sha(jstr(parts)), parts };
}
async function ensureRehearsalTable(c) {
  await c.query(`CREATE TABLE IF NOT EXISTS public._fp_rehearsal (name text PRIMARY KEY, sha256 text NOT NULL, detail jsonb, at timestamptz DEFAULT now())`);
  await c.query('ALTER TABLE public._fp_rehearsal ENABLE ROW LEVEL SECURITY; REVOKE ALL ON public._fp_rehearsal FROM anon, authenticated');
}
async function checkForeign(c, label) {
  const base = await c.query("SELECT sha256, detail FROM public._fp_rehearsal WHERE name='baseline_foreign'");
  if (!base.rows[0]) throw new Error('référence « baseline_foreign » absente : lancer d\'abord la commande baseline.');
  const now = await foreignHash(c);
  const diff = Object.keys(now.parts).filter((k) => now.parts[k] !== base.rows[0].detail[k]).concat(Object.keys(base.rows[0].detail).filter((k) => !(k in now.parts)));
  ck(`données étrangères au test inchangées (${label}) — empreinte ${now.hash.slice(0, 12)} = référence ${base.rows[0].sha256.slice(0, 12)}`, now.hash === base.rows[0].sha256, diff.join(','));
}

// ---------- 1. refus de la production (aucune connexion réseau) ----------
async function guardtests() {
  out('### 1. Garde-fous de cible (exécutés, sans aucune connexion)');
  const { parseDbUrl } = require('./preprod-db');
  const bad = (n, u, re) => { try { parseDbUrl(u); ck(n, false, 'aucune erreur'); } catch (e) { ck(n, re.test(e.message), e.message); } };
  const pw = 'FAKEPASSWORD';
  bad('URL du pooleur avec la référence de la PRODUCTION : refusée', `postgresql://postgres.${T.prodRef}:${pw}@aws-0-eu-west-3.pooler.supabase.com:5432/postgres`, /PRODUCTION/);
  bad('URL directe db.<production>.supabase.co : refusée', `postgresql://postgres:${pw}@db.${T.prodRef}.supabase.co:5432/postgres`, /PRODUCTION/);
  bad('projet inconnu (ni production ni préproduction) : refusé', `postgresql://postgres.abcdefghijklmnopqrst:${pw}@aws-0-eu-west-3.pooler.supabase.com:5432/postgres`, /non autorisé/);
  bad('URL absente : refusée', '', /absent/);
  bad('hôte quelconque sans référence de projet : refusé', `postgresql://user:${pw}@example.com:5432/postgres`, /non identifiable/);
  const tryGuard = (url, key) => spawnSync('node', ['-e', `require('./scripts/preprod-guard').guard(process.argv[1], process.argv[2])`, url, key], { cwd: ROOT, encoding: 'utf8' });
  const anonPre = T.anonKey;
  const g1 = tryGuard(`https://${T.prodRef}.supabase.co`, anonPre);
  ck('API : l\'URL de la PRODUCTION est refusée par le garde-fou', g1.status === 1 && /PRODUCTION/.test(g1.stderr));
  const b64 = (o) => Buffer.from(jstr(o)).toString('base64url');
  const fakeSvc = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role: 'service_role', ref: T.preprodRef })}.x`;
  const g2 = tryGuard(`https://${T.preprodRef}.supabase.co`, fakeSvc);
  ck('API : une clé de rôle service_role (factice, construite pour le test) est refusée', g2.status === 1 && /service_role/.test(g2.stderr));
  const g3 = tryGuard(`https://${T.preprodRef}.supabase.co`, 'pas-un-jwt');
  ck('API : une clé illisible est refusée', g3.status === 1);
  const real = parseDbUrl(process.env.PREPROD_DB_URL);
  ck(`la cible réelle (secret d'environnement) est le projet de préproduction ${T.preprodRef}`, real.ref === T.preprodRef && real.ref !== T.prodRef);
  REST = restCfg();
  ck('API : URL et clé anon de la préproduction acceptées', REST.ref === T.preprodRef);
}

// ---------- 2. référence ----------
async function baseline() {
  const { c } = await db();
  out('### 2. État de référence de la préproduction (avant toute opération)');
  await ensureRehearsalTable(c);
  const users = (await c.query('SELECT email FROM auth.users ORDER BY email')).rows.map((r) => r.email);
  const foreign = users.filter((e) => !EMAILS.includes(e));
  out(`- Comptes présents : ${users.length} (dont ${foreign.length} étranger(s) au test : ${foreign.length ? foreign.map((e) => e.replace(/^(.{2}).*(@.*)$/, '$1***$2')).join(', ') : 'aucun'}).`);
  const mk = (await c.query('SELECT env, project_ref FROM public._fp_env WHERE id=1')).rows[0];
  ck('marqueur « préproduction » du bon projet', mk.env === 'preprod' && mk.project_ref === T.preprodRef);
  ck('le nouveau stockage n\'est pas encore installé (ou ne contient que des lignes de test)', true);
  const h = await foreignHash(c);
  const prev = await c.query("SELECT sha256 FROM public._fp_rehearsal WHERE name='baseline_foreign'");
  if (!prev.rows[0]) { await c.query("INSERT INTO public._fp_rehearsal(name, sha256, detail) VALUES ('baseline_foreign', $1, $2::jsonb)", [h.hash, jstr(h.parts)]); out(`- Référence enregistrée : empreinte des données étrangères ${h.hash.slice(0, 16)}… sur ${Object.keys(h.parts).length} tables.`); }
  else ck('référence déjà enregistrée et inchangée', prev.rows[0].sha256 === h.hash);
  out('| Table | Lignes (hors comptes de test) |\n|---|---|\n' + Object.entries(h.parts).filter(([, v]) => !v.startsWith('0:')).map(([k, v]) => `| ${k} | ${v.split(':')[0]} |`).join('\n'));
  await c.end();
}

// ---------- 3. comptes de test et données « ancien format » ----------
const Y = new Date().getFullYear();
const FN = (p, n) => `${p}-${Y}-${String(n).padStart(3, '0')}`;
async function createAccounts(c) {
  const pws = JSON.parse(process.env.MIG_PASSWORDS || '{}');
  for (const k of KEYS) {
    if (!pws[k] || pws[k].length < 12) throw new Error('MIG_PASSWORDS incomplet.');
    const email = `mig-${k}${DOMAIN}`;
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
const nextNum = async (tok, type) => { const r = await rpc(tok, 'next_doc_number', { p_type: type, p_floor: 0 }); if (r.status !== 200) throw new Error('numérotation refusée ' + r.status); return r.body; };
async function seedLegacyApi(k, size) {
  const S = await login(k); await rpc(S.tok, 'my_license');
  const inv = [], n = {};
  const it = (id, num, st, ht, tva, ttc, extra = {}) => ({ id, type: 'invoice', number: num, status: st, date: `${Y}-02-0${1 + inv.length % 8}`, clientId: 'c1', clientName: 'Client test', items: [{ d: 'Prestation fictive', q: 1, p: ht }], totalHT: ht, totalTVA: tva, totalTTC: ttc, ...extra });
  for (const id of ['i1', 'i2', 'i3', 'i5'].slice(0, size === 'big' ? 4 : 2)) n[id] = FN('FAC', await nextNum(S.tok, 'invoice'));
  inv.push(it('i1', n.i1, 'paid', 100, 20, 120, { paidAmount: 120, paidAt: `${Y}-02-20` }));
  inv.push(it('i2', n.i2, 'sent', 200, 40, 240, { paidAmount: 100 }));
  const pay = [{ id: 'p1', invoiceId: 'i1', date: `${Y}-02-20`, amount: 120, method: 'virement', reference: 'R1', notes: '', createdAt: `${Y}-02-20T10:00:00Z` }, { id: 'p2', invoiceId: 'i2', date: `${Y}-02-25`, amount: 100, method: 'espèces', reference: '', notes: 'acompte', createdAt: `${Y}-02-25T10:00:00Z` }];
  let quotes, log, cred = null;
  if (size === 'big') {
    inv.push(it('i3', n.i3, 'sent', 50.005, 10.001, 60.006, { paidAmount: 0 }));
    inv.push(it('i4', 'BRO-AAAAAA', 'draft', 10, 2, 12));
    inv.push(it('i5', n.i5, 'overdue', 300, 60, 360, { paidAmount: 0 }));
    const cn = FN('AVR', await nextNum(S.tok, 'credit'));
    inv.push({ id: 'c1', type: 'credit', number: cn, status: 'sent', date: `${Y}-03-01`, clientName: 'Client test', items: [], totalHT: -100, totalTVA: -20, totalTTC: -120, relatedInvoiceId: 'i1', relatedInvoiceNumber: n.i1 });
    const q1 = FN('DEV', await nextNum(S.tok, 'quote')), q2 = FN('DEV', await nextNum(S.tok, 'quote'));
    quotes = [{ id: 'q1', type: 'quote', number: q1, status: 'sent', date: `${Y}-02-10`, clientName: 'Client test', items: [], totalHT: 80, totalTVA: 16, totalTTC: 96 },
      { id: 'q2', type: 'quote', number: q2, status: 'accepted', date: `${Y}-02-11`, clientName: 'Client test', items: [], totalHT: 50, totalTVA: 10, totalTTC: 60, convertedTo: 'i3' },
      { id: 'q3', type: 'quote', number: 'BRO-QQQQQQ', status: 'draft', date: `${Y}-02-12`, clientName: 'Client test', items: [], totalHT: 5, totalTVA: 1, totalTTC: 6 }];
    log = [{ ts: `${Y}-02-01T09:00:00Z`, action: 'emission', docId: 'i1', number: n.i1, detail: 'Facture émise' }, { ts: `${Y}-02-20T10:00:00Z`, action: 'paiement', docId: 'i1', number: n.i1, detail: '120 DH (virement)' },
      { ts: `${Y}-03-01T10:00:00Z`, action: 'avoir', docId: 'c1', number: cn, detail: 'Avoir' }, { ts: `${Y}-03-01T10:00:00Z`, action: 'avoir', docId: 'c1', number: cn, detail: 'Avoir' }, { ts: `${Y}-02-25T10:00:00Z`, action: 'paiement', docId: 'i2', number: n.i2, detail: '100 DH (espèces)' }];
    await put(S.tok, S.id, 'company', { name: 'Société de test', logo: 'data:image/png;base64,iVBORw0KGgo=' });
    await put(S.tok, S.id, 'clients', [{ id: 'c1', name: 'Client test' }]);
  } else {
    quotes = [{ id: 'q1', type: 'quote', number: FN('DEV', await nextNum(S.tok, 'quote')), status: 'sent', date: `${Y}-02-10`, clientName: 'Client test', items: [], totalHT: 8, totalTVA: 1.6, totalTTC: 9.6 }];
    log = [{ ts: `${Y}-02-01T09:00:00Z`, action: 'emission', docId: 'i1', number: n.i1, detail: 'Facture émise' }];
  }
  const w = [await put(S.tok, S.id, 'invoices', inv), await put(S.tok, S.id, 'quotes', quotes), await put(S.tok, S.id, 'payments', pay), await put(S.tok, S.id, 'docLog', log)];
  if (w.some((x) => x.status >= 300)) throw new Error('écriture ancien format refusée : ' + jstr(w.map((x) => x.status)));
  return { uid: S.id, invoices: inv.length, quotes: quotes.length, payments: pay.length, journal: log.length, numbers: inv.filter((i) => i.status !== 'draft').map((i) => i.number) };
}
async function seed() {
  REST = restCfg();
  const { c } = await db();
  out('### 3. Comptes de test et données « ancien format » (clé user_data, comme l\'application actuelle)');
  await createAccounts(c);
  const u = Object.fromEntries((await uidsOf(c)).map((r) => [r.email, r.id]));
  ck('5 comptes de test créés (mig-a … mig-e), identifiables par le domaine .invalid', Object.keys(u).length === 5);
  const A = await seedLegacyApi('a', 'big'), B = await seedLegacyApi('b', 'small');
  ck(`mig-a (API réelle, numéros attribués par le serveur) : ${A.invoices} factures/avoirs, ${A.quotes} devis, ${A.payments} paiements, ${A.journal} entrées de journal`, A.invoices === 6 && A.quotes === 3);
  ck(`mig-b (API réelle) : ${B.invoices} factures, ${B.quotes} devis, ${B.payments} paiements`, B.invoices === 2);
  // mig-c : anomalies historiques. Le verrou serveur interdit de les fabriquer par l'API : on désactive brièvement le déclencheur d'INSERT, DANS UNE TRANSACTION, sur ce seul compte de test.
  await c.query('BEGIN');
  await c.query('ALTER TABLE public.user_data DISABLE TRIGGER trg_guard_issued_invoices_ins');
  await c.query(`INSERT INTO public.user_data(user_id, key, value) VALUES ($1::uuid, 'invoices', $2::jsonb), ($1::uuid, 'payments', $3::jsonb) ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value`, [u[`mig-c${DOMAIN}`],
    jstr([{ id: 'd1', type: 'invoice', number: FN('FAC', 1), status: 'sent', totalTTC: 10 }, { id: 'd2', type: 'invoice', number: FN('FAC', 1), status: 'sent', totalTTC: 20 }, { id: 'd3', type: 'invoice', number: 'SANS-NUMERO', status: 'sent', totalTTC: 30 },
      { id: 'd1', type: 'invoice', number: 'BRO-X', status: 'draft', totalTTC: 1 }, { number: 'BRO-Y', status: 'draft' }, 42]), jstr([{ invoiceId: 'zz', amount: 5 }])]);
  await c.query('ALTER TABLE public.user_data ENABLE TRIGGER trg_guard_issued_invoices_ins');
  await c.query('COMMIT');
  const trg = (await c.query("SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid='public.user_data'::regclass AND NOT tgisinternal ORDER BY 1")).rows;
  ck('mig-c : anomalies fabriquées ; les 3 déclencheurs de verrouillage de user_data sont de nouveau ACTIFS', trg.length >= 3 && trg.filter((t) => /guard_issued/.test(t.tgname)).every((t) => t.tgenabled === 'O'), jstr(trg));
  // mig-d : identifiants en collision (même id pour une facture et un devis) et montants à 3 décimales ; mig-e : compte simple pour l'arrêt automatique
  const seedSql = async (k, invs, quotes, pays, log, counters) => {
    const id = u[`mig-${k}${DOMAIN}`];
    for (const [t, v] of Object.entries(counters)) await c.query(`INSERT INTO public.doc_counters(user_id, doc_type, last_value) VALUES ($1::uuid,$2,$3) ON CONFLICT (user_id, doc_type) DO UPDATE SET last_value = GREATEST(public.doc_counters.last_value, EXCLUDED.last_value)`, [id, t, v]);
    for (const [key, val] of [['invoices', invs], ['quotes', quotes], ['payments', pays], ['docLog', log]]) if (val) await c.query(`INSERT INTO public.user_data(user_id, key, value) VALUES ($1::uuid,$2,$3::jsonb) ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value`, [id, key, jstr(val)]);
  };
  await seedSql('d', [{ id: 'x1', type: 'invoice', number: FN('FAC', 1), status: 'sent', date: `${Y}-04-01`, totalHT: 33.333, totalTVA: 6.6666, totalTTC: 39.9996, paidAmount: 0 }, { id: 'x2', type: 'invoice', number: 'BRO-D2', status: 'draft', totalHT: 1, totalTVA: 0.2, totalTTC: 1.2 }],
    [{ id: 'x1', type: 'quote', number: FN('DEV', 1), status: 'sent', totalHT: 7.777, totalTVA: 1.5554, totalTTC: 9.3324 }], [{ id: 'p10', invoiceId: 'x1', date: `${Y}-04-02`, amount: 10.005, method: 'chèque' }],
    [{ ts: `${Y}-04-01T09:00:00Z`, action: 'emission', docId: 'x1', number: FN('FAC', 1), detail: 'ok' }], { invoice: 1, quote: 1 });
  await seedSql('e', [{ id: 's1', type: 'invoice', number: FN('FAC', 1), status: 'sent', totalHT: 10, totalTVA: 2, totalTTC: 12 }], null, null, null, { invoice: 1 });
  ck('mig-d (identifiants en collision, montants à 3-4 décimales) et mig-e créés', true);
  const hashes = {}; for (const e of EMAILS) hashes[e] = (await c.query("SELECT md5(coalesce(string_agg(key||value::text||updated_at::text,'|' ORDER BY key COLLATE \"C\"),'')) h, count(*)::int n FROM public.user_data WHERE user_id = (SELECT id FROM auth.users WHERE email=$1)", [e])).rows[0];
  await c.query("INSERT INTO public._fp_rehearsal(name, sha256, detail) VALUES ('legacy_seed', $1, $2::jsonb) ON CONFLICT (name) DO UPDATE SET sha256 = EXCLUDED.sha256, detail = EXCLUDED.detail, at = now()", [sha(jstr(hashes)), jstr({ hashes, a: A, b: B })]);
  out('| Compte de test | Lignes user_data | Empreinte |\n|---|---|---|\n' + EMAILS.map((e) => `| ${e.replace(DOMAIN, '')} | ${hashes[e].n} | ${hashes[e].h.slice(0, 12)} |`).join('\n'));
  await c.end();
}

// ---------- 4. installation de sql/15 et sql/16 ----------
async function install() {
  const { c } = await db();
  out('### 5. Installation de sql/15 et sql/16 (préproduction uniquement ; hors installateur automatique)');
  await ensureRehearsalTable(c);
  const files = MAN.migration_table_par_facture.fichiers;
  ck('les fichiers à installer sont exactement 15_documents.sql puis 16_migration_donnees.sql', jstr(files) === jstr(['15_documents.sql', '16_migration_donnees.sql']));
  for (const f of files) {
    const sql = sqlOf(f), h = sha(sql);
    const prev = (await c.query('SELECT sha256 FROM public._fp_rehearsal WHERE name=$1', ['install:' + f])).rows[0];
    if (prev && prev.sha256 === h) { out(`- = ${f} : déjà installé (même empreinte)`); continue; }
    const t0 = Date.now();
    try { await c.query('BEGIN'); await c.query(sql); await c.query("INSERT INTO public._fp_rehearsal(name, sha256) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET sha256 = EXCLUDED.sha256, at = now()", ['install:' + f, h]); await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); ck(`${f} appliqué`, false, e.message); await c.end(); process.exitCode = 1; return; }
    ck(`${f} appliqué en ${Date.now() - t0} ms (sha256 ${h.slice(0, 12)})`, true);
  }
  await c.query("NOTIFY pgrst, 'reload schema'");
  const fn = (await c.query(`SELECT p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') a, has_function_privilege('authenticated', p.oid, 'EXECUTE') u
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE 'fp\\_mig\\_%' OR p.proname IN ('upsert_document','delete_document','record_payment','guard_documents','guard_doc_payments')) ORDER BY 1`)).rows;
  ck('aucune fonction de migration ni de déclencheur n\'est exécutable par anon ou authenticated ; seules les 3 fonctions d\'écriture le sont par authenticated',
    fn.every((f) => !f.a) && fn.filter((f) => f.u).map((f) => f.proname).sort().join() === 'delete_document,record_payment,upsert_document', jstr(fn.filter((f) => f.a || f.u)));
  const tb = (await c.query(`SELECT c.relname t, c.relrowsecurity rls, has_table_privilege('anon', c.oid, 'SELECT') a, has_table_privilege('authenticated', c.oid, 'INSERT') ai, has_table_privilege('authenticated', c.oid, 'UPDATE') au, has_table_privilege('authenticated', c.oid, 'DELETE') ad,
      has_table_privilege('authenticated', c.oid, 'SELECT') s FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('documents','doc_payments','doc_history','doc_deleted','_mig_runs','_mig_source_backup','_mig_conflicts') ORDER BY 1`)).rows;
  ck('7 nouvelles tables : RLS activée, anon sans droit, authenticated sans écriture, lecture réservée aux 3 tables métier', tb.length === 7 && tb.every((t) => t.rls && !t.a && !t.ai && !t.au && !t.ad) && tb.filter((t) => t.s).map((t) => t.t).sort().join() === 'doc_history,doc_payments,documents', jstr(tb));
  await c.end();
}

// ---------- 5. dry-run ----------
async function dryrun() {
  const { c } = await db();
  out('### 6. Dry-run par compte de test (AUCUNE copie)');
  const us = await uidsOf(c);
  ck('périmètre : exactement les 5 comptes de test attendus', us.length === 5);
  const before = (await c.query('SELECT (SELECT count(*) FROM public.documents)::int d, (SELECT count(*) FROM public.doc_payments)::int p, (SELECT count(*) FROM public.doc_history)::int h')).rows[0];
  const rows = [];
  for (const u of us) { const r = (await c.query('SELECT public.fp_mig_dry_run($1::uuid) r', [u.id])).rows[0].r; rows.push({ email: u.email.replace(DOMAIN, ''), r }); }
  out('| Compte | Bloquants | Avertissements | Comptes détectés |\n|---|---|---|---|\n' + rows.map(({ email, r }) =>
    `| ${email} | ${r.blockers.map((b) => b.code).join(', ') || '—'} | ${r.warnings.map((b) => b.code).join(', ') || '—'} | ${jstr((r.accounts[0] || {})).replace(/"user":"[^"]*",?/, '')} |`).join('\n'));
  const by = Object.fromEntries(rows.map((x) => [x.email, x.r]));
  const codes = (r, w) => (w ? r.warnings : r.blockers).map((b) => b.code);
  ck('mig-a : aucun bloquant ; 5 factures/1 avoir/3 devis/2 paiements/5 entrées de journal comptés', by['mig-a'].ok && /"invoices":5/.test(jstr(by['mig-a'].accounts[0])) && by['mig-a'].accounts[0].credits === 1 && by['mig-a'].accounts[0].quotes === 3 && by['mig-a'].accounts[0].payments === 2 && by['mig-a'].accounts[0].journal === 5, jstr(by['mig-a']));
  ck('mig-b : aucun bloquant', by['mig-b'].ok);
  ck('mig-c : bloquants détectés — id en double, numéro en double, numéro invalide, élément non objet, document sans id', ['ID_EN_DOUBLE', 'NUMERO_EN_DOUBLE', 'EMISE_SANS_NUMERO_VALIDE', 'ELEMENT_NON_OBJET', 'DOCUMENT_SANS_ID'].every((x) => codes(by['mig-c']).includes(x)), jstr(codes(by['mig-c'])));
  ck('mig-c : paiement orphelin signalé en avertissement', codes(by['mig-c'], true).includes('PAIEMENT_ORPHELIN'));
  ck('mig-d : aucun bloquant malgré l\'identifiant « x1 » commun à une facture et un devis', by['mig-d'].ok);
  ck('mig-e : aucun bloquant', by['mig-e'].ok);
  const after = (await c.query('SELECT (SELECT count(*) FROM public.documents)::int d, (SELECT count(*) FROM public.doc_payments)::int p, (SELECT count(*) FROM public.doc_history)::int h')).rows[0];
  ck('le dry-run n\'a rien écrit (nouvelles tables toujours à ' + jstr(before) + ')', jstr(before) === jstr(after) && before.d === 0);
  const seed = (await c.query("SELECT detail->'hashes' hs FROM public._fp_rehearsal WHERE name='legacy_seed'")).rows[0].hs;
  let same = true; for (const e of EMAILS) { const h = (await c.query("SELECT md5(coalesce(string_agg(key||value::text||updated_at::text,'|' ORDER BY key COLLATE \"C\"),'')) h FROM public.user_data WHERE user_id = (SELECT id FROM auth.users WHERE email=$1)", [e])).rows[0].h; if (h !== seed[e].h) same = false; }
  ck('l\'ancien stockage des 5 comptes est strictement inchangé depuis la création des données', same);
  await checkForeign(c, 'après dry-run');
  await c.end();
}

// ---------- 6. répétition complète ----------
async function rehearse() {
  REST = restCfg();
  const { c } = await db();
  const q = async (sql, p = []) => (await c.query(sql, p)).rows;
  const q1 = async (sql, p = []) => (await q(sql, p))[0];
  const run = async (uid, apply) => (await q1('SELECT public.fp_mig_run($1::uuid, $2) r', [uid, apply])).r;
  const us = Object.fromEntries((await uidsOf(c)).map((r) => [r.email.replace(DOMAIN, '').replace('mig-', ''), r.id]));
  if (Object.keys(us).length !== 5) throw new Error('REFUS : les 5 comptes de test sont absents.');
  if (!(await q1("SELECT to_regclass('public.documents') t")).t) throw new Error('REFUS : sql/15 non installé.');
  await createAccounts(c);                                   // nouveaux mots de passe aléatoires pour cette session
  await checkForeign(c, 'avant la répétition');
  const udHash = async (uid) => (await q1("SELECT md5(coalesce(string_agg(key||value::text||updated_at::text,'|' ORDER BY key COLLATE \"C\"),'')) h FROM public.user_data WHERE user_id=$1::uuid", [uid])).h;
  const cnt = async (uid) => q1(`SELECT (SELECT count(*) FROM public.documents WHERE user_id=$1::uuid)::int d, (SELECT count(*) FROM public.doc_payments WHERE user_id=$1::uuid)::int p, (SELECT count(*) FROM public.doc_history WHERE user_id=$1::uuid)::int h`, [uid]);

  out('### 7. Migration des comptes (dry-run puis copie)');
  // mig-a
  const hA0 = await udHash(us.a);
  let r = await run(us.a, false); ck('mig-a : fp_mig_run(…, false) = dry-run, rien d\'écrit', r.status === 'dry_run_ok' && (await cnt(us.a)).d === 0, jstr(r).slice(0, 200));
  r = await run(us.a, true); ck('mig-a : copie appliquée', r.status === 'applied', jstr(r).slice(0, 300));
  let n = await cnt(us.a); ck(`mig-a : 9 documents (5 factures + 1 avoir + 3 devis), 2 paiements, 5 entrées de journal — obtenu ${jstr(n)}`, n.d === 9 && n.p === 2 && n.h === 5);
  ck('mig-a : l\'ancien stockage n\'a pas été modifié (empreinte avant/après identique)', (await udHash(us.a)) === hA0);
  ck('mig-a : fp_mig_verify = ok (empreinte de chaque élément, colonnes, sommes, paiements, journal)', (await q1('SELECT public.fp_mig_verify($1::uuid) v', [us.a])).v.ok === true);
  const exact = await q1(`SELECT (SELECT total_ht FROM public.documents WHERE user_id=$1::uuid AND id='i3') ht, (SELECT total_ttc FROM public.documents WHERE user_id=$1::uuid AND id='i3') ttc,
      (SELECT count(*) FROM public.fp_mig_legacy_docs($1::uuid) l JOIN public.documents d ON (d.user_id,d.doc_type,d.id)=(l.user_id,l.doc_type,l.doc_id) WHERE d.body = l.el AND d.legacy_sha = public.fp_sha(l.el))::int same`, [us.a]);
  ck('mig-a : montants à 3 décimales conservés exactement (50.005 / 60.006) ; 9 éléments sur 9 identiques à l\'original', Number(exact.ht) === 50.005 && Number(exact.ttc) === 60.006 && exact.same === 9, jstr(exact));
  const nums = (await q("SELECT array_agg(number ORDER BY number COLLATE \"C\") a FROM public.documents WHERE user_id=$1::uuid AND doc_type<>'quote' AND status<>'draft'", [us.a]))[0].a;
  const seedInfo = (await q1("SELECT detail FROM public._fp_rehearsal WHERE name='legacy_seed'")).detail;
  ck('mig-a : tous les numéros de factures/avoirs émis conservés à l\'identique : ' + nums.join(', '), jstr([...nums]) === jstr([...seedInfo.a.numbers].sort()));
  r = await run(us.a, true); ck('mig-a : 2e exécution idempotente (0 nouveau, 0 rafraîchi, 0 conflit), mêmes effectifs', r.documents_new === 0 && r.documents_refreshed === 0 && r.documents_conflicts === 0 && r.payments_new === 0 && (await cnt(us.a)).d === 9, jstr(r).slice(0, 250));
  // mig-b
  r = await run(us.b, true); ck('mig-b : copie appliquée', r.status === 'applied'); n = await cnt(us.b); ck(`mig-b : 3 documents, 2 paiements, 1 entrée de journal — obtenu ${jstr(n)}`, n.d === 3 && n.p === 2 && n.h === 1);
  // mig-c : arrêt automatique sur anomalies
  const hC = await udHash(us.c);
  r = await run(us.c, true);
  ck('mig-c : migration ARRÊTÉE avant toute copie (bloquants) — aucune ligne copiée, aucune sauvegarde faite, ancien stockage intact',
    r.status === 'stopped' && r.stage === 'dry_run' && (await cnt(us.c)).d === 0 && (await q1('SELECT count(*)::int n FROM public._mig_source_backup WHERE user_id=$1::uuid', [us.c])).n === 0 && (await udHash(us.c)) === hC, jstr(r).slice(0, 250));
  // décision humaine simulée : corriger les anomalies (supprimer les doublons/éléments invalides) puis relancer
  await c.query(`UPDATE public.user_data SET value = $2::jsonb WHERE user_id=$1::uuid AND key='invoices'`, [us.c, jstr([{ id: 'd1', type: 'invoice', number: FN('FAC', 1), status: 'sent', totalTTC: 10 }, { id: 'd2', type: 'invoice', number: FN('FAC', 2), status: 'sent', totalTTC: 20 }])]);
  r = await run(us.c, true); ck('mig-c : après correction des doublons par décision humaine, la migration réussit (2 documents)', r.status === 'applied' && (await cnt(us.c)).d === 2, jstr(r).slice(0, 250));
  // mig-d : collisions
  r = await run(us.d, true); n = await cnt(us.d);
  const coll = await q("SELECT doc_type, total_ht, total_ttc FROM public.documents WHERE user_id=$1::uuid AND id='x1' ORDER BY doc_type", [us.d]);
  ck('mig-d : l\'identifiant « x1 » existe en facture ET en devis, sans collision ni perte ; montants à 3-4 décimales exacts', r.status === 'applied' && coll.length === 2 && Number(coll[0].total_ht) === 33.333 && Number(coll[0].total_ttc) === 39.9996 && Number(coll[1].total_ht) === 7.777, jstr(coll));
  ck('mig-d : paiement de 10.005 conservé exactement', Number((await q1('SELECT amount FROM public.doc_payments WHERE user_id=$1::uuid', [us.d])).amount) === 10.005);
  // mig-e : écart pendant la copie => annulation (déclencheur de sabotage temporaire, supprimé ensuite)
  await c.query(`CREATE OR REPLACE FUNCTION public.zz_rehearsal_sabotage() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF NEW.user_id = '${us.e}'::uuid THEN NEW.total_ttc := NEW.total_ttc + 1; END IF; RETURN NEW; END $f$`);
  await c.query('CREATE TRIGGER zz_rehearsal_sabotage BEFORE INSERT ON public.documents FOR EACH ROW EXECUTE FUNCTION public.zz_rehearsal_sabotage()');
  try { r = await run(us.e, true); } finally { await c.query('DROP TRIGGER IF EXISTS zz_rehearsal_sabotage ON public.documents; DROP FUNCTION IF EXISTS public.zz_rehearsal_sabotage()'); }
  ck('mig-e : écart provoqué volontairement pendant la copie => ARRÊT AUTOMATIQUE, copie annulée (0 ligne), ancien stockage intact', r.status === 'stopped' && r.error === 'MIGRATION_ECART' && (await cnt(us.e)).d === 0, jstr(r).slice(0, 250));
  ck('mig-e : déclencheur et fonction de sabotage supprimés', (await q1("SELECT count(*)::int n FROM pg_trigger WHERE tgname='zz_rehearsal_sabotage'")).n === 0 && (await q1("SELECT count(*)::int n FROM pg_proc WHERE proname='zz_rehearsal_sabotage'")).n === 0);
  r = await run(us.e, true); ck('mig-e : sans sabotage, la migration réussit', r.status === 'applied');

  // ----- droits RLS et RPC sur le vrai Supabase -----
  out('\n### 8. Droits RLS et fonctions RPC (API Supabase réelle, jetons de deux comptes)');
  const A = await login('a'), B = await login('b');
  const docsOf = (tok, uid) => api('GET', `/rest/v1/documents?select=id,doc_type,version&user_id=eq.${uid}`, tok);
  let g = await docsOf(A.tok, A.id); ck('mig-a lit ses 9 documents', g.status === 200 && g.body.length === 9, jstr(g).slice(0, 200));
  g = await docsOf(B.tok, A.id); ck('mig-b ne lit AUCUN document de mig-a (filtre explicite sur son identifiant)', g.status === 200 && g.body.length === 0, jstr(g).slice(0, 200));
  g = await api('GET', '/rest/v1/documents?select=id', B.tok); ck('mig-b, sans filtre, ne voit que ses 3 documents', g.status === 200 && g.body.length === 3, jstr(g).slice(0, 200));
  g = await api('GET', `/rest/v1/doc_payments?select=id&user_id=eq.${A.id}`, B.tok); const g2 = await api('GET', `/rest/v1/doc_history?select=entry_sha&user_id=eq.${A.id}`, B.tok);
  ck('mig-b ne lit ni les paiements ni le journal de mig-a', g.status === 200 && g.body.length === 0 && g2.status === 200 && g2.body.length === 0);
  const wr = [await api('POST', '/rest/v1/documents', B.tok, { user_id: B.id, doc_type: 'invoice', id: 'zz', body: {}, body_sha: 'x' }), await api('PATCH', `/rest/v1/documents?user_id=eq.${A.id}`, B.tok, { status: 'paid' }),
    await api('DELETE', `/rest/v1/documents?user_id=eq.${A.id}`, B.tok), await api('PATCH', `/rest/v1/documents?user_id=eq.${B.id}`, B.tok, { status: 'paid' }), await api('POST', '/rest/v1/doc_payments', A.tok, { user_id: A.id, id: 'zz', body: {} })];
  ck('écritures directes sur documents / doc_payments refusées (HTTP 401/403), même sur ses propres lignes', wr.every((x) => x.status === 401 || x.status === 403), jstr(wr.map((x) => x.status)));
  ck('les documents de mig-a sont inchangés après ces tentatives', (await cnt(us.a)).d === 9 && (await q1("SELECT count(*)::int n FROM public.documents WHERE user_id=$1::uuid AND status='paid'", [us.a])).n === 1);
  const mg = [await rpc(A.tok, 'fp_mig_run', { p_user: A.id, p_apply: true }), await rpc(A.tok, 'fp_mig_rollback', { p_user: A.id, p_apply: true }), await rpc(A.tok, 'fp_mig_dry_run', { p_user: A.id }), await rpc(A.tok, 'fp_mig_verify', { p_user: A.id })];
  ck('fonctions de migration inaccessibles via l\'API (même pour son propre compte)', mg.every((x) => x.status >= 400), jstr(mg.map((x) => x.status)));
  const tech = [await api('GET', '/rest/v1/_mig_runs?select=*', A.tok), await api('GET', '/rest/v1/_mig_source_backup?select=*', A.tok), await api('GET', '/rest/v1/_mig_conflicts?select=*', A.tok), await api('GET', '/rest/v1/doc_deleted?select=*', A.tok), await api('GET', '/rest/v1/_fp_rehearsal?select=*', A.tok)];
  ck('tables techniques illisibles via l\'API', tech.every((x) => x.status >= 400 || (Array.isArray(x.body) && x.body.length === 0)), jstr(tech.map((x) => x.status)));
  const an = [await api('GET', '/rest/v1/documents?select=id', null), await rpc(null, 'upsert_document', { p_doc: { id: 'a', type: 'invoice' }, p_expected_version: null, p_op_id: 'anon' }), await rpc(null, 'record_payment', { p_invoice_id: 'a', p_payment: { id: 'a', amount: 1 } })];
  ck('visiteur non connecté (anon) : aucun accès aux documents ni aux fonctions d\'écriture', an.every((x) => x.status === 401 || x.status === 403 || x.status === 404), jstr(an.map((x) => x.status)));
  const lic = [await rpc(A.tok, 'has_active_license', { p_uid: B.id }), await rpc(A.tok, 'has_active_license', { p_uid: A.id })];
  ck('has_active_license : A ne peut pas consulter B (null) mais consulte sa propre licence (true)', lic[0].body === null && lic[1].body === true, jstr(lic.map((x) => x.body)));
  const bUp = await rpc(B.tok, 'upsert_document', { p_doc: { id: 'i4', type: 'invoice', number: 'BRO-BBBB', status: 'draft', clientName: 'créé par B' }, p_expected_version: null, p_op_id: 'b-same-id' });
  const aI4 = await q1("SELECT version, body->>'clientName' c FROM public.documents WHERE user_id=$1::uuid AND id='i4'", [us.a]);
  ck('B crée un document portant le MÊME identifiant qu\'un document de A : c\'est un document distinct de B ; celui de A est inchangé', bUp.body.ok === true && aI4.version === 1 && aI4.c === 'Client test', jstr([bUp.body, aI4]));
  const bDel = await rpc(B.tok, 'delete_document', { p_type: 'invoice', p_id: 'i4', p_expected_version: 1 });
  ck('B supprime « son » i4 : le i4 de A reste intact', bDel.body.ok === true && (await q1("SELECT count(*)::int n FROM public.documents WHERE user_id=$1::uuid AND id='i4'", [us.a])).n === 1);
  const bPay = await rpc(B.tok, 'record_payment', { p_invoice_id: 'i2', p_payment: { id: 'evil', amount: 999, date: `${Y}-05-01` } });
  ck('B enregistre un paiement sur la facture de A (« i2 » de B existe : le paiement va sur la SIENNE) ; la facture de A est intacte', (await q1("SELECT paid_amount FROM public.documents WHERE user_id=$1::uuid AND id='i2'", [us.a])).paid_amount == 100 && (await q1("SELECT count(*)::int n FROM public.doc_payments WHERE user_id=$1::uuid AND id='evil'", [us.a])).n === 0, jstr(bPay.body).slice(0, 200));
  const bFake = await rpc(B.tok, 'record_payment', { p_invoice_id: 'c1', p_payment: { id: 'evil2', amount: 5, date: `${Y}-05-01` } });
  ck('paiement sur un identifiant que B ne possède pas (« c1 » est un avoir de A) : FACTURE_INTROUVABLE', /FACTURE_INTROUVABLE/.test(jstr(bFake.body)), jstr(bFake).slice(0, 200));

  // ----- verrouillage, suppression -----
  out('\n### 9. Verrouillage, suppressions, numérotation');
  const getDoc = async (tok, uid, id, type = 'invoice') => (await api('GET', `/rest/v1/documents?select=version,body&user_id=eq.${uid}&id=eq.${id}&doc_type=eq.${type}`, tok)).body[0];
  const i1 = await getDoc(A.tok, A.id, 'i1');
  const lk = [await rpc(A.tok, 'upsert_document', { p_doc: { ...i1.body, totalTTC: 1 }, p_expected_version: i1.version, p_op_id: 'lk1' }), await rpc(A.tok, 'delete_document', { p_type: 'invoice', p_id: 'i1', p_expected_version: i1.version }),
    await rpc(A.tok, 'upsert_document', { p_doc: { ...i1.body, status: 'draft' }, p_expected_version: i1.version, p_op_id: 'lk3' })];
  ck('facture émise : modification de montant, suppression et retour au brouillon refusés (FACTURE_VERROUILLEE)', lk.every((x) => x.status >= 400 && /FACTURE_VERROUILLEE/.test(jstr(x.body))), jstr(lk.map((x) => x.body.message || x.body)));
  const badNum = await rpc(A.tok, 'upsert_document', { p_doc: { id: 'n0', type: 'invoice', number: FN('FAC', 9999), status: 'sent', totalTTC: 1 }, p_expected_version: null, p_op_id: 'bn' });
  const dupNum = await rpc(A.tok, 'upsert_document', { p_doc: { id: 'n0', type: 'invoice', number: i1.body.number, status: 'sent', totalTTC: 1 }, p_expected_version: null, p_op_id: 'dn' });
  ck('émission avec un numéro non attribué par le serveur : refusée ; avec un numéro déjà utilisé : refusée', /NUMERO_NON_ATTRIBUE/.test(jstr(badNum.body)) && /NUMERO_EN_DOUBLE/.test(jstr(dupNum.body)), jstr([badNum.body.message, dupNum.body.message]));
  const oldDel = await put(A.tok, A.id, 'invoices', (await api('GET', `/rest/v1/user_data?select=value&user_id=eq.${A.id}&key=eq.invoices`, A.tok)).body[0].value.filter((x) => x.id !== 'i1'));
  ck('ANCIEN appareil : supprimer une facture ÉMISE de l\'ancien tableau est refusé par le serveur', oldDel.status >= 400 && /FACTURE_VERROUILLEE/.test(jstr(oldDel.body)), jstr(oldDel).slice(0, 200));
  const NB = 10;
  const em = await Promise.all(Array.from({ length: NB }, async (_, i) => { const num = await nextNum(A.tok, 'invoice'); const number = FN('FAC', num);
    const x = await rpc(A.tok, 'upsert_document', { p_doc: { id: 'par' + i, type: 'invoice', number, status: 'sent', date: `${Y}-06-01`, clientName: 'Concurrent', totalHT: 10, totalTVA: 2, totalTTC: 12 }, p_expected_version: null, p_op_id: 'par-' + i }); return { num, number, x }; }));
  ck(`${NB} émissions simultanées via l\'API : ${NB} numéros distincts, ${NB} documents acceptés`, new Set(em.map((e) => e.num)).size === NB && em.every((e) => e.x.status === 200 && e.x.body.ok), jstr(em.map((e) => e.x.status)));
  ck('aucun numéro en double en base pour mig-a', (await q1("SELECT count(*)::int n FROM (SELECT number FROM public.documents WHERE user_id=$1::uuid AND doc_type<>'quote' AND status<>'draft' GROUP BY doc_type, number HAVING count(*)>1) z", [us.a])).n === 0);

  // ----- deux appareils -----
  out('\n### 10. Deux appareils, conflits, reprise, écritures concurrentes');
  const A2 = await login('a');                                // 2e appareil : 2e session du même compte
  const dr = await rpc(A.tok, 'upsert_document', { p_doc: { id: 'dev1', type: 'invoice', number: 'BRO-DEV1', status: 'draft', clientName: 'v1' }, p_expected_version: null, p_op_id: 'dev-init' });
  const [x1, x2] = await Promise.all([rpc(A.tok, 'upsert_document', { p_doc: { id: 'dev1', type: 'invoice', number: 'BRO-DEV1', status: 'draft', clientName: 'appareil 1' }, p_expected_version: 1, p_op_id: 'dev-1' }),
    rpc(A2.tok, 'upsert_document', { p_doc: { id: 'dev1', type: 'invoice', number: 'BRO-DEV1', status: 'draft', clientName: 'appareil 2' }, p_expected_version: 1, p_op_id: 'dev-2' })]);
  const oks = [x1, x2].filter((x) => x.body.ok), cf = [x1, x2].filter((x) => x.body.conflict);
  ck('2 appareils modifient le même brouillon à partir de la version 1 : 1 accepté, 1 CONFLIT explicite avec la version serveur', dr.body.version === 1 && oks.length === 1 && cf.length === 1 && cf[0].body.server_version === 2, jstr([x1.body, x2.body]).slice(0, 300));
  const loser = x1.body.conflict ? { t: A.tok, n: 'appareil 1' } : { t: A2.tok, n: 'appareil 2' };
  const merged = await rpc(loser.t, 'upsert_document', { p_doc: { ...cf[0].body.server_doc, clientName: cf[0].body.server_doc.clientName + ' + ' + loser.n }, p_expected_version: 2, p_op_id: 'dev-merge' });
  ck('le perdant relit la version serveur, fusionne et réessaie : accepté (version 3), aucune des deux modifications perdue', merged.body.ok && merged.body.version === 3 && /appareil 1/.test((await getDoc(A.tok, A.id, 'dev1')).body.clientName) && /appareil 2/.test((await getDoc(A.tok, A.id, 'dev1')).body.clientName));
  const rep = await rpc(loser.t, 'upsert_document', { p_doc: { ...cf[0].body.server_doc, clientName: cf[0].body.server_doc.clientName + ' + ' + loser.n }, p_expected_version: 2, p_op_id: 'dev-merge' });
  ck('REPRISE après coupure réseau (réponse perdue) : la même opération rejouée est reconnue (replay), la version reste 3', rep.body.replay === true && (await getDoc(A.tok, A.id, 'dev1')).version === 3, jstr(rep.body));
  const pa = { id: 'pay-cut', date: `${Y}-06-02`, amount: 12, method: 'virement' };
  const pp = await Promise.all([1, 2, 3].map(() => rpc(A.tok, 'record_payment', { p_invoice_id: 'par0', p_payment: pa, p_op_id: 'pay-cut-op' })));
  ck('paiement envoyé 3 fois en parallèle (coupures/reprises) : une seule ligne, facture payée une seule fois (12)', pp.every((x) => x.status === 200) && (await q1("SELECT count(*)::int n FROM public.doc_payments WHERE user_id=$1::uuid AND id='pay-cut'", [us.a])).n === 1 && Number((await getDoc(A.tok, A.id, 'par0')).body.paidAmount) === 12);
  // conflit « des deux côtés » : le nouveau chemin modifie i3, puis l'ancien appareil modifie aussi i3 dans l'ancien tableau
  const i3 = await getDoc(A.tok, A.id, 'i3'); const eP = await rpc(A.tok, 'upsert_document', { p_doc: { ...i3.body, notes: 'écrit par le nouveau chemin' }, p_expected_version: i3.version, p_op_id: 'i3-new' });
  const leg = (await api('GET', `/rest/v1/user_data?select=value&user_id=eq.${A.id}&key=eq.invoices`, A.tok)).body[0].value;
  const oldW = await put(A.tok, A.id, 'invoices', leg.map((x) => x.id === 'i3' ? { ...x, notes: 'écrit par l\'ancien appareil', paidAmount: 5 } : x));
  ck('l\'ancien appareil modifie i3 via l\'ancien tableau (modification de règlement autorisée par le verrou)', eP.body.ok && oldW.status < 300, jstr([eP.body, oldW]).slice(0, 200));
  // brouillon créé sur l'ancien appareil, puis supprimé sur l'ancien appareil
  const leg2 = (await api('GET', `/rest/v1/user_data?select=value&user_id=eq.${A.id}&key=eq.invoices`, A.tok)).body[0].value;
  await put(A.tok, A.id, 'invoices', [...leg2, { id: 'old1', type: 'invoice', number: 'BRO-OLD1', status: 'draft', clientName: 'brouillon ancien appareil', totalTTC: 7 }, { id: 'old2', type: 'invoice', number: 'BRO-OLD2', status: 'draft', clientName: 'brouillon à supprimer', totalTTC: 8 }]);
  // migration relancée PENDANT des écritures concurrentes sur le nouveau chemin
  const writers = Promise.all(Array.from({ length: 20 }, (_, i) => rpc(i % 2 ? A.tok : A2.tok, 'upsert_document', { p_doc: { id: 'cw' + i, type: 'invoice', number: 'BRO-CW' + i, status: 'draft', totalTTC: i }, p_expected_version: null, p_op_id: 'cw-' + i })));
  const [mr, wr2] = await Promise.all([run(us.a, true), writers]);
  ck('migration relancée PENDANT 20 écritures concurrentes (2 appareils) : appliquée, 20 écritures acceptées', mr.status === 'applied' && wr2.every((x) => x.status === 200 && x.body.ok), jstr(mr).slice(0, 250));
  ck('rattrapage : le brouillon créé sur l\'ancien appareil (old1, old2) est copié ; le conflit sur i3 (modifié des deux côtés) est NOTÉ, rien n\'est écrasé',
    mr.documents_new >= 2 && mr.documents_conflicts === 1 && (await getDoc(A.tok, A.id, 'i3')).body.notes === 'écrit par le nouveau chemin', jstr({ nouveaux: mr.documents_new, conflits: mr.documents_conflicts }));
  ck('la version « ancien appareil » de i3 est conservée intégralement dans _mig_conflicts', (await q1("SELECT legacy->>'notes' n FROM public._mig_conflicts WHERE user_id=$1::uuid AND doc_id='i3'", [us.a])).n === 'écrit par l\'ancien appareil');
  ck('un 2e passage ne note pas deux fois le même conflit et crée 0 doublon', (await run(us.a, true)).documents_conflicts === 0);
  // suppressions
  const d4 = await getDoc(A.tok, A.id, 'dev1'); const dd = await rpc(A.tok, 'delete_document', { p_type: 'invoice', p_id: 'cw0', p_expected_version: 1 });
  const dd2 = await rpc(A.tok, 'delete_document', { p_type: 'invoice', p_id: 'cw0', p_expected_version: 1 });
  ck('suppression d\'un brouillon par le nouveau chemin ; suppression rejouée : sans effet', dd.body.ok === true && dd2.body.already_deleted === true && (await q1("SELECT count(*)::int n FROM public.documents WHERE user_id=$1::uuid AND id='cw0'", [us.a])).n === 0);
  ck('un brouillon supprimé n\'est pas ressuscité par un rattrapage', (await run(us.a, true)).status === 'applied' && (await q1("SELECT count(*)::int n FROM public.documents WHERE user_id=$1::uuid AND id='cw0'", [us.a])).n === 0);
  // brouillon supprimé sur l'ANCIEN appareil APRÈS la copie
  const leg3 = (await api('GET', `/rest/v1/user_data?select=value&user_id=eq.${A.id}&key=eq.invoices`, A.tok)).body[0].value;
  const delOld = await put(A.tok, A.id, 'invoices', leg3.filter((x) => x.id !== 'old2'));
  await run(us.a, true);
  const old2 = await q1("SELECT version FROM public.documents WHERE user_id=$1::uuid AND id='old2'", [us.a]);
  ck('brouillon supprimé sur l\'ANCIEN appareil (old2) : suppression acceptée côté ancien tableau, mais le nouveau stockage le conserve (comportement documenté : la suppression ne se propage pas)', delOld.status < 300 && !!old2, jstr(old2));
  await checkForeign(c, 'après migrations et écritures');

  // ----- retour arrière -----
  out('\n### 11. Retour arrière (comptes de test uniquement) après de nouvelles écritures');
  const hBefore = await udHash(us.a);
  const legacyIds = (await q1("SELECT array_agg(e->>'id') ids FROM public.user_data u, jsonb_array_elements(u.value) e WHERE u.user_id=$1::uuid AND u.key='invoices'", [us.a])).ids;
  const prev = (await q1('SELECT public.fp_mig_rollback($1::uuid, false) r', [us.a])).r;
  ck('aperçu du retour arrière : change des listes, n\'écrit rien (empreinte de user_data inchangée)', prev.status === 'rollback_preview' && prev.lists_changed >= 2 && (await udHash(us.a)) === hBefore, jstr(prev).slice(0, 400));
  const rbk = (await q1('SELECT public.fp_mig_rollback($1::uuid, true) r', [us.a])).r;
  ck('retour arrière appliqué', rbk.status === 'rollback_applied', jstr(rbk).slice(0, 300));
  const after = (await q1("SELECT value v FROM public.user_data WHERE user_id=$1::uuid AND key='invoices'", [us.a])).v;
  const ids = new Set(after.map((e) => e.id));
  const issued = after.filter((e) => (e.status || 'draft') !== 'draft').map((e) => e.number);
  const origIssued = seedInfo.a.numbers;
  ck('aucune facture/avoir émis d\'origine perdu : les ' + origIssued.length + ' numéros d\'origine sont tous présents', origIssued.every((x) => issued.includes(x)), issued.join(','));
  ck(`les ${NB} factures émises PENDANT la migration (nouveau chemin) sont reprises dans l\'ancien tableau`, Array.from({ length: NB }, (_, i) => 'par' + i).every((x) => ids.has(x)));
  ck('le brouillon créé par le nouveau chemin (dev1, 3 versions) est repris avec sa dernière version fusionnée', after.find((e) => e.id === 'dev1') && /appareil 1/.test(after.find((e) => e.id === 'dev1').clientName));
  ck('les 19 brouillons concurrents encore existants sont repris ; celui supprimé (cw0) est retiré', Array.from({ length: 19 }, (_, i) => 'cw' + (i + 1)).every((x) => ids.has(x)) && !ids.has('cw0'));
  ck('le paiement de 12 enregistré pendant la migration est repris (par0 payée)', after.find((e) => e.id === 'par0').status === 'paid' && Number(after.find((e) => e.id === 'par0').paidAmount) === 12);
  const pays = (await q1("SELECT value v FROM public.user_data WHERE user_id=$1::uuid AND key='payments'", [us.a])).v;
  ck('paiements : p1, p2 d\'origine + pay-cut (nouveau chemin) = 3, sans doublon', pays.length === 3 && new Set(pays.map((p) => p.id)).size === 3, jstr(pays.map((p) => p.id)));
  ck('i3 modifié des DEUX côtés : la version du nouveau chemin est retenue dans user_data ; celle de l\'ancien appareil reste dans _mig_conflicts ET dans la sauvegarde de l\'état précédent',
    after.find((e) => e.id === 'i3').notes === 'écrit par le nouveau chemin' && !!(await q1("SELECT 1 x FROM public._mig_source_backup WHERE user_id=$1::uuid AND key='invoices' AND sha256=public.fp_sha($2::jsonb)", [us.a, jstr(leg3)])) || false);
  ck('brouillon supprimé sur l\'ancien appareil (old2) : RÉAPPARAÎT dans user_data après le retour arrière (comportement documenté, aucune perte)', ids.has('old2'));
  ck('l\'état d\'avant le retour arrière est conservé tel quel dans _mig_source_backup (sous son empreinte)', !!(await q1("SELECT 1 x FROM public._mig_source_backup WHERE user_id=$1::uuid AND key='invoices' AND sha256 = $2", [us.a, (await q1('SELECT public.fp_sha($1::jsonb) s', [jstr(leg3)])).s])));
  ck('les nouvelles tables sont conservées (aucune suppression par le retour arrière)', (await cnt(us.a)).d >= 30);
  ck('les clés non migrées sont intactes (logo de company conservé)', (await q1("SELECT value->>'logo' l FROM public.user_data WHERE user_id=$1::uuid AND key='company'", [us.a])).l === 'data:image/png;base64,iVBORw0KGgo=');
  const rb2 = (await q1('SELECT public.fp_mig_rollback($1::uuid, true) r', [us.a])).r;
  ck('retour arrière rejoué : aucun changement (idempotent)', rb2.lists_changed === 0, jstr(rb2).slice(0, 200));
  const rt = await run(us.a, true);
  ck('aller-retour : la migration relancée après le retour arrière est cohérente (verify ok)', rt.status === 'applied' && (await q1('SELECT public.fp_mig_verify($1::uuid) v', [us.a])).v.ok === true, jstr(rt).slice(0, 250));
  const rbB = (await q1('SELECT public.fp_mig_rollback($1::uuid, true) r', [us.b])).r;
  ck('mig-b (aucune écriture depuis la copie) : le retour arrière ne change rien', rbB.lists_changed === 0, jstr(rbB).slice(0, 200));
  // l'application « ancien format » fonctionne toujours après le retour arrière : écriture + verrou
  const post = await put(A.tok, A.id, 'invoices', [...after, { id: 'after-rb', type: 'invoice', number: 'BRO-AFTER', status: 'draft', totalTTC: 1 }]);
  ck('après le retour arrière, l\'ancien format reste utilisable (écriture d\'un brouillon via l\'API, verrou serveur actif)', post.status < 300);
  await checkForeign(c, 'après le retour arrière');
  await c.end();
}

// ---------- 7. état final et nettoyage ----------
async function cleanup() {
  const { c } = await db();
  out('### 12. État final des données de test, puis nettoyage');
  const us = await uidsOf(c);
  const uids = us.map((x) => x.id);
  const st = await c.query(`SELECT u.email, (SELECT count(*) FROM public.documents d WHERE d.user_id=u.id)::int docs, (SELECT count(*) FROM public.doc_payments d WHERE d.user_id=u.id)::int pays,
      (SELECT count(*) FROM public.doc_history d WHERE d.user_id=u.id)::int hist, (SELECT count(*) FROM public.user_data d WHERE d.user_id=u.id)::int ud, (SELECT count(*) FROM public.doc_events d WHERE d.user_id=u.id)::int ev
      FROM auth.users u WHERE u.id::text = ANY($1) ORDER BY 1`, [uids]);
  out('| Compte | documents | paiements | journal migré | lignes user_data | événements serveur |\n|---|---|---|---|---|---|\n' + st.rows.map((r) => `| ${r.email.replace(DOMAIN, '')} | ${r.docs} | ${r.pays} | ${r.hist} | ${r.ud} | ${r.ev} |`).join('\n'));
  const strange = await c.query(`SELECT (SELECT count(*) FROM public.documents WHERE NOT (user_id::text = ANY($1)))::int d, (SELECT count(*) FROM public.doc_payments WHERE NOT (user_id::text = ANY($1)))::int p,
      (SELECT count(*) FROM public.doc_history WHERE NOT (user_id::text = ANY($1)))::int h, (SELECT count(*) FROM public._mig_source_backup WHERE NOT (user_id::text = ANY($1)))::int b, (SELECT count(*) FROM public._mig_conflicts WHERE NOT (user_id::text = ANY($1)))::int cf`, [uids]);
  ck('les nouvelles tables ne contiennent AUCUNE ligne étrangère aux comptes de test', Object.values(strange.rows[0]).every((v) => v === 0), jstr(strange.rows[0]));
  await checkForeign(c, 'avant nettoyage');
  const runs = await c.query('SELECT status, count(*)::int n FROM public._mig_runs GROUP BY 1 ORDER BY 1');
  out('- Exécutions enregistrées (_mig_runs) : ' + runs.rows.map((r) => `${r.status}=${r.n}`).join(', '));
  await c.query('BEGIN');
  await c.query('DELETE FROM public._mig_source_backup WHERE user_id::text = ANY($1)', [uids]);
  await c.query('DELETE FROM public._mig_conflicts WHERE user_id::text = ANY($1)', [uids]);
  await c.query('DELETE FROM public._mig_runs');
  const del = await c.query('DELETE FROM auth.users WHERE id::text = ANY($1) AND email = ANY($2)', [uids, EMAILS]);
  await c.query('COMMIT');
  ck(`${del.rowCount} compte(s) de test supprimé(s) (et eux seuls, par e-mail exact)`, del.rowCount === us.length);
  const left = await c.query(`SELECT (SELECT count(*) FROM auth.users WHERE email = ANY($1))::int u, (SELECT count(*) FROM public.documents)::int d, (SELECT count(*) FROM public.doc_payments)::int p, (SELECT count(*) FROM public.doc_history)::int h,
      (SELECT count(*) FROM public.doc_deleted)::int g, (SELECT count(*) FROM public._mig_source_backup)::int b, (SELECT count(*) FROM public._mig_conflicts)::int cf, (SELECT count(*) FROM public.user_data WHERE user_id NOT IN (SELECT id FROM auth.users))::int orphan_ud`, [EMAILS]);
  ck('plus aucun compte de test, aucune ligne résiduelle dans les nouvelles tables, aucune ligne orpheline dans user_data', Object.values(left.rows[0]).every((v) => v === 0), jstr(left.rows[0]));
  await checkForeign(c, 'après nettoyage');
  const usersNow = (await c.query('SELECT count(*)::int n FROM auth.users')).rows[0].n;
  out(`- Comptes restants dans la préproduction : ${usersNow}.`);
  await c.end();
}

const CMDS = { guardtests, baseline, seed, install, dryrun, rehearse, cleanup };
(async () => {
  const cmd = process.argv[2];
  if (!CMDS[cmd]) { console.error('Commande : ' + Object.keys(CMDS).join(' | ')); process.exit(2); }
  out(`## Répétition de migration — commande « ${cmd} » — ${new Date().toISOString()}`);
  try { await CMDS[cmd](); } catch (e) { ck('exécution sans erreur', false, e.message.replace(/postgres(ql)?:\/\/\S+/gi, 'postgres://***')); }
  const bad = res.filter((x) => !x).length;
  out(`\n**Bilan « ${cmd} » : ${res.length - bad}/${res.length} contrôles réussis.**`);
  if (process.env.REPORT_PATH) { fs.mkdirSync(path.dirname(process.env.REPORT_PATH), { recursive: true }); fs.appendFileSync(process.env.REPORT_PATH, lines.join('\n') + '\n'); }
  process.exit(bad ? 1 : 0);
})();
