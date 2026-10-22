// Tests de concurrence RÉELLE (plusieurs connexions PostgreSQL) de sql/17_mode_stockage.sql : bascules pendant des écritures, paiements rejoués,
// conflits suppression/modification, prérequis et ré-application du script. Base PostgreSQL LOCALE jetable : SIMULATION, pas Supabase.
const { Pool } = require('pg');
const { execFileSync } = require('child_process');
const path = require('path');
const R = path.join(__dirname, '..', '..');
const DB = 'fp_modeit_' + process.pid, DB0 = 'fp_modepre_' + process.pid;
const ps = (db, a) => execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-d', db, ...a], { stdio: ['ignore', 'pipe', 'pipe'] });
const res = []; const ck = (n, ok, x = '') => { res.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || !x ? '' : ' -> ' + String(x).slice(0, 400))); };
const A = 'd1000000-0000-0000-0000-000000000001', B = 'd2000000-0000-0000-0000-000000000002', C = 'd3000000-0000-0000-0000-000000000003', D = 'd4000000-0000-0000-0000-000000000004';
let pool;
async function as(uid, fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); await c.query('SET LOCAL ROLE authenticated'); await c.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [uid]);
    const r = await fn(c); await c.query('COMMIT'); return r;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
const up = (uid, doc, ver, op) => as(uid, async (c) => (await c.query('SELECT public.upsert_document($1::jsonb,$2,$3) r', [JSON.stringify(doc), ver, op])).rows[0].r);
const del = (uid, id, ver, op) => as(uid, async (c) => (await c.query('SELECT public.delete_document($1,$2,$3,$4) r', ['invoice', id, ver, op])).rows[0].r);
const pay = (uid, inv, p, op) => as(uid, async (c) => (await c.query('SELECT public.record_payment($1,$2::jsonb,$3) r', [inv, JSON.stringify(p), op])).rows[0].r);
const flip = (uid, mode, resol = null) => pool.query('SELECT public.fp_doc_mode_set($1,$2,$3,0) r', [uid, mode, resol]).then((x) => x.rows[0].r);
const flipRetry = async (uid, mode, resol = null) => { for (let i = 0; i < 6; i++) { try { return await flip(uid, mode, resol); } catch (e) { if (!/deadlock/i.test(e.message)) throw e; } } throw new Error('trop de blocages'); };
const sel = async (sql, p = []) => (await pool.query(sql, p)).rows;
const settle = (ps_) => Promise.allSettled(ps_);
(async () => {
  const T0 = Date.now();
  // --- prérequis : sql/17 sans sql/15/16 doit s'arrêter sans rien créer ---
  ps('postgres', ['-c', `CREATE DATABASE ${DB0}`]); ps(DB0, ['-f', path.join(R, 'tests/sql/stub_supabase.sql')]);
  for (const f of ['00_setup_complet', '14_numerotation_et_verrouillage']) { try { ps(DB0, ['-f', path.join(R, 'sql', f + '.sql')]); } catch {} }
  let pre = ''; try { ps(DB0, ['-f', path.join(R, 'sql/17_mode_stockage.sql')]); } catch (e) { pre = String(e.stderr); }
  ck('sql/17 sans sql/15 + sql/16 : arrêt net (PREREQUIS_MANQUANT) et aucun objet créé', /PREREQUIS_MANQUANT/.test(pre) && ps(DB0, ['-At', '-c', "SELECT count(*) FROM pg_class WHERE relname IN ('doc_store_mode','doc_store_testers')"]).toString().trim() === '0', pre.slice(0, 200));
  ps('postgres', ['-c', `DROP DATABASE IF EXISTS ${DB0} WITH (FORCE)`]);

  ps('postgres', ['-c', `CREATE DATABASE ${DB}`]); ps(DB, ['-f', path.join(R, 'tests/sql/stub_supabase.sql')]);
  for (const f of ['00_setup_complet', '05_admins', '06_securite_rls', '07_licence_serveur', '08_admin_comptes', '09_periode_de_grace', '10_anti_abus', '12_admin_supprimer_compte', '13_profil_assistant', '14_numerotation_et_verrouillage'])
    ps(DB, ['-f', path.join(R, 'sql', f + '.sql')]);
  ps(DB, ['-c', 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated']);
  for (const f of ['15_documents', '16_migration_donnees', '17_mode_stockage']) ps(DB, ['-f', f === '17_mode_stockage' && process.env.MODE_SQL_FILE ? process.env.MODE_SQL_FILE : path.join(R, 'sql', f + '.sql')]);
  ps(DB, ['-c', `GRANT ALL ON public.user_data, public.licenses TO authenticated; GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated;
    INSERT INTO auth.users(id,email) VALUES ('${A}','ma@facturapro-test.invalid'),('${B}','mb@facturapro-test.invalid'),('${C}','mc@facturapro-test.invalid'),('${D}','md@facturapro-test.invalid');
    INSERT INTO public.licenses(user_id,type,status,expires_at) SELECT id,'annual','active',now()+interval '100 days' FROM auth.users;
    INSERT INTO public.doc_store_testers(user_id) SELECT id FROM auth.users;
    INSERT INTO public.doc_counters(user_id,doc_type,last_value) SELECT id,'invoice',1 FROM auth.users`]);
  pool = new Pool({ database: DB, max: 30 });
  const seed = (uid) => pool.query("INSERT INTO public.user_data(user_id,key,value) VALUES ($1,'invoices',$2)", [uid, JSON.stringify([{ id: 'i1', type: 'invoice', number: 'FAC-2026-001', status: 'sent', totalHT: 10, totalTVA: 2, totalTTC: 12 }, { id: 'd1', type: 'invoice', number: 'BRO-D1', status: 'draft', totalTTC: 5 }])]);
  for (const u of [A, B, C, D]) await seed(u);
  await pool.query("UPDATE public.user_data SET updated_at = now() - interval '1 hour'");

  // --- ré-application du script (idempotence) ---
  await flip(A, 'documents');
  const modesBefore = await sel('SELECT user_id, mode FROM public.doc_store_mode ORDER BY 1');
  ps(DB, ['-f', path.join(R, 'sql/17_mode_stockage.sql')]);
  const modesAfter = await sel('SELECT user_id, mode FROM public.doc_store_mode ORDER BY 1');
  ck('ré-application de sql/17 : sans erreur, les modes en place sont conservés', JSON.stringify(modesBefore) === JSON.stringify(modesAfter) && modesAfter.some((m) => m.user_id === A && m.mode === 'documents'));

  // --- paiements rejoués en parallèle ---
  const pr = await Promise.all(Array.from({ length: 12 }, () => pay(A, 'i1', { id: 'p-replay', amount: 7, date: '2026-04-01' }, 'pay-op')));
  ck('paiement rejoué 12 fois en parallèle : 12 réponses ok, une seule ligne, facture payée 7 une seule fois', pr.every((r) => r.ok) && (await sel("SELECT count(*)::int n FROM public.doc_payments WHERE user_id=$1 AND id='p-replay'", [A]))[0].n === 1
    && Number((await sel("SELECT paid_amount FROM public.documents WHERE user_id=$1 AND id='i1'", [A]))[0].paid_amount) === 7, JSON.stringify(pr.slice(0, 2)));
  const pd = await Promise.all(Array.from({ length: 8 }, (_, i) => pay(A, 'i1', { id: 'p-par' + i, amount: 1, date: '2026-04-02' }, 'pay-par' + i)));
  ck('8 paiements DISTINCTS simultanés : tous enregistrés, total exact 7 + 8 = 15', pd.every((r) => r.ok) && Number((await sel("SELECT paid_amount FROM public.documents WHERE user_id=$1 AND id='i1'", [A]))[0].paid_amount) === 15);

  // --- 10 appareils, même version ---
  await up(A, { id: 'v1', type: 'invoice', number: 'BRO-V1', status: 'draft', totalTTC: 1 }, 0, 'v-init');
  const vr = await Promise.all(Array.from({ length: 10 }, (_, i) => up(A, { id: 'v1', type: 'invoice', number: 'BRO-V1', status: 'draft', totalTTC: 1, clientName: 'A' + i }, 1, 'v-op' + i)));
  ck('10 appareils, même version : 1 accepté, 9 conflits explicites avec la version serveur', vr.filter((r) => r.ok).length === 1 && vr.filter((r) => r.conflict).length === 9 && vr.filter((r) => r.conflict).every((r) => r.server_version === 2));

  // --- suppression / modification concurrentes ---
  let both = { del: 0, upd: 0, ok: 0 };
  for (let k = 0; k < 8; k++) {
    const id = 'x' + k; await up(A, { id, type: 'invoice', number: 'BRO-X' + k, status: 'draft', totalTTC: 1 }, 0, 'xi' + k);
    const [d, u] = await Promise.all([del(A, id, 1, 'xd' + k), up(A, { id, type: 'invoice', number: 'BRO-X' + k, status: 'draft', totalTTC: 1, clientName: 'édité' }, 1, 'xu' + k)]);
    const n = (await sel("SELECT version, body->>'clientName' c FROM public.documents WHERE user_id=$1 AND id=$2", [A, id]));
    // exactement une des deux opérations réussit ; l'autre reçoit un conflit ; l'état final est celui du gagnant
    const winnerDel = d.ok && !d.conflict && u.conflict, winnerUpd = u.ok && d.conflict;
    if (winnerDel && n.length === 0) both.del++; else if (winnerUpd && n.length === 1 && n[0].c === 'édité') both.upd++;
    if (winnerDel || winnerUpd) both.ok++;
  }
  ck('suppression vs modification simultanées (8 essais) : toujours exactement un gagnant, l\'autre reçoit un conflit explicite, état final cohérent', both.ok === 8, JSON.stringify(both));

  // --- bascules PENDANT des écritures concurrentes (écritures étalées dans le temps pour que la course ait réellement lieu) ---
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const newAcct = async (u, email) => {
    await pool.query('INSERT INTO auth.users(id,email) VALUES ($1,$2)', [u, email]);
    await pool.query("INSERT INTO public.licenses(user_id,type,status,expires_at) VALUES ($1,'annual','active',now()+interval '100 days')", [u]);
    await pool.query('INSERT INTO public.doc_store_testers(user_id) VALUES ($1)', [u]);
    await pool.query("INSERT INTO public.doc_counters(user_id,doc_type,last_value) VALUES ($1,'invoice',1)", [u]);
  };
  const W = 60, ROUNDS = 6;
  const legacyWrite = (uid, i) => as(uid, (c) => c.query("UPDATE public.user_data SET value = value || $1::jsonb WHERE user_id=$2 AND key='invoices'", [JSON.stringify([{ id: 'w' + i, type: 'invoice', number: 'BRO-W' + i, status: 'draft', totalTTC: i }]), uid]));
  let tot1 = { ok: 0, refused: 0, lost: 0, flips: 0, stopped: 0, badRefusal: 0 };
  for (let k = 0; k < ROUNDS; k++) {
    const u = 'e' + k + '000000-0000-0000-0000-000000000001';
    await newAcct(u, `r${k}@facturapro-test.invalid`);
    await seed(u); await pool.query("UPDATE public.user_data SET updated_at = now() - interval '1 hour' WHERE user_id=$1", [u]);
    const writers = Promise.allSettled(Array.from({ length: W }, async (_, i) => { await sleep(i * 2); return legacyWrite(u, i); }));
    await sleep(25 + k * 12);
    const fr = await flipRetry(u, 'documents');
    const wr = await writers;
    const okW = wr.map((r, i) => ({ r, i })).filter((x) => x.r.status === 'fulfilled').map((x) => 'w' + x.i);
    const refused = wr.filter((r) => r.status === 'rejected');
    const inDocs = new Set((await sel('SELECT id FROM public.documents WHERE user_id=$1', [u])).map((r) => r.id));
    tot1.ok += okW.length; tot1.refused += refused.length; tot1.lost += okW.filter((id) => !inDocs.has(id)).length;
    tot1.badRefusal += refused.filter((r) => !(r.reason.code === '42501' || /deadlock/i.test(r.reason.message))).length;
    if (fr.ok) tot1.flips++; else tot1.stopped++;
  }
  ck(`bascule vers documents pendant des écritures concurrentes (${ROUNDS} courses × ${W} écritures) : ${tot1.ok} acceptées avant le verrou, ${tot1.refused} refusées après ; ${tot1.flips} bascules faites, ${tot1.stopped} arrêtées`,
    tot1.lost === 0 && tot1.ok > 0 && tot1.refused > 0 && tot1.flips === ROUNDS, JSON.stringify(tot1));
  ck('aucune écriture acceptée n\'est absente du nouveau stockage (0 perdue) ; toutes les refusées portent SQLSTATE 42501 (ou interblocage rejouable)', tot1.lost === 0 && tot1.badRefusal === 0, JSON.stringify(tot1));

  let tot2 = { ok: 0, refused: 0, lost: 0, flips: 0, badRefusal: 0 };
  for (let k = 0; k < ROUNDS; k++) {
    const u = 'f' + k + '000000-0000-0000-0000-000000000001';
    await newAcct(u, `s${k}@facturapro-test.invalid`);
    await seed(u); await pool.query("UPDATE public.user_data SET updated_at = now() - interval '1 hour' WHERE user_id=$1", [u]);
    await flipRetry(u, 'documents');
    const writers = Promise.allSettled(Array.from({ length: W }, async (_, i) => { await sleep(i * 2); return up(u, { id: 'n' + i, type: 'invoice', number: 'BRO-N' + i, status: 'draft', totalTTC: i }, 0, 'cw' + k + '-' + i); }));
    await sleep(25 + k * 12);
    const fr = await flipRetry(u, 'legacy');
    const wr = await writers;
    const okN = wr.map((r, i) => ({ r, i })).filter((x) => x.r.status === 'fulfilled' && x.r.value.ok).map((x) => 'n' + x.i);
    const refused = wr.filter((r) => r.status === 'rejected');
    const inLegacy = new Set((await sel("SELECT e->>'id' id FROM public.user_data x, jsonb_array_elements(x.value) e WHERE x.user_id=$1 AND x.key='invoices'", [u])).map((r) => r.id));
    tot2.ok += okN.length; tot2.refused += refused.length; tot2.lost += okN.filter((id) => !inLegacy.has(id)).length;
    tot2.badRefusal += refused.filter((r) => !/MODE_ANCIEN_STOCKAGE|deadlock/i.test(r.reason.message)).length;
    if (fr.ok) tot2.flips++;
  }
  ck(`retour vers legacy pendant des écritures concurrentes (${ROUNDS} courses × ${W} écritures) : ${tot2.ok} acceptées avant le verrou, ${tot2.refused} refusées après ; ${tot2.flips} retours faits`,
    tot2.lost === 0 && tot2.ok > 0 && tot2.refused > 0 && tot2.flips === ROUNDS, JSON.stringify(tot2));
  ck('aucune écriture acceptée n\'est absente de user_data après le retour (0 perdue) ; refus explicites MODE_ANCIEN_STOCKAGE (ou interblocage rejouable)', tot2.lost === 0 && tot2.badRefusal === 0, JSON.stringify(tot2));

  // --- deux bascules simultanées du même compte ---
  const dd = await settle([flip(D, 'documents'), flip(D, 'documents'), flip(D, 'documents')]);
  const okd = dd.filter((r) => r.status === 'fulfilled');
  ck('3 bascules simultanées du même compte : toutes terminent sans erreur, 1 seule bascule effective (les autres : unchanged), 3 documents au plus, aucun doublon',
    okd.length === 3 && okd.filter((r) => !r.value.unchanged).length === 1 && (await sel('SELECT count(*)::int n FROM public.documents WHERE user_id=$1', [D]))[0].n === 2, JSON.stringify(dd.map((r) => r.status === 'fulfilled' ? r.value.unchanged : r.reason.message)));
  await pool.end();
  ps('postgres', ['-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]);
  const n = res.filter(Boolean).length; console.log(`\n${n}/${res.length} tests de bascule (concurrence réelle, base locale) réussis en ${((Date.now() - T0) / 1000).toFixed(1)} s`); process.exit(n === res.length ? 0 : 1);
})().catch((e) => { console.error(e); try { ps('postgres', ['-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]); ps('postgres', ['-c', `DROP DATABASE IF EXISTS ${DB0} WITH (FORCE)`]); } catch {} process.exit(1); });
