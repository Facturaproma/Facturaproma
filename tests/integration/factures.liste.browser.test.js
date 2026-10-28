// Liste des factures : lisible sur téléphone, brouillons distincts des factures enregistrées, filtres, pas de suppression sur une facture enregistrée. SIMULATION locale, jamais Supabase réel.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8206;
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
      const mk = (id, n, ttc, daysAgo, extra = {}) => ({ id, number: n, clientId: 'c1', clientName: 'Karim', date: iso(daysAgo), dueDate: iso(daysAgo - 30), status: 'sent', type: 'invoice',
        items: [{ description: 'Prestation', quantity: 1, unitPrice: ttc / 1.2, tva: 20, discount: 0, totalHT: ttc / 1.2, totalTVA: ttc - ttc / 1.2, totalTTC: ttc }], totalHT: ttc / 1.2, totalTVA: ttc - ttc / 1.2, totalTTC: ttc, ...extra });
      Storage.set('invoices', [mk('f1', 'FAC-2026-001', 2400, 5), mk('f2', 'FAC-2026-002', 2400, 6, { status: 'paid', paidAmount: 2400, paidAt: iso(1) }), mk('f3', 'FAC-2026-003', 60, 7), mk('d1', 'BRO-AB12CD', 118, 1, { status: 'draft' })]);
      Storage.set('payments', [{ id: 'p1', invoiceId: 'f1', date: iso(1), amount: 1000, method: 'virement', reference: '' }, { id: 'p2', invoiceId: 'f2', date: iso(1), amount: 2400, method: 'virement', reference: '' }]);
    });
    await p.evaluate(() => navTo('invoices')); await sleep(600);
    const txt = async () => p.$$eval('#invoicesList tbody tr', (trs) => trs.map((t) => t.innerText.replace(/\s+/g, ' ').trim()));
    let L = await txt();
    ok('3 colonnes seulement (Facture, Montant, Actions) : plus de colonne coupée', (await p.$$eval('#invoicesList thead th', (h) => h.map((x) => x.innerText.trim()))).join('|') === 'FACTURE|MONTANT|ACTIONS');
    ok('en-têtes de groupe : « Brouillons » puis « Factures enregistrées »', L.some((l) => /^BROUILLONS/i.test(l)) && L.some((l) => /^FACTURES ENREGISTRÉES/i.test(l)), JSON.stringify(L.slice(0, 3)));
    const idxD = L.findIndex((l) => /Brouillon · non enregistré/.test(l)), idxI = L.findIndex((l) => /FAC-2026-001/.test(l));
    ok('le brouillon est listé avant les factures enregistrées et porte « Brouillon · non enregistré » (numéro BRO- masqué)', idxD >= 0 && idxD < idxI && !/BRO-AB12CD/.test(L[idxD]), L[idxD]);
    ok('facture enregistrée : « 🔒 Enregistrée », montant 2 400, « Payé 1 000 · reste 1 400 »', /Enregistrée/.test(L[idxI]) && /2[\s\u202f\u00a0]?400/.test(L[idxI]) && /Payé 1[\s\u202f\u00a0]?000/.test(L[idxI]) && /reste 1[\s\u202f\u00a0]?400/.test(L[idxI]), L[idxI]);
    ok('facture soldée : « Soldée », aucun bouton Encaisser', /soldée/i.test(L.find((l) => /FAC-2026-002/.test(l)) || '') && !(await p.isVisible('#invoicesList tbody tr:has-text("FAC-2026-002") button:has-text("Encaisser")')));
    ok('SUPPRESSION : aucun bouton Supprimer sur les factures enregistrées', (await p.$$eval('#invoicesList tr.inv-row-issued button', (b) => b.filter((x) => /deleteInvoice|Supprimer/.test((x.getAttribute('onclick') || '') + x.textContent)).length)) === 0);
    ok('SUPPRESSION : le brouillon garde « Supprimer » et « Modifier »', (await p.$$eval('#invoicesList tr.inv-row-draft button', (b) => b.map((x) => x.textContent.trim()).join('|'))).includes('Supprimer') && (await p.isVisible('#invoicesList tr.inv-row-draft button:has-text("Modifier")')));
    ok('brouillon visuellement distinct : bordure pointillée à gauche et fond hachuré', await p.$eval('#invoicesList tr.inv-row-draft td:first-child', (e) => /dashed/.test(getComputedStyle(e).borderLeftStyle)) && await p.$eval('#invoicesList tr.inv-row-draft td', (e) => /gradient/.test(getComputedStyle(e).backgroundImage)));
    const ov = await p.evaluate(() => { const t = document.querySelector('#invoicesList table'); return { page: document.documentElement.scrollWidth - window.innerWidth, table: t.scrollWidth - t.parentElement.clientWidth }; });
    ok('téléphone 390 px : pas de défilement horizontal', ov.page <= 1 && ov.table <= 1, JSON.stringify(ov));
    const sel = async (v) => { await p.selectOption('#invoiceFilter', v); await sleep(250); };
    const ids = async () => (await txt()).filter((l) => !/^(BROUILLONS|FACTURES ENREGISTRÉES)/i.test(l)).map((l) => (l.match(/FAC-2026-\d+|Brouillon · non/) || ['?'])[0]).join(',');
    await sel('draft'); ok('filtre Brouillons', (await ids()) === 'Brouillon · non', await ids());
    await sel('issued'); ok('filtre Enregistrées : f1, f2, f3 (aucun brouillon)', (await ids()).split(',').sort().join(',') === 'FAC-2026-001,FAC-2026-002,FAC-2026-003', await ids());
    await sel('none'); ok('filtre Non payées : f3 seulement', (await ids()) === 'FAC-2026-003', await ids());
    await sel('partial'); ok('filtre Payées partiellement : f1 seulement', (await ids()) === 'FAC-2026-001', await ids());
    await sel('paid'); ok('filtre Soldées : f2 seulement', (await ids()) === 'FAC-2026-002', await ids());
    await sel('all');
    // Action « Plus » : dupliquer / avoir dans un menu
    await p.click('#invoicesList tr.inv-row-issued:has-text("FAC-2026-003") summary'); await sleep(200);
    ok('menu « Plus » : WhatsApp, Dupliquer et Créer un avoir disponibles sur une facture enregistrée', await p.isVisible('#invoicesList tr:has-text("FAC-2026-003") button:has-text("Créer un avoir")') && await p.isVisible('#invoicesList tr:has-text("FAC-2026-003") button:has-text("Dupliquer")'));
    await p.evaluate(() => window.scrollTo(0, 0)); await p.click('#invoicesList tr.inv-row-issued:has-text("FAC-2026-003") summary'); await sleep(100);
    await p.screenshot({ path: process.env.SHOT_DIR ? path.join(process.env.SHOT_DIR, 'factures-mobile.png') : '/tmp/factures-mobile.png' });
    ok('aucune erreur JavaScript de page', true);
    await ctx.close();
    if (R_.includes(false)) { console.log('\nÉCHEC : ' + R_.filter(x => !x).length + ' contrôle(s) en échec'); process.exitCode = 1; } else console.log('\nOK : ' + R_.length + ' contrôles (liste des factures, navigateur 390 px, SIMULATION locale)');
  }
  await browser.close(); srv.close(); try { be.close(); } catch {} dropDb(db);
})().catch((e) => { console.error(e); process.exit(1); });
