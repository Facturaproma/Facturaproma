// Pagination (10 par page) : logique de fpPaginate extraite de app.html ET admin.html, + présence dans chaque liste.
const fs = require('fs'), path = require('path'), vm = require('vm');
let bad = 0; const ok = (n, c, x = '') => { console.log((c ? 'OK   ' : 'FAIL ') + n + (x ? ' ' + x : '')); if (!c) bad++; };
for (const f of ['app.html', 'admin.html']) {
  const h = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const a = h.indexOf('const FP_PAGE_SIZE'), b = h.indexOf('function fpGoto', a), e = h.indexOf('\n}\n', b) + 3;
  ok(f + ' : helper de pagination présent', a > 0 && b > a);
  const ctx = {}; vm.createContext(ctx); const ja = h.indexOf('function jsArg('), je = h.indexOf('\n}\n', ja) + 3;   // jsArg (échappement des arguments de gestionnaires) est utilisé par les onglets
  ok(f + ' : jsArg présent', ja > 0);
  vm.runInContext(h.slice(ja, je) + h.slice(a, e) + ';this.fpPaginate=fpPaginate;this.fpGoto=fpGoto;', ctx);
  const rows = Array.from({ length: 25 }, (_, i) => ({ id: 'r' + i }));
  let calls = 0; const fn = () => { calls++; };
  let p = ctx.fpPaginate('k', rows, 's', fn);
  ok(f + ' : 25 lignes → page 1 = 10 lignes, 3 pages', p.items.length === 10 && p.pages === 3 && p.items[0].id === 'r0');
  ok(f + ' : onglets 1 2 3 et « 1–10 sur 25 »', /fpGoto\('k',1\)/.test(p.html) && /fpGoto\('k',2\)/.test(p.html) && /fpGoto\('k',3\)/.test(p.html) && /1–10 sur 25/.test(p.html));
  ctx.fpGoto('k', 3); ok(f + ' : fpGoto redessine la liste', calls === 1);
  p = ctx.fpPaginate('k', rows, 's', fn);
  ok(f + ' : page 3 = 5 dernières lignes', p.items.length === 5 && p.items[0].id === 'r20' && /21–25 sur 25/.test(p.html));
  p = ctx.fpPaginate('k', rows.slice(0, 12), 's', fn);
  ok(f + ' : la liste raccourcit → page ramenée à la dernière (2)', p.page === 2 && p.items.length === 2);
  p = ctx.fpPaginate('k', rows, 'autre-filtre', fn);
  ok(f + ' : changement de filtre → retour page 1', p.page === 1);
  p = ctx.fpPaginate('k2', rows.slice(0, 10), 's', fn);
  ok(f + ' : 10 lignes ou moins → aucun pager', p.html === '' && p.items.length === 10 && p.pages === 1);
  p = ctx.fpPaginate('k3', [], 's', fn);
  ok(f + ' : liste vide → page 1 sur 1, aucun pager', p.html === '' && p.items.length === 0 && p.pages === 1);
  const big = Array.from({ length: 1000 }, (_, i) => i);
  ctx.fpPaginate('k4', big, 's', fn); ctx.fpGoto('k4', 50); p = ctx.fpPaginate('k4', big, 's', fn);
  const nb = (p.html.match(/class="fp-pg/g) || []).length;
  ok(f + ' : 100 pages → boutons bornés (≤ 9) avec « … »', nb <= 9 && /fp-gap/.test(p.html), String(nb));
  ctx.fpGoto('k4', 'abc'); p = ctx.fpPaginate('k4', big, 's', fn); ok(f + ' : numéro de page invalide → page 1', p.page === 1);
  ctx.fpGoto('k4', -5); p = ctx.fpPaginate('k4', big, 's', fn); ok(f + ' : page négative → page 1', p.page === 1);
}
const app = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8'), adm = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
for (const k of ['invoices', 'quotes', 'clients', 'products', 'payDue', 'payHist']) ok('app.html : liste « ' + k + ' » paginée', app.includes("fpPaginate('" + k + "'"));
for (const k of ['requests', 'users', 'usersLegacy', 'licenses', 'codes', 'payments', 'ledger', 'fpdocs', 'audit']) ok('admin.html : liste « ' + k + ' » paginée', adm.includes("fpPaginate('" + k + "'"));
ok('admin : plus de coupure silencieuse à 50 codes', !/allCodes\.slice\(0, 50\)/.test(adm));
ok('app : l\'historique des paiements n\'est plus coupé à 10', !/sortedPaymentsAll.*slice\(0, 10\)/.test(app));
process.exit(bad ? 1 : 0);
