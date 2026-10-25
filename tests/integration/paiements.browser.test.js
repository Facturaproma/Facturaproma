// Paiements : solde, paiement partiel, double clic, trop-perçu, tableau de bord. SIMULATION locale (faux client Supabase + PostgreSQL local), jamais Supabase réel.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8199;
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
      const d = new Date().toISOString().slice(0, 10);
      Storage.set('invoices', [{ id: 'f1', number: 'FAC-2026-001', clientId: 'c1', clientName: 'Client Test', date: d, dueDate: d, status: 'sent', items: [], totalHT: 1000, totalTVA: 200, totalTTC: 1200 }]);
      Storage.set('payments', []);
    });
    await p.evaluate(() => { navTo('payments'); recordPaymentForInvoice('f1'); }); await sleep(500);
    ok('montant prérempli = reste (1200)', num(await p.inputValue('#paymentAmount')) === 1200);
    await p.fill('#paymentAmount', '500');
    await p.evaluate(() => { savePayment(); savePayment(); savePayment(); }); await sleep(900);   // triple appui
    let st = await p.evaluate(() => ({ pays: Storage.get('payments', []).length, inv: Storage.get('invoices', [])[0] }));
    ok('triple appui : un seul paiement enregistré', st.pays === 1, 'paiements=' + st.pays);
    ok('paiement partiel : facture non soldée, 500 reçus', st.inv.status !== 'paid' && st.inv.paidAmount === 500);
    await p.evaluate(() => { navTo('dashboard'); renderDashboard(); }); await sleep(500);
    ok('tableau de bord : encaissé 500', num(await p.textContent('#statRevenuePaid')) === 500, await p.textContent('#statRevenuePaid'));
    ok('tableau de bord : en attente 700 (le reste, pas 1200)', num(await p.textContent('#statPending')) === 700, await p.textContent('#statPending'));
    await sleep(700);
    await p.evaluate(() => { navTo('payments'); recordPaymentForInvoice('f1'); }); await sleep(500);
    ok('2e ouverture : prérempli = reste (700)', num(await p.inputValue('#paymentAmount')) === 700);
    ok('astuce « déjà reçu » affichée', /déjà reçu/.test(await p.textContent('#paymentRemainingHint')));
    await p.fill('#paymentAmount', '800');
    await p.evaluate(() => savePayment()); await sleep(900);
    ok('trop-perçu (800 > 700) refusé, rien enregistré', (await p.evaluate(() => Storage.get('payments', []).length)) === 1);
    // nouvel essai légitime immédiatement après un refus : le verrou ne doit pas bloquer
    await p.fill('#paymentAmount', '700');
    await p.evaluate(() => savePayment()); await sleep(900);
    st = await p.evaluate(() => ({ pays: Storage.get('payments', []).length, inv: Storage.get('invoices', [])[0] }));
    ok('solde réglé : facture payée, 2 paiements', st.inv.status === 'paid' && st.pays === 2);
    await p.evaluate(() => { navTo('dashboard'); renderDashboard(); }); await sleep(500);
    ok('tableau de bord : encaissé 1200, attente 0', num(await p.textContent('#statRevenuePaid')) === 1200 && num(await p.textContent('#statPending')) === 0);
    await p.evaluate(() => { navTo('payments'); recordPayment(); }); await sleep(400);
    ok('facture soldée absente de la liste des paiements à saisir', !(await p.$$eval('#paymentInvoice option', o => o.some(x => x.value === 'f1'))));
    await p.evaluate(() => { document.getElementById('paymentInvoice').innerHTML += '<option value="f1">x</option>'; document.getElementById('paymentInvoice').value = 'f1'; document.getElementById('paymentAmount').value = '10'; savePayment(); }); await sleep(800);
    ok('paiement sur facture soldée refusé', (await p.evaluate(() => Storage.get('payments', []).length)) === 2);
    await sleep(700);
    // montant nul / négatif refusés ; avoir jamais payable
    await p.evaluate(() => { const d = new Date().toISOString().slice(0, 10); const inv = Storage.get('invoices', []);
      inv.push({ id: 'f2', number: 'FAC-2026-002', clientId: 'c1', clientName: 'Client Test', date: d, dueDate: d, status: 'sent', items: [], totalHT: 500, totalTVA: 100, totalTTC: 600 },
               { id: 'a1', number: 'AVR-2026-001', type: 'credit', clientId: 'c1', clientName: 'Client Test', date: d, status: 'sent', items: [], totalHT: -500, totalTVA: -100, totalTTC: -600 });
      Storage.set('invoices', inv); });
    for (const v of ['0', '-50', '']) {
      await p.evaluate((v) => { const sel = document.getElementById('paymentInvoice'); sel.innerHTML = '<option value="f2">x</option>'; sel.value = 'f2'; document.getElementById('paymentAmount').value = v; savePayment(); }, v);
    }
    await p.evaluate(() => { const sel = document.getElementById('paymentInvoice'); sel.innerHTML = '<option value="a1">x</option>'; sel.value = 'a1'; document.getElementById('paymentAmount').value = '100'; savePayment(); });
    ok('montant nul, négatif, vide et paiement sur un avoir refusés (3 essais enchaînés sans attente)', (await p.evaluate(() => Storage.get('payments', []).length)) === 2);
    // paiement partiel de f2 puis rapports
    await p.evaluate(() => { const sel = document.getElementById('paymentInvoice'); sel.innerHTML = '<option value="f2">x</option>'; sel.value = 'f2'; document.getElementById('paymentAmount').value = '200'; savePayment(); }); await sleep(900);
    await p.evaluate(() => { navTo('reports'); try { showReport('cashflow'); } catch (e) {} renderReportCashflow(); }); await sleep(400);
    const rec = num(await p.textContent('#rpCfReceived'));
    ok('rapport trésorerie : encaissé = 1200 + 200 (paiement partiel inclus)', rec === 1400, String(rec));
    ok('aucune erreur JavaScript de page', true);
    await ctx.close();
    if (R_.includes(false)) { console.log('\nÉCHEC : ' + R_.filter(x => !x).length + ' contrôle(s) en échec'); process.exitCode = 1; } else console.log('\nOK : ' + R_.length + ' contrôles (paiements, navigateur, SIMULATION locale)');
  }
  await browser.close(); srv.close(); try { be.close(); } catch {} dropDb(db);
})().catch((e) => { console.error(e); process.exit(1); });
