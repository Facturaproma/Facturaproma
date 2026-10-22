// Imitation minimale de l'API REST Supabase (GoTrue /token + PostgREST rpc/tables) au-dessus d'une base PostgreSQL LOCALE,
// pour exécuter tests/preprod/check.js SANS réseau. Ne remplace pas un vrai Supabase (voir docs/PREPRODUCTION_SUPABASE.md).
const http = require('http');
const { Pool } = require('pg');
const ident = /^[a-z_][a-z0-9_]*$/;
function start(db) {
  const pool = new Pool({ database: db, max: 6 });
  const roleOf = (req) => { const a = (req.headers.authorization || '').replace('Bearer ', ''); return a.startsWith('tok_') ? { role: 'authenticated', uid: a.slice(4) } : { role: 'anon', uid: null }; };
  const withRole = async (who, fn) => {
    const c = await pool.connect();
    try { await c.query('BEGIN'); await c.query(`SET LOCAL ROLE ${who.role}`); if (who.uid) await c.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [who.uid]);
      const r = await fn(c); await c.query('COMMIT'); return r; }
    catch (e) { try { await c.query('ROLLBACK'); } catch {} throw e; } finally { c.release(); }
  };
  const filters = (u, vals) => { const w = []; for (const [k, v] of u.searchParams) { if (['select', 'limit', 'on_conflict', 'order'].includes(k)) continue; const m = /^eq\.(.*)$/.exec(v); if (!ident.test(k) || !m) throw Object.assign(new Error('filtre non géré'), { http: 400 }); vals.push(m[1]); w.push(`${k}::text = $${vals.length}`); } return w.length ? ' WHERE ' + w.join(' AND ') : ''; };
  const srv = http.createServer(async (req, res) => {
    let raw = ''; req.on('data', d => raw += d); await new Promise(r => req.on('end', r));
    const send = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    const u = new URL(req.url, 'http://x'); const body = raw ? JSON.parse(raw) : undefined; const who = roleOf(req);
    try {
      if (u.pathname === '/auth/v1/token') {
        const r = await pool.query("SELECT id, email FROM auth.users WHERE email=$1 AND encrypted_password = crypt($2, encrypted_password)", [body.email, body.password]);
        if (!r.rows.length) return send(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
        return send(200, { access_token: 'tok_' + r.rows[0].id, user: { id: r.rows[0].id, email: r.rows[0].email } });
      }
      let m = /^\/rest\/v1\/rpc\/([a-z_0-9]+)$/.exec(u.pathname);
      if (m) {
        const keys = Object.keys(body || {}); keys.forEach(k => { if (!ident.test(k)) throw new Error('arg'); });
        const rows = await withRole(who, async c => (await c.query(`SELECT public.${m[1]}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) AS r`, keys.map(k => body[k]))).rows);
        return send(200, rows.length === 1 ? rows[0].r : rows.map(r => r.r));
      }
      m = /^\/rest\/v1\/([a-z_]+)$/.exec(u.pathname);
      if (m) {
        const t = 'public.' + m[1]; const vals = [];
        if (req.method === 'GET') {
          const cols = (u.searchParams.get('select') || '*').split(',').map(x => x.trim()); cols.forEach(k => { if (k !== '*' && !ident.test(k)) throw new Error('col'); });
          const w = filters(u, vals); const lim = u.searchParams.get('limit') ? ` LIMIT ${parseInt(u.searchParams.get('limit'), 10)}` : '';
          return send(200, await withRole(who, async c => (await c.query(`SELECT ${cols.join(',')} FROM ${t}${w}${lim}`, vals)).rows));
        }
        if (req.method === 'DELETE') { const w = filters(u, vals); await withRole(who, c => c.query(`DELETE FROM ${t}${w}`, vals)); return send(204, {}); }
        if (req.method === 'POST') {
          const oc = u.searchParams.get('on_conflict'); const merge = /merge-duplicates/.test(req.headers.prefer || '');
          const cols = Object.keys(body); cols.forEach(k => { if (!ident.test(k)) throw new Error('col'); });
          let sql = `INSERT INTO ${t} (${cols.join(',')}) SELECT ${cols.join(',')} FROM jsonb_populate_record(null::${t}, $1::jsonb)`;
          if (oc && merge) sql += ` ON CONFLICT (${oc}) DO UPDATE SET ${cols.filter(k => !oc.split(',').includes(k)).map(k => `${k}=EXCLUDED.${k}`).join(',')}`;
          await withRole(who, c => c.query(sql, [JSON.stringify(body)])); return send(201, {});
        }
      }
      return send(404, { message: 'route non gérée par la simulation' });
    } catch (e) { return send(e.http || (e.code === '42501' ? (who.role === 'anon' ? 401 : 403) : (e.code === '42883' || e.code === '42P01' ? 404 : 400)), { code: e.code, message: e.message }); }
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ port: srv.address().port, close: async () => { srv.close(); await pool.end(); } })));
}
module.exports = { start };
