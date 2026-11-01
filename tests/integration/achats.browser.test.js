// Achats & fournisseurs : entrées de stock automatiques, TVA déductible, suppression avec correction du stock. SIMULATION locale, aucune donnée réelle.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8251;
const srv = http.createServer((q, r) => {
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
  const db = createDb({ stock: true }); const be = makeBackend(db);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' }); const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 160))); p.on('dialog', (d) => d.accept());
  await p.exposeFunction('__srv', (op, args) => be.handle(op, args));
  await p.route(/jsdelivr.*supabase/, (r) => r.fulfill({ body: FAKE, contentType: 'text/javascript' }));
  await p.route('**/jspdf.umd.min.js', (r) => r.fulfill({ path: nm('jspdf', 'dist', 'jspdf.umd.min.js'), contentType: 'text/javascript' }));
  await p.route('**/jspdf.plugin.autotable.min.js', (r) => r.fulfill({ path: nm('jspdf-autotable', 'dist', 'jspdf.plugin.autotable.min.js'), contentType: 'text/javascript' }));
  await p.route(/googleapis|gstatic|hcaptcha/, (r) => r.abort());
  const R_ = []; const ok = (n, c, x = '') => { R_.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? ' ' + x : '')); };
  await p.goto(`http://localhost:${PORT}/app.html?mode=login`); await sleep(800);
  await p.click('[data-tab=signup]');
  await p.fill('#signupEmail', `achats-${process.pid}@facturapro-test.invalid`); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500);
  if (!(await p.isVisible('#mainApp'))) {
    await p.evaluate(() => selectStatus(document.querySelector('[onclick*="selectStatus"]').getAttribute('onclick').match(/'(.*?)'/)[1])); await p.evaluate(() => onboardingNext(1));
    await p.fill('#onbCompanyName', 'Atelier Atlas SARL'); await p.fill('#onbICE', '001234567000089'); await p.evaluate(() => onboardingNext(2));
    await p.fill('#onbBank', 'Banque test'); await p.fill('#onbRIB', '007 780 0001234567890123 45'); await p.evaluate(() => finishOnboarding()); await sleep(1800);
  }
  await p.evaluate(() => stockRefreshLevels());
  await p.evaluate(() => { Storage.set('clients', [{ id: 'c1', name: 'Client Test', createdAt: new Date().toISOString() }]); });
  const level = (id) => p.evaluate((i) => stockLevel(i), id);
  const pid = async (n) => p.evaluate((nm) => (Storage.get('products', []).find(x => x.name === nm) || {}).id, n);

  await p.evaluate(() => { Storage.set('products', [{ id: 'pf', name: 'Farine 25kg', price: 100, tva: 20, unit: 'sac', trackStock: true }, { id: 'ps', name: 'Transport', price: 50, tva: 20 }]); });
  // Fournisseur depuis la saisie d'achat
  await p.evaluate(() => { navTo('purchases'); openPurchase(); openSupplierModal(null, true); });
  await p.fill('#supName', 'Minoterie Atlas'); await p.fill('#supICE', '1234'); await p.evaluate(() => saveSupplier());
  ok('ICE fournisseur invalide refusé (15 chiffres)', (await p.evaluate(() => purSuppliers().length)) === 0);
  await p.fill('#supICE', '001122334455667'); await p.evaluate(() => saveSupplier());
  ok('fournisseur créé et sélectionné dans l\'achat', await p.evaluate(() => purSuppliers().length === 1 && document.getElementById('purSupplier').value === purSuppliers()[0].id));
  // Achat : 1 ligne produit suivi + 1 ligne libre
  await p.evaluate(() => {
    const r1 = document.querySelector('#purLines .pur-line'); r1.querySelector('.pl-prod').value = 'pf'; onPurchaseProduct(r1.querySelector('.pl-prod'));
    r1.querySelector('.pl-qty').value = '12'; r1.querySelector('.pl-price').value = '8';
    addPurchaseLine(); const r2 = document.querySelectorAll('#purLines .pur-line')[1];
    r2.querySelector('.pl-desc').value = 'Frais de port'; r2.querySelector('.pl-qty').value = '1'; r2.querySelector('.pl-price').value = '100'; r2.querySelector('.pl-tva').value = '10';
    addPurchaseLine(); updatePurchaseTotals();   // 3e ligne vide : ignorée
    document.getElementById('purRef').value = 'FA-118';
  });
  ok('totaux en direct : HT 196, TVA 29,20, TTC 225,20', /196,00/.test(await p.innerText('#purTotals')) && /29,20/.test(await p.innerText('#purTotals')) && /225,20/.test(await p.innerText('#purTotals')), await p.innerText('#purTotals'));
  if (process.env.SHOT_DIR) await p.screenshot({ path: process.env.SHOT_DIR + '/achat-saisie.png', fullPage: false, animations: 'disabled' });
  await p.evaluate(() => savePurchase()); await sleep(900);
  const pur = await p.evaluate(() => purList()[0]);
  ok('achat enregistré : n° ACH-AAAA-001, 2 lignes, totaux exacts', /^ACH-\d{4}-001$/.test(pur.number) && pur.lines.length === 2 && pur.totalHT === 196 && pur.totalTVA === 29.2 && pur.totalTTC === 225.2, JSON.stringify([pur.number, pur.totalHT, pur.totalTVA, pur.totalTTC]));
  ok('stock du produit suivi : +12 (ligne libre sans effet)', (await p.evaluate(() => stockLevel('pf'))) === 12);
  const mv = await be.sql("SELECT source, qty::float q, ref FROM stock_movements WHERE source = 'purchase'");
  ok('serveur : 1 mouvement « purchase » de 12, référence ACH', mv.length === 1 && mv[0].q === 12 && /^ACH-/.test(mv[0].ref), JSON.stringify(mv));
  ok('liste des achats : fournisseur, n° et total TTC', /Minoterie Atlas/.test(await p.innerText('#purchasesList')) && /225,20/.test(await p.innerText('#purchasesList')));
  // TVA déductible
  await p.evaluate(() => { navTo('taxes'); try { renderVatReport(true); } catch (e) {} });
  const vat = await p.evaluate(() => allVatPurchases().filter(x => x.fromPurchase).map(x => x.tva));
  ok('TVA déductible : l\'achat est repris (29,20)', vat.length === 1 && vat[0] === 29.2, JSON.stringify(vat));
  ok('liste TVA : ligne « Achats » non supprimable depuis la TVA', await p.evaluate(() => { const t = document.getElementById('vatPurchasesBody'); return /ACH-/.test(t.innerText) && /Achats/.test(t.innerText); }));
  // Achat sans TVA déductible
  await p.evaluate(async () => { navTo('purchases'); openPurchase(); document.getElementById('purSupplier').value = purSuppliers()[0].id; const r = document.querySelector('#purLines .pur-line'); r.querySelector('.pl-desc').value = 'Ticket'; r.querySelector('.pl-qty').value = '1'; r.querySelector('.pl-price').value = '10'; document.getElementById('purVat').checked = false; await savePurchase(); });
  ok('achat « TVA non déduite » : exclu de la TVA déductible, n° 002', await p.evaluate(() => allVatPurchases().filter(x => x.fromPurchase).length === 1 && purList().some(x => /-002$/.test(x.number))));
  // Validation
  await p.evaluate(async () => { openPurchase(); document.getElementById('purSupplier').value = purSuppliers()[0].id; const r = document.querySelector('#purLines .pur-line'); r.querySelector('.pl-desc').value = 'X'; r.querySelector('.pl-qty').value = '0'; await savePurchase(); closeModal('purchaseModal'); });
  ok('quantité 0 refusée', (await p.evaluate(() => purList().length)) === 2);
  // Stock page : origine « Achat »
  await p.evaluate(async () => { navTo('stock'); setStockPeriod('month'); }); await sleep(900);
  ok('page Stock : mouvement affiché avec l\'origine « Achat »', /Achat ACH-/.test(await p.innerText('#stockMoves')));
  // Fournisseur avec achats : suppression refusée
  await p.evaluate(() => { openSuppliersList(); deleteSupplier(purSuppliers()[0].id); });
  ok('fournisseur avec achats : suppression refusée', (await p.evaluate(() => purSuppliers().length)) === 1);
  await p.evaluate(() => document.querySelectorAll('.modal-overlay.sup-list').forEach(m => m.remove()));
  // Suppression de l'achat : stock corrigé, TVA retirée
  await p.evaluate(async () => { navTo('purchases'); await deletePurchase(purList().find(x => /-001$/.test(x.number)).id); }); await sleep(500);
  ok('suppression de l\'achat : stock revenu à 0', (await p.evaluate(() => stockLevel('pf'))) === 0);
  ok('serveur : historique conservé (entrée + sortie d\'annulation)', (await be.sql("SELECT count(*)::int n FROM stock_movements WHERE source='purchase'"))[0].n === 2);
  ok('achat supprimé et retiré de la TVA', await p.evaluate(() => purList().length === 1 && allVatPurchases().filter(x => x.fromPurchase).length === 0));
  // Rattrapage d'un achat dont l'entrée de stock avait échoué
  await p.evaluate(async () => { const all = purList(); all.push({ id: 'pz', number: 'ACH-2026-099', date: todayISO(), supplierId: purSuppliers()[0].id, supplierName: 'Minoterie Atlas', lines: [{ productId: 'pf', description: 'Farine', qty: 5, price: 8, tva: 20 }], totalHT: 40, totalTVA: 8, totalTTC: 48, stockMoves: [{ key: 'pur:pz:0', productId: 'pf', productName: 'Farine 25kg', unit: 'sac', qty: 5 }], stockOk: false }); Storage.set('purchases', all); await purSyncStock(); await purSyncStock(); });
  ok('stock en attente : renvoyé automatiquement, une seule fois', (await p.evaluate(() => stockLevel('pf'))) === 5 && (await p.evaluate(() => purList().find(x => x.id === 'pz').stockOk)) === true);
  // Injection
  ok('injection : nom de fournisseur échappé', await p.evaluate(() => { const s = purSuppliers(); s[0].name = '<img src=x onerror=window.__x=1>'; Storage.set('suppliers', s); const pl = purList(); pl.forEach(x => { x.supplierName = s[0].name; }); Storage.set('purchases', pl); renderPurchases(); openSuppliersList(); const okk = !document.querySelector('#purchasesList img, .sup-list img') && !window.__x; document.querySelectorAll('.modal-overlay.sup-list').forEach(m => m.remove()); return okk; }));
  if (process.env.SHOT_DIR) { await p.evaluate(() => { const s = purSuppliers(); s[0].name = 'Minoterie Atlas'; Storage.set('suppliers', s); const pl = purList(); pl.forEach(x => { x.supplierName = 'Minoterie Atlas'; }); Storage.set('purchases', pl); renderPurchases(); togglePurchaseDetail('pz'); }); await sleep(300); await p.screenshot({ path: process.env.SHOT_DIR + '/achats-liste.png', fullPage: true, animations: 'disabled' }); }
  await browser.close(); srv.close(); try { dropDb(db); } catch (e) {}
  const n = R_.filter(Boolean).length; console.log(`\n${n === R_.length ? 'OK' : 'ÉCHEC'} : ${n}/${R_.length} contrôles (achats et fournisseurs)`); process.exit(n === R_.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
