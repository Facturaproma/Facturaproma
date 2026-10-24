// Revue de la proposition docs/PROPOSITION_SQL_PAIEMENTS.md : paiements SIMULTANÉS sur une vraie base PostgreSQL LOCALE jetable
// (scripts sql/15, 16, 17 du dépôt). SIMULATION : ce n'est pas Supabase. Aucune migration n'est appliquée ailleurs que dans cette base jetable.
//   Partie 1 : fonction ACTUELLE (sql/15)  -> documente l'absence de plafond (dépassement possible).
//   Partie 2 : fonction PROPOSÉE (tests/sql/proposition_record_payment.sql) -> plafond tenu malgré la concurrence.
const { Pool } = require('pg');
const { execFileSync } = require('child_process');
const path = require('path');
const R = path.join(__dirname, '..', '..');
const DB = 'fp_paysql_' + process.pid;
const ps = (db, a) => execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-d', db, ...a], { stdio: ['ignore', 'pipe', 'pipe'] });
const res = []; const ck = (n, ok, x = '') => { res.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || !x ? '' : ' -> ' + String(x).slice(0, 300))); };
const U = 'e1000000-0000-0000-0000-000000000001', V = 'e2000000-0000-0000-0000-000000000002';
let pool;
async function as(uid, fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); await c.query('SET LOCAL ROLE authenticated'); await c.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [uid]);
    const r = await fn(c); await c.query('COMMIT'); return r;
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
const pay = (uid, inv, p) => as(uid, async (c) => (await c.query('SELECT public.record_payment($1,$2::jsonb,$3) r', [inv, JSON.stringify(p), 'op-' + p.id])).rows[0].r).then((r) => ({ ok: true, r }), (e) => ({ ok: false, msg: e.message }));
const sel = async (sql, p = []) => (await pool.query(sql, p)).rows;
const state = async (uid, id) => { const r = (await sel('SELECT paid_amount, status, version FROM public.documents WHERE user_id=$1 AND id=$2', [uid, id]))[0]; const s = (await sel('SELECT COALESCE(SUM(amount),0) s, count(*)::int n FROM public.doc_payments WHERE user_id=$1 AND invoice_id=$2', [uid, id]))[0]; return { paid: Number(r.paid_amount), status: r.status, sum: Number(s.s), n: s.n }; };
(async () => {
  ps('postgres', ['-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, '-c', `CREATE DATABASE ${DB}`]); ps(DB, ['-f', path.join(R, 'tests/sql/stub_supabase.sql')]);
  for (const f of ['00_setup_complet', '05_admins', '06_securite_rls', '07_licence_serveur', '08_admin_comptes', '09_periode_de_grace', '10_anti_abus', '12_admin_supprimer_compte', '13_profil_assistant', '14_numerotation_et_verrouillage', '19_journal_sans_doublons', '18_contact_public'])
    ps(DB, ['-f', path.join(R, 'sql', f + '.sql')]);
  ps(DB, ['-c', 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated']);
  for (const f of ['15_documents', '16_migration_donnees', '17_mode_stockage']) ps(DB, ['-f', path.join(R, 'sql', f + '.sql')]);
  ps(DB, ['-c', `GRANT ALL ON public.user_data, public.licenses TO authenticated; GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated;
    INSERT INTO auth.users(id,email) VALUES ('${U}','pa@facturapro-test.invalid'),('${V}','pb@facturapro-test.invalid');
    INSERT INTO public.licenses(user_id,type,status,expires_at) SELECT id,'annual','active',now()+interval '100 days' FROM auth.users;
    INSERT INTO public.doc_store_testers(user_id) SELECT id FROM auth.users;
    INSERT INTO public.doc_counters(user_id,doc_type,last_value) SELECT id,'invoice',9 FROM auth.users`]);
  pool = new Pool({ database: DB, max: 30 });
  const inv = (id, n, ttc, extra = {}) => ({ id, type: 'invoice', number: 'FAC-2026-00' + n, status: 'sent', totalHT: ttc / 1.2, totalTVA: ttc - ttc / 1.2, totalTTC: ttc, ...extra });
  for (const u of [U, V]) await pool.query("INSERT INTO public.user_data(user_id,key,value) VALUES ($1,'invoices',$2)", [u, JSON.stringify([inv('f1', 1, 1000), inv('f2', 2, 1000), inv('f3', 3, 1000), inv('f4', 4, 600), inv('g1', 5, 0)])]);
  await pool.query("UPDATE public.user_data SET updated_at = now() - interval '1 hour'");
  for (const u of [U, V]) { const r = (await sel('SELECT public.fp_doc_mode_set($1,$2,$3,0) r', [u, 'documents', null]))[0].r; if (r && r.ok === false) throw new Error('bascule: ' + JSON.stringify(r)); }

  // ---- Partie 1 : fonction actuelle ----
  const cur = await Promise.all(Array.from({ length: 6 }, (_, i) => pay(U, 'f1', { id: 'cur' + i, amount: 400, date: '2026-10-01' })));
  const s1 = await state(U, 'f1');
  ck('ACTUEL (sql/15) : 6 paiements simultanés de 400 sur 1000 -> tous acceptés, total 2400 (pas de plafond serveur : constat)', cur.every((r) => r.ok) && s1.sum === 2400, JSON.stringify(s1));
  ck('ACTUEL : le cumul reste exact et la facture passe « paid » (pas de perte ni de doublon)', s1.paid === 2400 && s1.status === 'paid' && s1.n === 6);

  // ---- Partie 2 : fonction proposée (dans la base jetable uniquement) ----
  ps(DB, ['-f', path.join(R, 'tests/sql/proposition_record_payment.sql')]);
  const dg = (await sel("SELECT has_function_privilege('anon','public.record_payment(text,jsonb,text)','EXECUTE') a, has_function_privilege('authenticated','public.record_payment(text,jsonb,text)','EXECUTE') b"))[0];
  ck('PROPOSÉ : droits d\'exécution conservés (anon non, authenticated oui) après CREATE OR REPLACE', dg.a === false && dg.b === true, JSON.stringify(dg));
  const prop = await Promise.all(Array.from({ length: 10 }, (_, i) => pay(U, 'f2', { id: 'p' + i, amount: 400, date: '2026-10-01' })));
  const s2 = await state(U, 'f2');
  ck('PROPOSÉ : 10 paiements simultanés de 400 sur 1000 -> exactement 2 acceptés, 8 refusés PAIEMENT_SUPERIEUR_AU_RESTE', prop.filter((r) => r.ok).length === 2 && prop.filter((r) => !r.ok && /PAIEMENT_SUPERIEUR_AU_RESTE/.test(r.msg)).length === 8, JSON.stringify(prop.map((r) => r.ok)));
  ck('PROPOSÉ : cumul 800 <= 1000, facture non soldée, cohérente avec doc_payments', s2.sum === 800 && s2.paid === 800 && s2.status === 'sent' && s2.n === 2, JSON.stringify(s2));
  const last = await Promise.all(Array.from({ length: 5 }, (_, i) => pay(U, 'f2', { id: 'q' + i, amount: 200, date: '2026-10-02' })));
  const s3 = await state(U, 'f2');
  ck('PROPOSÉ : 5 paiements simultanés de 200 sur un reste de 200 -> 1 accepté, facture soldée à 1000 exactement', last.filter((r) => r.ok).length === 1 && s3.sum === 1000 && s3.status === 'paid', JSON.stringify(s3));
  const after = await pay(U, 'f2', { id: 'z1', amount: 0.02, date: '2026-10-03' });
  ck('PROPOSÉ : paiement sur facture soldée refusé', !after.ok && /PAIEMENT_SUPERIEUR_AU_RESTE/.test(after.msg), after.msg);
  const rp = await Promise.all(Array.from({ length: 8 }, () => pay(U, 'f3', { id: 'same', amount: 300, date: '2026-10-01' })));
  const s4 = await state(U, 'f3');
  ck('PROPOSÉ : même paiement (même identifiant) rejoué 8 fois en parallèle -> 8 réponses ok, une seule ligne, 300 une seule fois', rp.every((r) => r.ok) && s4.n === 1 && s4.sum === 300, JSON.stringify(s4));
  const acc = prop.findIndex((r) => r.ok);   // les 2 paiements acceptés dépendent de l'ordre d'arrivée : on rejoue un paiement réellement accepté
  const rp2 = await pay(U, 'f2', { id: 'p' + acc, amount: 400, date: '2026-10-01' });
  ck('PROPOSÉ : rejeu d\'un ancien paiement sur facture déjà soldée -> réponse ok (replay), rien ajouté', rp2.ok && rp2.r.replay === true && (await state(U, 'f2')).n === 3);
  const bad = await Promise.all([pay(U, 'f4', { id: 'b0', amount: 0, date: '2026-10-01' }), pay(U, 'f4', { id: 'b1', amount: -5, date: '2026-10-01' }), pay(U, 'f4', { id: 'b2', amount: 'abc', date: '2026-10-01' }), pay(U, 'g1', { id: 'b3', amount: 10, date: '2026-10-01' })]);
  ck('PROPOSÉ : montant nul, négatif, non numérique et facture à 0 refusés', bad.every((r) => !r.ok), JSON.stringify(bad.map((r) => r.msg)));
  const tol = await pay(U, 'f4', { id: 't1', amount: 600.01, date: '2026-10-01' });
  ck('PROPOSÉ : tolérance d\'arrondi 0,01 : 600,01 sur 600 accepté (même seuil que l\'application)', tol.ok);
  const iso = await pay(V, 'f1', { id: 'cur0', amount: 100, date: '2026-10-01' });
  ck('ISOLATION : le compte B paie sa propre facture avec le même identifiant de paiement que le compte A, sans lien entre comptes', iso.ok && (await state(V, 'f1')).sum === 100);
  const cross = await as(V, async (c) => (await c.query("SELECT count(*)::int n FROM public.doc_payments WHERE user_id=$1", [U])).rows[0].n);
  ck('ISOLATION (RLS) : le compte B ne voit aucun paiement du compte A', cross === 0);
  let direct = null; try { await as(U, (c) => c.query("INSERT INTO public.doc_payments(user_id,id,body,body_sha) VALUES ($1,'hack','{\"amount\":1}','')", [U])); } catch (e) { direct = e.message; }
  ck('Aucune écriture directe dans doc_payments par un utilisateur (seule la fonction écrit)', !!direct, direct);
  const tot = await sel("SELECT count(*)::int n FROM public.doc_payments WHERE user_id=$1 AND invoice_id='f2'", [U]);
  ck('Cohérence finale f2 : somme des lignes = paid_amount du document', (await state(U, 'f2')).sum === (await state(U, 'f2')).paid && tot[0].n === 3);
  const f = res.filter((x) => !x).length; console.log(`\n${res.length - f}/${res.length} contrôles (SIMULATION PostgreSQL locale, PAS Supabase)`);
  await pool.end(); try { ps('postgres', ['-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]); } catch (e) {}
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); try { ps('postgres', ['-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]); } catch (_) {} process.exit(1); });
