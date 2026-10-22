#!/usr/bin/env node
// VALIDATION RÉELLE (Supabase PRÉPRODUCTION uniquement, jamais la production) du commit « intégration du nouveau stockage ».
//   guardtests : refus de la production (aucune connexion)
//   test       : comptes jetables ui-*@facturapro-test.invalid (dont ui-o, compte « ordinaire » : absent de doc_store_testers, jamais basculé) :
//                  N1…N10 : protocole réel (PostgREST + GoTrue + RPC) avec docstore.js et un vrai client supabase-js
//                  B1…B5  : navigateur réel (Chromium) sur le build de préproduction, ancien stockage (compte l)
//                  U1…U4  : navigateur réel, nouveau stockage (compte f)
//   cleanup    : supprime UNIQUEMENT les comptes de cette campagne (adresse exacte), vérifie orphelins et empreinte
// Chaque contrôle consigne : nature (RÉEL / RÉEL + réseau coupé côté client / SIMULÉ), attendu, obtenu, SQLSTATE, preuve.
// Variables : PREPROD_DB_URL (secret), PREPROD_URL, PREPROD_ANON_KEY, UI_PASSWORDS (JSON, jamais affichées), REPORT_PATH.
// UI_DRYRUN=1 : répétition LOCALE (PostgreSQL local + client simulé) pour tester CE script ; le rapport l'indique (SIMULÉ).
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const T = require('./preprod-target.json');
const DRY = process.env.UI_DRYRUN === '1';
const DOMAIN = '@facturapro-test.invalid';
const KEYS = ['l', 'd', 'e', 'f', 'g', 'o'];
const EMAIL = (k) => `ui-${k}${DOMAIN}`;
const EMAILS = KEYS.map(EMAIL);
const Y = new Date().getFullYear();
const NATURE = DRY ? 'SIMULÉ (répétition locale du script)' : 'RÉEL';
const NET = DRY ? 'SIMULÉ (répétition locale du script)' : 'RÉEL (serveur) + réseau coupé côté client';
const lines = [], res = [], rows = [];
const out = (s = '') => { lines.push(s); console.log(s); };
const jstr = (o) => JSON.stringify(o);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n = 260) => String(s == null ? '' : s).replace(/eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{5,}/g, '***jwt***').replace(/postgres(ql)?:\/\/\S+/gi, 'postgres://***').slice(0, n);

class Stop extends Error {}
// rec : un contrôle consigné. fatal = perte de données / doublon / écrasement : on arrête tous les essais (aucun nettoyage automatique)
function rec(id, title, expected, actual, ok, o = {}) {
  res.push(!!ok); rows.push({ id, ok: !!ok, nature: o.nature || NATURE });
  out(`- ${ok ? 'RÉUSSI' : '**ÉCHEC**'} — **${id}** [${o.nature || NATURE}] ${title}\n  - attendu : ${clip(expected)}\n  - obtenu : ${clip(actual)}${o.sqlstate ? `\n  - SQLSTATE : ${clip(o.sqlstate, 80)}` : ''}${o.proof ? `\n  - preuve : ${clip(o.proof, 400)}` : ''}`);
  if (!ok && o.fatal) throw new Stop(`${id} : ${title}`);
  return !!ok;
}

// ---------------------------------------------------------------- accès base (administrateur, uniquement pour préparer / vérifier)
let CTX;
async function makeCtx() {
  if (DRY) {
    const { createDb, dropDb, makeBackend } = require('../tests/integration/backend');
    const dbName = createDb({ docs: true }); const be = makeBackend(dbName);
    const q = async (s, p) => { const rows_ = await be.sql(s, p); return { rows: rows_, rowCount: rows_.length }; };
    const adm = { query: q, end: async () => {} };
    if (process.env.UI_DRY_KNOWNROW === '1') await q('INSERT INTO public._mig_runs(run_id, mode, status, started_at, report) VALUES ($1::uuid,$2,$3,$4::timestamptz,$5::jsonb)', ['cff4cac4-0000-4000-8000-000000000001', 'apply', 'applied', '2026-10-22 11:58:03.125123+00', '{"dry_run": {"accounts": []}}']);   // répétition locale : ligne historique connue présente dès le départ
    return { dry: true, adm, be, dropDb: () => { try { be.close(); } catch {} dropDb(dbName); }, url: 'https://' + T.preprodRef + '.supabase.co', key: T.anonKey };
  }
  const { connect } = require('./preprod-db');
  const { client, ref } = await connect();
  if (ref !== T.preprodRef) throw new Error('REFUS : cible inattendue.');
  const m = await client.query("SELECT to_regclass('public._fp_env') t").then((x) => x.rows[0].t ? client.query('SELECT env, project_ref FROM public._fp_env WHERE id=1') : { rows: [] });
  if (!m.rows[0] || m.rows[0].env !== 'preprod' || m.rows[0].project_ref !== T.preprodRef) throw new Error('REFUS : marqueur « préproduction » absent ou inattendu.');
  const G = require('./preprod-guard').guard(process.env.PREPROD_URL, process.env.PREPROD_ANON_KEY);
  return { dry: false, adm: client, url: G.url, key: G.key };
}
const q = async (s, p = []) => (await CTX.adm.query(s, p)).rows;
const q1 = async (s, p = []) => (await q(s, p))[0];
const pw = (k) => { const v = JSON.parse(process.env.UI_PASSWORDS || '{}')[k]; if (!v || v.length < 12) throw new Error('UI_PASSWORDS incomplet.'); return v; };

async function createAccounts() {
  for (const k of KEYS) {
    const email = EMAIL(k);
    if (CTX.dry) { const r = await CTX.be.handle('signUp', { email }); if (r.error) throw new Error(r.error.message); continue; }
    const ex = await q('SELECT id FROM auth.users WHERE email=$1', [email]);
    if (ex[0]) throw new Error('REFUS : le compte de test ' + email + ' préexiste (campagne précédente non nettoyée).');
    const id = crypto.randomUUID();
    await q(`INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
      VALUES ('00000000-0000-0000-0000-000000000000', $1::uuid, 'authenticated', 'authenticated', $2, crypt($3, gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '')`, [id, email, pw(k)]);
    await q(`INSERT INTO auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
      VALUES (gen_random_uuid(), $1::uuid, $1::text, jsonb_build_object('sub', $1::text, 'email', $2::text, 'email_verified', true), 'email', now(), now(), now())`, [id, email]);
  }
}
const uidOf = async (k) => (await q1('SELECT id::text id FROM auth.users WHERE email=$1', [EMAIL(k)])).id;

// ---------------------------------------------------------------- clients (supabase-js réel, ou simulé en répétition)
function simClient() {
  let tok = null;
  const call = (op, a) => CTX.be.handle(op, { ...a, token: tok });
  const builder = (table) => {
    const st = { table, op: 'select', filters: {} };
    const b = { select(c) { st.cols = c; return b; }, eq(k, v) { st.filters[k] = v; return b; }, order() { return b; }, limit() { return b; }, range(a, z) { st.range = [a, z]; return b; },
      insert(row) { st.op = 'insert'; st.row = row; return b; }, update(row) { st.op = 'update'; st.row = row; return b; }, upsert(row) { st.op = 'upsert'; st.row = row; return b; }, delete() { st.op = 'delete'; return b; },
      then(res_, rej) { return call('table', st).then((r) => ({ ...r, status: r.error ? 403 : 200 })).then(res_, rej); } };
    return b;
  };
  return {
    auth: { async signInWithPassword({ email }) { const r = await CTX.be.handle('signIn', { email }); if (r.error) return { data: null, error: r.error }; tok = r.session.access_token; return { data: { user: r.session.user, session: r.session }, error: null }; } },
    async rpc(fn, args) { const r = await call('rpc', { fn, args }); return { data: r.data, error: r.error, status: r.error ? 400 : 200 }; },
    from: builder
  };
}
function mkClient() {
  if (CTX.dry) return simClient();
  const { createClient } = require('@supabase/supabase-js');
  return createClient(CTX.url, CTX.key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}
async function signIn(k) {
  const c = mkClient();
  const r = await c.auth.signInWithPassword({ email: EMAIL(k), password: CTX.dry ? 'x' : pw(k) });
  if (r.error || !r.data.user || r.data.user.email !== EMAIL(k)) throw new Error('connexion impossible pour ' + EMAIL(k) + ' : ' + clip(r.error && r.error.message));
  return { c, uid: r.data.user.id, email: EMAIL(k), k };
}

// ---------------------------------------------------------------- EXCEPTION DOCUMENTÉE : une seule ligne historique de `_mig_runs`
// La ligne cff4cac4… (bascule de ui-g, campagne du run 39774301049, 2026-10-22 11:58:03.125 UTC) a été CONSERVÉE au nettoyage : son rattachement n'est qu'une inférence (horodatage et séquence de transactions), pas une preuve.
// Elle n'est ni supprimée ni modifiée. Les contrôles de départ la TOLÈRENT, elle seule, et seulement si TOUS ses traits correspondent (préfixe d'identifiant, mode, statut, instant à la milliseconde, rapport sans compte à migrer).
// Toute autre ligne de `_mig_runs`, ou une ligne qui ressemble à celle-ci mais dont un trait diffère, fait ÉCHOUER le contrôle.
const KNOWN_RUN = { prefix: 'cff4cac4', mode: 'apply', status: 'applied', ms: Date.parse('2026-10-22T11:58:03.125Z') };
const isKnownRun = (r) => String(r.run_id).startsWith(KNOWN_RUN.prefix) && r.mode === KNOWN_RUN.mode && r.status === KNOWN_RUN.status && Math.floor(new Date(r.started_at).getTime()) === KNOWN_RUN.ms && /"accounts":\s*\[\s*\]/.test(r.rep || '');
async function migRuns() {
  const rows_ = await q('SELECT run_id::text run_id, mode, status, started_at, finished_at, xmin::text::bigint x, report::text rep FROM public._mig_runs ORDER BY started_at');
  return { known: rows_.filter(isKnownRun), others: rows_.filter((r) => !isKnownRun(r)) };
}

// ---------------------------------------------------------------- empreinte des données préexistantes (identique à la campagne précédente)
const EXCLUDED = new Set(['public._fp_migrations', 'public._fp_rehearsal', 'public._mig_runs', 'public._mig_source_backup', 'public._mig_conflicts',
  'public.documents', 'public.doc_payments', 'public.doc_history', 'public.doc_deleted', 'public.doc_store_mode', 'public.doc_store_testers']);
async function foreignHash() {
  const uids = (await q('SELECT id::text id FROM auth.users WHERE email = ANY($1)', [EMAILS])).map((x) => x.id);
  const tabs = await q(`SELECT n.nspname s, c.relname t FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname IN ('public','auth') ORDER BY 1, 2`);
  const parts = {};
  for (const { s, t } of tabs) {
    const fq = `${s}.${t}`; if (EXCLUDED.has(fq)) continue;
    const cols = (await q('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2', [s, t])).map((r) => r.column_name);
    let where = 'TRUE';
    if (fq === 'auth.users') where = 'NOT (email = ANY($1::text[]))';
    else if (fq === 'public.admin_codes') where = "code NOT LIKE 'MODE-TEST-%'";
    else if (fq === 'auth.audit_log_entries') where = `COALESCE(payload->>'actor_username','') NOT LIKE '%@facturapro-%.invalid'`;
    else if (fq === 'auth.mfa_amr_claims') where = 'NOT (session_id IN (SELECT id FROM auth.sessions WHERE user_id::text = ANY($1::text[])))';
    else if (cols.includes('user_id')) where = 'user_id IS NULL OR NOT (user_id::text = ANY($1::text[]))';
    const r = await q1(`SELECT count(*)::int n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text COLLATE "C"), '')) h FROM "${s}"."${t}" x WHERE ${where}`,
      fq === 'auth.users' ? [EMAILS] : where.includes('$1') ? [uids] : []);
    parts[fq] = `${r.n}:${r.h}`;
  }
  return { hash: sha(jstr(parts)), parts };
}
async function checkForeign(label, id) {
  if (CTX.dry) return rec(id, `empreinte des données préexistantes (${label})`, 'non applicable en répétition locale', 'ignoré', true);
  const base = await q1("SELECT sha256, detail FROM public._fp_rehearsal WHERE name='mode_baseline_foreign'");
  if (!base) throw new Error('référence « mode_baseline_foreign » absente.');
  const now = await foreignHash();
  const diff = Object.keys(now.parts).filter((k) => now.parts[k] !== base.detail[k]).concat(Object.keys(base.detail).filter((k) => !(k in now.parts)));
  return rec(id, `données préexistantes inchangées (${label})`, `empreinte = référence ${base.sha256.slice(0, 12)}`, `empreinte ${now.hash.slice(0, 12)}${diff.length ? ' ; tables différentes : ' + diff.join(',') : ''}`, now.hash === base.sha256, { proof: `référence ${base.sha256.slice(0, 12)} / actuelle ${now.hash.slice(0, 12)}`, fatal: true });
}

// ---------------------------------------------------------------- bascule (comptes jetables uniquement)
async function flip(uid, mode) {
  for (let i = 0; i < 10; i++) {
    let r;
    try { r = (await q1('SELECT public.fp_doc_mode_set($1::uuid,$2,NULL,0) r', [uid, mode])).r; } catch (e) { r = { error: e.message }; }
    if (r && r.reason === 'ACTIVITE_RECENTE_ANCIEN_APPAREIL') { await sleep(300); continue; }
    return r;
  }
  return { error: 'ACTIVITE_RECENTE persistante' };
}
async function toDocuments(k) {
  const uid = await uidOf(k);
  await q('INSERT INTO public.doc_store_testers(user_id) VALUES ($1::uuid) ON CONFLICT DO NOTHING', [uid]);
  return flip(uid, 'documents');
}

// ---------------------------------------------------------------- appareil « documents » (docstore.js réel + client réel)
const DocStore = require('../docstore.js');
const memStorage = () => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; }, m }; };
const clone = (v) => JSON.parse(JSON.stringify(v));
class Device {
  constructor(who, o = {}) {
    this.who = who; this.storage = o.storage || memStorage(); this.timers = []; this.notes = []; this.calls = []; this.net = { offline: false, dropAfter: null, gate: null };
    this.state = { invoices: [], quotes: [], payments: [], docLog: [] };
    const self = this, base = who.c;
    this.client = {
      auth: base.auth, from: (t) => base.from(t),
      async rpc(fn, args) {
        self.calls.push({ fn, op: args && args.p_op_id, t: Date.now() });
        if (self.net.offline && fn !== 'get_doc_mode') return { data: null, error: { message: 'TypeError: Failed to fetch' }, status: 0 };
        const r = await base.rpc(fn, args);
        if (self.net.dropAfter && self.net.dropAfter.fn === fn && self.net.dropAfter.n > 0) { self.net.dropAfter.n--; return { data: null, error: { message: 'TypeError: Failed to fetch' }, status: 0 }; }   // réponse perdue : le serveur a répondu, le client ne le sait pas
        if (self.net.gate && self.net.gate.fn === fn) await self.net.gate.promise;
        return r;
      }
    };
    this.store = DocStore.createStore({
      client: this.client, userId: who.uid, email: who.email, url: CTX.url, storage: this.storage, uuid: () => crypto.randomUUID(),
      notify: (l, m) => this.notes.push([l, m]), isOnline: () => true, onChange: () => {},
      timers: { set: (f, ms) => { const t = { f, ms, done: false }; this.timers.push(t); return t; }, clear: (t) => { if (t) t.done = true; } },
      onReload: (st) => { this.state = clone(st); },
      onApply: (key, doc, op, id) => { const a = this.state[key].slice(); const i = a.findIndex((d) => d.id === (doc ? doc.id : id)); if (op === 'remove') { if (i >= 0) a.splice(i, 1); } else if (i >= 0) a[i] = doc; else a.push(doc); this.state[key] = a; }
    });
  }
  async start() { const r = await this.store.start(); if (r.state) this.state = clone(r.state); return r; }
  commit(key, next) { this.state[key] = next; return this.store.commit(key, clone(next)); }
  create(id, over = {}) { const d = inv(id, over); this.commit('invoices', this.state.invoices.concat([d])); return d; }
  edit(id, patch) { const next = this.state.invoices.map((d) => d.id === id ? { ...d, ...patch } : d); this.commit('invoices', next); return next.find((d) => d.id === id); }
  remove(id) { this.commit('invoices', this.state.invoices.filter((d) => d.id !== id)); }
  pendingTimers() { return this.timers.filter((t) => !t.done); }
  async fire() { for (const t of this.pendingTimers()) { t.done = true; await t.f(); } await this.settle(); }
  async settle(ms = 90000) {
    await sleep(15); const t0 = Date.now();
    for (;;) {
      const s = this.store.status();
      if (!s.flushing && (s.pending === 0 || s.halted || s.conflicts || this.pendingTimers().length)) { await sleep(15); const s2 = this.store.status(); if (!s2.flushing) return s2; }
      if (Date.now() - t0 > ms) throw new Error('settle : délai dépassé ' + jstr(s));
      await sleep(40);
    }
  }
  rpcs(fn) { return this.calls.filter((c) => c.fn === fn); }
}
const inv = (id, over = {}) => ({ id, type: 'invoice', number: 'BRO-' + id, status: 'draft', date: `${Y}-03-01`, clientId: 'c1', clientName: 'Client UI', items: [{ description: 'Prestation', quantity: 1, price: 10 }], totalHT: 10, totalTVA: 2, totalTTC: 12, paidAmount: 0, ...over });
const docsOf = (uid) => q("SELECT doc_type, id, version, number, status, body FROM public.documents WHERE user_id=$1::uuid ORDER BY created_at, id", [uid]);
const rpcErr = (r) => r && r.error ? `${r.error.code || '?'} ${r.error.message || ''}`.trim() : '';
const sqlst = (r) => (r && r.error && r.error.code) || '';

// ================================================================ SECTION N : protocole réel
async function sectionN() {
  out('\n### N. Protocole réel (PostgREST + GoTrue + RPC, docstore.js, client supabase-js réel)');
  const D = await signIn('d'), E = await signIn('e'), G = await signIn('g'), O = await signIn('o');
  for (const S of [D, E, G, O]) { const r = await S.c.rpc('my_license'); if (r.error) throw new Error('my_license : ' + rpcErr(r)); }
  // ---- N1 modes décidés par le serveur
  const modes = {}; for (const S of [D, E, G, O]) modes[S.k] = (await S.c.rpc('get_doc_mode')).data;
  rec('N1', 'mode décidé par le serveur (get_doc_mode) : comptes de test basculés = documents ; compte ordinaire = legacy', 'd,e,g = documents ; o = legacy', jstr(modes), modes.d === 'documents' && modes.e === 'documents' && modes.g === 'documents' && modes.o === 'legacy', { proof: 'réponses get_doc_mode via PostgREST' });
  const ordW = await O.c.rpc('upsert_document', { p_doc: inv('ord1'), p_expected_version: 0, p_op_id: 'o:ord1:1' });
  rec('N1b', 'compte ordinaire : écriture dans le nouveau stockage refusée par le serveur', 'MODE_ANCIEN_STOCKAGE', rpcErr(ordW), /MODE_ANCIEN_STOCKAGE/.test(JSON.stringify(ordW.error || {})) && (await docsOf(O.uid)).length === 0, { sqlstate: sqlst(ordW), proof: 'aucune ligne dans documents pour ui-o', fatal: true });

  // ---- N2 création et lecture réelles via PostgREST (2 appareils)
  const d1 = new Device(D); const s1 = await d1.start();
  rec('N2a', 'appareil 1 : démarrage en mode documents (get_doc_mode réel), chargement initial vide', 'mode documents', `${s1.mode} (${s1.reason || ''})`, s1.mode === 'documents');
  d1.create('n2-d1', { clientName: 'Brouillon 1' }); d1.create('n2-d2', { clientName: 'Brouillon 2' });
  const num = (await D.c.rpc('next_doc_number', { p_type: 'invoice', p_floor: 0 })).data;
  const numStr = `FAC-${Y}-${String(num).padStart(3, '0')}`;
  d1.create('n2-i1', { status: 'sent', number: numStr, clientName: 'Émise' });
  d1.commit('quotes', [{ id: 'n2-q1', type: 'quote', number: 'DEV-' + Y + '-001', status: 'draft', clientId: 'c1', clientName: 'Devis', items: [], totalHT: 0, totalTVA: 0, totalTTC: 0, date: `${Y}-03-01` }]);
  const st1 = await d1.settle();
  const rows1 = await docsOf(D.uid);
  rec('N2b', 'création réelle via upsert_document : 3 factures + 1 devis stockés (version 1), file vide', '4 lignes documents, pending 0', `${rows1.length} lignes ; pending ${st1.pending} ; versions ${rows1.map((r) => r.version).join(',')}`, rows1.length === 4 && st1.pending === 0 && rows1.every((r) => r.version === 1), { proof: `ids ${rows1.map((r) => r.id).join(',')}`, fatal: true });
  const d2 = new Device(D); const s2 = await d2.start();
  const same = s2.state && s2.state.invoices.length === 3 && s2.state.quotes.length === 1 && s2.state.invoices.find((i) => i.id === 'n2-i1').number === numStr;
  rec('N2c', 'lecture réelle via PostgREST par un autre appareil : mêmes documents', '3 factures + 1 devis, numéro émis identique', s2.state ? `${s2.state.invoices.length} factures, ${s2.state.quotes.length} devis` : 'aucun état', same, { proof: `numéro ${numStr}`, fatal: true });
  const ledger = await q1("SELECT count(*)::int n FROM public.user_data WHERE user_id=$1::uuid AND key IN ('invoices','quotes','payments','docLog')", [D.uid]);
  rec('N2d', 'aucune écriture dans user_data pour les 4 clés en mode documents', '0 ligne', `${ledger.n} ligne(s)`, ledger.n === 0, { fatal: true });

  // ---- N3 pagination + tri (plus de 1000 lignes : plafond PostgREST)
  const BULK = 1250, t0 = Date.now(); let bulkErr = '';
  for (let off = 0; off < BULK; off += 10) {
    const batch = []; for (let i = off; i < Math.min(off + 10, BULK); i++) batch.push(D.c.rpc('upsert_document', { p_doc: inv('bulk-' + String(i).padStart(4, '0'), { clientName: 'Bulk ' + i }), p_expected_version: 0, p_op_id: 'bulk:' + i }));
    for (const r of await Promise.all(batch)) if (r.error || !r.data || r.data.ok !== true) bulkErr = bulkErr || clip(jstr(r.error || r.data), 160);
  }
  const hist = []; for (let i = 0; i < 1100; i++) hist.push({ id: 'h-' + String(i).padStart(4, '0'), ts: new Date(Date.UTC(Y, 0, 1) + i * 1000).toISOString(), action: 'bulk', i });
  for (let i = 0; i < hist.length; i += 100) { const r = await D.c.rpc('append_history', { p_entries: hist.slice(i, i + 100), p_op_id: 'hist:' + i }); if (r.error) bulkErr = bulkErr || clip(jstr(r.error), 160); }
  const total = (await q1('SELECT count(*)::int n FROM public.documents WHERE user_id=$1::uuid', [D.uid])).n;
  rec('N3a', `création de ${BULK} brouillons + 1100 entrées de journal (${Math.round((Date.now() - t0) / 1000)} s)`, `${BULK + 4} documents en base, aucune erreur`, `${total} documents ; erreurs : ${bulkErr || 'aucune'}`, total === BULK + 4 && !bulkErr, { fatal: true });
  let reqs = 0; const d3 = new Device({ ...D, c: { auth: D.c.auth, rpc: (f, a) => D.c.rpc(f, a), from: (t) => { reqs++; return D.c.from(t); } } });
  const s3 = await d3.start(); const inv3 = s3.state.invoices;
  const ids = inv3.map((x) => x.id), uniq = new Set(ids).size;
  const dbOrder = (await q('SELECT id FROM public.documents WHERE user_id=$1::uuid AND doc_type<>\'quote\' ORDER BY created_at, id', [D.uid])).map((r) => r.id);
  rec('N3b', 'lecture paginée (plafond serveur 1000) : aucun document manquant ni dupliqué', `${BULK + 3} factures, ids uniques`, `${inv3.length} factures, ${uniq} uniques ; requêtes de lecture : ${reqs}`, inv3.length === BULK + 3 && uniq === inv3.length, { proof: `${reqs} appels from() (documents, paiements, journal)`, fatal: true });
  rec('N3c', 'tri stable : ordre de chargement = ORDER BY created_at, id côté base', 'ordre identique', ids.join() === dbOrder.join() ? 'identique' : `différent (premier écart à l'indice ${ids.findIndex((x, i) => x !== dbOrder[i])})`, ids.join() === dbOrder.join());
  const lg = s3.state.docLog;
  rec('N3d', 'journal paginé (1100 entrées) restitué dans l\'ordre chronologique, sans perte', '1100 entrées, indices 0…1099 dans l\'ordre', `${lg.length} entrées ; ordre ${lg.every((e, i) => e.i === i) ? 'correct' : 'incorrect'}`, lg.length === 1100 && lg.every((e, i) => e.i === i), { fatal: true });

  // ---- N4 contrôle d'accès entre comptes (RLS)
  const rE = await E.c.from('documents').select('id').eq('user_id', D.uid);
  rec('N4a', 'lecture des documents d\'un autre compte (filtre user_id = autre compte)', '0 ligne (RLS)', rE.error ? 'erreur ' + rpcErr({ error: rE.error }) : `${(rE.data || []).length} ligne(s)`, !rE.error && (rE.data || []).length === 0, { sqlstate: rE.error && rE.error.code, proof: 'ui-e lit les documents de ui-d', fatal: true });
  const rAll = await E.c.from('documents').select('user_id');
  rec('N4b', 'lecture sans filtre : uniquement ses propres lignes', 'aucune ligne de ui-d', `${(rAll.data || []).filter((r) => r.user_id === D.uid).length} ligne(s) de ui-d`, !rAll.error && (rAll.data || []).every((r) => r.user_id === E.uid), { fatal: true });
  const before = await q1("SELECT version, body_sha FROM public.documents WHERE user_id=$1::uuid AND id='n2-d1'", [D.uid]);
  const w1 = await E.c.from('documents').insert({ user_id: D.uid, doc_type: 'invoice', id: 'intrus', body: {} });
  const w2 = await E.c.from('documents').update({ body: { hack: true } }).eq('user_id', D.uid);
  const w3 = await E.c.from('documents').delete().eq('user_id', D.uid);
  const after = await q1("SELECT version, body_sha FROM public.documents WHERE user_id=$1::uuid AND id='n2-d1'", [D.uid]);
  const nD = (await q1('SELECT count(*)::int n FROM public.documents WHERE user_id=$1::uuid', [D.uid])).n;
  rec('N4c', 'écritures directes (insert / update / delete) refusées, y compris sur les lignes d\'un autre compte', 'trois refus, données intactes', `${[w1, w2, w3].map((w) => w.error ? w.error.code : 'ACCEPTÉ').join(' / ')} ; documents ui-d : ${nD}`, [w1, w2, w3].every((w) => w.error) && before.version === after.version && before.body_sha === after.body_sha && nD === BULK + 4, { sqlstate: [w1, w2, w3].map((w) => w.error && w.error.code).join('/'), proof: 'version et empreinte du document n2-d1 inchangées', fatal: true });
  const cross = await E.c.rpc('upsert_document', { p_doc: inv('n2-d1', { clientName: 'Pris par ui-e' }), p_expected_version: 1, p_op_id: 'e:cross:1' });
  const eDoc = await q1("SELECT version, body->>'clientName' c FROM public.documents WHERE user_id=$1::uuid AND id='n2-d1'", [E.uid]);
  const dDoc = await q1("SELECT version, body->>'clientName' c FROM public.documents WHERE user_id=$1::uuid AND id='n2-d1'", [D.uid]);
  rec('N4d', 'upsert_document par ui-e avec l\'identifiant d\'un document de ui-d : n\'atteint jamais le document de ui-d', 'ui-d inchangé (Brouillon 1)', `ui-d : ${dDoc.c} v${dDoc.version} ; ui-e : ${eDoc ? eDoc.c + ' v' + eDoc.version : 'aucun'} ; réponse ${cross.error ? rpcErr(cross) : jstr(cross.data)}`, dDoc.c === 'Brouillon 1' && dDoc.version === 1, { sqlstate: sqlst(cross), proof: 'l\'espace de ui-e est distinct (clé (user_id, id))', fatal: true });
  const pay = await E.c.rpc('record_payment', { p_invoice_id: 'n2-i1', p_payment: { id: 'intrus-pay', invoiceId: 'n2-i1', amount: 5, date: `${Y}-03-02`, method: 'cash' }, p_op_id: 'e:pay:1' });
  const payRows = (await q1("SELECT count(*)::int n FROM public.doc_payments WHERE user_id=$1::uuid", [D.uid])).n;
  rec('N4e', 'paiement sur la facture d\'un autre compte refusé', 'erreur, aucun paiement chez ui-d', `${rpcErr(pay) || jstr(pay.data)} ; paiements ui-d : ${payRows}`, payRows === 0, { sqlstate: sqlst(pay), fatal: true });
  const anon = mkClient(); const ra = await anon.from('documents').select('id').limit(1);
  rec('N4f', 'lecture anonyme (clé anon sans session)', 'refus ou 0 ligne', ra.error ? 'erreur ' + ra.error.code : `${(ra.data || []).length} ligne(s)`, !!ra.error || (ra.data || []).length === 0, { sqlstate: ra.error && ra.error.code });

  // ---- N5 licence inactive (réelle) en mode documents
  const a1 = new Device(E); await a1.start();
  await q("UPDATE public.licenses SET status='suspended', expires_at = now() - interval '60 days', updated_at = now() WHERE user_id=$1::uuid", [E.uid]);
  a1.create('n5-1', { clientName: 'Pendant licence inactive' });
  const s5 = await a1.settle(); const nCalls = a1.rpcs('upsert_document').length;
  rec('N5a', 'licence inactive : écriture refusée par le serveur, modification CONSERVÉE en file, arrêt net', 'halted=licence, pending=1, 1 appel', `halted=${s5.halted} pending=${s5.pending} appels=${nCalls} ; ${s5.lastError || ''}`, s5.halted === 'licence' && s5.pending === 1 && nCalls === 1, { sqlstate: 'P0001 (LICENCE_INACTIVE)', proof: 'file persistée : ' + (a1.storage.getItem('fpd_q_' + E.uid) || '').length + ' octets', fatal: true });
  await a1.store.flush(); await sleep(200);
  rec('N5b', 'aucune boucle : un nouveau flush est sans effet tant que l\'arrêt n\'est pas levé', 'toujours 1 appel', `${a1.rpcs('upsert_document').length} appel(s)`, a1.rpcs('upsert_document').length === 1 && a1.pendingTimers().length === 0);
  await q("UPDATE public.licenses SET status='active', expires_at = now() + interval '30 days', updated_at = now() WHERE user_id=$1::uuid", [E.uid]);
  await a1.store.retryNow(); const s5c = await a1.settle();
  const eRows = await q("SELECT id FROM public.documents WHERE user_id=$1::uuid AND id='n5-1'", [E.uid]);
  rec('N5c', 'licence rétablie + « Réessayer » : la modification conservée arrive au serveur', 'pending 0, document présent', `pending ${s5c.pending}, ${eRows.length} ligne`, s5c.pending === 0 && eRows.length === 1, { proof: 'document n5-1 présent pour ui-e', fatal: true });

  // ---- N6 conflits entre deux appareils (deux « navigateurs » du même compte)
  const X = new Device(D), Y_ = new Device(D); await X.start(); await Y_.start();
  X.create('c6-a', { clientName: 'v1 (X)' }); await X.settle();
  await Y_.store.reload(); await Y_.settle();
  X.edit('c6-a', { clientName: 'v2 (X)' }); await X.settle();
  Y_.edit('c6-a', { clientName: 'v2 (Y, périmée)' }); const sY = await Y_.settle();
  const srv = await q1("SELECT version, body->>'clientName' c FROM public.documents WHERE user_id=$1::uuid AND id='c6-a'", [D.uid]);
  rec('N6a', 'modification simultanée d\'un brouillon : le second appareil reçoit un CONFLIT, rien n\'est écrasé', 'conflit enregistré, serveur = v2 (X)', `conflits ${sY.conflicts} ; serveur ${srv.c} v${srv.version}`, sY.conflicts === 1 && srv.c === 'v2 (X)' && srv.version === 2, { proof: 'version serveur 2, contenu de X', fatal: true });
  const cf = Y_.store.conflicts[0];
  rec('N6b', 'le conflit conserve les DEUX versions', 'ma version + version serveur', `mine=${cf && cf.mine && cf.mine.clientName} ; serveur=${cf && cf.server_doc && cf.server_doc.clientName} v${cf && cf.server_version}`, !!cf && cf.mine.clientName === 'v2 (Y, périmée)' && cf.server_doc.clientName === 'v2 (X)');
  Y_.store.resolveConflict('c6-a', 'keep-mine', Y_.state.invoices); const sY2 = await Y_.settle();
  const srv2 = await q1("SELECT version, body->>'clientName' c FROM public.documents WHERE user_id=$1::uuid AND id='c6-a'", [D.uid]);
  rec('N6c', 'résolution explicite « garder la mienne » : réappliquée sur la version serveur', 'serveur = v2 (Y) version 3', `serveur ${srv2.c} v${srv2.version} ; conflits ${sY2.conflicts}`, srv2.c === 'v2 (Y, périmée)' && srv2.version === 3 && sY2.conflicts === 0, { fatal: true });
  X.create('c6-b', { clientName: 'à supprimer' }); await X.settle(); await Y_.store.reload(); await Y_.settle();
  X.remove('c6-b'); await X.settle();
  Y_.edit('c6-b', { clientName: 'modifié pendant la suppression' }); const sY3 = await Y_.settle();
  const gone = await q("SELECT 1 FROM public.documents WHERE user_id=$1::uuid AND id='c6-b'", [D.uid]);
  const cfb = Y_.store.conflicts.find((c) => c.id === 'c6-b');
  rec('N6d', 'modification d\'un brouillon supprimé ailleurs : conflit « supprimé », jamais recréé en silence', 'conflit sans version serveur, document absent', `conflit ${cfb ? (cfb.server_doc ? 'avec version serveur' : 'supprimé') : 'aucun'} ; lignes ${gone.length}`, !!cfb && !cfb.server_doc && gone.length === 0, { proof: 'la version locale reste dans le conflit', fatal: true });
  Y_.store.resolveConflict('c6-b', 'keep-server', Y_.state.invoices); await Y_.settle();
  rec('N6e', 'résolution « garder le serveur » : version locale abandonnée explicitement', 'document retiré localement, conflits 0', `local ${Y_.state.invoices.some((d) => d.id === 'c6-b') ? 'présent' : 'absent'} ; conflits ${Y_.store.status().conflicts}`, !Y_.state.invoices.some((d) => d.id === 'c6-b') && Y_.store.status().conflicts === 0);

  // ---- N7 réponse perdue après acceptation serveur : idempotence
  const L = new Device(G); await L.start();
  L.net.dropAfter = { fn: 'upsert_document', n: 1 };
  L.create('n7-1', { clientName: 'réponse perdue' }); const s7 = await L.settle();
  const mid = await docsOf(G.uid);
  rec('N7a', 'réponse perdue (le serveur a appliqué) : le client croit à un échec réseau et garde l\'opération', 'pending 1, document déjà en base (1 ligne)', `pending ${s7.pending} ; base : ${mid.filter((r) => r.id === 'n7-1').length} ligne`, s7.pending === 1 && mid.filter((r) => r.id === 'n7-1').length === 1, { nature: NET, proof: 'client : erreur réseau simulée APRÈS la réponse réelle du serveur' });
  await L.fire();
  const fin = (await docsOf(G.uid)).filter((r) => r.id === 'n7-1'), ops = L.rpcs('upsert_document').map((c) => c.op);
  rec('N7b', 'rejeu avec le même op_id : aucune duplication, version inchangée', '1 ligne, version 1, deux appels au même op_id', `${fin.length} ligne, v${fin[0] && fin[0].version} ; ops ${ops.length} (${new Set(ops).size} distinct)`, fin.length === 1 && fin[0].version === 1 && ops.length === 2 && new Set(ops).size === 1, { nature: NET, proof: `op_id ${ops[0]}`, fatal: true });
  const gnum = (await G.c.rpc('next_doc_number', { p_type: 'invoice', p_floor: 0 })).data; const gstr = `FAC-${Y}-${String(gnum).padStart(3, '0')}`;
  L.create('n7-2', { status: 'sent', number: gstr, clientName: 'Émise pour paiement', totalTTC: 100, totalHT: 83.33, totalTVA: 16.67 }); await L.settle();
  L.net.dropAfter = { fn: 'record_payment', n: 1 };
  L.commit('payments', [{ id: 'n7-pay', invoiceId: 'n7-2', amount: 40, date: `${Y}-03-05`, method: 'cash' }]); const s7p = await L.settle();
  await L.fire();
  const pays = await q("SELECT id, amount FROM public.doc_payments WHERE user_id=$1::uuid", [G.uid]);
  const invRow = await q1("SELECT status, paid_amount FROM public.documents WHERE user_id=$1::uuid AND id='n7-2'", [G.uid]);
  rec('N7c', 'paiement : réponse perdue puis rejeu → UN seul paiement, montant payé = 40 (pas 80)', '1 paiement, paid_amount 40', `${pays.length} paiement(s) ; paid_amount ${invRow.paid_amount} ; statut ${invRow.status}`, pays.length === 1 && Number(invRow.paid_amount) === 40, { nature: NET, proof: 'doc_payments : ' + jstr(pays), fatal: true });

  // ---- N8 déconnexion pendant un envoi
  const M = new Device(G); await M.start();
  let release; M.net.gate = { fn: 'upsert_document', promise: new Promise((r) => { release = r; }) };
  M.create('n8-1', { clientName: 'en vol' }); await sleep(400);
  M.create('n8-2', { clientName: 'suivante 1' }); M.create('n8-3', { clientName: 'suivante 2' });
  const qBefore = JSON.parse(M.storage.getItem('fpd_q_' + G.uid) || '[]');
  M.store.reset();                              // déconnexion pendant l'envoi de n8-1
  release(); await sleep(1500);
  const qAfter = JSON.parse(M.storage.getItem('fpd_q_' + G.uid) || '[]');
  rec('N8a', 'déconnexion pendant un envoi : la file persistée garde les opérations suivantes', 'n8-2 et n8-3 toujours en file', `avant ${qBefore.map((o) => o.id)} / après ${qAfter.map((o) => o.id)}`, qBefore.length === 3 && qAfter.some((o) => o.id === 'n8-2') && qAfter.some((o) => o.id === 'n8-3'), { nature: NET, proof: 'stockage local du magasin déconnecté', fatal: true });
  const M2 = new Device(G, { storage: M.storage }); const r8 = await M2.start(); await M2.store.flush(); await M2.settle();
  const n8 = (await docsOf(G.uid)).filter((r) => /^n8-/.test(r.id));
  rec('N8b', 'reconnexion : les trois documents arrivent, chacun UNE fois (l\'envoi interrompu est rejoué sans doublon)', 'n8-1, n8-2, n8-3 ; versions 1', `${n8.map((r) => r.id + ' v' + r.version).join(', ')} ; file ${M2.store.status().pending}`, n8.length === 3 && n8.every((r) => r.version === 1) && M2.store.status().pending === 0, { nature: NET, fatal: true });

  // ---- N9 numérotation concurrente + isolation des compteurs
  const [E2, D2c] = [await signIn('e'), await signIn('d')];
  const callsN = (S, n) => Array.from({ length: n }, () => S.c.rpc('next_doc_number', { p_type: 'invoice', p_floor: 0 }));
  const bE0 = (await q1("SELECT last_value FROM public.doc_counters WHERE user_id=$1::uuid AND doc_type='invoice'", [E.uid]) || { last_value: 0 }).last_value;
  const bD0 = (await q1("SELECT last_value FROM public.doc_counters WHERE user_id=$1::uuid AND doc_type='invoice'", [D.uid]) || { last_value: 0 }).last_value;
  const [rE_, rE2_, rD_] = await Promise.all([Promise.all(callsN(E, 8)), Promise.all(callsN(E2, 8)), Promise.all(callsN(D2c, 8))]);
  const numsE = [...rE_, ...rE2_].map((r) => r.data).sort((a, b) => a - b), numsD = rD_.map((r) => r.data).sort((a, b) => a - b);
  const contiguous = (arr, from) => arr.every((v, i) => v === from + 1 + i);
  rec('N9a', '16 attributions simultanées (2 sessions du même compte) : numéros distincts et consécutifs', `${Number(bE0) + 1}…${Number(bE0) + 16}`, numsE.join(','), new Set(numsE).size === 16 && contiguous(numsE, Number(bE0)), { proof: 'compteur serveur atomique (doc_counters)', fatal: true });
  rec('N9b', 'un autre compte, en même temps : séquence indépendante', `${Number(bD0) + 1}…${Number(bD0) + 8}`, numsD.join(','), new Set(numsD).size === 8 && contiguous(numsD, Number(bD0)), { fatal: true });
  const dev9 = new Device(E); await dev9.start();
  const issue = numsE.slice(0, 6).map((n, i) => ({ id: 'n9-' + i, n }));
  dev9.commit('invoices', dev9.state.invoices.concat(issue.map(({ id, n }) => inv(id, { status: 'sent', number: `FAC-${Y}-${String(n).padStart(3, '0')}`, clientName: 'Émission ' + id }))));
  await dev9.settle();
  const sent = await q("SELECT number FROM public.documents WHERE user_id=$1::uuid AND id LIKE 'n9-%' ORDER BY number", [E.uid]);
  rec('N9c', 'émission de 6 factures avec ces numéros : toutes acceptées, numéros uniques', '6 factures distinctes', `${sent.length} : ${sent.map((r) => r.number.slice(-3)).join(',')}`, sent.length === 6 && new Set(sent.map((r) => r.number)).size === 6, { fatal: true });
  const dup = await E.c.rpc('upsert_document', { p_doc: inv('n9-dup', { status: 'sent', number: `FAC-${Y}-${String(issue[0].n).padStart(3, '0')}` }), p_expected_version: 0, p_op_id: 'n9:dup' });
  rec('N9d', 'numéro déjà utilisé par une autre facture : refus explicite (jamais de doublon)', 'NUMERO_EN_DOUBLE', rpcErr(dup) || jstr(dup.data), /NUMERO_EN_DOUBLE/.test(JSON.stringify(dup.error || {})), { sqlstate: sqlst(dup), fatal: true });
  const unassigned = await E.c.rpc('upsert_document', { p_doc: inv('n9-hole', { status: 'sent', number: `FAC-${Y}-${String(Number(bE0) + 999).padStart(3, '0')}` }), p_expected_version: 0, p_op_id: 'n9:hole' });
  rec('N9e', 'numéro jamais attribué par le serveur : refusé', 'NUMERO_NON_ATTRIBUE', rpcErr(unassigned) || jstr(unassigned.data), /NUMERO_NON_ATTRIBUE/.test(JSON.stringify(unassigned.error || {})), { sqlstate: sqlst(unassigned), fatal: true });

  // ---- N10 retour au legacy avec une file locale non vide
  const R = new Device(G); await R.start();
  R.net.offline = true;
  R.create('n10-1', { clientName: 'hors ligne 1' }); R.create('n10-2', { clientName: 'hors ligne 2' }); const s10 = await R.settle();
  rec('N10a', 'réseau coupé (côté client) : deux brouillons conservés en file persistée', 'pending 2, minuteur de reprise armé', `pending ${s10.pending} ; minuteurs ${R.pendingTimers().length}`, s10.pending === 2, { nature: NET });
  const gUid = G.uid; const f1 = await flip(gUid, 'legacy');
  rec('N10b', 'retour du compte au mode ancien (bascule contrôlée, compte jetable)', 'ok, mode legacy', jstr(f1).slice(0, 200), !!f1 && f1.ok === true && !f1.error, { proof: 'fp_doc_mode_set(uid, legacy)' });
  const ud = await q1("SELECT jsonb_array_length(value) n FROM public.user_data WHERE user_id=$1::uuid AND key='invoices'", [gUid]);
  const docsLeft = (await docsOf(gUid)).filter((r) => r.doc_type !== 'quote').length;
  rec('N10c', 'les documents déjà acceptés sont repassés dans user_data.invoices (aucune perte)', `${docsLeft} documents ↔ user_data`, `user_data.invoices : ${ud && ud.n}`, !!ud && ud.n >= 1, { proof: 'comptage user_data.invoices après le retour' });
  const R2 = new Device(G, { storage: R.storage }); const s10b = await R2.start();
  rec('N10d', 'nouveau démarrage : mode legacy, file locale SIGNALÉE (orphan), jamais rejouée', 'legacy, orphan.pending=2, aucun envoi', `${s10b.mode} ; orphan ${jstr(s10b.orphan)} ; rpc d'écriture ${R2.rpcs('upsert_document').length}`, s10b.mode === 'legacy' && !!s10b.orphan && s10b.orphan.pending === 2 && R2.rpcs('upsert_document').length === 0, { fatal: true });
  const exp = JSON.parse(R2.store.exportRecovery());
  rec('N10e', 'export de récupération : file complète avec le contenu des brouillons', 'n10-1, n10-2 et leur contenu', `file ${exp.queue.map((o) => o.id + '=' + (o.doc && o.doc.clientName)).join(' | ')}`, exp.queue.length === 2 && exp.queue.every((o) => o.doc && /hors ligne/.test(o.doc.clientName)), { proof: 'JSON exporté (queue, conflicts, rejected, caches)' });
  const replay = await G.c.rpc('upsert_document', { p_doc: exp.queue[0].doc, p_expected_version: 0, p_op_id: exp.queue[0].opId });
  const noDoc = (await docsOf(gUid)).filter((r) => /^n10-/.test(r.id));
  rec('N10f', 'rejeu forcé d\'une opération orpheline en mode legacy : refusé par le serveur', 'MODE_ANCIEN_STOCKAGE, aucun document n10-*', `${rpcErr(replay)} ; documents n10 : ${noDoc.length}`, /MODE_ANCIEN_STOCKAGE/.test(JSON.stringify(replay.error || {})) && noDoc.length === 0, { sqlstate: sqlst(replay), proof: 'indice (hint) : ' + clip(replay.error && replay.error.hint, 80), fatal: true });
  const lw = await G.c.from('user_data').upsert({ user_id: gUid, key: 'company', value: { name: 'écriture ancien format après retour' } }, { onConflict: 'user_id,key' });
  const lwv = await q1("SELECT value->>'name' n FROM public.user_data WHERE user_id=$1::uuid AND key='company'", [gUid]);
  rec('N10g', 'ancien stockage de nouveau fonctionnel après le retour', 'écriture user_data acceptée', lw.error ? rpcErr({ error: lw.error }) : `acceptée (${lwv && lwv.n})`, !lw.error && lwv && /après retour/.test(lwv.n), { sqlstate: lw.error && lw.error.code });
}

// ================================================================ SECTION B/U : navigateur réel (Chromium) — voir preprod-ui-browser.js
async function sectionBrowser() {
  const mod = require('./preprod-ui-browser.js');
  await mod.run({ rec, q, q1, uidOf, EMAIL, pw, CTX, flip, toDocuments, NATURE, sleep, clip, Y, jstr });
}

// ================================================================ commandes
async function guardtests() {
  out('### 1. Contrôles de cible (exécutés, sans connexion)');
  const { parseDbUrl } = require('./preprod-db');
  const bad = (n, u, re) => { try { parseDbUrl(u); rec('G-' + n, n, 'refus', 'aucune erreur', false); } catch (e) { rec('G-' + n, n, 'refus', e.message, re.test(e.message)); } };
  bad('URL du pooleur de la PRODUCTION refusée', `postgresql://postgres.${T.prodRef}:FAKEPW@aws-0-eu-west-3.pooler.supabase.com:5432/postgres`, /PRODUCTION/);
  bad('URL directe de la PRODUCTION refusée', `postgresql://postgres:FAKEPW@db.${T.prodRef}.supabase.co:5432/postgres`, /PRODUCTION/);
  const g = (url, key) => spawnSync('node', ['-e', "require('./scripts/preprod-guard').guard(process.argv[1], process.argv[2])", url, key], { cwd: ROOT, encoding: 'utf8' });
  rec('G-api-prod', 'API : URL de la PRODUCTION refusée', 'refus', 'code ' + g(`https://${T.prodRef}.supabase.co`, T.anonKey).status, g(`https://${T.prodRef}.supabase.co`, T.anonKey).status === 1);
  if (!DRY) {
    const real = parseDbUrl(process.env.PREPROD_DB_URL);
    rec('G-cible', 'cible réelle (secret) = préproduction', T.preprodRef, real.ref, real.ref === T.preprodRef && real.ref !== T.prodRef);
    const G = require('./preprod-guard').guard(process.env.PREPROD_URL, process.env.PREPROD_ANON_KEY);
    rec('G-api', 'API : URL et clé anon de la préproduction acceptées', T.preprodRef, G.ref, G.ref === T.preprodRef);
  }
}

// ================================================================ SECTION F : règles fonctionnelles côté serveur (factures, devis, paiements, licence, session)
// Réel : appels RPC / PostgREST authentifiés sur la préproduction. Simulé (répétition locale) : même code contre PostgreSQL local avec faux client.
// Données : uniquement des documents « f-* » du compte jetable ui-e (mode documents).
async function sectionF() {
  out('\n### F. Règles fonctionnelles (factures, devis, paiements, licence, session)');
  const E = await signIn('e');
  const call = (fn, args) => E.c.rpc(fn, args);
  const up = (doc, v, op) => call('upsert_document', { p_doc: doc, p_expected_version: v, p_op_id: op });
  const msg = (r) => (r && r.error ? `${r.error.code || ''} ${r.error.message || ''}` : jstr(r && r.data)).trim();
  const row = async (type, id) => (await q('SELECT version, status, number, body FROM public.documents WHERE user_id=$1::uuid AND doc_type=$2 AND id=$3', [E.uid, type, id]))[0];
  const numStr = async () => { const n = (await call('next_doc_number', { p_type: 'invoice', p_floor: 0 })).data; return `FAC-${Y}-${String(n).padStart(3, '0')}`; };
  const events = (id) => q('SELECT action, detail FROM public.doc_events WHERE user_id=$1::uuid AND doc_id=$2', [E.uid, id]);

  // ---- F1 factures : brouillon, modification, émission, verrouillage
  const d1 = await up(inv('f-d1', { clientName: 'Brouillon A' }), 0, 'f:d1:1');
  const d1b = await up(inv('f-d1', { clientName: 'Brouillon B', totalHT: 20, totalTVA: 4, totalTTC: 24 }), 1, 'f:d1:2');
  const r1 = await row('invoice', 'f-d1');
  rec('F1a', 'brouillon créé puis modifié librement (versions 1 puis 2)', 'v1 puis v2, contenu modifié', `${msg(d1).slice(0, 60)} ; ${msg(d1b).slice(0, 60)} ; base v${r1.version} ${r1.body.clientName}`, d1.data && d1.data.ok && d1b.data && d1b.data.ok && r1.version === 2 && r1.body.clientName === 'Brouillon B', { fatal: true, sqlstate: sqlst(d1b) });
  const nF = await numStr();
  const em = await up({ ...inv('f-d1', { clientName: 'Brouillon B', totalHT: 20, totalTVA: 4, totalTTC: 24 }), status: 'sent', number: nF }, 2, 'f:d1:3');
  const ev = await events('f-d1');
  rec('F1b', 'émission avec un numéro attribué par le serveur : acceptée, événement « emission » consigné', `statut sent, numéro ${nF}, événement emission`, `${msg(em).slice(0, 70)} ; événements : ${ev.map((x) => x.action).join(',')}`, em.data && em.data.ok && (await row('invoice', 'f-d1')).status === 'sent' && ev.some((x) => x.action === 'emission'), { fatal: true, sqlstate: sqlst(em) });
  const mod = await up({ ...inv('f-d1', { clientName: 'Brouillon B', totalHT: 20, totalTVA: 4, totalTTC: 24, items: [{ description: 'Autre', quantity: 9, price: 1 }] }), status: 'sent', number: nF }, 3, 'f:d1:4');
  rec('F1c', 'facture émise : modification des lignes REFUSÉE', 'FACTURE_VERROUILLEE', msg(mod).slice(0, 120), /FACTURE_VERROUILLEE/.test(msg(mod)) && (await row('invoice', 'f-d1')).version === 3, { fatal: true, sqlstate: sqlst(mod), proof: 'version inchangée (3)' });
  const back = await up({ ...inv('f-d1', { clientName: 'Brouillon B', totalHT: 20, totalTVA: 4, totalTTC: 24 }), status: 'draft', number: nF }, 3, 'f:d1:5');
  rec('F1d', 'facture émise : retour au brouillon REFUSÉ', 'FACTURE_VERROUILLEE', msg(back).slice(0, 120), /FACTURE_VERROUILLEE/.test(msg(back)), { fatal: true, sqlstate: sqlst(back) });
  const delI = await call('delete_document', { p_type: 'invoice', p_id: 'f-d1', p_expected_version: 3, p_op_id: 'f:d1:6' });
  rec('F1e', 'facture émise : suppression REFUSÉE ; la facture existe toujours', 'FACTURE_VERROUILLEE', `${msg(delI).slice(0, 100)} ; présente : ${!!(await row('invoice', 'f-d1'))}`, /FACTURE_VERROUILLEE/.test(msg(delI)) && !!(await row('invoice', 'f-d1')), { fatal: true, sqlstate: sqlst(delI) });
  await up(inv('f-d2', { clientName: 'À supprimer' }), 0, 'f:d2:1');
  const delD = await call('delete_document', { p_type: 'invoice', p_id: 'f-d2', p_expected_version: 1, p_op_id: 'f:d2:2' });
  rec('F1f', 'brouillon : suppression acceptée (trace dans doc_deleted)', 'ok, absent, tracé', `${msg(delD).slice(0, 60)} ; absent : ${!(await row('invoice', 'f-d2'))}`, delD.data && delD.data.ok && !(await row('invoice', 'f-d2')) && (await q('SELECT 1 FROM public.doc_deleted WHERE user_id=$1::uuid AND id=$2', [E.uid, 'f-d2'])).length === 1, { fatal: true });

  // ---- F2 devis et conversion en facture (deux écritures : brouillon de facture + devis marqué converti, comme app.html convertQuoteToInvoice)
  const qd = { id: 'f-q1', type: 'quote', number: 'DEV-F-001', status: 'draft', date: `${Y}-03-02`, clientId: 'c1', clientName: 'Client Devis', items: [{ description: 'Étude', quantity: 2, price: 50 }], totalHT: 100, totalTVA: 20, totalTTC: 120 };
  const q1r = await up(qd, 0, 'f:q1:1'), q2r = await up({ ...qd, status: 'accepted' }, 1, 'f:q1:2');
  rec('F2a', 'devis créé puis accepté (le devis reste modifiable, hors numérotation fiscale)', 'v1 puis v2 accepted', `${msg(q1r).slice(0, 40)} ; ${msg(q2r).slice(0, 40)} ; statut ${(await row('quote', 'f-q1')).status}`, q2r.data && q2r.data.ok && (await row('quote', 'f-q1')).status === 'accepted', { fatal: true });
  const conv = inv('f-c1', { clientName: 'Client Devis', items: qd.items, totalHT: 100, totalTVA: 20, totalTTC: 120, sourceQuote: 'f-q1', sourceQuoteNumber: 'DEV-F-001' });
  const c1 = await up(conv, 0, 'f:c1:1'), qc = await up({ ...qd, status: 'accepted', convertedTo: 'f-c1', convertedInvoiceNumber: 'brouillon' }, 2, 'f:c1:2');
  rec('F2b', 'conversion : brouillon de facture créé et devis marqué converti, les deux relus', 'facture f-c1 (brouillon, sourceQuote) + devis convertedTo', `${msg(c1).slice(0, 40)} ; ${msg(qc).slice(0, 40)} ; devis→${(await row('quote', 'f-q1')).body.convertedTo} ; facture←${(await row('invoice', 'f-c1')).body.sourceQuote}`, c1.data && c1.data.ok && qc.data && qc.data.ok && (await row('quote', 'f-q1')).body.convertedTo === 'f-c1' && (await row('invoice', 'f-c1')).body.sourceQuote === 'f-q1', { fatal: true });
  const c1r = await up(conv, 0, 'f:c1:1');
  const nConv = (await q("SELECT count(*)::int n FROM public.documents WHERE user_id=$1::uuid AND body->>'sourceQuote'='f-q1'", [E.uid]))[0].n;
  rec('F2c', 'conversion rejouée (même op_id) : aucune seconde facture', '1 facture issue du devis', `rejeu : ${msg(c1r).slice(0, 80)} ; factures issues du devis : ${nConv}`, nConv === 1, { fatal: true });
  const nC = await numStr();
  const emC = await up({ ...conv, status: 'sent', number: nC }, 1, 'f:c1:3');
  rec('F2d', 'émission de la facture issue du devis : numéro serveur, lien vers le devis conservé', `numéro ${nC}, sourceQuote f-q1`, `${msg(emC).slice(0, 60)} ; ${(await row('invoice', 'f-c1')).number} ; ${(await row('invoice', 'f-c1')).body.sourceQuote}`, emC.data && emC.data.ok && (await row('invoice', 'f-c1')).number === nC && (await row('invoice', 'f-c1')).body.sourceQuote === 'f-q1', { fatal: true });
  const delQ = await call('delete_document', { p_type: 'quote', p_id: 'f-q1', p_expected_version: (await row('quote', 'f-q1')).version, p_op_id: 'f:q1:9' });
  rec('F2e', 'devis (non fiscal) : suppression acceptée, la facture issue du devis est intacte', 'devis absent, facture présente', `${msg(delQ).slice(0, 50)} ; devis absent : ${!(await row('quote', 'f-q1'))} ; facture présente : ${!!(await row('invoice', 'f-c1'))}`, delQ.data && delQ.data.ok && !(await row('quote', 'f-q1')) && !!(await row('invoice', 'f-c1')), { fatal: true });

  // ---- F3 paiements
  await up(inv('f-p0', { clientName: 'Paiement brouillon' }), 0, 'f:p0:1');
  const pay = (id, inv_, amount, op) => call('record_payment', { p_invoice_id: inv_, p_payment: { id, invoiceId: inv_, amount, date: `${Y}-03-03`, method: 'cash' }, p_op_id: op });
  const pDraft = await pay('f-pay-0', 'f-p0', 5, 'f:pay0');
  rec('F3a', 'paiement sur un BROUILLON refusé', 'PAIEMENT_SUR_BROUILLON', msg(pDraft).slice(0, 110), /PAIEMENT_SUR_BROUILLON/.test(msg(pDraft)) && (await q('SELECT 1 FROM public.doc_payments WHERE user_id=$1::uuid AND id=$2', [E.uid, 'f-pay-0'])).length === 0, { fatal: true, sqlstate: sqlst(pDraft) });
  const nP = await numStr();
  await up(inv('f-p1', { clientName: 'Paiements', status: 'sent', number: nP, totalHT: 10, totalTVA: 2, totalTTC: 12 }), 0, 'f:p1:1');
  const pa = await pay('f-pay-a', 'f-p1', 5, 'f:pay-a');
  const afterA = await row('invoice', 'f-p1');
  rec('F3b', 'paiement partiel (5 sur 12) : enregistré, facture NON soldée', 'paidAmount 5, statut sent', `${msg(pa).slice(0, 60)} ; paidAmount ${afterA.body.paidAmount}, statut ${afterA.status}`, pa.data && pa.data.ok && Number(afterA.body.paidAmount) === 5 && afterA.status === 'sent', { fatal: true });
  const paR = await pay('f-pay-a', 'f-p1', 5, 'f:pay-a');
  const nPay = (await q('SELECT count(*)::int n FROM public.doc_payments WHERE user_id=$1::uuid AND invoice_id=$2', [E.uid, 'f-p1']))[0].n;
  rec('F3c', 'même paiement rejoué : une seule ligne, montant payé inchangé (5)', '1 paiement, paidAmount 5', `${msg(paR).slice(0, 60)} ; ${nPay} paiement(s) ; paidAmount ${(await row('invoice', 'f-p1')).body.paidAmount}`, nPay === 1 && Number((await row('invoice', 'f-p1')).body.paidAmount) === 5, { fatal: true });
  const pb = await pay('f-pay-b', 'f-p1', 7, 'f:pay-b');
  const afterB = await row('invoice', 'f-p1');
  rec('F3d', 'second paiement qui solde (5 + 7 = 12) : facture « paid »', 'paidAmount 12, statut paid', `${msg(pb).slice(0, 50)} ; paidAmount ${afterB.body.paidAmount}, statut ${afterB.status}`, Number(afterB.body.paidAmount) === 12 && afterB.status === 'paid', { fatal: true });
  const pBad0 = await pay('f-pay-z', 'f-p1', 0, 'f:pay-z');
  const pBadId = await call('record_payment', { p_invoice_id: 'f-p1', p_payment: { invoiceId: 'f-p1', amount: 3, date: `${Y}-03-04`, method: 'cash' }, p_op_id: 'f:pay-y' });
  const pGhost = await pay('f-pay-g', 'f-inexistante', 3, 'f:pay-x');
  rec('F3e', 'paiements invalides refusés : montant nul, identifiant absent, facture inexistante', 'PAIEMENT_INVALIDE ×2, FACTURE_INTROUVABLE', `${msg(pBad0).slice(0, 40)} | ${msg(pBadId).slice(0, 40)} | ${msg(pGhost).slice(0, 40)}`, /PAIEMENT_INVALIDE/.test(msg(pBad0)) && /PAIEMENT_INVALIDE/.test(msg(pBadId)) && /FACTURE_INTROUVABLE/.test(msg(pGhost)), { fatal: true });
  const amountA = async () => (await q("SELECT body->>'amount' a FROM public.doc_payments WHERE user_id=$1::uuid AND id=$2", [E.uid, 'f-pay-a']))[0].a;
  const wr = await E.c.from('doc_payments').update({ body: { amount: 999 } }).eq('user_id', E.uid).eq('id', 'f-pay-a');
  const wd = await E.c.from('doc_payments').delete().eq('user_id', E.uid).eq('id', 'f-pay-a');
  rec('F3f', 'un paiement enregistré ne se modifie ni ne se supprime par l\'API (écriture directe refusée)', 'refus, paiement intact (5)', `update : ${msg(wr).slice(0, 50)} | delete : ${msg(wd).slice(0, 50)} ; montant ${await amountA()}`, !!wr.error && !!wd.error && (await amountA()) === '5', { fatal: true, sqlstate: sqlst(wr) });

  // ---- F4 licence inactive : TOUTES les écritures refusées, la lecture reste possible
  await q("UPDATE public.licenses SET status='suspended', expires_at = now() - interval '60 days', updated_at = now() WHERE user_id=$1::uuid", [E.uid]);
  const lu = await up(inv('f-lic', { clientName: 'Sans licence' }), 0, 'f:lic:1');
  const lp = await pay('f-pay-l', 'f-p1', 1, 'f:pay-l');
  const ld = await call('delete_document', { p_type: 'invoice', p_id: 'f-p0', p_expected_version: 1, p_op_id: 'f:lic:2' });
  const lh = await call('append_history', { p_entries: [{ ts: new Date().toISOString(), action: 'x' }], p_op_id: 'f:lic:3' });
  const lr = await E.c.from('documents').select('id').eq('user_id', E.uid).limit(1);
  await q("UPDATE public.licenses SET status='active', expires_at = now() + interval '30 days', updated_at = now() WHERE user_id=$1::uuid", [E.uid]);
  rec('F4a', 'licence inactive : upsert, paiement, suppression et journal refusés (LICENCE_INACTIVE) ; aucune ligne créée', 'LICENCE_INACTIVE ×4', [lu, lp, ld, lh].map((r) => (/LICENCE_INACTIVE/.test(msg(r)) ? 'LICENCE_INACTIVE' : msg(r).slice(0, 30))).join(' | ') + ` ; f-lic créé : ${!!(await row('invoice', 'f-lic'))}`, [lu, lp, ld, lh].every((r) => /LICENCE_INACTIVE/.test(msg(r))) && !(await row('invoice', 'f-lic')), { fatal: true, sqlstate: sqlst(lu) });
  rec('F4b', 'licence inactive : la LECTURE de ses propres documents reste possible (aucune perte d\'accès aux données)', 'lecture sans erreur', lr.error ? msg(lr) : `${(lr.data || []).length} ligne(s) lue(s)`, !lr.error && (lr.data || []).length >= 1);
  const lback = await up(inv('f-lic', { clientName: 'Après rétablissement' }), 0, 'f:lic:4');
  rec('F4c', 'licence rétablie : l\'écriture refusée plus haut peut être rejouée', 'ok', msg(lback).slice(0, 80), lback.data && lback.data.ok && !!(await row('invoice', 'f-lic')), { fatal: true });

  // ---- F5 session (réel uniquement : GoTrue n'existe pas dans la répétition locale)
  if (CTX.dry) { rec('F5', 'sessions : connexion, renouvellement, déconnexion, jeton invalide', 'non applicable en répétition locale', 'ignoré (GoTrue réel requis)', true); return; }
  const c2 = mkClient(); const si = await c2.auth.signInWithPassword({ email: EMAIL('e'), password: pw('e') });
  const ok1 = await c2.rpc('get_doc_mode');
  rec('F5a', 'connexion GoTrue réelle : session ouverte, appel authentifié accepté', 'session + get_doc_mode = documents', `${si.error ? clip(si.error.message) : 'session ok'} ; ${ok1.error ? msg(ok1) : ok1.data}`, !si.error && ok1.data === 'documents', { fatal: true });
  const rf = await c2.auth.refreshSession();
  const ok2 = await c2.rpc('get_doc_mode');
  rec('F5b', 'renouvellement de session (refresh token) : nouveau jeton d\'accès valide', 'nouveau jeton, appel accepté', `${rf.error ? clip(rf.error.message) : 'jeton renouvelé'} ; ${ok2.error ? msg(ok2) : ok2.data}`, !rf.error && rf.data.session.access_token !== si.data.session.access_token && ok2.data === 'documents', { fatal: true });
  const oldRefresh = rf.data.session.refresh_token;
  await c2.auth.signOut({ scope: 'local' });
  const c3 = mkClient(); const reuse = await c3.auth.refreshSession({ refresh_token: oldRefresh });
  rec('F5c', 'après déconnexion, l\'ancien refresh token ne rouvre pas la session', 'erreur de refresh', reuse.error ? clip(reuse.error.message) : 'SESSION RÉOUVERTE', !!reuse.error && !(reuse.data && reuse.data.session), { fatal: true });
  const bad = mkClient(); const wp = await bad.auth.signInWithPassword({ email: EMAIL('e'), password: 'mot-de-passe-faux-0000' });
  rec('F5d', 'mauvais mot de passe : refus, aucune session', 'erreur invalid_credentials', wp.error ? `${wp.error.status || ''} ${clip(wp.error.code || wp.error.message)}` : 'SESSION OUVERTE', !!wp.error && !(wp.data && wp.data.session), { fatal: true });
  const forged = await fetch(`${CTX.url}/rest/v1/rpc/get_doc_mode`, { method: 'POST', headers: { apikey: CTX.key, Authorization: 'Bearer ' + 'x'.repeat(20) + '.' + 'y'.repeat(20) + '.' + 'z'.repeat(20), 'content-type': 'application/json' }, body: '{}' });
  rec('F5e', 'jeton falsifié : refusé par l\'API (401)', '401', `HTTP ${forged.status}`, forged.status === 401, { fatal: true, sqlstate: 'HTTP 401 (PGRST301)' });
}

async function test() {
  CTX = await makeCtx();
  out(`### 2. Préparation (${NATURE})`);
  const mr0 = await migRuns();
  rec('P1', 'aucune ligne _mig_runs inattendue (seule exception documentée et tolérée : la ligne historique cff4cac4, jamais supprimée ni modifiée)', '0 ligne inattendue (la ligne connue est tolérée)', `${mr0.others.length} ligne(s) inattendue(s)${mr0.others.length ? ' : ' + mr0.others.map((r) => r.run_id.slice(0, 8)).join(',') : ''} ; ligne connue présente : ${mr0.known.length ? 'oui' : 'non'}`, mr0.others.length === 0 && mr0.known.length <= 1, { fatal: true });
  if (!CTX.dry) {
    const hasMode = await q1("SELECT to_regclass('public.doc_store_mode') t");
    if (!hasMode.t) throw new Error('REFUS : sql/17 non installé.');
    const pre = await q('SELECT email FROM auth.users WHERE email = ANY($1)', [EMAILS]);
    if (pre.length) throw new Error('REFUS : comptes de test déjà présents (' + pre.length + ') : nettoyer d\'abord.');
    const foreign = await q1(`SELECT (SELECT count(*) FROM public.documents)::int d, (SELECT count(*) FROM public.doc_store_mode)::int m, (SELECT count(*) FROM public.doc_store_testers)::int t`);
    rec('P2', 'état initial : tables du nouveau stockage vides, tous les comptes en legacy', 'documents=0, modes=0, testeurs=0', jstr(foreign), foreign.d === 0 && foreign.m === 0 && foreign.t === 0, { fatal: true });
    await checkForeign('avant les tests', 'P3');
  }
  await createAccounts();
  rec('P4', '6 comptes jetables @facturapro-test.invalid créés (dont ui-o, ordinaire, non listé testeur)', '6', String((await q('SELECT 1 FROM auth.users WHERE email = ANY($1)', [EMAILS])).length), (await q('SELECT 1 FROM auth.users WHERE email = ANY($1)', [EMAILS])).length === 6, { fatal: true });
  // licences d'essai (comme à la première connexion), puis bascule des seuls comptes jetables prévus
  for (const k of KEYS) { const S = await signIn(k); const r = await S.c.rpc('my_license'); if (r.error) throw new Error('my_license ' + k + ' : ' + rpcErr(r)); }
  const fl = {};
  for (const k of ['d', 'e', 'f', 'g']) fl[k] = await toDocuments(k);
  rec('P5', 'bascule vers « documents » des 4 comptes jetables prévus (d, e, f, g) ; l et o restent en legacy', 'ok pour d,e,f,g', jstr(Object.fromEntries(Object.entries(fl).map(([k, v]) => [k, v && v.ok === true ? 'ok' : jstr(v).slice(0, 80)]))), Object.values(fl).every((v) => v && v.ok === true), { fatal: true });
  const modesDb = await q("SELECT u.email, COALESCE((SELECT mode FROM public.doc_store_mode m WHERE m.user_id=u.id),'legacy') mode FROM auth.users u WHERE u.email = ANY($1) ORDER BY 1", [EMAILS]);
  rec('P6', 'seuls les comptes jetables prévus sont en « documents »', 'd,e,f,g = documents', modesDb.map((r) => r.email.split('@')[0] + '=' + r.mode).join(' '), modesDb.every((r) => (/ui-[defg]@/.test(r.email)) === (r.mode === 'documents')), { fatal: true });
  await sectionN();
  await sectionF();
  if (!CTX.dry) await sectionBrowser();
  await checkForeign('après les tests, avant nettoyage', 'F1');
  if (CTX.dry) CTX.dropDb();
}

async function cleanup() {
  CTX = await makeCtx();
  if (CTX.dry) { await createAccounts(); for (const k of ['d', 'e', 'f', 'g']) await toDocuments(k); }   // répétition locale : comptes simulés + vraies bascules locales
  out('### 15. État final des données de test, puis nettoyage (comptes de cette campagne uniquement)');
  const us = await q('SELECT id::text id, email FROM auth.users WHERE email = ANY($1) ORDER BY email', [EMAILS]), uids = us.map((x) => x.id);
  // C0 : identité exacte des comptes à supprimer (adresses, identifiants, date de création, correspondance avec le run indiqué dans ops/preprod-ui.json)
  let scope = (() => { try { return require('../ops/preprod-ui.json').cleanup_scope; } catch { return null; } })();
  const idRows = await q('SELECT id::text id, email, created_at FROM auth.users WHERE email = ANY($1) ORDER BY email', [EMAILS]);
  if (CTX.dry) scope = { run: 'répétition', created_between: [new Date(Date.now() - 3600e3).toISOString(), new Date(Date.now() + 3600e3).toISOString()], runs_until: new Date(Date.now() + 3600e3).toISOString(), accounts: Object.fromEntries(idRows.map((r) => [r.email, r.id])) };
  const totalUsers = (await q1('SELECT count(*)::int n FROM auth.users')).n;
  out('- Comptes ciblés (adresse exacte) : ' + idRows.map((r) => `${r.email} / ${r.id} / créé ${new Date(r.created_at).toISOString()}`).join(' ; ') + `. Comptes totaux dans la base : ${totalUsers}.`);
  const inWin = scope && Array.isArray(scope.created_between) && idRows.every((r) => new Date(r.created_at) >= new Date(scope.created_between[0]) && new Date(r.created_at) <= new Date(scope.created_between[1]));
  // identité par UUID ET adresse : la table attendue figure dans ops/preprod-ui.json (cleanup_scope.accounts), relevée lors de l'inspection en lecture seule
  const expected = scope && scope.accounts ? scope.accounts : {};
  const idOk = EMAILS.every((e) => expected[e] && idRows.some((r) => r.email === e && r.id === expected[e])) && Object.keys(expected).length === EMAILS.length && idRows.length === EMAILS.length;
  out('- Identité attendue (adresse → UUID) : ' + EMAILS.map((e) => `${e} → ${expected[e] || '(absent du périmètre)'}`).join(' ; '));
  const winEnd = scope && scope.created_between ? scope.created_between[1] : null, winRuns = scope && scope.runs_until ? scope.runs_until : winEnd;
  const firstCreated = idRows.reduce((m, r) => (!m || new Date(r.created_at) < m ? new Date(r.created_at) : m), null);
  // _mig_runs (référence 0 avant la campagne ; table GLOBALE) : on ne supprime QUE les lignes dont le rattachement est PROUVÉ — A : le rapport cite un compte de la campagne ; B : écrite dans la même transaction (xmin identique) qu'une ligne d'un compte de la campagne.
  // Une ligne rattachée par la seule proximité d'horodatage (C) est CONSERVÉE et signalée.
  const mrC = await migRuns(); const runsList = mrC.others;   // la ligne historique connue est EXCLUE du périmètre : ni supprimée, ni modifiée
  if (mrC.known.length) out('- Ligne `_mig_runs` historique connue (cff4cac4, exception documentée) : présente, hors périmètre, NON touchée.');
  const anchors = await q(`SELECT u.email, 'mode' src, m.xmin::text::bigint x FROM public.doc_store_mode m JOIN auth.users u ON u.id=m.user_id WHERE u.email = ANY($1)
      UNION ALL SELECT u.email, 'testeur', t.xmin::text::bigint FROM public.doc_store_testers t JOIN auth.users u ON u.id=t.user_id WHERE u.email = ANY($1)
      UNION ALL SELECT u.email, 'evenement', e.xmin::text::bigint FROM public.doc_events e JOIN auth.users u ON u.id=e.user_id WHERE u.email = ANY($1)
      UNION ALL SELECT u.email, 'sauvegarde_migration', b.xmin::text::bigint FROM public._mig_source_backup b JOIN auth.users u ON u.id=b.user_id WHERE u.email = ANY($1)`, [EMAILS]);
  const strongAnchors = anchors.filter((a) => a.src !== 'testeur');   // une ligne testeur est écrite par une transaction distincte de la bascule
  const stampsC = []; for (const r of await q(`SELECT u.email, to_jsonb(m)::text j FROM public.doc_store_mode m JOIN auth.users u ON u.id=m.user_id WHERE u.email = ANY($1) UNION ALL SELECT u.email, to_jsonb(t)::text FROM public.doc_store_testers t JOIN auth.users u ON u.id=t.user_id WHERE u.email = ANY($1)`, [EMAILS])) for (const m of r.j.matchAll(/"(\d{4}-\d{2}-\d{2}T[0-9:.]+(?:[+-]\d{2}:?\d{2}|Z))"/g)) stampsC.push({ who: r.email.split('@')[0], t: new Date(m[1]).getTime() });
  const attrib = runsList.map((r) => {
    const cited = idRows.filter((u) => r.rep && r.rep.includes(u.id.slice(0, 8))).map((u) => u.email.split('@')[0]);
    const same = strongAnchors.filter((a) => Number(a.x) === Number(r.x)).map((a) => `${a.email.split('@')[0]}/${a.src}`);
    const st = new Date(r.started_at).getTime(), near = stampsC.filter((x) => Math.abs(x.t - st) <= 1000).length > 0;
    const inW = !!firstCreated && new Date(r.started_at) >= firstCreated && !!winRuns && new Date(r.started_at) <= new Date(winRuns);
    const cls = !inW ? 'HORS FENÊTRE' : cited.length ? 'A' : same.length ? 'B' : near ? 'C' : '—';
    return { run_id: r.run_id, run: r.run_id.slice(0, 8), started: new Date(r.started_at).toISOString(), cited, same, cls, del: cls === 'A' || cls === 'B' };
  });
  out('- Rattachement des lignes `_mig_runs` : ' + attrib.map((a) => `${a.run}@${a.started} → classe ${a.cls}${a.cited.length ? ' (cite ' + a.cited.join(',') + ')' : ''}${a.same.length ? ' (même transaction : ' + a.same.join(',') + ')' : ''} → ${a.del ? 'SUPPRIMÉE' : 'CONSERVÉE'}`).join(' ; '));
  const otherUsers = (await q1('SELECT count(*)::int n FROM auth.users WHERE NOT (email = ANY($1))', [EMAILS])).n;
  out(`- Autres comptes dans la base : ${otherUsers}.`);
  const keptRuns = attrib.filter((a) => !a.del).map((a) => a.run_id), delRuns = attrib.filter((a) => a.del).map((a) => a.run_id);
  rec('C0', `identité par UUID et adresse des ${EMAILS.length} comptes, créés pendant le run ${scope && scope.run} (${scope && scope.created_between && scope.created_between.join(' → ')}) ; aucune ligne _mig_runs hors fenêtre ou sans aucun indice`, `${EMAILS.length} comptes (UUID et adresse), fenêtre respectée, aucun autre compte, aucune ligne sans indice`, `${idOk ? 'UUID et adresses conformes' : 'UUID/adresses NON conformes'}, fenêtre ${inWin ? 'respectée' : 'NON respectée'}, autres comptes ${otherUsers}, lignes sans indice ou hors fenêtre : ${attrib.filter((a) => a.cls === '—' || a.cls === 'HORS FENÊTRE').length}`, idOk && !!inWin && otherUsers === 0 && attrib.every((a) => a.cls !== '—' && a.cls !== 'HORS FENÊTRE'), { fatal: true, proof: 'adresses, UUID, dates et classes de rattachement affichés ci-dessus' });
  const struct = async () => q1(`SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname IN ('public','auth'))::int tables,
      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND c.relrowsecurity AND n.nspname IN ('public','auth'))::int rls,
      (SELECT count(*) FROM pg_policies WHERE schemaname IN ('public','auth'))::int politiques,
      (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public')::int fonctions_public,
      (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname IN ('public','auth'))::int declencheurs,
      (SELECT count(*) FROM pg_constraint k JOIN pg_namespace n ON n.oid=k.connamespace WHERE n.nspname IN ('public','auth'))::int contraintes`);
  const structBefore = await struct();
  out('- Structure avant nettoyage : ' + jstr(structBefore));
  const st = await q(`SELECT u.email, COALESCE((SELECT mode FROM public.doc_store_mode m WHERE m.user_id=u.id),'legacy') mode, (SELECT count(*) FROM public.documents d WHERE d.user_id=u.id)::int docs, (SELECT count(*) FROM public.doc_payments d WHERE d.user_id=u.id)::int pays,
      (SELECT count(*) FROM public.doc_history d WHERE d.user_id=u.id)::int hist, (SELECT count(*) FROM public.user_data d WHERE d.user_id=u.id)::int ud FROM auth.users u WHERE u.id::text = ANY($1) ORDER BY 1`, [uids]);
  out('| Compte | mode | documents | paiements | journal | lignes user_data |\n|---|---|---|---|---|---|\n' + st.map((r) => `| ${r.email.split('@')[0]} | ${r.mode} | ${r.docs} | ${r.pays} | ${r.hist} | ${r.ud} |`).join('\n'));
  const strange = await q1(`SELECT (SELECT count(*) FROM public.documents WHERE NOT (user_id::text = ANY($1)))::int d, (SELECT count(*) FROM public.doc_payments WHERE NOT (user_id::text = ANY($1)))::int p,
      (SELECT count(*) FROM public.doc_history WHERE NOT (user_id::text = ANY($1)))::int h, (SELECT count(*) FROM public.doc_store_mode WHERE NOT (user_id::text = ANY($1)))::int m, (SELECT count(*) FROM public.doc_store_testers WHERE NOT (user_id::text = ANY($1)))::int t,
      (SELECT count(*) FROM public._mig_source_backup WHERE NOT (user_id::text = ANY($1)))::int b, (SELECT count(*) FROM public._mig_conflicts WHERE NOT (user_id::text = ANY($1)))::int cf`, [uids]);
  rec('C1', 'les tables du nouveau stockage ne contiennent AUCUNE ligne étrangère aux comptes de cette campagne', 'toutes à 0', jstr(strange), Object.values(strange).every((v) => v === 0), { fatal: true });
  await checkForeign('avant nettoyage', 'C2');
  const base = CTX.dry ? { sha256: '0' } : await q1("SELECT sha256 FROM public._fp_rehearsal WHERE name='mode_mig_runs'");
  const runs = (await migRuns()).others.length;
  rec('C3', '_mig_runs : référence 0 avant la campagne ; lignes actuelles = lignes prouvées + lignes conservées', 'référence 0', `référence ${base && base.sha256}, actuel ${runs} (à supprimer ${delRuns.length}, conservées ${keptRuns.length})`, base && Number(base.sha256) === 0 && runs === delRuns.length + keptRuns.length, { fatal: true });
  await CTX.adm.query('BEGIN');
  let del;
  try {
    await CTX.adm.query('DELETE FROM public._mig_source_backup WHERE user_id::text = ANY($1)', [uids]);
    await CTX.adm.query('DELETE FROM public._mig_conflicts WHERE user_id::text = ANY($1)', [uids]);
    await CTX.adm.query('DELETE FROM public.code_attempts WHERE user_id::text = ANY($1)', [uids]);
    await CTX.adm.query('DELETE FROM public._mig_runs WHERE run_id::text = ANY($1)', [delRuns]);   // uniquement les lignes DONT LE RATTACHEMENT EST PROUVÉ (A ou B)
    del = await CTX.adm.query('DELETE FROM auth.users WHERE id::text = ANY($1) AND email = ANY($2) RETURNING id', [Object.values(expected), EMAILS]);   // UUID ET adresse
    await CTX.adm.query('COMMIT');
  } catch (e) { try { await CTX.adm.query('ROLLBACK'); } catch {} throw e; }
  rec('C4', 'comptes de test supprimés (par adresse exacte, eux seuls)', `${us.length}`, `${del.rows.length}`, del.rows.length === us.length, { fatal: true });
  const left = await q1(`SELECT (SELECT count(*) FROM auth.users WHERE email = ANY($1))::int u, (SELECT count(*) FROM public.documents)::int d, (SELECT count(*) FROM public.doc_payments)::int p, (SELECT count(*) FROM public.doc_history)::int h,
      (SELECT count(*) FROM public.doc_deleted)::int g, (SELECT count(*) FROM public.doc_store_mode)::int m, (SELECT count(*) FROM public.doc_store_testers)::int t, (SELECT count(*) FROM public._mig_source_backup)::int b,
      (SELECT count(*) FROM public._mig_conflicts)::int cf, (SELECT count(*) FROM public.user_data WHERE user_id NOT IN (SELECT id FROM auth.users))::int orphan_ud,
      (SELECT count(*) FROM public.doc_counters WHERE user_id NOT IN (SELECT id FROM auth.users))::int orphan_dc, (SELECT count(*) FROM public.doc_events WHERE user_id NOT IN (SELECT id FROM auth.users))::int orphan_ev,
      (SELECT count(*) FROM public.licenses WHERE user_id NOT IN (SELECT id FROM auth.users))::int orphan_lic, (SELECT count(*) FROM public.code_attempts WHERE user_id NOT IN (SELECT id FROM auth.users))::int orphan_att`, [EMAILS]);
  rec('C5', 'plus aucun compte de test ni ligne résiduelle ou orpheline', 'tout à 0', jstr(left), Object.values(left).every((v) => v === 0), { fatal: true });
  const runsAfter = (await migRuns()).others.map((r) => r.run_id);
  rec('C5b', `_mig_runs : seules les lignes prouvées ont été supprimées ; ${keptRuns.length} ligne(s) CONSERVÉE(S) : ${attrib.filter((a) => !a.del).map((a) => a.run + ' (classe ' + a.cls + ')').join(', ') || 'aucune'}`, `${keptRuns.length} ligne(s) restantes, identiques aux lignes conservées`, `${runsAfter.length} ligne(s) restantes : ${runsAfter.map((r) => r.slice(0, 8)).join(', ') || 'aucune'}`, runsAfter.length === keptRuns.length && runsAfter.every((r) => keptRuns.includes(r)), { fatal: true });
  const structAfter = await struct();
  rec('C5c', 'structure inchangée : tables, RLS, politiques, fonctions publiques, déclencheurs, contraintes', jstr(structBefore), jstr(structAfter), jstr(structBefore) === jstr(structAfter), { fatal: true });
  await checkForeign('après nettoyage', 'C6');
  out(`- Comptes restants dans la préproduction : ${(await q1('SELECT count(*)::int n FROM auth.users')).n}.`);
}

// ---------------------------------------------------------------- inspect : LECTURE SEULE (session forcée en lecture seule ; aucune suppression, aucune bascule, aucun essai)
const BASELINE_ROWS = { 'public._fp_env': 1, 'public._fp_migrations': 10, 'public._fp_rehearsal': 7, 'public.admins': 1, 'auth.schema_migrations': 82 };   // lignes préexistantes de la préproduction (sauvegarde du 22/10 : 51 tables, 101 lignes)
async function inspect() {
  CTX = await makeCtx();
  if (CTX.dry) await createAccounts();   // répétition locale seulement : comptes simulés pour exercer les requêtes
  await CTX.adm.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
  const ro = await q1('SHOW transaction_read_only');
  let writeErr = '';
  try { await CTX.adm.query('UPDATE public.licenses SET status = status WHERE FALSE'); } catch (e) { writeErr = e.code || String(e.message).slice(0, 80); }
  rec('I0', 'session administrateur forcée en LECTURE SEULE (toute écriture est impossible)', 'transaction_read_only = on, tentative d\'écriture refusée (25006)', `transaction_read_only = ${ro.transaction_read_only} ; tentative d'écriture : ${writeErr || 'ACCEPTÉE'}`, ro.transaction_read_only === 'on' && writeErr === '25006', { fatal: true, sqlstate: writeErr });
  out('### I. Comptes de la campagne (adresses exactes)');
  const us = await q(`SELECT u.id::text id, u.email, to_jsonb(u)->>'created_at' created_at, to_jsonb(u)->>'last_sign_in_at' last_sign_in FROM auth.users u WHERE u.email = ANY($1) ORDER BY u.email`, [EMAILS]);
  const uids = us.map((x) => x.id);
  out('| Compte | UUID | créé (UTC) | dernière connexion |\n|---|---|---|---|\n' + us.map((r) => `| ${r.email} | ${r.id} | ${r.created_at} | ${r.last_sign_in || '—'} |`).join('\n'));
  const all = await q1('SELECT count(*)::int n FROM auth.users');
  rec('I1', 'exactement les 6 comptes prévus existent (et aucun autre compte dans la base)', `6 comptes ui-*, ${EMAILS.length} adresses, total 6`, `${us.length} comptes trouvés, ${all.n} comptes au total`, us.length === EMAILS.length && all.n === us.length);
  out('\n### II. Mode, licence et données par compte');
  const per = await q(`SELECT u.email,
      COALESCE((SELECT m.mode FROM public.doc_store_mode m WHERE m.user_id=u.id),'legacy') mode,
      (SELECT count(*) FROM public.doc_store_testers t WHERE t.user_id=u.id)::int testeur,
      COALESCE((SELECT l.status FROM public.licenses l WHERE l.user_id=u.id),'—') licence,
      (SELECT count(*) FROM public.documents d WHERE d.user_id=u.id)::int docs,
      (SELECT count(*) FROM public.documents d WHERE d.user_id=u.id AND d.doc_type='quote')::int devis,
      (SELECT count(*) FROM public.doc_payments d WHERE d.user_id=u.id)::int pays,
      (SELECT count(*) FROM public.doc_history d WHERE d.user_id=u.id)::int hist,
      (SELECT count(*) FROM public.doc_deleted d WHERE d.user_id=u.id)::int suppr,
      (SELECT count(*) FROM public.doc_events d WHERE d.user_id=u.id)::int evts,
      COALESCE((SELECT c.last_value::text FROM public.doc_counters c WHERE c.user_id=u.id AND c.doc_type='invoice' LIMIT 1),'—') compteur,
      (SELECT count(*) FROM public.user_data d WHERE d.user_id=u.id)::int ud,
      (SELECT count(*) FROM public.code_attempts d WHERE d.user_id=u.id)::int att,
      (SELECT count(*) FROM public._mig_source_backup d WHERE d.user_id=u.id)::int mbk,
      (SELECT count(*) FROM public._mig_conflicts d WHERE d.user_id=u.id)::int mcf
    FROM auth.users u WHERE u.email = ANY($1) ORDER BY u.email`, [EMAILS]);
  out('| Compte | mode | testeur | licence | documents (dont devis) | paiements | journal | supprimés | événements | compteur facture | user_data | tentatives code | sauv. migration | conflits migration |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n' +
    per.map((r) => `| ${r.email.split('@')[0]} | ${r.mode} | ${r.testeur} | ${r.licence} | ${r.docs} (${r.devis}) | ${r.pays} | ${r.hist} | ${r.suppr} | ${r.evts} | ${r.compteur} | ${r.ud} | ${r.att} | ${r.mbk} | ${r.mcf} |`).join('\n'));
  const modeRows = await q('SELECT u.email, to_jsonb(m) j FROM public.doc_store_mode m JOIN auth.users u ON u.id=m.user_id ORDER BY u.email');
  out('\nLignes `doc_store_mode` (identité du mode, dates) : ' + (modeRows.map((r) => `${r.email.split('@')[0]}=${clip(jstr(r.j), 220)}`).join(' ; ') || 'aucune'));
  const strangeModes = await q1('SELECT (SELECT count(*) FROM public.doc_store_mode WHERE NOT (user_id::text = ANY($1)))::int m, (SELECT count(*) FROM public.doc_store_testers WHERE NOT (user_id::text = ANY($1)))::int t', [uids]);
  rec('I2', 'modes et testeurs : uniquement des comptes de la campagne', 'aucune ligne étrangère', jstr(strangeModes), strangeModes.m === 0 && strangeModes.t === 0);
  out('\n### III. Balayage de TOUTES les tables (public + auth) : lignes de la campagne / lignes préexistantes');
  const tabs = await q(`SELECT n.nspname s, c.relname t FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname IN ('public','auth') ORDER BY 1, 2`);
  const sweep = []; let unexplained = [];
  for (const { s: sc, t } of tabs) {
    const fq = `${sc}.${t}`;
    const cols = (await q('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2', [sc, t])).map((r) => r.column_name);
    let mine = null;   // condition « appartient à la campagne »
    if (fq === 'auth.users') mine = 'email = ANY($1::text[])';
    else if (fq === 'auth.audit_log_entries') mine = `COALESCE(payload->>'actor_username','') LIKE '%@facturapro-test.invalid'`;
    else if (fq === 'auth.mfa_amr_claims') mine = 'session_id IN (SELECT id FROM auth.sessions WHERE user_id::text = ANY($1::text[]))';
    else if (fq === 'public.admin_codes') mine = "code LIKE 'MODE-TEST-%'";
    else if (cols.includes('user_id')) mine = 'user_id::text = ANY($1::text[])';
    const r = await q1(`SELECT count(*)::int total${mine ? `, count(*) FILTER (WHERE ${mine})::int mine` : ', 0::int mine'} FROM "${sc}"."${t}"`, mine && mine.includes('$1') ? [fq === 'auth.users' ? EMAILS : uids] : []);
    const pre = r.total - r.mine, exp = BASELINE_ROWS[fq] || 0;
    sweep.push({ fq, total: r.total, mine: r.mine, pre, exp, attributable: !!mine });
    if (fq !== 'public._mig_runs' && pre !== exp) unexplained.push(`${fq} (préexistantes ${pre}, attendu ${exp})`);
  }
  const shown = sweep.filter((x) => x.total || x.exp);
  out('| Table | total | lignes de la campagne | autres lignes | attendu avant campagne |\n|---|---|---|---|---|\n' + shown.map((x) => `| ${x.fq} | ${x.total} | ${x.mine}${x.attributable ? '' : ' (non attribuable)'} | ${x.pre} | ${x.exp} |`).join('\n'));
  out(`\n${tabs.length} tables examinées, ${tabs.length - shown.length} vides.`);
  rec('I3', 'les lignes qui ne sont pas à la campagne correspondent EXACTEMENT à l\'état préexistant (sauvegarde : 101 lignes)', 'aucune différence', unexplained.length ? 'différences : ' + unexplained.join(' ; ') : 'aucune différence', unexplained.length === 0);
  const orph = await q1(`SELECT (SELECT count(*) FROM public.user_data WHERE user_id NOT IN (SELECT id FROM auth.users))::int user_data, (SELECT count(*) FROM public.documents WHERE user_id NOT IN (SELECT id FROM auth.users))::int documents, (SELECT count(*) FROM public.doc_payments WHERE user_id NOT IN (SELECT id FROM auth.users))::int doc_payments, (SELECT count(*) FROM public.doc_history WHERE user_id NOT IN (SELECT id FROM auth.users))::int doc_history, (SELECT count(*) FROM public.licenses WHERE user_id NOT IN (SELECT id FROM auth.users))::int licenses, (SELECT count(*) FROM public.doc_counters WHERE user_id NOT IN (SELECT id FROM auth.users))::int doc_counters`);
  rec('I4', 'aucune ligne orpheline (sans compte propriétaire)', 'tout à 0', jstr(orph), Object.values(orph).every((v) => v === 0));
  const mrI = await migRuns();
  out(`- Information : ${mrI.others.length} ligne(s) dans _mig_runs hors exception documentée (référence avant campagne : 0) — leur attribution est jugée par I7. Ligne historique connue cff4cac4 : ${mrI.known.length ? 'présente (tolérée, non touchée)' : 'absente'}.`);
  out('\n### III bis. Lignes de `_mig_runs` : preuves de rattachement (référence 0 avant la campagne ; table exclue de l\'empreinte)');
  out('Méthode : une bascule (fp_doc_mode_set) écrit la ligne de mode ET la ligne `_mig_runs` dans UNE SEULE transaction ; deux lignes écrites par la même transaction portent le même `xmin`. Preuves, de la plus forte à la plus faible : (A) le rapport de la ligne cite un compte de la campagne ; (B) même transaction qu\'une ligne de mode / testeur / événement d\'un compte de la campagne (xmin identique) ; (C) simple proximité d\'horodatage — jamais considérée comme une preuve suffisante.');
  const first = us.reduce((m, r) => (!m || new Date(r.created_at) < new Date(m) ? r.created_at : m), null);
  const runsList = mrI.others;
  const anchors = await q(`SELECT 'users' src, u.email, u.xmin::text::bigint x FROM auth.users u WHERE u.email = ANY($1)
      UNION ALL SELECT 'licence', u.email, l.xmin::text::bigint FROM public.licenses l JOIN auth.users u ON u.id=l.user_id WHERE u.email = ANY($1)
      UNION ALL SELECT 'testeur', u.email, t.xmin::text::bigint FROM public.doc_store_testers t JOIN auth.users u ON u.id=t.user_id WHERE u.email = ANY($1)
      UNION ALL SELECT 'mode', u.email, m.xmin::text::bigint FROM public.doc_store_mode m JOIN auth.users u ON u.id=m.user_id WHERE u.email = ANY($1)
      UNION ALL SELECT 'evenement', u.email, e.xmin::text::bigint FROM public.doc_events e JOIN auth.users u ON u.id=e.user_id WHERE u.email = ANY($1)
      UNION ALL SELECT 'sauvegarde_migration', u.email, b.xmin::text::bigint FROM public._mig_source_backup b JOIN auth.users u ON u.id=b.user_id WHERE u.email = ANY($1)
      UNION ALL SELECT 'compteur', u.email, c.xmin::text::bigint FROM public.doc_counters c JOIN auth.users u ON u.id=c.user_id WHERE u.email = ANY($1)`, [EMAILS]);
  const pref = us.map((r) => ({ p: r.id.slice(0, 8), n: r.email.split('@')[0] }));
  const stampsI = []; for (const r of await q(`SELECT 'mode' src, u.email, to_jsonb(m)::text j FROM public.doc_store_mode m JOIN auth.users u ON u.id=m.user_id WHERE u.email = ANY($1) UNION ALL SELECT 'testeur', u.email, to_jsonb(t)::text FROM public.doc_store_testers t JOIN auth.users u ON u.id=t.user_id WHERE u.email = ANY($1)`, [EMAILS])) for (const m of r.j.matchAll(/"(\d{4}-\d{2}-\d{2}T[0-9:.]+(?:[+-]\d{2}:?\d{2}|Z))"/g)) stampsI.push({ src: r.src, who: r.email.split('@')[0], t: new Date(m[1]).getTime() });
  const runsInfo = runsList.map((r) => {
    const cited = pref.filter((x) => r.rep && r.rep.includes(x.p)).map((x) => x.n);
    const same = anchors.filter((a) => Number(a.x) === Number(r.x)).map((a) => `${a.email.split('@')[0]}/${a.src}`);
    const st = new Date(r.started_at).getTime(), near = stampsI.filter((x) => Math.abs(x.t - st) <= 1000).map((x) => `${x.who}/${x.src} à ${Math.abs(x.t - st)} ms`);
    return { ...r, cited, same, near, after: !!first && new Date(r.started_at) >= new Date(first), cls: cited.length ? 'A' : same.length ? 'B' : near.length ? 'C' : '—' };
  });
  out('| run | mode | statut | début (UTC) | xmin | A : compte cité | B : même transaction que | C : horodatage proche (indicatif) | classe |\n|---|---|---|---|---|---|---|---|---|\n' +
    runsInfo.map((r) => `| ${r.run_id.slice(0, 8)} | ${r.mode} | ${r.status} | ${new Date(r.started_at).toISOString()} | ${r.x} | ${r.cited.join(', ') || '—'} | ${r.same.join(', ') || '—'} | ${r.near.join(', ') || '—'} | ${r.cls} |`).join('\n'));
  out('\nChronologie des identifiants de transaction (xmin croissants) des lignes de la campagne et des lignes `_mig_runs` — toute transaction étrangère intercalée se verrait comme un trou dans la séquence :\n' +
    anchors.concat(runsInfo.map((r) => ({ src: '_mig_runs ' + r.run_id.slice(0, 8), email: 'run@', x: r.x }))).filter((a) => ['users', 'testeur', 'mode', '_mig'].some((k) => a.src.startsWith(k))).sort((a, b) => Number(a.x) - Number(b.x)).map((a) => `${a.x}:${a.email.split('@')[0]}/${a.src}`).join(' ; '));
  out('\nContenu résumé de chaque rapport (identifiants tronqués) :\n' + runsInfo.map((r) => `- ${r.run_id.slice(0, 8)} : ${clip(r.rep, 300)}`).join('\n'));
  const strong = runsInfo.filter((r) => r.after && (r.cls === 'A' || r.cls === 'B'));
  rec('I7', 'chaque ligne de `_mig_runs` est rattachée à la campagne par une preuve A (compte cité) ou B (même transaction) — la proximité d\'horodatage seule (C) ne suffit pas', 'toutes en A ou B', `${strong.length}/${runsInfo.length} en A ou B ; classe C seulement : ${runsInfo.filter((r) => r.cls === 'C').map((r) => r.run_id.slice(0, 8)).join(',') || 'aucune'} ; sans preuve : ${runsInfo.filter((r) => r.cls === '—').map((r) => r.run_id.slice(0, 8)).join(',') || 'aucune'}`, strong.length === runsInfo.length, { proof: 'xmin comparés entre `_mig_runs` et les lignes de mode / testeur / événements' });
  out('\n### IV. Empreinte des données préexistantes');
  await checkForeign('inspection en lecture seule', 'I6');
  out('\n**Lecture seule : rien n\'a été supprimé, basculé ni modifié.**');
}

// ---------------------------------------------------------------- tests locaux de l'exception « ligne historique » (base LOCALE jetable uniquement, jamais Supabase)
async function knownrun() {
  if (!DRY) throw new Error('knownrun : répétition locale uniquement (UI_DRYRUN=1).');
  CTX = await makeCtx();
  const ins = (id, mode, status, at, rep) => CTX.adm.query('INSERT INTO public._mig_runs(run_id, mode, status, started_at, report) VALUES ($1::uuid,$2,$3,$4::timestamptz,$5::jsonb)', [id, mode, status, at, rep]);
  const KNOWN = ['cff4cac4-0000-4000-8000-000000000001', 'apply', 'applied', '2026-10-22 11:58:03.125123+00', '{"dry_run": {"ok": true, "accounts": []}}'];
  let m = await migRuns();
  rec('K1', 'aucune ligne : rien d\'inattendu', '0 inattendue, 0 connue', `${m.others.length} / ${m.known.length}`, m.others.length === 0 && m.known.length === 0);
  await ins(...KNOWN); m = await migRuns();
  rec('K2', 'la ligne historique exacte est tolérée (et elle seule)', '0 inattendue, 1 connue', `${m.others.length} / ${m.known.length}`, m.others.length === 0 && m.known.length === 1);
  await ins('11111111-0000-4000-8000-000000000002', 'apply', 'applied', '2026-10-22 12:30:00+00', '{"dry_run": {"accounts": []}}'); m = await migRuns();
  rec('K3', 'toute AUTRE ligne en plus de la ligne connue fait échouer le contrôle', '1 inattendue', `${m.others.length} inattendue(s), ${m.known.length} connue(s)`, m.others.length === 1 && m.known.length === 1);
  await CTX.adm.query('DELETE FROM public._mig_runs WHERE run_id::text LIKE $1', ['11111111%']);
  await ins('cff4cac4-0000-4000-8000-000000000003', 'apply', 'applied', '2026-10-22 11:58:03.200+00', '{"dry_run": {"accounts": []}}'); m = await migRuns();
  rec('K4', 'même préfixe mais instant différent : NON toléré', '1 inattendue', `${m.others.length} inattendue(s)`, m.others.length === 1 && m.known.length === 1);
  await CTX.adm.query('DELETE FROM public._mig_runs WHERE run_id::text LIKE $1', ['cff4cac4-0000-4000-8000-000000000003']);
  await ins('cff4cac4-0000-4000-8000-000000000004', 'apply', 'applied', '2026-10-22 11:58:03.125+00', '{"dry_run": {"accounts": [{"user": "abcd1234"}]}}'); m = await migRuns();
  rec('K5', 'même préfixe et même instant mais rapport avec compte à migrer : NON toléré', '1 inattendue', `${m.others.length} inattendue(s)`, m.others.length === 1);
  await CTX.adm.query('DELETE FROM public._mig_runs WHERE run_id::text LIKE $1', ['cff4cac4-0000-4000-8000-000000000004']);
  await ins('cff4cac4-0000-4000-8000-000000000005', 'rollback', 'rollback_applied', '2026-10-22 11:58:03.125+00', '{"dry_run": {"accounts": []}}'); m = await migRuns();
  rec('K6', 'même préfixe et instant mais mode/statut différents : NON toléré', '1 inattendue', `${m.others.length} inattendue(s)`, m.others.length === 1);
  CTX.dropDb();
}

const CMDS = { guardtests, test, cleanup, inspect, knownrun };
(async () => {
  const cmd = process.argv[2];
  if (!CMDS[cmd]) { console.error('Commande : ' + Object.keys(CMDS).join(' | ')); process.exit(2); }
  out(`## Validation isolée du nouveau stockage — commande « ${cmd} » — ${new Date().toISOString()} — nature : ${NATURE}`);
  let stopped = false;
  try { await CMDS[cmd](); }
  catch (e) {
    stopped = true;
    if (e instanceof Stop) out(`\n**ARRÊT IMMÉDIAT** (perte de données ou incohérence) : ${clip(e.message, 300)}. Aucun nettoyage n'a été effectué : la cause doit être établie d'abord.`);
    else { res.push(false); rows.push({ id: 'EXC', ok: false, nature: NATURE }); out(`- **ÉCHEC** — exécution sans erreur — ${clip(e && e.stack || e.message, 600)}`); out('\n**ARRÊT** (erreur inattendue). Aucun nettoyage n\'a été effectué.'); }
  }
  const bad = res.filter((x) => !x).length;
  out(`\n**Bilan « ${cmd} » : ${res.length - bad}/${res.length} contrôles réussis${stopped ? ' (arrêté avant la fin)' : ''}.**`);
  const byNature = {}; for (const r of rows) { byNature[r.nature] = byNature[r.nature] || { ok: 0, ko: 0 }; byNature[r.nature][r.ok ? 'ok' : 'ko']++; }
  out('Répartition par nature : ' + Object.entries(byNature).map(([k, v]) => `${k} → ${v.ok} réussis, ${v.ko} échecs`).join(' ; '));
  if (process.env.REPORT_PATH) { fs.mkdirSync(path.dirname(process.env.REPORT_PATH), { recursive: true }); fs.appendFileSync(process.env.REPORT_PATH, lines.join('\n') + '\n'); }
  process.exit(bad || stopped ? 1 : 0);
})();
