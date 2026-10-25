// Pagination dans l application (10 par page) : clients, factures, historique des paiements. SIMULATION locale (faux Supabase).
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8210;
const srv = http.createServer((q, r) => {
  // Serveur de test local : chemin normalisé et borné au dépôt (aucune sortie du dossier possible)
  let u = '/'; try { u = decodeURIComponent(q.url.split('?')[0]); } catch (e) { r.writeHead(400); return r.end(); }
  const f = path.resolve(R, '.' + path.posix.normalize('/' + (u === '/' ? 'index.html' : u)));
  if (f !== R && !f.startsWith(R + path.sep)) { r.writeHead(403); return r.end(); }
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } let body = d;
    if (/(app|admin)\.html$/.test(f)) body = d.toString('utf8').replace(/^const SUPABASE_URL = .*$/m, "const SUPABASE_URL = 'https://fake.supabase.test';").replace(/^const SUPABASE_ANON_KEY = .*$/m, "const SUPABASE_ANON_KEY = 'fake-anon-key';");
    const t = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.ttf': 'font/ttf', '.png': 'image/png', '.css': 'text/css' }[path.extname(f)] || 'application/octet-stream';
    r.writeHead(200, { 'content-type': t }); r.end(body); });
}).listen(PORT);
const nm = (...s) => path.join(R, 'node_modules', ...s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const db = createDb(); const be = makeBackend(db);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  async function dev(vp) {
    const ctx = await browser.newContext({ viewport: vp, serviceWorkers: 'block' }); const p = await ctx.newPage();
    p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 160))); p.on('dialog', (d) => d.accept());
    await p.exposeFunction('__srv', (op, args) => be.handle(op, args));
    await p.route(/jsdelivr.*supabase/, (r) => r.fulfill({ body: FAKE, contentType: 'text/javascript' }));
    await p.route('**/jspdf.umd.min.js', (r) => r.fulfill({ path: nm('jspdf', 'dist', 'jspdf.umd.min.js'), contentType: 'text/javascript' }));
    await p.route('**/jspdf.plugin.autotable.min.js', (r) => r.fulfill({ path: nm('jspdf-autotable', 'dist', 'jspdf.plugin.autotable.min.js'), contentType: 'text/javascript' }));
    await p.route(/googleapis|gstatic|hcaptcha/, (r) => r.abort());
    return { ctx, p };
  }
  const sizes = { m: { width: 390, height: 844 }, d: { width: 1366, height: 800 } };
  const email = `pag-${process.pid}@facturapro-test.invalid`;
  let first = true;
  for (const k of ['m']) {
    const { ctx, p } = await dev(sizes[k]);
    await p.goto(`http://localhost:${PORT}/app.html?mode=login`); await sleep(800);
    if (first) {
      await p.evaluate(() => { const t = [...document.querySelectorAll('button,div,a')].find((e) => e.textContent.trim() === 'Inscription'); t && t.click(); });
      await p.fill('#signupEmail', email); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500); first = false;
    } else { await p.fill('#loginEmail', email); await p.fill('#loginPassword', 'Test#12345'); await p.click('#loginBtn'); await sleep(2500); }
    if (!(await p.isVisible('#mainApp'))) {
      await p.evaluate(() => selectStatus(document.querySelector('[onclick*="selectStatus"]').getAttribute('onclick').match(/'(.*?)'/)[1])); await p.evaluate(() => onboardingNext(1));
      await p.fill('#onbCompanyName', 'Atelier Atlas SARL'); await p.fill('#onbICE', '001234567000089'); await p.evaluate(() => onboardingNext(2));
      await p.fill('#onbBank', 'Banque test'); await p.fill('#onbRIB', '007 780 0001234567890123 45'); await p.evaluate(() => finishOnboarding()); await sleep(1800);
    }
    const R_ = []; const ok = (n, c, x = '') => { R_.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? ' ' + x : '')); };
    await p.evaluate(() => { window.isUserLicensed = () => true; });
    const iso = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    await p.evaluate(() => {
      const n = (k) => new Date(Date.now() - k * 86400000).toISOString().slice(0, 10);
      Storage.set('clients', Array.from({ length: 25 }, (_, i) => ({ id: 'c' + i, name: 'Client ' + String(i).padStart(2, '0'), createdAt: new Date().toISOString() })));
      Storage.set('invoices', Array.from({ length: 23 }, (_, i) => ({ id: 'f' + i, number: 'BRO-T' + String(i).padStart(5, '0'), clientId: 'c0', clientName: 'Client 00', date: n(i), dueDate: n(-30), status: 'draft', type: 'invoice',
        items: [{ description: 'x', quantity: 1, unitPrice: 100, price: 100, tva: 20, discount: 0, totalHT: 100, totalTVA: 20, totalTTC: 120 }], totalHT: 100, totalTVA: 20, totalTTC: 120 })));
    });
    const rows = (sel) => p.evaluate((s) => document.querySelectorAll(s + ' tbody tr').length, sel);
    const tabs = (sel) => p.evaluate((s) => [...document.querySelectorAll(s + ' .fp-pg')].map((b) => b.textContent.trim()).join(','), sel);
    // Clients
    await p.evaluate(() => navTo('clients')); await sleep(300);
    ok('clients : 10 lignes sur la page 1', (await rows('#clientsList')) === 10);
    ok('clients : onglets ‹ 1 2 3 ›', (await tabs('#clientsList')) === '‹,1,2,3,›', await tabs('#clientsList'));
    await p.evaluate(() => [...document.querySelectorAll('#clientsList .fp-pg')].find((b) => b.textContent.trim() === '3').click()); await sleep(200);
    ok('clients : page 3 = 5 lignes', (await rows('#clientsList')) === 5);
    ok('clients : indication « 21–25 sur 25 »', await p.evaluate(() => /21–25 sur 25/.test(document.querySelector('#clientsList .fp-info').textContent)));
    await p.fill('#clientSearch', 'Client 0'); await p.evaluate(() => renderClients()); await sleep(200);
    ok('clients : une recherche ramène à la page 1 (10 résultats, pas de pager)', (await rows('#clientsList')) === 10 && (await tabs('#clientsList')) === '');
    await p.fill('#clientSearch', ''); await p.evaluate(() => renderClients()); await sleep(200);
    // Factures
    await p.evaluate(() => navTo('invoices')); await sleep(400);
    ok('factures : 10 lignes sur la page 1 (23 brouillons → 3 pages)', (await rows('#invoicesList')) === 10 && (await tabs('#invoicesList')) === '‹,1,2,3,›', String(await rows('#invoicesList')));
    await p.evaluate(() => fpGoto('invoices', 2)); await sleep(200);
    ok('factures : page 2 = 10 lignes', (await rows('#invoicesList')) === 10);
    await p.evaluate(() => fpGoto('invoices', 3)); await sleep(200);
    ok('factures : page 3 = 3 lignes', (await rows('#invoicesList')) === 3);
    // Paiements : historique non coupé à 10
    await p.evaluate(() => { const n = (k) => new Date(Date.now() - k * 86400000).toISOString().slice(0, 10); Storage.set('payments', Array.from({ length: 14 }, (_, i) => ({ id: 'p' + i, invoiceId: 'f0', date: n(i), amount: 1, method: 'virement', reference: 'R' + i, createdAt: new Date(Date.now() - i * 1000).toISOString() }))); });
    await p.evaluate(() => navTo('payments')); await sleep(400);
    ok('historique des paiements : 10 lignes + pager (14 paiements → 2 pages)', (await rows('#paymentsHistoryList')) === 10 && (await tabs('#paymentsHistoryList')) === '‹,1,2,›', await tabs('#paymentsHistoryList'));
    await p.evaluate(() => fpGoto('payHist', 2)); await sleep(200);
    ok('historique des paiements : page 2 = 4 lignes', (await rows('#paymentsHistoryList')) === 4);
    const ov = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    ok('téléphone 390 px : pas de défilement horizontal de la page', ov <= 1, String(ov));
    await ctx.close();
    if (R_.includes(false)) { console.log('\nÉCHEC : ' + R_.filter(x => !x).length + ' contrôle(s) en échec'); process.exitCode = 1; } else console.log('\nOK : ' + R_.length + ' contrôles (simulation locale)');
  }
  await browser.close(); srv.close(); try { be.close(); } catch {} dropDb(db);
})().catch((e) => { console.error(e); process.exit(1); });
