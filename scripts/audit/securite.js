// Audit de sécurité côté navigateur (base locale, données fictives) : injection de HTML dans les champs saisis, données restantes après déconnexion.
// Usage : node scripts/audit/securite.js
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('../../tests/integration/backend');
const FAKE = fs.readFileSync(path.join(R, 'tests', 'integration', 'fake_supabase.js'), 'utf8');
const PORT = 8293;
const srv = http.createServer((q, r) => {
  let u = '/'; try { u = decodeURIComponent(q.url.split('?')[0]); } catch (e) { r.writeHead(400); return r.end(); }
  const f = path.resolve(R, '.' + path.posix.normalize('/' + (u === '/' ? 'index.html' : u)));
  if (f !== R && !f.startsWith(R + path.sep)) { r.writeHead(403); return r.end(); }
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } let body = d;
    if (/(app|admin)\.html$/.test(f)) body = d.toString('utf8').replace(/^const SUPABASE_URL = .*$/m, "const SUPABASE_URL = 'https://fake.supabase.test';").replace(/^const SUPABASE_ANON_KEY = .*$/m, "const SUPABASE_ANON_KEY = 'fake-anon-key';").replace(/ integrity="[^"]*" crossorigin="anonymous"/g, '');
    const t = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.ttf': 'font/ttf', '.png': 'image/png', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(f)] || 'application/octet-stream';
    r.writeHead(200, { 'content-type': t }); r.end(body); });
}).listen(PORT);
const nm = (...s) => path.join(R, 'node_modules', ...s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const db = createDb({ stock: true }); const be = makeBackend(db); const R = []; const ok = (n, c, d) => { R.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + (d || ''))); };
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: 'block', locale: 'fr-FR' }); const p = await ctx.newPage();
  p.on('dialog', (d) => d.accept()); p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 160)));
  await p.exposeFunction('__srv', (op, args) => be.handle(op, args));
  await p.route(/jsdelivr.*supabase/, (r) => r.fulfill({ body: FAKE, contentType: 'text/javascript' }));
  await p.route('**/jspdf.umd.min.js', (r) => r.fulfill({ path: nm('jspdf', 'dist', 'jspdf.umd.min.js'), contentType: 'text/javascript' }));
  await p.route('**/jspdf.plugin.autotable.min.js', (r) => r.fulfill({ path: nm('jspdf-autotable', 'dist', 'jspdf.plugin.autotable.min.js'), contentType: 'text/javascript' }));
  await p.route(/googleapis|gstatic|hcaptcha/, (r) => r.abort());
  const EMAIL = `sec-${process.pid}@facturapro-test.invalid`, PASS = 'Demo#12345';
  await p.goto(`http://localhost:${PORT}/app.html?mode=login`); await sleep(900);
  await p.click('[data-tab=signup]'); await p.fill('#signupEmail', EMAIL); await p.fill('#signupPassword', PASS); await p.fill('#signupConfirm', PASS); await p.click('#signupBtn'); await sleep(2500);
  if (!(await p.isVisible('#mainApp'))) { await p.evaluate(() => finishOnboarding()); await sleep(1800); }
  // Charge utile : si elle est interprétée comme du HTML, elle crée un élément marqué ou lève window.__xss
  const X = '"><img src=x data-xss=1 onerror="window.__xss=(window.__xss||0)+1"><svg onload="window.__xss=(window.__xss||0)+1">\'';
  await p.evaluate(async (X) => {
    window.__xss = 0; Storage.set('guideSeen', true);
    const c = Storage.get('company', {}) || {}; Object.assign(c, { name: 'Société ' + X, address: X, city: X, ice: '001234567000089', if: X, rc: X, phone: X, email: X, bank: X, rib: X, footer: X, notes: X }); Storage.set('company', c);
    Storage.set('clients', [{ id: 'cx', kind: 'societe', name: 'Client ' + X, ice: X, if: X, rc: X, address: X, city: X, phone: X, email: X }]);
    Storage.set('suppliers', [{ id: 'sx', kind: 'societe', name: 'Fournisseur ' + X, ice: X, if: X, address: X, city: X, phone: X }]);
    Storage.set('products', [{ id: 'px', name: 'Produit ' + X, price: 100, tva: 20, unit: X, description: X, sku: X }]);
    Storage.set('teamMembers', [{ email: X, name: X, role: X }]); Storage.set('teamInvitations', [{ email: X, name: X, role: X, code: X, status: 'pending', createdAt: new Date().toISOString() }]);
    Storage.set('vatPurchases', [{ id: 'vx', date: todayISO(), payDate: todayISO(), supplier: X, ref: X, designation: X, if: X, ice: X, ht: 100, tva: 20, rate: 20, mode: 'virement' }]);
  }, X);
  await p.evaluate(() => { navTo('invoices'); newInvoice(); }); await sleep(400);
  await p.selectOption('#editorClient', 'cx');
  await p.evaluate((X) => { document.getElementById('itemsBody').innerHTML = ''; addItem({ description: 'Ligne ' + X, quantity: 1, price: 100, tva: 20 }); const n = document.getElementById('editorNotes'); if (n) n.value = X; }, X);
  await p.evaluate(async () => { await saveInvoice('sent'); }); await sleep(1000);
  await p.evaluate(async (X) => { try { const t = todayISO();
    await supaClient.rpc('cash_account_create', { p: { key: 'x-b', name: 'Banque ' + X, kind: 'bank', opening_balance: 1000, opening_date: t } });
    const r = await supaClient.rpc('purchase_record', { p: { key: 'x-p', supplier_id: 'sx', supplier_name: 'Fournisseur ' + X, supplier_ref: X, date: t, lines: [{ nature: 'expense', category: X, description: X, qty: 1, unit_price: 100, tva_rate: 20 }] } });
    await cashLoadAccounts(true); await purLoad(true);
    if (r.data) await supaClient.rpc('supplier_settle', { p: { purchase_id: r.data.id, account_id: cashActive()[0].id, date: t, amount: 120, mode: 'virement', label: X } });
    await purLoad(true); } catch (e) { console.log('achats', e.message); } }, X);
  const seen = [];
  for (const pg of ['dashboard', 'invoices', 'quotes', 'deliveries', 'clients', 'products', 'stock', 'purchases', 'payments', 'treasury', 'pilotage', 'reminders', 'reports', 'cnss', 'taxes', 'company', 'messages', 'license', 'team']) {
    await p.evaluate((x) => { document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active')); navTo(x); }, pg); await sleep(pg === 'pilotage' || pg === 'taxes' || pg === 'dashboard' ? 1300 : 700);
    const r = await p.evaluate(() => ({ x: window.__xss, el: document.querySelectorAll('[data-xss], svg[onload]').length }));
    if (r.x || r.el) seen.push(pg + ':' + JSON.stringify(r) + ' ' + await p.evaluate(() => [...document.querySelectorAll('[data-xss], svg[onload]')].map(e => { const a = []; let n = e.parentElement; while (n && a.length < 4) { a.push(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.className && typeof n.className === 'string' ? '.' + n.className.split(' ')[0] : '')); n = n.parentElement; } return a.join(' < '); }).join(' ; ')));
    await p.evaluate(() => { window.__xss = 0; document.querySelectorAll('[data-xss], svg[onload]').forEach(e => e.remove()); });
  }
  // fenêtres : aperçu de facture, encaissement, relance, fiche client, achat
  const id = await p.evaluate(() => (Storage.get('invoices', [])[0] || {}).id);
  const pid = await p.evaluate(() => (purList()[0] || {}).id);
  const FN = [`viewInvoice(${JSON.stringify(id)})`, `recordPayment(${JSON.stringify(id)})`, `editClient('cx')`, `openSupplierSchedule()`, `openGuide()`, `editInvoice(${JSON.stringify(id)})`, `navTo('invoices');newInvoice()`,
    `navTo('quotes');newQuote()`, `openProductPicker()`, `editProduct('px')`, `openStockMove('in')`, `openPurchase('expense')`, `openPurchase('goods')`, `openSupplierCredit(${JSON.stringify(pid)})`, `openSupplierModal('sx')`,
    `openSuppliersList()`, `openDelivery()`, `openCashAccount()`, `openCashMove()`, `openSettle(${JSON.stringify(pid)})`, `openCloseMonth()`, `openRecurringList()`, `openClientLink(${JSON.stringify(id)})`, `createCreditNote(${JSON.stringify(id)})`,
    `createPartialCredit(${JSON.stringify(id)})`, `openSupportMessages()`, `printDocument('invoice', ${JSON.stringify(id)})`];
  for (const fn of FN) {
    await p.evaluate((f) => { try { document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active')); new Function(f)(); } catch (e) {} }, fn); await sleep(700);
    const r = await p.evaluate(() => ({ x: window.__xss, el: document.querySelectorAll('[data-xss], svg[onload]').length }));
    if (r.x || r.el) seen.push(fn + ':' + JSON.stringify(r) + ' ' + await p.evaluate(() => [...document.querySelectorAll('[data-xss], svg[onload]')].map(e => { const a = []; let n = e.parentElement; while (n && a.length < 4) { a.push(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.className && typeof n.className === 'string' ? '.' + n.className.split(' ')[0] : '')); n = n.parentElement; } return a.join(' < '); }).join(' ; ')));
    await p.evaluate(() => { window.__xss = 0; document.querySelectorAll('[data-xss], svg[onload]').forEach(e => e.remove()); });
  }
  ok('aucun champ saisi n\'est interprété comme du HTML (19 pages, ' + FN.length + ' fenêtres)', seen.length === 0, seen.join(' | '));
  const pdfOk = await p.evaluate(async (id) => { try { const r = await generatePDF(id, 'invoice', { asBlob: true }); return !!(r && r.blob && r.blob.size > 1000); } catch (e) { return 'ERR ' + e.message; } }, id);
  ok('PDF généré malgré les caractères spéciaux', pdfOk === true, String(pdfOk));
  // Déconnexion : que reste-t-il dans le navigateur ?
  await p.evaluate(() => { document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active')); handleLogout(); }); await sleep(2000);
  const left = await p.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = (localStorage.getItem(k) || '').length; } return o; });
  const biz = Object.keys(left).filter(k => /clients|invoices|products|payments|company|suppliers|quotes|vatPurchases/i.test(k));
  ok('après déconnexion : aucune donnée métier ne reste dans le navigateur', biz.length === 0, JSON.stringify(biz.map(k => k + '=' + left[k])));
  ok('après déconnexion : aucun jeton de session', !Object.keys(left).some(k => /auth-token|sb-.*-auth/i.test(k) && left[k] > 10), JSON.stringify(Object.keys(left)));
  console.log('clés restantes :', JSON.stringify(left));
  const n = R.filter(Boolean).length; console.log(`${n === R.length ? 'OK' : 'ECHEC'} : ${n}/${R.length}`);
  await browser.close(); srv.close(); dropDb(db); process.exit(n === R.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
