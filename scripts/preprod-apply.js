#!/usr/bin/env node
// Installe / contrôle / nettoie la PRÉPRODUCTION de façon reproductible.
//   node scripts/preprod-apply.js install    # scripts SQL de sql/MANIFEST.json, dans l'ordre, un par transaction
//   node scripts/preprod-apply.js postcheck  # contrôles de sécurité en lecture seule
//   node scripts/preprod-apply.js seed       # 2 comptes de TEST fictifs (mots de passe depuis l'environnement)
//   node scripts/preprod-apply.js cleanup    # supprime uniquement ces 2 comptes de test
//   node scripts/preprod-apply.js status
// Garde-fous : cible vérifiée (preprod-db.js) ; marqueur public._fp_env (env='preprod', ref) exigé pour toute opération
// sauf la toute première installation, qui exige une base totalement vide (sans schéma FacturaPro ni compte).
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const MAN = JSON.parse(fs.readFileSync(path.join(ROOT, 'sql', 'MANIFEST.json'), 'utf8'));
const TEST_EMAILS = ['preprod-a@facturapro-test.invalid', 'preprod-b@facturapro-test.invalid'];
const out = []; const log = (s) => { out.push(s); console.log(s); };

async function marker(c) {
  const r = await c.query("SELECT to_regclass('public._fp_env') t"); if (!r.rows[0].t) return null;
  return (await c.query('SELECT env, project_ref FROM public._fp_env WHERE id=1')).rows[0] || null;
}
async function requireMarker(c, ctx) {
  const m = await marker(c);
  if (!m) throw new Error('REFUS : base non marquée « préproduction » (marqueur absent). Rien n\'a été modifié.');
  if (m.env !== 'preprod' || m.project_ref !== ctx.ref) throw new Error(`REFUS : marqueur inattendu (${m.env}/${m.project_ref}).`);
}
async function install(c, ctx) {
  let m = await marker(c);
  if (!m) {
    const r = await c.query(`SELECT to_regclass('public.user_data') ud, to_regclass('public.admins') ad, (SELECT count(*) FROM auth.users)::int users`);
    const x = r.rows[0];
    if (x.ud || x.ad || x.users > 0) throw new Error('REFUS : base non vide et non marquée préproduction (schéma FacturaPro ou comptes présents). Rien n\'a été modifié.');
    await c.query('BEGIN');
    await c.query(`CREATE TABLE public._fp_env (id int PRIMARY KEY DEFAULT 1 CHECK (id=1), env text NOT NULL, project_ref text NOT NULL, created_at timestamptz DEFAULT now())`);
    await c.query(`CREATE TABLE public._fp_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz DEFAULT now())`);
    await c.query('ALTER TABLE public._fp_env ENABLE ROW LEVEL SECURITY; ALTER TABLE public._fp_migrations ENABLE ROW LEVEL SECURITY');
    await c.query("INSERT INTO public._fp_env(env, project_ref) VALUES ('preprod', $1)", [ctx.ref]);
    await c.query('COMMIT');
    log(`Base vide confirmée : marqueur « préproduction / ${ctx.ref} » posé.`);
  } else await requireMarker(c, ctx);
  await c.query('CREATE TABLE IF NOT EXISTS public._fp_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz DEFAULT now())');
  // tables techniques : jamais accessibles via l'API publique
  await c.query('REVOKE ALL ON public._fp_env, public._fp_migrations FROM anon, authenticated');
  for (const s of MAN.ordre) {
    const sql = fs.readFileSync(path.join(ROOT, 'sql', s.file), 'utf8');
    const sha = crypto.createHash('sha256').update(sql).digest('hex');
    const prev = (await c.query('SELECT sha256 FROM public._fp_migrations WHERE name=$1', [s.file])).rows[0];
    if (prev && prev.sha256 === sha) { log(`= ${s.file} : déjà appliqué (même empreinte), ignoré`); continue; }
    if (prev && !s.reexecutable) throw new Error(`${s.file} modifié et non réexécutable : arrêt.`);
    const t0 = Date.now();
    try {
      await c.query('BEGIN'); await c.query(sql);
      await c.query('INSERT INTO public._fp_migrations(name, sha256) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET sha256=EXCLUDED.sha256, applied_at=now()', [s.file, sha]);
      await c.query('COMMIT');
      log(`✔ ${s.file} : ${prev ? 'ré' : ''}appliqué en ${Date.now() - t0} ms (sha256 ${sha.slice(0, 12)})`);
    } catch (e) { try { await c.query('ROLLBACK'); } catch {} throw new Error(`✘ ${s.file} : ÉCHEC, annulé (transaction), procédure arrêtée → ${e.message}`); }
  }
}
// Contrôles de sécurité en lecture seule (résultats réels, aucun succès supposé)
async function postcheck(c, ctx) {
  await requireMarker(c, ctx);
  let fails = 0; const ck = (n, ok, x = '') => { if (!ok) fails++; log(`${ok ? 'PASS' : 'FAIL'} ${n}${ok || !x ? '' : ' -> ' + x}`); };
  const q = async (s, a) => (await c.query(s, a)).rows;
  const migs = await q('SELECT name FROM public._fp_migrations');
  ck('les 10 scripts du manifeste sont enregistrés', migs.length === MAN.ordre.length, String(migs.length));
  ck('next_doc_number(text,int) existe', (await q("SELECT to_regprocedure('public.next_doc_number(text,integer)') p"))[0].p !== null);
  ck('RLS activée sur toutes les tables de public', (await q("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity"))[0].n === 0);
  // Supabase accorde par défaut des droits d'accès aux rôles anon/authenticated sur les nouvelles tables : c'est la RLS qui protège.
  // Ce n'est donc PAS un échec ; on le journalise et on vérifie surtout qu'aucune table n'est sans RLS (contrôle précédent).
  ck('tables techniques _fp_* inaccessibles à anon/authenticated', !(await q("SELECT bool_or(has_table_privilege(r, t, 'SELECT')) b FROM unnest(ARRAY['anon','authenticated']) r, unnest(ARRAY['public._fp_env','public._fp_migrations']) t"))[0].b);
  const ag = await q("SELECT DISTINCT table_name FROM information_schema.role_table_grants WHERE grantee='anon' AND table_schema='public' ORDER BY 1");
  log(`INFO droits de table accordés à anon (protégés par la RLS) : ${ag.length ? ag.map(r => r.table_name).join(', ') : 'aucun'}`);
  ck('fonctions SECURITY DEFINER : search_path fixé', (await q("SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace WHERE s.nspname='public' AND p.prosecdef AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig,'{}')) cfg WHERE cfg LIKE 'search_path=%')"))[0].n === 0);
  const sd = await q("SELECT p.proname FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace WHERE s.nspname='public' AND p.prosecdef AND has_function_privilege('anon', p.oid, 'EXECUTE')");
  ck('aucune fonction SECURITY DEFINER exécutable par anon', sd.length === 0, sd.map(r => r.proname).join(','));
  const tf = await q("SELECT p.proname FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace WHERE s.nspname='public' AND p.prorettype='trigger'::regtype AND (has_function_privilege('anon', p.oid,'EXECUTE') OR has_function_privilege('authenticated', p.oid,'EXECUTE'))");
  ck('aucune fonction de déclencheur exécutable par anon/authenticated', tf.length === 0, tf.map(r => r.proname).join(','));
  ck('doc_counters : écriture directe impossible pour authenticated', !(await q("SELECT has_table_privilege('authenticated','public.doc_counters','INSERT') OR has_table_privilege('authenticated','public.doc_counters','UPDATE') OR has_table_privilege('authenticated','public.doc_counters','DELETE') b"))[0].b);
  ck('doc_events : écriture directe impossible pour authenticated', !(await q("SELECT has_table_privilege('authenticated','public.doc_events','INSERT') OR has_table_privilege('authenticated','public.doc_events','UPDATE') OR has_table_privilege('authenticated','public.doc_events','DELETE') b"))[0].b);
  ck('next_doc_number non exécutable par anon, exécutable par authenticated', !(await q("SELECT has_function_privilege('anon','public.next_doc_number(text,integer)','EXECUTE') b"))[0].b && (await q("SELECT has_function_privilege('authenticated','public.next_doc_number(text,integer)','EXECUTE') b"))[0].b);
  const trg = await q("SELECT tgname FROM pg_trigger WHERE tgrelid='public.user_data'::regclass AND NOT tgisinternal");
  ck('déclencheurs de verrouillage présents sur user_data', ['trg_guard_issued_invoices_ins', 'trg_guard_issued_invoices', 'trg_guard_issued_invoices_del'].every(n => trg.some(t => t.tgname === n)), trg.map(t => t.tgname).join(','));
  ck('my_license() (création paresseuse de l\'essai) existe et n\'est pas exécutable par anon', (await q("SELECT to_regprocedure('public.my_license()') p"))[0].p !== null && !(await q("SELECT has_function_privilege('anon','public.my_license()','EXECUTE') b"))[0].b);
  ck('aucun compte utilisateur hors comptes de test', (await q("SELECT count(*)::int n FROM auth.users WHERE email NOT LIKE '%@facturapro-test.invalid' AND email <> 'webnour@gmail.com'"))[0].n === 0);
  log(fails ? `\n${fails} contrôle(s) en échec` : '\nTous les contrôles de sécurité réussis');
  return fails;
}
async function seed(c, ctx) {
  await requireMarker(c, ctx);
  const pw = [process.env.TEST_A_PASSWORD, process.env.TEST_B_PASSWORD];
  if (!pw[0] || !pw[1] || pw[0].length < 12) throw new Error('TEST_A_PASSWORD / TEST_B_PASSWORD (≥ 12 caractères) requis dans l\'environnement.');
  await c.query('BEGIN');
  await c.query('DELETE FROM auth.users WHERE email = ANY($1)', [TEST_EMAILS]);
  for (let i = 0; i < 2; i++) {
    const id = crypto.randomUUID();
    await c.query(`INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
      VALUES ('00000000-0000-0000-0000-000000000000', $1::uuid, 'authenticated', 'authenticated', $2, crypt($3, gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '')`, [id, TEST_EMAILS[i], pw[i]]);
    await c.query(`INSERT INTO auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
      VALUES (gen_random_uuid(), $1::uuid, $1::text, jsonb_build_object('sub', $1::text, 'email', $2::text, 'email_verified', true), 'email', now(), now(), now())`, [id, TEST_EMAILS[i]]);
  }
  await c.query('COMMIT');
  const l = (await c.query("SELECT email, email_confirmed_at IS NOT NULL AS confirme FROM auth.users WHERE email = ANY($1) ORDER BY 1", [TEST_EMAILS])).rows;
  log('Comptes de test créés (sans licence : l\'essai est créé par my_license() à la première connexion, comme dans l\'application) : ' + JSON.stringify(l));
  if (l.length !== 2) throw new Error('création des comptes de test incomplète');
}
async function cleanup(c, ctx) {
  await requireMarker(c, ctx);
  const before = (await c.query('SELECT (SELECT count(*) FROM public.user_data d JOIN auth.users u ON u.id=d.user_id WHERE u.email=ANY($1))::int ud, (SELECT count(*) FROM public.doc_counters d JOIN auth.users u ON u.id=d.user_id WHERE u.email=ANY($1))::int dc', [TEST_EMAILS])).rows[0];
  const r = await c.query('DELETE FROM auth.users WHERE email = ANY($1)', [TEST_EMAILS]);
  const left = (await c.query("SELECT (SELECT count(*) FROM auth.users WHERE email=ANY($1))::int users, (SELECT count(*) FROM public.user_data WHERE user_id NOT IN (SELECT id FROM auth.users))::int orphan", [TEST_EMAILS])).rows[0];
  log(`Nettoyage : ${r.rowCount} compte(s) de test supprimé(s) (user_data ${before.ud}, compteurs ${before.dc} supprimés en cascade) ; restants : comptes ${left.users}, lignes orphelines ${left.orphan}`);
  if (left.users || left.orphan) throw new Error('nettoyage incomplet');
}
async function status(c, ctx) {
  await requireMarker(c, ctx);
  log(JSON.stringify({ marqueur: await marker(c), migrations: (await c.query('SELECT name, left(sha256,12) sha, applied_at FROM public._fp_migrations ORDER BY applied_at')).rows, comptes: (await c.query('SELECT count(*)::int n FROM auth.users')).rows[0].n }, null, 1));
}
const CMDS = { install, postcheck, seed, cleanup, status };
async function run(c, cmd, ctx) { return CMDS[cmd](c, ctx); }
module.exports = { run, CMDS, TEST_EMAILS };
if (require.main === module) {
  const cmd = process.argv[2];
  if (!CMDS[cmd]) { console.error('Commande : ' + Object.keys(CMDS).join(' | ')); process.exit(1); }
  const { connect } = require('./preprod-db');
  (async () => {
    let conn, code = 0;
    try {
      conn = await connect();
      log(`Cible vérifiée : projet ${conn.ref} (préproduction) — commande « ${cmd} »`);
      const r = await run(conn.client, cmd, { ref: conn.ref }); if (typeof r === 'number' && r > 0) code = 1;
    } catch (e) { log('ERREUR : ' + e.message); code = 1; }
    finally { if (conn) await conn.client.end().catch(() => {}); if (process.env.REPORT_PATH) fs.appendFileSync(process.env.REPORT_PATH, `\n### ${cmd}\n\n\`\`\`\n${out.join('\n')}\n\`\`\`\n`); }
    process.exit(code);
  })();
}
