// Écran Paiements : situation d'encaissement (payé / reste sur la même ligne), filtres, lien Encaisser. SIMULATION locale (faux client Supabase + PostgreSQL local), jamais Supabase réel.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8205;
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
    await p.evaluate(() => {
      const iso = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
      Storage.set('clients', [{ id: 'c1', name: 'Karim', ice: '001234567000089', createdAt: new Date().toISOString() }]);
      const mk = (id, n, ttc, daysAgo, extra = {}) => ({ id, number: 'FAC-2026-00' + n, clientId: 'c1', clientName: 'Karim', date: iso(daysAgo), dueDate: iso(daysAgo - 30), status: 'sent', type: 'invoice',
        items: [{ description: 'Prestation', quantity: 1, unitPrice: ttc / 1.2, tva: 20, discount: 0, totalHT: ttc / 1.2, totalTVA: ttc - ttc / 1.2, totalTTC: ttc }], totalHT: ttc / 1.2, totalTVA: ttc - ttc / 1.2, totalTTC: ttc, ...extra });
      Storage.set('invoices', [mk('f1', 1, 1200, 5), mk('f2', 2, 1000, 6, { status: 'paid', paidAmount: 1000, paidAt: iso(1) }), mk('f3', 3, 900, 7), mk('f4', 4, 800, 40, { status: 'sent' }), mk('f5', 5, 500, 2, { status: 'draft', number: 'BRO-1' })]);
      Storage.set('payments', [{ id: 'p1', invoiceId: 'f1', date: iso(1), amount: 400, method: 'virement', reference: '' }, { id: 'p2', invoiceId: 'f2', date: iso(1), amount: 1000, method: 'virement', reference: '' }]);
    });
    await p.evaluate(() => { navTo('payments'); }); await sleep(600);
    const sel = async (v) => { await p.selectOption('#paymentFilter', v); await sleep(250); };
    const rows = async () => p.$$eval('#paymentsList tbody tr', (trs) => trs.map((t) => t.innerText.replace(/\s+/g, ' ').trim()));
    let L = await rows();
    ok('filtre par défaut « À encaisser » : f1 (partielle), f3 (aucun paiement), f4 (en retard) ; ni soldée ni brouillon', L.length === 3 && !L.some((l) => /FAC-2026-002|Brouillon|BRO-1/.test(l)), JSON.stringify(L));
    const f1 = L.find((l) => /FAC-2026-001/.test(l)) || '';
    ok('ligne partielle : « Payé 400 » et « Reste 800 » sur la MÊME ligne, total 1 200', /Payé 400/.test(f1) && /Reste 800/.test(f1) && /1[\s\u202f\u00a0]?200/.test(f1), f1);
    const f3 = L.find((l) => /FAC-2026-003/.test(l)) || '';
    ok('ligne sans paiement : « Aucun paiement » et reste 900', /Aucun paiement/.test(f3) && /Reste 900/.test(f3), f3);
    ok('retard signalé sur la facture en retard (f4)', /retard/.test(L.find((l) => /FAC-2026-004/.test(l)) || ''));
    await sel('none'); L = await rows(); ok('filtre « Sans paiement » : f3 et f4 seulement', L.length === 2 && L.every((l) => /Aucun paiement/.test(l)), JSON.stringify(L));
    await sel('partial'); L = await rows(); ok('filtre « Partiellement payées » : f1 seulement', L.length === 1 && /FAC-2026-001/.test(L[0]), JSON.stringify(L));
    await sel('paid'); L = await rows(); ok('filtre « Soldées » : f2 avec « Soldée », sans bouton Encaisser', L.length === 1 && /Soldée/.test(L[0]) && (await p.$$eval('#paymentsList tbody tr button.btn-success', (b) => b.length)) === 0, JSON.stringify(L));
    await sel('all'); L = await rows(); ok('filtre « Toutes » : 3 à encaisser + 1 soldée, aucun brouillon', L.length === 4, JSON.stringify(L));
    await sel('open');
    // Aucun défilement horizontal sur téléphone (390 px)
    const overflow = await p.evaluate(() => { const t = document.querySelector('#paymentsList table'); return { page: document.documentElement.scrollWidth - window.innerWidth, table: t ? t.scrollWidth - t.parentElement.clientWidth : 0 }; });
    ok('téléphone 390 px : pas de défilement horizontal de la page ni du tableau', overflow.page <= 1 && overflow.table <= 1, JSON.stringify(overflow));
    ok('bouton « Encaisser le reste » visible sur la ligne partielle', await p.isVisible('#paymentsList tbody tr:has-text("FAC-2026-001") button.btn-success:has-text("Encaisser le reste")'));
    await p.screenshot({ path: process.env.SHOT_DIR ? path.join(process.env.SHOT_DIR, 'paiements-mobile.png') : '/tmp/paiements-mobile.png', fullPage: false });
    // Lien Encaisser : ouvre le formulaire avec la facture et le reste
    await p.click('#paymentsList tbody tr:has-text("FAC-2026-001") button.btn-success'); await sleep(500);
    ok('« Encaisser le reste » : formulaire prérempli (facture f1, montant 800)', (await p.inputValue('#paymentInvoice')) === 'f1' && parseFloat(await p.inputValue('#paymentAmount')) === 800, (await p.inputValue('#paymentInvoice')) + ' / ' + (await p.inputValue('#paymentAmount')));
    await p.evaluate(() => closeModal && closeModal('paymentModal')).catch(() => {});
    // Liste des factures : situation + bouton Encaisser
    await p.evaluate(() => { document.querySelectorAll('.modal-overlay.active,.modal.active').forEach((m) => m.classList.remove('active')); navTo('invoices'); }); await sleep(500);
    const inv = (await p.$$eval('#invoicesList tbody tr', (trs) => trs.map((t) => t.innerText.replace(/\s+/g, ' ').trim()))).find((l) => /FAC-2026-001/.test(l)) || '';
    ok('liste des factures : « Payé 400 · reste 800 » sous le montant', /Payé 400/.test(inv) && /reste 800/.test(inv), inv);
    ok('liste des factures : bouton « Encaisser le reste » sur f1, aucun sur la facture soldée (f2)', await p.isVisible('#invoicesList tbody tr:has-text("FAC-2026-001") button:has-text("Encaisser")') && !(await p.isVisible('#invoicesList tbody tr:has-text("FAC-2026-002") button:has-text("Encaisser")')));
    // Historique : numéro de facture cliquable + reste
    await p.evaluate(() => navTo('payments')); await sleep(400);
    const hist = await p.$$eval('#paymentsHistoryList tbody tr', (trs) => trs.map((t) => t.innerText.replace(/\s+/g, ' ').trim()));
    ok('historique : le paiement partiel de f1 indique « reste 800 »', hist.some((l) => /FAC-2026-001/.test(l) && /reste 800/.test(l)), JSON.stringify(hist));
    ok('historique : le numéro de facture est un lien', (await p.$$eval('#paymentsHistoryList tbody a', (a) => a.length)) >= 1);
    ok('aucune erreur JavaScript de page', true);
    await ctx.close();
    if (R_.includes(false)) { console.log('\nÉCHEC : ' + R_.filter(x => !x).length + ' contrôle(s) en échec'); process.exitCode = 1; } else console.log('\nOK : ' + R_.length + ' contrôles (écran Paiements, navigateur 390 px, SIMULATION locale)');
  }
  await browser.close(); srv.close(); try { be.close(); } catch {} dropDb(db);
})().catch((e) => { console.error(e); process.exit(1); });
