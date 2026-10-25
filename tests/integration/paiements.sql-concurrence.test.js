// Revue de la proposition docs/PROPOSITION_SQL_PAIEMENTS.md : paiements SIMULTANÉS sur une vraie base PostgreSQL LOCALE jetable
// (scripts sql/15, 16, 17 du dépôt). SIMULATION : ce n'est pas Supabase. Aucune migration n'est appliquée ailleurs que dans cette base jetable.
//   Partie 1 : fonction ACTUELLE (sql/15)  -> documente l'absence de plafond (dépassement possible).
//   Partie 2 : fonction PROPOSÉE (sql/25_plafond_paiements.sql) -> plafond tenu malgré la concurrence.
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
  ps(DB, ['-f', path.join(R, 'sql/25_plafond_paiements.sql')]);
  await require('../lib/paiements-sql-checks').capChecks({ pool, as, ck: (n, ok, x = '') => ck(n, ok, x), U, V });
  const f = res.filter((x) => !x).length; console.log(`\n${res.length - f}/${res.length} contrôles (SIMULATION PostgreSQL locale, PAS Supabase)`);
  await pool.end(); try { ps('postgres', ['-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]); } catch (e) {}
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error(e); try { ps('postgres', ['-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]); } catch (_) {} process.exit(1); });
