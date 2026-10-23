#!/usr/bin/env node
// PARCOURS DU PREMIER CLIENT sur la PRÉPRODUCTION Supabase (jamais la production) :
//   inscription -> contact de support (réglages admin) -> demande d'abonnement -> virement (message admin avec RIB de TEST)
//   -> création du code -> activation de licence -> assistance.
// Commandes :
//   journey          : contrôle de cible, empreinte de départ, SQL 18, comptes jetables ui-j*, parcours en navigateur RÉEL (app.html + admin.html) + contrôles RLS réels.
//                      AUCUN nettoyage automatique.
//   journey-cleanup  : supprime UNIQUEMENT ce que le parcours a créé (périmètre UUID + adresse dans ops/preprod-ui.json -> journey_scope), puis exige que l'empreinte
//                      des données préexistantes soit IDENTIQUE à la référence.
// Répétition locale (UI_DRYRUN=1) : même script contre PostgreSQL local + faux client (SIMULÉ, sans navigateur) — le rapport le dit.
// Garde-fous : même contrôle de cible que le reste du dépôt (preprod-db.js / preprod-guard.js), marqueur « préproduction » en base, RIB/WhatsApp/e-mail FICTIFS,
// mots de passe aléatoires en mémoire (jamais écrits ni affichés), aucune suppression de donnée préexistante (dont les lignes _mig_runs cff4cac4 et fe82bee1).
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const T = require('./preprod-target.json');
const DRY = process.env.UI_DRYRUN === '1';
const DOMAIN = '@facturapro-test.invalid';
const K = { c: 'ui-jc', o: 'ui-jo', a: 'ui-ja', s: 'ui-js' };   // client, autre client, administrateur de test, inscription réelle par l'API
const EM = (k) => K[k] + DOMAIN;
const ALL = Object.keys(K).map(EM);
// Valeurs FICTIVES (aucun vrai RIB, aucun vrai numéro, aucun vrai e-mail)
const SETTINGS = { whatsapp_number: '+212 600 000 000', contact_email: 'support-test' + DOMAIN, bank_beneficiary: 'FacturaPro TEST', bank_rib: '000 000 0000000000000000 00', bank_name: 'Banque de test (fictive)' };
const NATURE = DRY ? 'SIMULÉ (répétition locale du script)' : 'RÉEL';
const lines = [], res = [], rows = [];
const out = (s = '') => { lines.push(s); console.log(s); };
const jstr = (o) => JSON.stringify(o);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n = 260) => String(s == null ? '' : s).replace(/eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{5,}/g, '***jwt***').replace(/postgres(ql)?:\/\/\S+/gi, 'postgres://***').slice(0, n);
class Stop extends Error {}
function rec(id, title, expected, actual, ok, o = {}) {
  res.push(!!ok); rows.push({ id, ok: !!ok, nature: o.nature || NATURE });
  out(`- ${ok ? 'RÉUSSI' : '**ÉCHEC**'} — **${id}** [${o.nature || NATURE}] ${title}\n  - attendu : ${clip(expected)}\n  - obtenu : ${clip(actual)}${o.proof ? `\n  - preuve : ${clip(o.proof, 400)}` : ''}`);
  if (!ok && o.fatal) throw new Stop(`${id} : ${title}`);
  return !!ok;
}
const PW = {}; for (const k of Object.keys(K)) PW[k] = crypto.randomBytes(18).toString('base64url') + 'Aa1!';   // en mémoire uniquement

// ---------------------------------------------------------------- accès base (administrateur, uniquement pour préparer / vérifier)
let CTX;
async function makeCtx() {
  if (DRY) {
    const { createDb, dropDb, makeBackend } = require('../tests/integration/backend');
    const dbName = createDb({ docs: true }); const be = makeBackend(dbName);
    const adm = { query: async (s, p) => { const r = await be.sql(s, p); return { rows: r, rowCount: r.length }; }, end: async () => {} };
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

// ---------------------------------------------------------------- clients (supabase-js réel, ou simulé en répétition)
function simClient() {
  let tok = null;
  const call = (op, a) => CTX.be.handle(op, { ...a, token: tok });
  const builder = (table) => {
    const st = { table, op: 'select', filters: {} };
    const b = { select(c) { st.cols = c; return b; }, eq(k, v) { st.filters[k] = v; return b; }, order() { return b; }, limit() { return b; },
      insert(row) { st.op = 'insert'; st.row = row; return b; }, update(row) { st.op = 'update'; st.row = row; return b; }, delete() { st.op = 'delete'; return b; },
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
  const r = await c.auth.signInWithPassword({ email: EM(k), password: CTX.dry ? 'x' : PW[k] });
  if (r.error || !r.data.user || r.data.user.email !== EM(k)) throw new Error('connexion impossible pour ' + EM(k) + ' : ' + clip(r.error && r.error.message));
  return { c, uid: r.data.user.id, k };
}
const errOf = (r) => (r && r.error ? `${r.error.code || ''} ${r.error.message || ''}`.trim() : '');

async function createAccount(k) {
  const email = EM(k);
  if (CTX.dry) { const r = await CTX.be.handle('signUp', { email }); if (r.error) throw new Error(r.error.message); return; }
  const ex = await q('SELECT id FROM auth.users WHERE email=$1', [email]);
  if (ex[0]) throw new Error('REFUS : le compte de test ' + email + ' préexiste (campagne précédente non nettoyée).');
  const id = crypto.randomUUID();
  await q(`INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
    VALUES ('00000000-0000-0000-0000-000000000000', $1::uuid, 'authenticated', 'authenticated', $2, crypt($3, gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '')`, [id, email, PW[k]]);
  await q(`INSERT INTO auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    VALUES (gen_random_uuid(), $1::uuid, $1::text, jsonb_build_object('sub', $1::text, 'email', $2::text, 'email_verified', true), 'email', now(), now(), now())`, [id, email]);
}

// ---------------------------------------------------------------- empreinte des données PRÉEXISTANTES (même méthode que preprod-ui-validation.js ; les comptes jetables du parcours sont exclus)
const EXCLUDED = new Set(['public._fp_migrations', 'public._fp_rehearsal', 'public._mig_runs', 'public._mig_source_backup', 'public._mig_conflicts',
  'public.documents', 'public.doc_payments', 'public.doc_history', 'public.doc_deleted', 'public.doc_store_mode', 'public.doc_store_testers']);
async function foreignHash() {
  const uids = (await q('SELECT id::text id FROM auth.users WHERE email = ANY($1)', [ALL])).map((x) => x.id);
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
      fq === 'auth.users' ? [ALL] : where.includes('$1') ? [uids] : []);
    parts[fq] = `${r.n}:${r.h}`;
  }
  return { hash: sha(jstr(parts)), parts };
}
async function checkForeign(label, id) {
  if (CTX.dry) return rec(id, `empreinte des données préexistantes (${label})`, 'non applicable en répétition locale', 'ignoré', true);
  const base = await q1("SELECT sha256, detail FROM public._fp_rehearsal WHERE name='mode_baseline_foreign'");
  if (!base) throw new Error('référence « mode_baseline_foreign » absente.');
  const now = await foreignHash();
  // Tables créées APRÈS la référence par des scripts autorisés (sql/20 : plans ; sql/24 : sauvegarde des droits) : tolérées seulement si
  // elles figurent dans cette liste fermée ; toute autre table nouvelle reste un échec. Les tables de la référence sont comparées à l'identique.
  const NEW_OK = new Set(['public.plans', 'public._fp_acl_backup_24']);
  const added = Object.keys(now.parts).filter((k) => !(k in base.detail));
  const unexpected = added.filter((k) => !NEW_OK.has(k));
  const cmp = {}; for (const k of Object.keys(now.parts)) if (k in base.detail) cmp[k] = now.parts[k];
  const diff = Object.keys(cmp).filter((k) => cmp[k] !== base.detail[k]).concat(Object.keys(base.detail).filter((k) => !(k in now.parts))).concat(unexpected);
  now.hash = sha(jstr(cmp));
  return rec(id, `données préexistantes inchangées (${label})`, `empreinte = référence ${base.sha256.slice(0, 12)} (tables nouvelles tolérées : ${[...NEW_OK].join(', ')})`, `empreinte ${now.hash.slice(0, 12)}${added.length ? ' ; tables nouvelles : ' + added.join(',') : ''}${diff.length ? ' ; tables différentes : ' + diff.join(',') : ''}`, now.hash === base.sha256 && unexpected.length === 0, { proof: `référence ${base.sha256.slice(0, 12)} / actuelle ${now.hash.slice(0, 12)}`, fatal: true });
}
const snapshot = async () => q1(`SELECT (SELECT count(*) FROM public.admin_settings)::int admin_settings, (SELECT count(*) FROM public.admin_codes)::int admin_codes, (SELECT count(*) FROM public.subscription_requests)::int subscription_requests,
  (SELECT count(*) FROM public.admins)::int admins, (SELECT count(*) FROM public.licenses)::int licenses, (SELECT count(*) FROM auth.users)::int users, (SELECT count(*) FROM public.code_attempts)::int code_attempts`);

// ================================================================ commandes
async function guardtests() {
  out('### 1. Contrôles de cible');
  if (!DRY) {
    const { parseDbUrl } = require('./preprod-db');
    const real = parseDbUrl(process.env.PREPROD_DB_URL);
    rec('G-cible', 'cible réelle (secret) = préproduction, jamais la production', T.preprodRef, real.ref, real.ref === T.preprodRef && real.ref !== T.prodRef, { fatal: true });
    const G = require('./preprod-guard').guard(process.env.PREPROD_URL, process.env.PREPROD_ANON_KEY);
    rec('G-api', 'API : URL et clé anon de la préproduction', T.preprodRef, G.ref, G.ref === T.preprodRef, { fatal: true });
  }
}

async function journey() {
  await guardtests();
  CTX = await makeCtx();
  out(`### 2. Départ (${NATURE})`);
  await checkForeign('au départ', 'J0');
  const pre = await q('SELECT email FROM auth.users WHERE email = ANY($1)', [ALL]);
  const keys = Object.keys(SETTINGS);
  const hasSet = await q('SELECT key FROM public.admin_settings WHERE key = ANY($1)', [keys]);
  const hasAdm = await q('SELECT email FROM public.admins WHERE lower(email) = ANY($1)', [ALL]);
  rec('J1', 'aucun compte, réglage ni administrateur de test préexistant', 'tout à 0', `comptes ${pre.length}, réglages ${hasSet.length}, admins ${hasAdm.length}`, !pre.length && !hasSet.length && !hasAdm.length, { fatal: true });
  const base = await snapshot();
  out('- Compteurs de départ : ' + jstr(base));
  const baseline = { admin_settings: base.admin_settings, admin_codes: base.admin_codes, subscription_requests: base.subscription_requests, admins: base.admins, code_attempts: base.code_attempts };

  // ---- SQL 18 (fonction get_contact_info) : appliqué à la préproduction UNIQUEMENT, après sauvegarde restaurée et contrôles de cible (étapes précédentes du workflow)
  const f18 = fs.readFileSync(path.join(ROOT, 'sql', '18_contact_public.sql'), 'utf8');
  const had = (await q1("SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='get_contact_info'")).n;
  if (!DRY && !had) await q(f18);
  const fn = await q1(`SELECT count(*)::int n, bool_and(p.prosecdef) sd, bool_and(EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig,'{}')) c WHERE c LIKE 'search_path=%')) sp,
      has_function_privilege('anon','public.get_contact_info()','EXECUTE') anon, has_function_privilege('authenticated','public.get_contact_info()','EXECUTE') auth
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='get_contact_info'`);
  rec('J2', `sql/18 ${had ? 'déjà présent' : 'appliqué'} : fonction get_contact_info() SECURITY DEFINER, search_path fixé, anon refusé, authenticated autorisé`, '1 fonction ; sd ; sp ; anon=false ; authenticated=true', jstr(fn), fn.n === 1 && fn.sd && fn.sp && fn.anon === false && fn.auth === true, { fatal: true });
  const anonC = mkClient();
  const anonR = await anonC.rpc('get_contact_info');
  rec('J2b', 'un visiteur NON connecté (clé anon) ne peut pas appeler get_contact_info', 'erreur de droit', errOf(anonR) || 'aucune erreur', !!anonR.error && !anonR.data, { proof: 'appel REST réel avec la clé anon seule' });

  // ---- comptes jetables
  for (const k of ['c', 'o', 'a']) await createAccount(k);
  if (!DRY) await q('INSERT INTO public.admins(email, password_hash, is_master) VALUES ($1, $2, false)', [EM('a'), 'compte-de-test-sans-mot-de-passe-applicatif']); else await q('INSERT INTO public.admins(email, password_hash, is_master) VALUES ($1, $2, false)', [EM('a'), 'x']);
  rec('J3', '3 comptes jetables créés (client ui-jc, autre client ui-jo, administrateur de test ui-ja)', '3', String((await q('SELECT 1 FROM auth.users WHERE email = ANY($1)', [ALL])).length), (await q('SELECT 1 FROM auth.users WHERE email = ANY($1)', [ALL])).length === 3, { fatal: true });
  const ids = {}; for (const r of await q('SELECT id::text id, email FROM auth.users WHERE email = ANY($1)', [ALL])) ids[r.email] = r.id;
  out('- PÉRIMÈTRE DU PARCOURS (à reporter dans ops/preprod-ui.json -> journey_scope pour le nettoyage) : ' + jstr({ accounts: ids, baseline }));

  // ---- inscription réelle par l'API (sans captcha, sans boîte de réception) : on consigne honnêtement ce qui est vérifiable
  if (!DRY) {
    const sc = mkClient();
    const sr = await sc.auth.signUp({ email: EM('s'), password: PW.s });
    const created = await q1('SELECT id::text id, email_confirmed_at FROM auth.users WHERE email=$1', [EM('s')]);
    if (created) out('- PÉRIMÈTRE (compte créé par l\'inscription API) : ' + jstr({ signup_account: { [EM('s')]: created.id } }));
    rec('J3s', 'inscription réelle par l\'API Auth (adresse jetable invalide, sans captcha)', 'résultat consigné (information)', sr.error ? `refusée : ${clip(sr.error.message, 120)}` : `créée, e-mail ${created && created.email_confirmed_at ? 'confirmé' : 'NON confirmé (confirmation par e-mail exigée, non vérifiable sans boîte réelle)'} ; session renvoyée : ${sr.data && sr.data.session ? 'oui' : 'non'}`, true, { proof: 'information : la confirmation par e-mail et le captcha ne peuvent pas être complétés par un script' });
  }

  // ---- contrôles côté serveur avec des sessions réelles
  const C = await signIn('c'), O = await signIn('o'), A = await signIn('a');
  const lc = await C.c.rpc('my_license');
  rec('J4', 'le client reçoit sa licence d\'essai à la première connexion (my_license)', 'type trial, active', jstr(lc.data && { type: lc.data.type, status: lc.data.status }), !lc.error && lc.data && lc.data.type === 'trial', { fatal: true });
  const wc = await C.c.rpc('admin_whoami'), wa = await A.c.rpc('admin_whoami');
  rec('J5', 'admin_whoami : le client n\'est pas administrateur, le compte de test l\'est', 'client false / admin true', `${jstr(wc.data && wc.data.is_admin)} / ${jstr(wa.data && wa.data.is_admin)}`, !wc.error && !wa.error && wc.data.is_admin === false && wa.data.is_admin === true);
  const e0 = await C.c.rpc('get_contact_info');
  rec('J6', 'contact NON configuré : get_contact_info renvoie des chaînes vides (aucun faux numéro)', '{"whatsapp":"","email":""}', jstr(e0.data) + (e0.error ? ' ' + errOf(e0) : ''), !e0.error && e0.data && e0.data.whatsapp === '' && e0.data.email === '');
  // RLS réelle : ce qu'un client ne doit pas pouvoir faire
  const neg = {};
  neg.codes = await C.c.from('admin_codes').insert({ code: 'FP-ZZZZ-ZZZZ-ZZZZ', type: 'annual', client_email: EM('c'), status: 'pending' });
  neg.sets = await C.c.from('admin_settings').select('key, value');
  neg.other = await C.c.from('subscription_requests').insert({ client_email: EM('o'), tier: 'annual', base_price: 449, final_price: 449, status: 'pending' });
  neg.forged = await C.c.from('subscription_requests').insert({ client_email: EM('c'), tier: 'annual', base_price: 449, final_price: 449, status: 'processed', license_code: 'FP-AAAA-AAAA-AAAA' });
  neg.lic = await C.c.from('licenses').update({ type: 'lifetime', expires_at: null, status: 'active' }).eq('user_id', C.uid);
  const licAfter = await q1('SELECT type, status FROM public.licenses WHERE user_id=$1::uuid', [C.uid]);
  const noCode = (await q('SELECT 1 FROM public.admin_codes WHERE code=$1', ['FP-ZZZZ-ZZZZ-ZZZZ'])).length === 0;
  const noSet = !neg.sets.error ? (neg.sets.data || []).length === 0 : true;
  const noOther = (await q('SELECT 1 FROM public.subscription_requests WHERE client_email=$1', [EM('o')])).length === 0;
  const noForged = (await q("SELECT 1 FROM public.subscription_requests WHERE client_email=$1 AND (status<>'pending' OR license_code IS NOT NULL)", [EM('c')])).length === 0;
  rec('J7', 'RLS réelle : un client ne peut ni créer de code, ni lire les réglages, ni demander au nom d\'un autre, ni se déclarer « traité », ni modifier sa licence', 'tout refusé / sans effet', `code créé: ${!noCode}; réglages lus: ${!noSet}; demande pour autrui: ${!noOther}; demande falsifiée: ${!noForged}; licence: ${licAfter && licAfter.type}/${licAfter && licAfter.status}`, noCode && noSet && noOther && noForged && licAfter && licAfter.type === 'trial', { fatal: true });

  if (!DRY) await require('./preprod-journey-browser.js').run({ rec, q, q1, CTX, EM, PW, SETTINGS, sleep, clip, jstr, signIn, errOf, ids, T });
  else await dryPath({ C, O, A });

  out('\n### 9. État final du parcours (avant nettoyage)');
  const end = await snapshot();
  out('- Compteurs en fin de parcours : ' + jstr(end) + ' ; départ : ' + jstr(base));
  out('- Le SQL 18 (fonction get_contact_info) RESTE installé en préproduction : c\'est l\'artefact à valider ; retour arrière : DROP FUNCTION IF EXISTS public.get_contact_info();');
  if (CTX.dry) CTX.dropDb(); else await CTX.adm.end();
}

// Répétition locale (sans navigateur) du même enchaînement au niveau protocole : demande -> message admin -> code -> activation
async function dryPath({ C, O, A }) {
  out('\n### 3-8. Parcours (protocole, SIMULÉ)');
  for (const [key, value] of Object.entries(SETTINGS)) { const r = await A.c.from('admin_settings').insert({ key, value }); if (r.error) throw new Error('réglage ' + key + ' : ' + errOf(r)); }
  const ci = await C.c.rpc('get_contact_info');
  rec('D1', 'contact configuré : WhatsApp et e-mail renvoyés, jamais le RIB', 'whatsapp+email, 2 clés', jstr(ci.data), !ci.error && ci.data.whatsapp === SETTINGS.whatsapp_number && ci.data.email === SETTINGS.contact_email && Object.keys(ci.data).length === 2);
  const r1 = await C.c.from('subscription_requests').insert({ client_email: EM('c'), company_name: 'SARL Test', tier: 'annual', base_price: 449, final_price: 449, status: 'pending' });
  const r2 = await C.c.from('subscription_requests').insert({ client_email: EM('c'), tier: 'annual', base_price: 449, final_price: 449, status: 'pending' });
  rec('D2', 'demande créée ; la seconde demande en attente est refusée (« demande déjà en attente »)', '1 acceptée, 1 refusée', `${errOf(r1) || 'ok'} / ${errOf(r2) || 'ok'}`, !r1.error && !!r2.error && /demande déjà en attente/.test(r2.error.message));
  const req = await q1('SELECT id::text id FROM public.subscription_requests WHERE client_email=$1', [EM('c')]);
  const code = 'FP-' + [4, 4, 4].map(() => crypto.randomBytes(8).toString('hex').toUpperCase().replace(/[01OI]/g, 'A').slice(0, 4)).join('-');
  const ic = await A.c.from('admin_codes').insert({ code, type: 'annual', client_email: EM('c'), note: 'TEST parcours', status: 'pending' });
  const up = await A.c.from('subscription_requests').update({ status: 'processed', processed_at: new Date().toISOString(), license_code: code }).eq('id', req.id);
  rec('D3', 'l\'administrateur crée le code et marque la demande traitée', 'ok', `${errOf(ic) || 'ok'} / ${errOf(up) || 'ok'}`, !ic.error && !up.error);
  const wo = await O.c.rpc('activate_license', { p_code: code });
  const ac = await C.c.rpc('activate_license', { p_code: code });
  const ac2 = await C.c.rpc('activate_license', { p_code: code });
  const lic = await q1('SELECT type, status, expires_at > now() + interval \'364 days\' long FROM public.licenses WHERE user_id=$1::uuid', [C.uid]);
  rec('D4', 'activation : autre compte refusé (wrong_email), bon compte accepté, réutilisation refusée (used) ; licence annuelle active', 'wrong_email / ok / used ; annual active', `${wo.data && wo.data.reason} / ${ac.data && ac.data.ok} / ${ac2.data && ac2.data.reason} ; ${jstr(lic)}`, wo.data.reason === 'wrong_email' && ac.data.ok === true && ac2.data.reason === 'used' && lic.type === 'annual' && lic.status === 'active' && lic.long);
}

// ---------------------------------------------------------------- nettoyage
async function cleanup() {
  CTX = await makeCtx();
  out('### 15. Nettoyage du parcours client (comptes et lignes créés par le parcours uniquement)');
  let scope = (() => { try { return require('../ops/preprod-ui.json').journey_scope; } catch { return null; } })();
  if (CTX.dry) {
    await createAccount('c'); await createAccount('o'); await createAccount('a');
    const m = {}; for (const r of await q('SELECT id::text id, email FROM auth.users WHERE email = ANY($1)', [ALL])) m[r.email] = r.id;
    await q('INSERT INTO public.admins(email, password_hash) VALUES ($1,$2)', [EM('a'), 'x']);
    for (const [key, value] of Object.entries(SETTINGS)) await q('INSERT INTO public.admin_settings(key, value) VALUES ($1,$2)', [key, value]);
    scope = { run: 'répétition', accounts: m, baseline: { admin_settings: 0, admin_codes: 0, subscription_requests: 0, admins: 1, code_attempts: 0 } };
  }
  if (!scope || !scope.accounts || !scope.baseline) throw new Error('REFUS : ops/preprod-ui.json -> journey_scope (accounts + baseline) absent.');
  const expected = scope.accounts;
  const idRows = await q('SELECT id::text id, email, created_at FROM auth.users WHERE email = ANY($1) ORDER BY email', [ALL]);
  const idOk = idRows.length > 0 && idRows.every((r) => expected[r.email] === r.id) && Object.keys(expected).every((e) => ALL.includes(e)) && Object.keys(expected).every((e) => idRows.some((r) => r.email === e));
  out('- Comptes ciblés (adresse / UUID / création) : ' + idRows.map((r) => `${r.email} / ${r.id} / ${new Date(r.created_at).toISOString()}`).join(' ; '));
  rec('JC0', 'identité par UUID ET adresse des comptes à supprimer conforme au périmètre relevé pendant le parcours', `${Object.keys(expected).length} comptes (UUID + adresse)`, idOk ? 'conforme' : 'NON conforme', idOk && !!scope, { fatal: true });
  const uids = idRows.map((r) => r.id), emails = idRows.map((r) => r.email);
  const keys = Object.keys(SETTINGS);
  await CTX.adm.query('BEGIN');
  let del;
  try {
    await CTX.adm.query('DELETE FROM public.subscription_requests WHERE lower(client_email) = ANY($1)', [emails]);
    await CTX.adm.query('DELETE FROM public.admin_codes WHERE lower(client_email) = ANY($1)', [emails]);
    await CTX.adm.query('DELETE FROM public.admin_settings WHERE key = ANY($1) AND value = ANY($2)', [keys, Object.values(SETTINGS)]);   // clé ET valeur de test : jamais une valeur réelle
    await CTX.adm.query('DELETE FROM public.admins WHERE lower(email) = ANY($1) AND is_master = false', [emails]);
    await CTX.adm.query('DELETE FROM public.code_attempts WHERE user_id::text = ANY($1)', [uids]);
    del = await CTX.adm.query('DELETE FROM auth.users WHERE id::text = ANY($1) AND email = ANY($2) RETURNING id', [uids, emails]);   // UUID ET adresse
    await CTX.adm.query('COMMIT');
  } catch (e) { try { await CTX.adm.query('ROLLBACK'); } catch {} throw e; }
  rec('JC1', 'comptes de test supprimés (par UUID ET adresse, eux seuls)', String(uids.length), String(del.rows.length), del.rows.length === uids.length, { fatal: true });
  const left = await q1(`SELECT (SELECT count(*) FROM auth.users WHERE email = ANY($1))::int u, (SELECT count(*) FROM public.licenses WHERE user_id NOT IN (SELECT id FROM auth.users))::int orphan_lic,
    (SELECT count(*) FROM public.user_data WHERE user_id NOT IN (SELECT id FROM auth.users))::int orphan_ud, (SELECT count(*) FROM public.subscription_requests WHERE lower(client_email) = ANY($1))::int req,
    (SELECT count(*) FROM public.admin_codes WHERE lower(client_email) = ANY($1))::int codes`, [ALL]);
  rec('JC2', 'plus aucun compte, demande, code ni ligne orpheline du parcours', 'tout à 0', jstr(left), Object.values(left).every((v) => v === 0), { fatal: true });
  const now = await snapshot();
  const b = scope.baseline;
  rec('JC3', 'compteurs des tables touchées revenus au départ', jstr(b), jstr({ admin_settings: now.admin_settings, admin_codes: now.admin_codes, subscription_requests: now.subscription_requests, admins: now.admins, code_attempts: now.code_attempts }),
    ['admin_settings', 'admin_codes', 'subscription_requests', 'admins', 'code_attempts'].every((k) => now[k] === b[k]), { fatal: true });
  await checkForeign('après nettoyage', 'JC4');
  const fnStill = (await q1("SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='get_contact_info'")).n;
  out(`- Fonction get_contact_info() : ${fnStill ? 'conservée (artefact SQL 18 à valider)' : 'absente'}. Lignes _mig_runs cff4cac4 et fe82bee1 : non touchées (le nettoyage ne les cible pas).`);
  if (CTX.dry) CTX.dropDb(); else await CTX.adm.end();
}

const CMDS = { journey, 'journey-cleanup': cleanup };
(async () => {
  const cmd = process.argv[2];
  if (!CMDS[cmd]) { console.error('Commande : ' + Object.keys(CMDS).join(' | ')); process.exit(2); }
  out(`## Parcours du premier client — commande « ${cmd} » — ${new Date().toISOString()} — nature : ${NATURE}`);
  let stopped = false;
  try { await CMDS[cmd](); }
  catch (e) {
    stopped = true;
    if (e instanceof Stop) out(`\n**ARRÊT IMMÉDIAT** : ${clip(e.message, 300)}. Voir le rapport pour l'état exact des données.`);
    else { res.push(false); rows.push({ id: 'EXC', ok: false, nature: NATURE }); out(`- **ÉCHEC** — exécution sans erreur — ${clip(e && e.stack || e.message, 700)}`); out('\n**ARRÊT** (erreur inattendue). Voir le rapport pour l\'état exact des données.'); }
  }
  const bad = res.filter((x) => !x).length;
  out(`\n**Bilan « ${cmd} » : ${res.length - bad}/${res.length} contrôles réussis${stopped ? ' (arrêté avant la fin)' : ''}.**`);
  if (process.env.REPORT_PATH) { fs.mkdirSync(path.dirname(process.env.REPORT_PATH), { recursive: true }); fs.appendFileSync(process.env.REPORT_PATH, lines.join('\n') + '\n'); }
  process.exit(bad || stopped ? 1 : 0);
})();
