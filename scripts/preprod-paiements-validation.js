#!/usr/bin/env node
// VALIDATION de sql/25_plafond_paiements.sql (comptes « documents ») ET de sql/26_plafond_paiements_legacy.sql (comptes legacy) sur la PRÉPRODUCTION Supabase (njjaomichdlnoscrnxlz) — jamais la production.
// *** PRÉPARÉ, NON EXÉCUTÉ sur Supabase. Aucune phase ne doit être lancée sans l'autorisation écrite explicite de l'utilisateur. ***
//   precheck : LECTURE SEULE. Cible, marqueur « préproduction », empreinte de record_payment, droits, comptes et données existants.
//   install  : (écriture) sauvegarde de la définition actuelle dans public._fp_backup_record_payment, puis applique sql/25 (une transaction).
//   test     : (écriture, comptes jetables uniquement) 2 comptes pay-a / pay-b, factures de test, contrôles partagés avec la simulation locale.
//   cleanup  : (écriture) supprime UNIQUEMENT les comptes pay-a / pay-b de cette opération ; restaure record_payment si --rollback.
// Variables : PREPROD_DB_URL (secret, jamais affichée). Mode répétition locale : LOCAL_REHEARSAL=1 + REHEARSAL_DB (base locale jetable).
// Les phases d'écriture exigent en plus ops/preprod-paiements.json : { "phase": "...", "authorized": true, "authorized_on": "AAAA-MM-JJ" } ;
// ce fichier ne passe à « authorized: true » qu'après l'autorisation écrite de l'utilisateur.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const T = require('./preprod-target.json');
const EXPECTED_SQL15_MD5 = '437d99973de84c9b3ad9f7bcc456635c';   // md5(pg_get_functiondef) de record_payment installé par sql/15 (relevé en préproduction le 24/10/2026, identique à la base locale)
const EMAILS = ['pay-a@facturapro-test.invalid', 'pay-b@facturapro-test.invalid', 'pay-c@facturapro-test.invalid', 'pay-d@facturapro-test.invalid'];   // a, b : mode « documents » (sql/25) ; c, d : mode legacy (sql/26)
const LOCAL = process.env.LOCAL_REHEARSAL === '1';
const lines = [], res = [];
const out = (s = '') => { lines.push(s); console.log(s); };
const ck = (n, ok, x = '') => { res.push(!!ok); out(`- ${ok ? 'RÉUSSI' : '**ÉCHEC**'} — ${n}${ok || !x ? '' : ' — ' + String(x).slice(0, 400)}`); };

async function connect() {
  if (LOCAL) { const { Client } = require('pg'); const c = new Client({ database: process.env.REHEARSAL_DB }); await c.connect(); return c; }
  const { connect: cn } = require('./preprod-db');
  const { client, ref } = await cn();
  if (ref !== T.preprodRef) throw new Error('REFUS : cible inattendue.');
  return client;
}
async function target(c) {
  const t = await c.query("SELECT to_regclass('public._fp_env') t");
  if (!t.rows[0].t) throw new Error('REFUS : marqueur de préproduction (public._fp_env) absent.');
  const m = (await c.query('SELECT env, project_ref FROM public._fp_env WHERE id=1')).rows[0];
  if (!m || m.env !== 'preprod' || m.project_ref !== T.preprodRef) throw new Error('REFUS : marqueur « préproduction » inattendu.');
  ck('cible : marqueur public._fp_env = préproduction (' + T.preprodRef + '), jamais la production', true);
}
function authorized(phase) {
  if (phase === 'precheck') return;
  let o = {}; try { o = JSON.parse(fs.readFileSync(path.join(ROOT, 'ops', 'preprod-paiements.json'), 'utf8')); } catch (e) {}
  if (!LOCAL && (o.phase !== phase || o.authorized !== true || !/^\d{4}-\d{2}-\d{2}$/.test(o.authorized_on || ''))) {
    console.error(`REFUS : la phase « ${phase} » écrit en base ; ops/preprod-paiements.json doit porter phase="${phase}", authorized=true et authorized_on (autorisation écrite de l'utilisateur).`); process.exit(2);
  }
}
const functionMd5 = async (c) => (await c.query("SELECT md5(pg_get_functiondef('public.record_payment(text,jsonb,text)'::regprocedure)) m")).rows[0].m;

async function precheck() {
  const c = await connect();
  await c.query('BEGIN READ ONLY');
  out('## Contrôles préalables (lecture seule)');
  await target(c);
  const ro = (await c.query("SELECT current_setting('transaction_read_only') v")).rows[0].v;
  ck('transaction en lecture seule', ro === 'on');
  const md5 = await functionMd5(c);
  ck('record_payment actuel identique à sql/15 (empreinte)', md5 === EXPECTED_SQL15_MD5, md5);
  const g = (await c.query("SELECT has_function_privilege('anon','public.record_payment(text,jsonb,text)','EXECUTE') a, has_function_privilege('authenticated','public.record_payment(text,jsonb,text)','EXECUTE') b")).rows[0];
  ck('droits actuels : anon non, authenticated oui', g.a === false && g.b === true, JSON.stringify(g));
  const tb = (await c.query("SELECT string_agg(relname, ',' ORDER BY relname) t FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND relname IN ('documents','doc_payments','doc_store_mode','doc_store_testers','doc_counters','licenses','user_data')")).rows[0].t;
  ck('tables du nouveau stockage présentes (sql/15, 16, 17 installés)', tb === 'doc_counters,doc_payments,doc_store_mode,doc_store_testers,documents,licenses,user_data', tb);
  const n = (await c.query("SELECT (SELECT count(*) FROM public.documents)::int d, (SELECT count(*) FROM public.doc_payments)::int p, (SELECT count(*) FROM public.doc_store_mode WHERE mode='documents')::int m, (SELECT count(*) FROM auth.users WHERE email = ANY($1))::int t, (SELECT count(*) FROM auth.users)::int u", [EMAILS])).rows[0];
  out(`- Données existantes (information) : ${n.u} comptes, ${n.d} documents, ${n.p} paiements, ${n.m} compte(s) en mode documents.`);
  ck('aucun compte pay-a / pay-b déjà présent (pas de reste d\'un essai précédent)', n.t === 0, String(n.t));
  const t26 = (await c.query("SELECT (SELECT count(*) FROM pg_trigger WHERE tgname='trg_10_payments_cap')::int t, to_regprocedure('public.guard_payments_cap_legacy()') f")).rows[0];
  ck('sql/26 pas encore installé (ni déclencheur ni fonction)', t26.t === 0 && !t26.f, JSON.stringify(t26));
  const bk = (await c.query("SELECT to_regclass('public._fp_backup_record_payment') t")).rows[0].t;
  ck('table de sauvegarde de la définition absente (install pas encore fait)', !bk);
  await c.query('ROLLBACK'); await c.end();
}

async function install() {
  authorized('install');
  const c = await connect(); await target(c);
  const md5 = await functionMd5(c);
  if (md5 !== EXPECTED_SQL15_MD5) { ck('record_payment attendu (sql/15) avant installation', false, md5); await c.end(); return; }
  await c.query('BEGIN');
  await c.query('CREATE TABLE IF NOT EXISTS public._fp_backup_record_payment (id int PRIMARY KEY, saved_at timestamptz DEFAULT now(), definition text NOT NULL, grants text)');
  await c.query("ALTER TABLE public._fp_backup_record_payment ENABLE ROW LEVEL SECURITY");
  await c.query("INSERT INTO public._fp_backup_record_payment(id, definition, grants) SELECT 1, pg_get_functiondef('public.record_payment(text,jsonb,text)'::regprocedure), (SELECT proacl::text FROM pg_proc WHERE oid='public.record_payment(text,jsonb,text)'::regprocedure) ON CONFLICT (id) DO NOTHING");
  await c.query(fs.readFileSync(path.join(ROOT, 'sql', '25_plafond_paiements.sql'), 'utf8'));
  await c.query(fs.readFileSync(path.join(ROOT, 'sql', '26_plafond_paiements_legacy.sql'), 'utf8'));
  await c.query('COMMIT');
  ck('sql/25 et sql/26 appliqués (une seule transaction), définition précédente de record_payment sauvegardée', true);
  const t26 = (await c.query("SELECT (SELECT count(*) FROM pg_trigger WHERE tgname='trg_10_payments_cap' AND tgenabled='O')::int t")).rows[0].t;
  ck('déclencheur trg_10_payments_cap installé et actif sur user_data', t26 === 1);
  const g = (await c.query("SELECT has_function_privilege('anon','public.record_payment(text,jsonb,text)','EXECUTE') a, has_function_privilege('authenticated','public.record_payment(text,jsonb,text)','EXECUTE') b, (SELECT prosecdef FROM pg_proc WHERE oid='public.record_payment(text,jsonb,text)'::regprocedure) sd")).rows[0];
  ck('droits après installation : anon non, authenticated oui, SECURITY DEFINER conservé', g.a === false && g.b === true && g.sd === true, JSON.stringify(g));
  ck('empreinte modifiée (la fonction a bien changé)', (await functionMd5(c)) !== EXPECTED_SQL15_MD5);
  await c.end();
}

async function test() {
  authorized('test');
  const { Pool } = require('pg');
  const c = await connect(); await target(c);
  const ids = [];
  for (const e of EMAILS.slice(0, 2)) {
    const ex = await c.query('SELECT id FROM auth.users WHERE email=$1', [e]);
    if (ex.rows[0]) { ids.push(ex.rows[0].id); continue; }
    const id = crypto.randomUUID(); ids.push(id);
    if (LOCAL) await c.query('INSERT INTO auth.users(id,email) VALUES ($1,$2)', [id, e]);
    else {
      const pw = crypto.randomBytes(18).toString('hex') + 'Aa1!';   // aléatoire, jamais affiché ni conservé
      await c.query(`INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
        VALUES ('00000000-0000-0000-0000-000000000000', $1::uuid, 'authenticated', 'authenticated', $2, crypt($3, gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '')`, [id, e, pw]);
      await c.query(`INSERT INTO auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
        VALUES (gen_random_uuid(), $1::uuid, $1::text, jsonb_build_object('sub', $1::text, 'email', $2::text, 'email_verified', true), 'email', now(), now(), now())`, [id, e]);
    }
  }
  const [U, V] = ids;
  for (const u of ids) {
    await c.query("INSERT INTO public.licenses(user_id,type,status,expires_at) VALUES ($1,'annual','active',now()+interval '30 days') ON CONFLICT DO NOTHING", [u]).catch(() => {});
    await c.query('INSERT INTO public.doc_store_testers(user_id) VALUES ($1) ON CONFLICT DO NOTHING', [u]);
    await c.query("INSERT INTO public.doc_counters(user_id,doc_type,last_value) VALUES ($1,'invoice',9) ON CONFLICT (user_id, doc_type) DO NOTHING", [u]);
    await c.query("INSERT INTO public.user_data(user_id,key,value) VALUES ($1,'invoices',$2) ON CONFLICT (user_id,key) DO UPDATE SET value=EXCLUDED.value, updated_at = now() - interval '1 hour'", [u, JSON.stringify(require('../tests/lib/paiements-sql-checks').seedInvoices())]);
    await c.query("UPDATE public.user_data SET updated_at = now() - interval '1 hour' WHERE user_id=$1", [u]);
    const r = (await c.query('SELECT public.fp_doc_mode_set($1::uuid,$2,$3,0) r', [u, 'documents', null])).rows[0].r;
    if (r && r.ok === false) throw new Error('bascule de mode refusée : ' + JSON.stringify(r));
  }
  // Comptes legacy pay-c / pay-d : aucune bascule de mode, factures dans user_data (clé 'invoices'), compteurs serveur cohérents
  const lids = [];
  for (const e of EMAILS.slice(2)) {
    const ex = await c.query('SELECT id FROM auth.users WHERE email=$1', [e]);
    if (ex.rows[0]) { lids.push(ex.rows[0].id); continue; }
    const id = crypto.randomUUID(); lids.push(id);
    if (LOCAL) await c.query('INSERT INTO auth.users(id,email) VALUES ($1,$2)', [id, e]);
    else {
      const pw = crypto.randomBytes(18).toString('hex') + 'Aa1!';
      await c.query(`INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
        VALUES ('00000000-0000-0000-0000-000000000000', $1::uuid, 'authenticated', 'authenticated', $2, crypt($3, gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '')`, [id, e, pw]);
      await c.query(`INSERT INTO auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
        VALUES (gen_random_uuid(), $1::uuid, $1::text, jsonb_build_object('sub', $1::text, 'email', $2::text, 'email_verified', true), 'email', now(), now(), now())`, [id, e]);
    }
  }
  for (const u of lids) {
    await c.query("INSERT INTO public.licenses(user_id,type,status,expires_at) VALUES ($1,'annual','active',now()+interval '30 days') ON CONFLICT DO NOTHING", [u]).catch(() => {});
    await c.query("INSERT INTO public.doc_counters(user_id,doc_type,last_value) VALUES ($1,'invoice',9) ON CONFLICT (user_id, doc_type) DO NOTHING", [u]);
    await c.query("INSERT INTO public.user_data(user_id,key,value) VALUES ($1,'invoices',$2) ON CONFLICT (user_id,key) DO UPDATE SET value=EXCLUDED.value", [u, JSON.stringify(require('../tests/lib/paiements-sql-checks').seedInvoices())]);
    const md = (await c.query('SELECT public.fp_doc_mode($1::uuid) m', [u])).rows[0].m;
    if (md !== 'legacy') throw new Error('compte legacy attendu pour ' + u);
  }
  out('## Essais du plafond (comptes jetables pay-a / pay-b en mode documents ; pay-c / pay-d en mode legacy)');
  const pool = new (require('pg').Pool)(LOCAL ? { database: process.env.REHEARSAL_DB, max: 20 } : (() => { const p = require('./preprod-db').parseDbUrl(process.env.PREPROD_DB_URL); return { host: p.host, port: Number(p.port), database: p.database, user: p.user, password: p.password, ssl: { rejectUnauthorized: false }, max: 12 }; })());
  async function as(uid, fn) {
    const k = await pool.connect();
    try { await k.query('BEGIN'); await k.query('SET LOCAL ROLE authenticated'); await k.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [uid]);
      await k.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: 'authenticated' })]);
      const r = await fn(k); await k.query('COMMIT'); return r; } catch (e) { await k.query('ROLLBACK').catch(() => {}); throw e; } finally { k.release(); }
  }
  await require('../tests/lib/paiements-sql-checks').capChecks({ pool, as, ck, U, V });
  out('\n## Essais du plafond legacy (sql/26)');
  await require('../tests/lib/paiements-legacy-checks').legacyChecks({ pool, as, ck, U: lids[0], V: lids[1] });
  await pool.end(); await c.end();
}

async function cleanup() {
  authorized('cleanup');
  const c = await connect(); await target(c);
  const us = (await c.query('SELECT id::text id, email FROM auth.users WHERE email = ANY($1)', [EMAILS])).rows;
  const uids = us.map((u) => u.id);
  const strange = (await c.query('SELECT (SELECT count(*) FROM public.doc_payments WHERE NOT (user_id::text = ANY($1)))::int p, (SELECT count(*) FROM public.documents WHERE NOT (user_id::text = ANY($1)))::int d', [uids])).rows[0];
  out(`- Lignes de paiements/documents étrangères aux comptes de test (information, non touchées) : ${strange.p} / ${strange.d}`);
  if (process.argv.includes('--rollback')) {
    await c.query('DROP TRIGGER IF EXISTS trg_10_payments_cap ON public.user_data'); await c.query('DROP FUNCTION IF EXISTS public.guard_payments_cap_legacy()');
    ck('sql/26 retiré (déclencheur et fonction supprimés)', (await c.query("SELECT count(*)::int n FROM pg_trigger WHERE tgname='trg_10_payments_cap'")).rows[0].n === 0);
    const b = await c.query('SELECT definition FROM public._fp_backup_record_payment WHERE id=1');
    if (!b.rows[0]) ck('définition sauvegardée trouvée pour le retour arrière', false);
    else { await c.query('BEGIN'); await c.query(b.rows[0].definition); await c.query('REVOKE ALL ON FUNCTION public.record_payment(TEXT, JSONB, TEXT) FROM PUBLIC, anon'); await c.query('GRANT EXECUTE ON FUNCTION public.record_payment(TEXT, JSONB, TEXT) TO authenticated'); await c.query('COMMIT'); ck('record_payment restauré à la définition de sql/15', (await functionMd5(c)) === EXPECTED_SQL15_MD5); }
  }
  await c.query('BEGIN');
  // le journal des paiements est verrouillé : le trigger autorise la suppression en cascade d'un compte (voir guard_doc_payments)
  const del = await c.query('DELETE FROM auth.users WHERE id::text = ANY($1) AND email = ANY($2)', [uids, EMAILS]);
  await c.query('COMMIT');
  ck(`${del.rowCount} compte(s) de test supprimé(s) (e-mails exacts pay-a / pay-b uniquement)`, del.rowCount === us.length);
  const left = (await c.query('SELECT (SELECT count(*) FROM auth.users WHERE email = ANY($1))::int u, (SELECT count(*) FROM public.documents WHERE user_id::text = ANY($2))::int d, (SELECT count(*) FROM public.doc_payments WHERE user_id::text = ANY($2))::int p', [EMAILS, uids])).rows[0];
  const ud = (await c.query("SELECT count(*)::int n FROM public.user_data WHERE user_id::text = ANY($1)", [uids])).rows[0].n;
  ck('plus aucun compte, document, paiement ni donnée legacy de test', left.u === 0 && left.d === 0 && left.p === 0 && ud === 0, JSON.stringify({ ...left, user_data: ud }));
  await c.end();
}

(async () => {
  const phase = process.argv[2];
  if (!['precheck', 'install', 'test', 'cleanup'].includes(phase)) { console.error('Usage : precheck | install | test | cleanup [--rollback]'); process.exit(1); }
  out(`# Plafond des paiements — phase ${phase}${LOCAL ? ' (RÉPÉTITION LOCALE, pas Supabase)' : ''}`);
  await ({ precheck, install, test, cleanup })[phase]();
  const f = res.filter((x) => !x).length;
  out(`\n${res.length - f}/${res.length} contrôles réussis`);
  if (process.env.REPORT_PATH) fs.writeFileSync(process.env.REPORT_PATH, lines.join('\n') + '\n');
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error('ERREUR : ' + e.message); process.exit(1); });
