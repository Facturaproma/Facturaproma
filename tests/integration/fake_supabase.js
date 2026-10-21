// Faux client Supabase injecté dans le navigateur à la place de supabase-js.
// Il relaie chaque appel vers window.__srv (fonction exposée par le test), qui parle à une
// vraie base PostgreSQL locale (RLS, déclencheurs et fonctions SQL réels du dépôt).
(function () {
  window.__net = { down: false, missingRpc: [] };
  window.__rpcLog = [];
  function makeClient() {
    let session = null;
    try { session = JSON.parse(localStorage.getItem('__fake_session') || 'null'); } catch (e) {}
    const listeners = [];
    const persist = () => { try { session ? localStorage.setItem('__fake_session', JSON.stringify(session)) : localStorage.removeItem('__fake_session'); } catch (e) {} };
    const netErr = () => ({ data: null, error: { message: 'TypeError: Failed to fetch' } });
    const call = (op, args) => window.__srv(op, Object.assign({ token: session && session.access_token }, args || {}));
    const auth = {
      async signUp({ email, password }) {
        const r = await window.__srv('signUp', { email, password });
        if (r.error) return { data: { user: null, session: null }, error: r.error };
        session = r.session; persist();
        return { data: { user: r.session.user, session }, error: null };
      },
      async signInWithPassword({ email, password }) {
        const r = await window.__srv('signIn', { email, password });
        if (r.error) return { data: { user: null, session: null }, error: r.error };
        session = r.session; persist();
        return { data: { user: r.session.user, session }, error: null };
      },
      async getSession() { return { data: { session }, error: null }; },
      async getUser() { return { data: { user: session && session.user }, error: null }; },
      async signOut() { session = null; persist(); listeners.forEach(f => f('SIGNED_OUT', null)); return { error: null }; },
      onAuthStateChange(cb) { listeners.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
      async updateUser() { return { data: {}, error: null }; },
      async resetPasswordForEmail() { return { data: {}, error: null }; }
    };
    return {
      auth,
      async rpc(fn, args) {
        window.__rpcLog.push({ fn, args });
        if (window.__net.down) return netErr();
        if (window.__net.missingRpc.includes(fn)) return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.' + fn } };
        return call('rpc', { fn, args });
      },
      from(table) {
        const st = { table, op: 'select', filters: {} };
        const b = {
          select() { st.op = 'select'; return b; },
          eq(k, v) { st.filters[k] = v; return b; },
          upsert(row) { st.op = 'upsert'; st.row = row; return b; },
          delete() { st.op = 'delete'; return b; },
          then(res, rej) {
            const p = window.__net.down ? Promise.resolve(netErr()) : call('table', st);
            return p.then(res, rej);
          }
        };
        return b;
      }
    };
  }
  window.supabase = { createClient: makeClient };
})();
