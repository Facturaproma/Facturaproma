// Serveur de test : relaie les appels du faux client vers une vraie base PostgreSQL locale
// (mêmes scripts SQL que Supabase, sous le rôle « authenticated » avec RLS).
const { Pool } = require('pg');
const { execFileSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const SQL_FILES = ['00_setup_complet', '05_admins', '06_securite_rls', '07_licence_serveur', '08_admin_comptes',
  '09_periode_de_grace', '10_anti_abus', '12_admin_supprimer_compte', '13_profil_assistant', '14_numerotation_et_verrouillage'];

function psql(db, args) { return execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-d', db, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString(); }

function createDb() {
  const db = 'fp_it_' + process.pid;
  psql('postgres', ['-c', `DROP DATABASE IF EXISTS ${db}`, '-c', `CREATE DATABASE ${db}`]);
  psql(db, ['-f', path.join(ROOT, 'tests/sql/stub_supabase.sql')]);
  for (const f of SQL_FILES) psql(db, ['-f', path.join(ROOT, 'sql', f + '.sql')]);
  psql(db, ['-c', 'GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated; REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.doc_counters, public.doc_events FROM authenticated;']);
  return db;
}
function dropDb(db) { try { psql('postgres', ['-c', `DROP DATABASE IF EXISTS ${db}`]); } catch (e) {} }

function makeBackend(db) {
  const pool = new Pool({ database: db, max: 8 });
  const log = [];
  const asUser = async (uid, fn) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE authenticated');
      await c.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [uid]);
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { c.release(); }
  };
  const uidOf = (token) => (token && token.startsWith('tok_')) ? token.slice(4) : null;
  const err = (e) => ({ data: null, error: { message: e.message, code: e.code } });
  const session = (id, email) => ({ access_token: 'tok_' + id, user: { id, email }, expires_at: Math.floor(Date.now() / 1000) + 3600 });
  const RPC = { my_license: [], activate_license: ['p_code'], next_doc_number: ['p_type', 'p_floor'] };

  async function handle(op, a) {
    log.push({ op, fn: a.fn, table: a.table && a.table, tableOp: a.op });
    try {
      if (op === 'signUp') {
        const id = crypto.randomUUID();
        await pool.query('INSERT INTO auth.users(id,email) VALUES ($1,$2)', [id, a.email]);
        return { session: session(id, a.email) };
      }
      if (op === 'signIn') {
        const r = await pool.query('SELECT id FROM auth.users WHERE email=$1', [a.email]);
        if (!r.rows.length) return { error: { message: 'Invalid login credentials' } };
        return { session: session(r.rows[0].id, a.email) };
      }
      const uid = uidOf(a.token);
      if (!uid) return { data: null, error: { message: 'JWT manquant', code: '401' } };
      if (op === 'rpc') {
        const names = RPC[a.fn];
        if (!names) return { data: null, error: { message: 'fonction non autorisée dans le test', code: 'PGRST202' } };
        const vals = names.map(n => (a.args || {})[n]);
        const placeholders = names.map((n, i) => `${n} => $${i + 1}`).join(', ');
        const r = await asUser(uid, c => c.query(`SELECT public.${a.fn}(${placeholders}) AS r`, vals));
        return { data: r.rows[0].r, error: null };
      }
      if (op === 'table') {
        if (a.table !== 'user_data') return { data: null, error: { message: 'table non gérée dans le test' } };
        if (a.op === 'select') {
          const r = await asUser(uid, c => c.query('SELECT key, value FROM public.user_data WHERE user_id = $1', [a.filters.user_id]));
          return { data: r.rows, error: null };
        }
        if (a.op === 'upsert') {
          await asUser(uid, c => c.query(
            `INSERT INTO public.user_data(user_id, key, value, updated_at) VALUES ($1,$2,$3::jsonb,now())
             ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
            [a.row.user_id, a.row.key, JSON.stringify(a.row.value)]));
          return { data: null, error: null };
        }
        if (a.op === 'delete') {
          await asUser(uid, c => c.query('DELETE FROM public.user_data WHERE user_id = $1', [a.filters.user_id]));
          return { data: null, error: null };
        }
      }
      return { data: null, error: { message: 'opération inconnue' } };
    } catch (e) { return op === 'signUp' || op === 'signIn' ? { error: { message: e.message } } : err(e); }
  }
  const sql = async (text, params) => (await pool.query(text, params)).rows;   // lecture « administrateur » pour vérifier l'état serveur
  return { handle, sql, asUser, close: () => pool.end(), log };
}
module.exports = { createDb, dropDb, makeBackend };
