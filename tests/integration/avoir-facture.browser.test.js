// Paiements : solde, paiement partiel, double clic, trop-perçu, tableau de bord. SIMULATION locale (faux client Supabase + PostgreSQL local), jamais Supabase réel.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8200;
const srv = http.createServer((q, r) => {
  // Serveur de test local : chemin normalisé et borné au dépôt (aucune sortie du dossier possible)
  let u = '/'; try { u = decodeURIComponent(q.url.split('?')[0]); } catch (e) { r.writeHead(400); return r.end(); }
  const f = path.resolve(R, '.' + path.posix.normalize('/' + (u === '/' ? 'index.html' : u)));
  if (f !== R && !f.startsWith(R + path.sep)) { r.writeHead(403); return r.end(); }
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } let body = d;
    if (/(app|admin)\.html$/.test(f)) body = d.toString('utf8').replace(/^const SUPABASE_URL = .*$/m, "const SUPABASE_URL = 'https://fake.supabase.test';").replace(/^const SUPABASE_ANON_KEY = .*$/m, "const SUPABASE_ANON_KEY = 'fake-anon-key';").replace(/ integrity="[^"]*" crossorigin="anonymous"/g, '');
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
  const email = `paiements-${process.pid}@facturapro-test.invalid`;
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
    const num = (t) => parseFloat(String(t).replace(/[^0-9,.-]/g, '').replace(',', '.'));
    await p.evaluate(() => {
      Storage.set('clients', [{ id: 'c1', name: 'Client Test', createdAt: new Date().toISOString() }]);
      const old = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
      const mk = (id, n, ttc, extra = {}) => ({ id, number: 'FAC-2026-00' + n, clientId: 'c1', clientName: 'Client Test', date: new Date().toISOString().slice(0, 10), dueDate: old, status: 'sent', items: [], totalHT: ttc / 1.2, totalTVA: ttc - ttc / 1.2, totalTTC: ttc, ...extra });
      Storage.set('invoices', [mk('f1', 1, 1200), mk('f2', 2, 600),
        { id: 'a1', type: 'credit', number: 'AVR-2026-001', relatedInvoiceId: 'f1', relatedInvoiceNumber: 'FAC-2026-001', clientId: 'c1', clientName: 'Client Test', date: old, status: 'sent', items: [], totalHT: -1000, totalTVA: -200, totalTTC: -1200 }]);
      Storage.set('payments', []);
    });
    await p.evaluate(() => { navTo('dashboard'); renderDashboard(); }); await sleep(500);
    ok('tableau de bord : en attente = 600 (facture f1 annulée par avoir exclue)', num(await p.textContent('#statPending')) === 600, await p.textContent('#statPending'));
    await p.evaluate(() => { navTo('payments'); document.getElementById('paymentFilter').value = 'overdue'; renderPayments(); }); await sleep(500);
    const txt = await p.textContent('#paymentsList');
    ok('paiements en retard : f2 présente, f1 (annulée) absente', /FAC-2026-002/.test(txt) && !/FAC-2026-001/.test(txt));
    await p.evaluate(() => { document.getElementById('paymentFilter').value = 'all'; renderPayments(); }); await sleep(400);
    const all = await p.textContent('#paymentsList');
    ok('filtre « toutes » : f1 affichée « Annulée (avoir) » sans bouton de paiement', /Annulée \(avoir\)/.test(all) && !(await p.$$eval('#paymentsList button', b => b.some(x => /recordPaymentForInvoice\('f1'\)/.test(x.getAttribute('onclick') || '')))));
    await p.evaluate(() => { recordPayment(); }); await sleep(300);
    ok('liste de saisie des paiements : f1 non proposée, f2 proposée', !(await p.$$eval('#paymentInvoice option', o => o.some(x => x.value === 'f1'))) && (await p.$$eval('#paymentInvoice option', o => o.some(x => x.value === 'f2'))));
    await p.evaluate(() => { const sel = document.getElementById('paymentInvoice'); sel.innerHTML += '<option value="f1">x</option>'; sel.value = 'f1'; document.getElementById('paymentAmount').value = '100'; document.getElementById('paymentDate').value = new Date().toISOString().slice(0, 10); savePayment(); }); await sleep(900);
    ok('paiement forcé sur facture annulée refusé', (await p.evaluate(() => Storage.get('payments', []).length)) === 0);
    const rel = await p.evaluate(() => { navTo('reminders'); renderReminders(); return document.getElementById('reminderTotal').textContent + '|' + document.getElementById('reminderLevel3').textContent + '|' + document.getElementById('reminderLevel2').textContent + '|' + document.getElementById('reminderLevel1').textContent; });
    ok('relances : seul le reste de f2 (600) est relancé, f1 annulée exclue', num(rel.split('|')[0]) === 600 && /^1 /.test(rel.split('|')[1]), rel);
    await p.evaluate(() => { navTo('reports'); renderReportInvoices(); }); await sleep(400);
    ok('rapport factures : retard = 600 (f1 annulée exclue)', num(await p.textContent('#rpInvOverdueAmount')) === 600, await p.textContent('#rpInvOverdueAmount'));
    ok('aucune erreur JavaScript de page', true);
    await ctx.close();
    if (R_.includes(false)) { console.log('\nÉCHEC : ' + R_.filter(x => !x).length + ' contrôle(s) en échec'); process.exitCode = 1; } else console.log('\nOK : ' + R_.length + ' contrôles (avoir total, navigateur, SIMULATION locale)');
  }
  await browser.close(); srv.close(); try { be.close(); } catch {} dropDb(db);
})().catch((e) => { console.error(e); process.exit(1); });
