// Serveur de test : relaie les appels du faux client vers une vraie base PostgreSQL locale
// (mêmes scripts SQL que Supabase, sous le rôle « authenticated » avec RLS).
const { Pool } = require('pg');
const { execFileSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const SQL_FILES = ['00_setup_complet', '05_admins', '06_securite_rls', '07_licence_serveur', '08_admin_comptes',
  '09_periode_de_grace', '10_anti_abus', '12_admin_supprimer_compte', '13_profil_assistant', '14_numerotation_et_verrouillage', '19_journal_sans_doublons', '18_contact_public'];

function psql(db, args) { return execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-d', db, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString(); }

// opts.docs : charge aussi sql/15, 16 et 17 (nouveau stockage) — base LOCALE jetable, jamais Supabase
function createDb(opts = {}) {
  const db = (opts.docs ? 'fp_itd_' : 'fp_it_') + process.pid;
  psql('postgres', ['-c', `DROP DATABASE IF EXISTS ${db}`, '-c', `CREATE DATABASE ${db}`]);
  psql(db, ['-f', path.join(ROOT, 'tests/sql/stub_supabase.sql')]);
  for (const f of SQL_FILES) psql(db, ['-f', path.join(ROOT, 'sql', f + '.sql')]);
  psql(db, ['-c', 'GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated; REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.doc_counters, public.doc_events FROM authenticated;']);
  if (opts.messagerie) for (const f of ['28_admin_nom_societe', '29_messagerie_support']) psql(db, ['-f', path.join(ROOT, 'sql', f + '.sql')]);
  if (opts.docs) {
    // comme Supabase : privilèges par défaut larges, puis les scripts 15/16/17 retirent ce qui doit l'être
    psql(db, ['-c', 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated']);
    for (const f of ['15_documents', '16_migration_donnees', '17_mode_stockage'].concat(opts.plafond ? ['26_plafond_paiements_legacy'] : [])) psql(db, ['-f', path.join(ROOT, 'sql', f + '.sql')]);
    psql(db, ['-c', 'GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated']);
  }
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
      await c.query("SELECT set_config('request.jwt.claim.email', coalesce((SELECT email FROM auth.users WHERE id = $1::uuid), ''), true)", [uid]);   // comme Supabase : le jeton porte l'e-mail (auth.jwt()->>'email')
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { c.release(); }
  };
  const uidOf = (token) => (token && token.startsWith('tok_')) ? token.slice(4) : null;
  const err = (e) => ({ data: null, error: { message: e.message, code: e.code, hint: e.hint } });
  const session = (id, email) => ({ access_token: 'tok_' + id, user: { id, email }, expires_at: Math.floor(Date.now() / 1000) + 3600 });
  const RPC = { my_license: [], activate_license: ['p_code'], next_doc_number: ['p_type', 'p_floor'],
    get_doc_mode: [], upsert_document: ['p_doc', 'p_expected_version', 'p_op_id'], delete_document: ['p_type', 'p_id', 'p_expected_version', 'p_op_id'],
    record_payment: ['p_invoice_id', 'p_payment', 'p_op_id'], append_history: ['p_entries', 'p_op_id'], get_contact_info: [], admin_whoami: [],
    support_my_messages: [], support_send: ['p_body'], support_mark_read: [], support_unread_count: [],
    admin_support_threads: [], admin_support_messages: ['p_user'], admin_support_reply: ['p_user', 'p_body'], admin_support_mark_read: ['p_user'], admin_support_unread_total: [] };
  const RPC_SET = ['support_my_messages', 'admin_support_threads', 'admin_support_messages'];   // fonctions qui renvoient une table
  const GENERIC = ['subscription_requests', 'admin_codes', 'admin_settings', 'licenses', 'admins'];
  const JSONB_PARAMS = ['p_doc', 'p_payment', 'p_entries'];
  const DOC_TABLES = { documents: 'doc_type, id, version, body, created_at', doc_payments: 'id, body, created_at', doc_history: 'seq, ts, body' };
  const DOC_ORDER = { documents: 'created_at, id', doc_payments: 'created_at, id', doc_history: 'seq' };

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
        const vals = names.map(n => JSONB_PARAMS.includes(n) ? JSON.stringify((a.args || {})[n]) : (a.args || {})[n]);
        const placeholders = names.map((n, i) => `${n} => $${i + 1}${JSONB_PARAMS.includes(n) ? '::jsonb' : ''}`).join(', ');
        if (RPC_SET.includes(a.fn)) { const r = await asUser(uid, c => c.query(`SELECT * FROM public.${a.fn}(${placeholders})`, vals)); return { data: r.rows, error: null }; }
        const r = await asUser(uid, c => c.query(`SELECT public.${a.fn}(${placeholders}) AS r`, vals));
        return { data: r.rows[0].r, error: null };
      }
      if (op === 'table') {
        if (DOC_TABLES[a.table]) {
          if (a.op !== 'select') return { data: null, error: { message: 'écriture directe non gérée (et refusée par les droits)', code: '42501' } };
          const [from, to] = a.range || [0, 999];
          const r = await asUser(uid, c => c.query(`SELECT ${DOC_TABLES[a.table]} FROM public.${a.table} WHERE user_id = $1 ORDER BY ${DOC_ORDER[a.table]} OFFSET $2 LIMIT $3`, [a.filters.user_id, from, to - from + 1]));
          return { data: r.rows, error: null };
        }
        if (GENERIC.includes(a.table)) {   // tables du parcours client (demandes, codes, réglages, licences, admins) : lecture/écriture SOUS RLS, comme PostgREST
          const f = Object.entries(a.filters || {});
          const where = f.length ? ' WHERE ' + f.map(([k], i) => `"${k}" = $${i + 1}`).join(' AND ') : '';
          const fv = f.map(([, v]) => v);
          if (a.op === 'select') { const r = await asUser(uid, c => c.query(`SELECT * FROM public.${a.table}${where}`, fv)); return { data: r.rows, error: null }; }
          if (a.op === 'insert') {
            const ks = Object.keys(a.row);
            await asUser(uid, c => c.query(`INSERT INTO public.${a.table}(${ks.map(k => '"' + k + '"').join(',')}) VALUES (${ks.map((_, i) => '$' + (i + 1)).join(',')})`, ks.map(k => a.row[k])));
            return { data: null, error: null };
          }
          if (a.op === 'update') {
            const ks = Object.keys(a.row);
            const w2 = f.length ? ' WHERE ' + f.map(([k], i) => `"${k}" = $${ks.length + i + 1}`).join(' AND ') : '';
            await asUser(uid, c => c.query(`UPDATE public.${a.table} SET ${ks.map((k, i) => '"' + k + '" = $' + (i + 1)).join(',')}${w2}`, [...ks.map(k => a.row[k]), ...fv]));
            return { data: null, error: null };
          }
          if (a.op === 'delete') { await asUser(uid, c => c.query(`DELETE FROM public.${a.table}${where}`, fv)); return { data: null, error: null }; }
        }
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
