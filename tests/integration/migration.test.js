// Tests de concurrence RÉELLE (plusieurs connexions PostgreSQL simultanées) du nouveau stockage « une ligne par document » :
// deux appareils, coupures réseau, numérotation simultanée, paiements rejoués, migration pendant que d'autres écrivent.
// Base PostgreSQL LOCALE jetable + imitation d'auth Supabase (SIMULATION : pas Supabase). Données fictives.
const { Pool, Client } = require('pg');
const { execFileSync } = require('child_process');
const path = require('path');
const R = path.join(__dirname, '..', '..');
const DB = 'fp_migit_' + process.pid;
const U = 'c1000000-0000-0000-0000-000000000001', U2 = 'c2000000-0000-0000-0000-000000000002';
const ps = (db, a) => execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-d', db, ...a], { stdio: ['ignore', 'pipe', 'pipe'] });
const res = []; const ck = (n, ok, x = '') => { res.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || !x ? '' : ' -> ' + String(x).slice(0, 300))); };
let pool;
async function as(uid, fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); await c.query('SET LOCAL ROLE authenticated'); await c.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [uid]);
    const r = await fn(c); await c.query('COMMIT'); return r;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
const up = (uid, doc, ver, op) => as(uid, async (c) => (await c.query('SELECT public.upsert_document($1::jsonb,$2,$3) r', [JSON.stringify(doc), ver, op])).rows[0].r);
const sel = async (sql, p = []) => (await pool.query(sql, p)).rows;
(async () => {
  ps('postgres', ['-c', `CREATE DATABASE ${DB}`]);
  ps(DB, ['-f', path.join(R, 'tests/sql/stub_supabase.sql')]);
  for (const f of ['00_setup_complet', '05_admins', '06_securite_rls', '07_licence_serveur', '08_admin_comptes', '09_periode_de_grace', '10_anti_abus', '12_admin_supprimer_compte', '13_profil_assistant', '14_numerotation_et_verrouillage'])
    ps(DB, ['-f', path.join(R, 'sql', f + '.sql')]);
  ps(DB, ['-c', 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated']);
  for (const f of ['15_documents', '16_migration_donnees']) ps(DB, ['-f', path.join(R, 'sql', f + '.sql')]);
  ps(DB, ['-c', `GRANT ALL ON public.user_data, public.licenses TO authenticated; GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated;
    INSERT INTO auth.users(id,email) VALUES ('${U}','it1@test.invalid'),('${U2}','it2@test.invalid');
    INSERT INTO public.licenses(user_id,type,status,expires_at) VALUES ('${U}','annual','active',now()+interval '100 days'),('${U2}','annual','active',now()+interval '100 days');`]);
  pool = new Pool({ database: DB, max: 24 });
  const T0 = Date.now();

  // C1 : 10 appareils modifient le MÊME brouillon à partir de la même version
  await up(U, { id: 'd1', type: 'invoice', number: 'BRO-D1', status: 'draft', totalTTC: 1 }, null, 'c1-init');
  const r1 = await Promise.all(Array.from({ length: 10 }, (_, i) => up(U, { id: 'd1', type: 'invoice', number: 'BRO-D1', status: 'draft', totalTTC: 1, clientName: 'App' + i }, 1, 'c1-op' + i)));
  const ok1 = r1.filter(r => r.ok), cf1 = r1.filter(r => r.conflict);
  ck('10 appareils, même document, même version : exactement 1 accepté, 9 conflits explicites', ok1.length === 1 && cf1.length === 9, JSON.stringify(r1.map(r => r.ok)));
  const d1 = (await sel("SELECT version, body->>'clientName' c FROM public.documents WHERE id='d1'"))[0];
  ck('le document contient la modification du seul gagnant, version 2 (aucun écrasement)', d1.version === 2 && cf1.every(r => r.server_version === 2) && /^App\d$/.test(d1.c), JSON.stringify(d1));

  // C2 : création simultanée du même identifiant
  const r2 = await Promise.all(Array.from({ length: 10 }, (_, i) => up(U, { id: 'dup', type: 'invoice', number: 'BRO-DUP', status: 'draft', clientName: 'N' + i }, 0, 'c2-op' + i)));
  ck('10 créations simultanées du même id : 1 acceptée, 9 conflits, 1 seule ligne', r2.filter(r => r.ok).length === 1 && r2.filter(r => r.conflict).length === 9 && (await sel("SELECT count(*)::int n FROM public.documents WHERE id='dup'"))[0].n === 1);

  // C3 : numérotation + émission simultanées
  const NB = 20;
  const em = await Promise.all(Array.from({ length: NB }, async (_, i) => {
    const num = await as(U, async (c) => (await c.query("SELECT public.next_doc_number('invoice', 0) n")).rows[0].n);
    const number = 'FAC-2026-' + String(num).padStart(3, '0');
    const r = await up(U, { id: 'e' + i, type: 'invoice', number, status: 'sent', date: '2026-05-01', totalHT: 10, totalTVA: 2, totalTTC: 12 }, null, 'c3-op' + i);
    return { num, number, r };
  }));
  const nums = em.map(x => x.num);
  ck(`${NB} émissions simultanées : ${NB} numéros distincts, ${NB} documents acceptés`, new Set(nums).size === NB && em.every(x => x.r.ok), JSON.stringify(nums));
  const cnt = (await sel("SELECT count(*)::int n, count(DISTINCT number)::int d FROM public.documents WHERE user_id=$1 AND doc_type='invoice' AND status<>'draft'", [U]))[0];
  const ctr = (await sel("SELECT last_value FROM public.doc_counters WHERE user_id=$1 AND doc_type='invoice'", [U]))[0].last_value;
  ck('aucun doublon de numéro en base ; le compteur serveur = plus grand numéro attribué', cnt.n === NB && cnt.d === NB && ctr === Math.max(...nums), JSON.stringify([cnt, ctr]));
  // un numéro attribué mais jamais utilisé laisse un trou : documenté, jamais réattribué
  const gap = await as(U, async (c) => (await c.query("SELECT public.next_doc_number('invoice', 0) n")).rows[0].n);
  ck('un numéro attribué puis abandonné n\'est JAMAIS réattribué (trou de numérotation documenté)', gap === ctr + 1);
  let dupErr = null;
  try { await up(U, { id: 'steal', type: 'invoice', number: 'FAC-2026-' + String(nums[0]).padStart(3, '0'), status: 'sent', totalTTC: 1 }, null, 'c3-steal'); } catch (e) { dupErr = e.message; }
  ck('réutiliser le numéro d\'une facture existante : refusé (NUMERO_EN_DOUBLE)', /NUMERO_EN_DOUBLE/.test(dupErr || ''), dupErr);

  // C4 : deux appareils sur des documents différents, en parallèle : aucune perte (contrairement à l'ancien tableau)
  await Promise.all(Array.from({ length: 30 }, (_, i) => up(U, { id: 'p' + i, type: 'invoice', number: 'BRO-P' + i, status: 'draft', totalTTC: i }, null, 'c4-init' + i)));
  const both = await Promise.all([0, 1].flatMap(dev => Array.from({ length: 30 }, (_, i) => (i % 2 === dev) ? up(U, { id: 'p' + i, type: 'invoice', number: 'BRO-P' + i, status: 'draft', totalTTC: i, device: dev }, 1, `c4-d${dev}-${i}`) : null)).filter(Boolean));
  const lost = await sel("SELECT count(*)::int n FROM public.documents WHERE id LIKE 'p%' AND (body->>'device') IS NULL");
  ck('2 appareils, documents différents, en parallèle : 30 modifications acceptées, 0 perdue', both.every(r => r.ok) && lost[0].n === 0, JSON.stringify(lost));
  // témoin : l'ancien stockage en bloc perd bien une écriture dans le même scénario (lecture A, lecture B, écriture A, écriture B)
  await pool.query("INSERT INTO public.user_data(user_id,key,value) VALUES ($1,'quotes','[{\"id\":\"a\"},{\"id\":\"b\"}]')", [U2]);
  const rd = async () => (await pool.query("SELECT value FROM public.user_data WHERE user_id=$1 AND key='quotes'", [U2])).rows[0].value;
  const A = await rd(), B = await rd(); A[0].x = 'A'; B[1].x = 'B';
  await pool.query("UPDATE public.user_data SET value=$2 WHERE user_id=$1 AND key='quotes'", [U2, JSON.stringify(A)]);
  await pool.query("UPDATE public.user_data SET value=$2 WHERE user_id=$1 AND key='quotes'", [U2, JSON.stringify(B)]);
  const fin = await rd();
  ck('témoin : avec l\'ancien tableau en bloc, la modification de l\'appareil A est PERDUE (c\'est le défaut que la migration corrige)', fin[0].x === undefined && fin[1].x === 'B');

  // C5 : coupure réseau AVANT validation : rien n'est enregistré, la reprise aboutit une seule fois
  const adm = new Client({ database: DB }); await adm.connect();
  const cl = new Client({ database: DB }); await cl.connect();
  // La connexion de `cl` est coupée VOLONTAIREMENT ci-dessous : selon le timing, pg signale la socket fermée (EPIPE / ECONNRESET / « terminating connection »)
  // par un événement « error » du client EN PLUS du rejet de la requête. On absorbe UNIQUEMENT ces erreurs de coupure attendues ; toute autre erreur est conservée et fait échouer le test.
  const cutEvents = [], unexpectedClientErrors = [];
  cl.on('error', (e) => { (e && (e.code === 'EPIPE' || e.code === 'ECONNRESET' || e.code === '57P01' || /terminating connection|Connection terminated/i.test(e.message || '')) ? cutEvents : unexpectedClientErrors).push(e); });
  const pid = (await cl.query('SELECT pg_backend_pid() p')).rows[0].p;
  await cl.query('BEGIN'); await cl.query('SET LOCAL ROLE authenticated'); await cl.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [U]);
  await cl.query('SELECT public.upsert_document($1::jsonb,$2,$3)', [JSON.stringify({ id: 'cut1', type: 'invoice', number: 'BRO-CUT1', status: 'draft' }), null, 'cut-op-1']);
  await adm.query('SELECT pg_terminate_backend($1)', [pid]);
  let cutErr = null; try { await cl.query('COMMIT'); } catch (e) { cutErr = e.message; }
  await cl.end().catch(() => {});
  ck('coupure avant COMMIT : la connexion est perdue et AUCUNE ligne n\'a été enregistrée', !!cutErr && (await sel("SELECT count(*)::int n FROM public.documents WHERE id='cut1'"))[0].n === 0, cutErr);
  const retry = await up(U, { id: 'cut1', type: 'invoice', number: 'BRO-CUT1', status: 'draft' }, null, 'cut-op-1');
  ck('reprise avec la même opération : enregistré une fois (version 1)', retry.ok && retry.version === 1 && !retry.replay);
  // C6 : coupure APRÈS validation (réponse perdue) : le rejeu est reconnu
  await up(U, { id: 'cut1', type: 'invoice', number: 'BRO-CUT1', status: 'draft', clientName: 'X' }, 1, 'cut-op-2');   // réponse « perdue »
  const replay = await up(U, { id: 'cut1', type: 'invoice', number: 'BRO-CUT1', status: 'draft', clientName: 'X' }, 1, 'cut-op-2');
  ck('réponse perdue après validation : le rejeu est reconnu (replay), aucune version supplémentaire', replay.ok && replay.replay === true && (await sel("SELECT version FROM public.documents WHERE id='cut1'"))[0].version === 2);
  // C6b : émission rejouée après coupure => un seul numéro, un seul événement
  const nn = await as(U, async (c) => (await c.query("SELECT public.next_doc_number('invoice',0) n")).rows[0].n);
  const issue = { id: 'cut1', type: 'invoice', number: 'FAC-2026-' + String(nn).padStart(3, '0'), status: 'sent', clientName: 'X', totalHT: 1, totalTVA: 0.2, totalTTC: 1.2 };
  await up(U, issue, 2, 'cut-op-3'); const issue2 = await up(U, issue, 2, 'cut-op-3');
  ck('émission rejouée après coupure : un seul événement « emission » dans le journal serveur', issue2.replay === true && (await sel("SELECT count(*)::int n FROM public.doc_events WHERE doc_id='cut1' AND action='emission'"))[0].n === 1);

  // C7/C8 : paiements
  const pay = (id, amt, op) => as(U, async (c) => (await c.query('SELECT public.record_payment($1,$2::jsonb,$3) r', ['e0', JSON.stringify({ id, amount: amt, date: '2026-05-02', method: 'virement' }), op])).rows[0].r);
  const same = await Promise.all(Array.from({ length: 5 }, () => pay('pay-same', 4, 'pp-same')));
  ck('5 envois simultanés du MÊME paiement : 1 seule ligne, règlement non multiplié', (await sel("SELECT count(*)::int n FROM public.doc_payments WHERE id='pay-same'"))[0].n === 1 && (await sel("SELECT paid_amount FROM public.documents WHERE id='e0'"))[0].paid_amount == 4 && same.every(r => r.ok));
  await Promise.all(Array.from({ length: 4 }, (_, i) => pay('pay-d' + i, 2, 'pp-d' + i)));
  const pd = (await sel("SELECT d.paid_amount pa, d.status, (SELECT sum(amount) FROM public.doc_payments WHERE invoice_id='e0') s FROM public.documents d WHERE id='e0'"))[0];
  ck('4 paiements simultanés différents sur la même facture : règlement = somme des paiements (4+4×2=12 → payée)', pd.pa == pd.s && pd.pa == 12 && pd.status === 'paid', JSON.stringify(pd));

  // C9 : migration pendant que d'autres écrivent
  const N = 200; const legacy = Array.from({ length: N }, (_, i) => ({ id: 'L' + i, type: 'invoice', number: 'BRO-L' + i, status: 'draft', totalHT: i, totalTVA: 0, totalTTC: i }));
  await pool.query("INSERT INTO public.user_data(user_id,key,value) VALUES ($1,'invoices',$2)", [U2, JSON.stringify(legacy)]);
  const mig = pool.query('SELECT public.fp_mig_run($1, true) r', [U2]);
  const writers = Promise.all(Array.from({ length: 20 }, (_, i) => up(U2, { id: 'W' + i, type: 'invoice', number: 'BRO-W' + i, status: 'draft', totalTTC: i }, null, 'c9-w' + i)));
  const [mr] = await Promise.all([mig, writers]);
  ck('migration de 200 documents pendant 20 écritures concurrentes : appliquée', mr.rows[0].r.status === 'applied', JSON.stringify(mr.rows[0].r).slice(0, 200));
  const m2 = (await pool.query('SELECT public.fp_mig_run($1, true) r', [U2])).rows[0].r;
  const tot = (await sel("SELECT count(*)::int n FROM public.documents WHERE user_id=$1", [U2]))[0].n;
  ck('2e passage : rien de dupliqué ; 200 factures + 2 devis migrés + 20 nouveaux = 222 ; vérification ok', m2.status === 'applied' && m2.documents_new === 0 && tot === 222 && (await pool.query('SELECT public.fp_mig_verify($1) v', [U2])).rows[0].v.ok === true, JSON.stringify([m2.status, m2.documents_new, tot]));
  const rb = (await pool.query('SELECT public.fp_mig_rollback($1, false) r', [U2])).rows[0].r;
  ck('aperçu de retour arrière après écritures concurrentes : 20 éléments à reprendre dans l\'ancien tableau', rb.changes.some(c => c.key === 'invoices' && c.after === 220 && c.appended === 20), JSON.stringify(rb.changes));

  ck('coupure volontaire (C5) : aucune erreur de client INATTENDUE sur toute la durée du test (seules les erreurs de coupure attendues ont été absorbées)', unexpectedClientErrors.length === 0, unexpectedClientErrors.map((e) => e.code + ' ' + e.message).join(' | '));
  await adm.end(); await pool.end();
  ps('postgres', ['-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]);
  const n = res.filter(Boolean).length; console.log(`\n${n}/${res.length} tests de concurrence/migration réussis en ${((Date.now() - T0) / 1000).toFixed(1)} s`); process.exit(n === res.length ? 0 : 1);
})().catch((e) => { console.error(e); try { ps('postgres', ['-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]); } catch {} process.exit(1); });
