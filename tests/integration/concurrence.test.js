// Émissions concurrentes : N connexions PostgreSQL simultanées appellent next_doc_number.
// Vérifie : numéros tous distincts, sans trou, compteurs indépendants par compte et par type.
const { createDb, dropDb, makeBackend } = require('./backend');
(async () => {
  const db = createDb(); const be = makeBackend(db); const res = [];
  const ck = (n, ok, x = '') => res.push([!!ok, n, x]);
  try {
    const mk = async (e) => (await be.handle('signUp', { email: e })).session;
    const A = await mk('ca@test.invalid'), B = await mk('cb@test.invalid');
    const call = (s, type) => be.handle('rpc', { fn: 'next_doc_number', args: { p_type: type, p_floor: 0 }, token: s.access_token });
    const N = 60;
    const jobs = [], tagA = [];
    for (let i = 0; i < N; i++) { tagA.push(jobs.length); jobs.push(call(A, 'invoice')); if (i % 3 === 0) jobs.push(call(A, 'credit')); if (i % 2 === 0) jobs.push(call(B, 'invoice')); }
    const out = await Promise.all(jobs);
    const errs = out.filter(o => o.error);
    ck('aucune erreur pendant ' + out.length + ' appels parallèles', errs.length === 0, errs.map(e => e.error.message).slice(0, 2).join(';'));
    const vals = (s, t) => out.filter(o => o.data != null).map(o => o.data);
    const getAll = async (email, type) => (await be.sql("SELECT last_value FROM doc_counters c JOIN auth.users u ON u.id=c.user_id WHERE u.email=$1 AND doc_type=$2", [email, type]))[0].last_value;
    ck('compteur facture A = 60', (await getAll('ca@test.invalid', 'invoice')) === N);
    ck('compteur avoir A = 20', (await getAll('ca@test.invalid', 'credit')) === 20);
    ck('compteur facture B = 30', (await getAll('cb@test.invalid', 'invoice')) === 30);
    const aInv = tagA.map(i => out[i].data);
    ck('60 numéros de facture A tous distincts et couvrant 1..60 sans trou', new Set(aInv).size === N && Math.min(...aInv) === 1 && Math.max(...aInv) === N, aInv.slice(0,5).join(','));
    const strs = out.map(o => o.data);
    ck('toutes les réponses sont des numéros', strs.every(x => typeof x === 'string' || typeof x === 'number'), String(strs[0]));
  } catch (e) { ck('exécution', false, e.stack); }
  let f = 0; for (const [ok, n, x] of res) { if (!ok) f++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || !x ? '' : ' -> ' + x)); }
  console.log(`\n${res.length - f}/${res.length} tests de concurrence réussis`);
  await be.close(); dropDb(db); process.exit(f ? 1 : 0);
})();
