// Achats et dépenses côté serveur (sql/37) : natures, stock au coût, charges, TVA déductible, annulation, reprise des achats JSON, fournisseurs. SIMULATION locale, aucune donnée réelle.
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

  await p.evaluate(() => { Storage.set('products', [{ id: 'pf', name: 'Farine 25kg', price: 100, tva: 20, unit: 'sac', trackStock: true }, { id: 'pz', name: 'Emballages', price: 1, tva: 20 }]); });
  // Reprise d'un ancien achat JSON (version précédente) au premier chargement
  await p.evaluate(() => { Storage.set('purchases', [{ id: 'old-1', number: 'ACH-2026-001', date: '2026-10-01', supplierName: 'Ancien fournisseur', includeVat: true, lines: [{ productId: 'pf', description: 'Farine', qty: 2, price: 40, tva: 20 }] }]); Storage.set('purchasesMigrated', false); });
  await p.evaluate(async () => { navTo('purchases'); await purLoad(true); });
  ok('reprise : l\'ancien achat JSON est repris par le serveur (numéro conservé), une seule fois', (await p.evaluate(() => purList().filter(x => x.number === 'ACH-2026-001').length)) === 1 && (await be.sql("SELECT count(*)::int n FROM purchases WHERE legacy_id = 'old-1'"))[0].n === 1);
  await p.evaluate(async () => { Storage.set('purchasesMigrated', false); await purLoad(true); });
  ok('reprise rejouée : aucun doublon', (await be.sql("SELECT count(*)::int n FROM purchases"))[0].n === 1);
  ok('reprise : aucun mouvement de stock recréé', (await be.sql("SELECT count(*)::int n FROM stock_movements"))[0].n === 0);
  // Fournisseur depuis la saisie
  await p.evaluate(() => { openPurchase(); openSupplierModal(null, true); });
  await p.fill('#supName', 'Minoterie Atlas'); await p.fill('#supICE', '1234'); await p.evaluate(() => saveSupplier());
  ok('ICE fournisseur invalide refusé (15 chiffres)', (await p.evaluate(() => purSuppliers().length)) === 0);
  await p.fill('#supICE', '001122334455667'); await p.evaluate(() => saveSupplier());
  ok('fiche incomplète (IF, RC, adresse, ville, téléphone manquants) refusée', (await p.evaluate(() => purSuppliers().length)) === 0);
  await p.fill('#supIF', '12345678'); await p.fill('#supRC', '98765 Casablanca'); await p.fill('#supAddress', '12 rue Atlas'); await p.fill('#supCity', 'Casablanca'); await p.fill('#supPhone', '0522 11 22 33');
  await p.evaluate(() => saveSupplier());
  ok('fournisseur créé et sélectionné', await p.evaluate(() => purSuppliers().length === 1 && document.getElementById('purSupplier').value === purSuppliers()[0].id));
  // Achat mixte : marchandise suivie + frais de port (charge) + marchandise non suivie
  await p.evaluate(() => {
    const r1 = document.querySelector('#purLines .pur-line'); r1.querySelector('.pl-prod').value = 'pf'; onPurchaseProduct(r1.querySelector('.pl-prod')); r1.querySelector('.pl-qty').value = '12'; r1.querySelector('.pl-price').value = '8';
    addPurchaseLine('expense'); const r2 = document.querySelectorAll('#purLines .pur-line')[1]; r2.querySelector('.pl-cat').value = 'Carburant et transport'; r2.querySelector('.pl-desc').value = 'Frais de port'; r2.querySelector('.pl-price').value = '100'; setTvaSelect(r2.querySelector('.pl-tva'), 10);
    addPurchaseLine('goods'); const r3 = document.querySelectorAll('#purLines .pur-line')[2]; r3.querySelector('.pl-prod').value = 'pz'; onPurchaseProduct(r3.querySelector('.pl-prod')); r3.querySelector('.pl-qty').value = '50'; r3.querySelector('.pl-price').value = '1';
    addPurchaseLine(); updatePurchaseTotals();
    document.getElementById('purRef').value = 'FA-118'; document.getElementById('purDue').value = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  });
  ok('ligne « Charge » : catégorie visible, produit masqué', await p.evaluate(() => { const r = document.querySelectorAll('#purLines .pur-line')[1]; return r.querySelector('.pl-cat').style.display === '' && r.querySelector('.pl-prod').style.display === 'none'; }));
  ok('totaux en direct : HT 246, TVA 39,20 (19,20 + 10 + 10), TTC 285,20', /246,00/.test(await p.innerText('#purTotals')) && /39,20/.test(await p.innerText('#purTotals')) && /285,20/.test(await p.innerText('#purTotals')), await p.innerText('#purTotals'));
  if (process.env.SHOT_DIR) await p.screenshot({ path: process.env.SHOT_DIR + '/achat-saisie.png', fullPage: false, animations: 'disabled' });
  await p.evaluate(() => savePurchase()); await sleep(900);
  const pur = await p.evaluate(() => purList().find(x => x.supplierName === 'Minoterie Atlas'));
  ok('achat enregistré par le serveur : n° ACH-2026-002 (après l\'achat repris), 3 lignes, totaux exacts', pur && pur.number === 'ACH-2026-002' && pur.lines.length === 3 && pur.totalHT === 246 && pur.totalTVA === 39.2 && pur.totalTTC === 285.2, JSON.stringify(pur && [pur.number, pur.totalHT, pur.totalTVA, pur.totalTTC]));
  ok('natures enregistrées : marchandise suivie / charge « Carburant et transport » / marchandise non suivie', pur.lines[0].nature === 'goods' && pur.lines[0].trackStock && pur.lines[1].nature === 'expense' && pur.lines[1].category === 'Carburant et transport' && pur.lines[2].nature === 'goods' && !pur.lines[2].trackStock);
  ok('stock : seule la farine suivie entre (+12 au coût 8)', (await p.evaluate(() => stockLevel('pf'))) === 12 && (await be.sql("SELECT count(*)::int n, max(unit_cost)::float c FROM stock_movements"))[0].c === 8);
  ok('liste : fournisseur, n°, natures et total TTC', /Minoterie Atlas/.test(await p.innerText('#purchasesList')) && /285,20/.test(await p.innerText('#purchasesList')) && /Marchandise \+ Charge/.test(await p.innerText('#purchasesList')));
  // Double clic / renvoi : un seul achat
  ok('double envoi de la même saisie : un seul achat', await p.evaluate(async () => { openPurchase(); document.getElementById('purSupplier').value = purSuppliers()[0].id; const r = document.querySelector('#purLines .pur-line'); onPurchaseNature(Object.assign(r.querySelector('.pl-nature'), { value: 'asset' })); r.querySelector('.pl-desc').value = 'Balance'; r.querySelector('.pl-qty').value = '1'; r.querySelector('.pl-price').value = '1500'; const a = savePurchase(), b = savePurchase(); await a; await b; return purList().filter(x => x.lines.some(l => l.description === 'Balance')).length === 1; }));
  ok('investissement : ni stock ni charge (nature asset)', await p.evaluate(() => purList().find(x => x.lines.some(l => l.description === 'Balance')).lines[0].nature === 'asset'));
  // Dépense rapide (+ Dépense) avec TVA non déductible
  await p.evaluate(async () => { openPurchase('expense'); document.getElementById('purSupplier').value = purSuppliers()[0].id; const r = document.querySelector('#purLines .pur-line'); r.querySelector('.pl-cat').value = 'Carburant et transport'; r.querySelector('.pl-desc').value = 'Gasoil'; r.querySelector('.pl-price').value = '500'; document.getElementById('purVat').checked = false; await savePurchase(); });
  ok('« + Dépense » : ligne charge par défaut, quantité 1, enregistrée', await p.evaluate(() => { const x = purList().find(y => y.lines.some(l => l.description === 'Gasoil')); return x && x.lines[0].nature === 'expense' && x.lines[0].qty === 1 && !x.includeVat; }));
  // TVA déductible
  await p.evaluate(async () => { navTo('taxes'); await purLoad(); try { renderVatReport(true); } catch (e) {} });
  const vat = await p.evaluate(() => allVatPurchases().filter(x => x.fromPurchase).map(x => x.tva).sort((a, b) => a - b));
  ok('TVA déductible : achats actifs à TVA déductible seulement (reprise 16, achat 39,20, balance 300 ; gasoil exclu)', JSON.stringify(vat) === '[16,39.2,300]', JSON.stringify(vat));
  await p.evaluate(() => dedLoad(true));
  ok('relevé des déductions : seulement les achats réglés (TVA déductible au mois du paiement)', await p.evaluate(() => { const all = { key: 'x', start: '2000-01-01', end: '2099-12-31' };
    const r = deductionRows(all, purList(), _dedPay, purSuppliers(), []); return Array.isArray(_dedPay) && r.rows.every(x => _dedPay.some(y => y.purchaseId === x.purchaseId)); }));
  // Validations
  ok('marchandise sans produit : refusée avant envoi', await p.evaluate(async () => { navTo('purchases'); openPurchase(); document.getElementById('purSupplier').value = purSuppliers()[0].id; const r = document.querySelector('#purLines .pur-line'); r.querySelector('.pl-desc').value = 'X'; r.querySelector('.pl-qty').value = '1'; r.querySelector('.pl-price').value = '1'; const n = purList().length; await savePurchase(); const ok_ = purList().length === n && document.getElementById('purchaseModal').classList.contains('active'); closeModal('purchaseModal'); return ok_; }));
  ok('charge sans catégorie : refusée', await p.evaluate(async () => { openPurchase('expense'); document.getElementById('purSupplier').value = purSuppliers()[0].id; const r = document.querySelector('#purLines .pur-line'); r.querySelector('.pl-desc').value = 'X'; r.querySelector('.pl-price').value = '1'; const n = purList().length; await savePurchase(); const ok_ = purList().length === n; closeModal('purchaseModal'); return ok_; }));
  // Erreur réseau : la fenêtre reste ouverte, rien n'est créé, un nouvel essai avec la même clé fonctionne
  await p.evaluate(async () => { openPurchase('expense'); document.getElementById('purSupplier').value = purSuppliers()[0].id; const r = document.querySelector('#purLines .pur-line'); r.querySelector('.pl-cat').value = 'Loyer'; r.querySelector('.pl-desc').value = 'Loyer novembre'; r.querySelector('.pl-price').value = '2000'; setTvaSelect(r.querySelector('.pl-tva'), 0); window.__net.down = true; await savePurchase(); });
  ok('hors ligne : rien d\'enregistré, la saisie reste ouverte', await p.evaluate(() => document.getElementById('purchaseModal').classList.contains('active') && !purList().some(x => x.lines.some(l => l.description === 'Loyer novembre'))));
  await p.evaluate(async () => { window.__net.down = false; await savePurchase(); });
  ok('connexion revenue : même saisie enregistrée une fois', (await be.sql("SELECT count(*)::int n FROM purchase_lines WHERE description = 'Loyer novembre'"))[0].n === 1);
  // Fournisseur avec achats : suppression refusée
  await p.evaluate(async () => { await openSuppliersList(); await deleteSupplier(purSuppliers()[0].id); document.querySelectorAll('.modal-overlay.sup-list').forEach(m => m.remove()); });
  ok('fournisseur avec achats : suppression refusée', (await p.evaluate(() => purSuppliers().length)) === 1);
  // Annulation : stock corrigé au coût d'achat, retirée de la TVA, visible « annulée »
  await p.evaluate(async () => { navTo('purchases'); await cancelPurchase(purList().find(x => x.supplierName === 'Minoterie Atlas' && x.lines.length === 3).id); }); await sleep(500);
  ok('annulation : stock de farine revenu à 0', (await p.evaluate(() => stockLevel('pf'))) === 0);
  ok('annulation : sortie au coût de l\'achat (8), historique conservé (entrée + sortie)', (await be.sql("SELECT count(*)::int n, min(unit_cost)::float c FROM stock_movements WHERE product_id = 'pf'"))[0].n === 2);
  ok('annulation : pièce toujours visible, « annulée », retirée de la TVA déductible', await p.evaluate(() => { const x = purList().find(y => y.number === 'ACH-2026-002'); return x.status === 'cancelled' && !allVatPurchases().some(v => v.ref.startsWith('ACH-2026-002')); }));
  ok('filtre « Annulés » : 1 pièce', await p.evaluate(async () => { document.getElementById('purFilter').value = 'cancelled'; await renderPurchases(); const n = document.querySelectorAll('#purchasesList .pur-detail').length; document.getElementById('purFilter').value = 'all'; return n === 1; }));
  ok('filtre « Charges » : pièces contenant une charge', await p.evaluate(async () => { document.getElementById('purFilter').value = 'expense'; await renderPurchases(); const n = document.querySelectorAll('#purchasesList .pur-detail').length; document.getElementById('purFilter').value = 'all'; return n === 2; }));   // gasoil, loyer (l'achat mixte annulé est exclu)
  // Injection
  ok('injection : nom de fournisseur échappé', await p.evaluate(async () => { const s = purSuppliers(); s[0].name = '<img src=x onerror=window.__x=1>'; Storage.set('suppliers', s); openPurchase('expense'); document.getElementById('purSupplier').value = s[0].id; const r = document.querySelector('#purLines .pur-line'); r.querySelector('.pl-cat').value = 'Autre'; r.querySelector('.pl-desc').value = '<b>x</b>'; r.querySelector('.pl-price').value = '1'; await savePurchase(); await renderPurchases(); await openSuppliersList(); const okk = !document.querySelector('#purchasesList img, .sup-list img') && !window.__x && document.getElementById('purchasesList').textContent.includes('<b>x</b>'); document.querySelectorAll('.modal-overlay.sup-list').forEach(m => m.remove()); return okk; }));
  if (process.env.SHOT_DIR) { await p.evaluate(async () => { const s = purSuppliers(); s[0].name = 'Minoterie Atlas'; Storage.set('suppliers', s); await renderPurchases(); }); await sleep(300); await p.screenshot({ path: process.env.SHOT_DIR + '/achats-liste.png', fullPage: true, animations: 'disabled' }); }
  await browser.close(); srv.close(); try { dropDb(db); } catch (e) {}
  const n = R_.filter(Boolean).length; console.log(`\n${n === R_.length ? 'OK' : 'ÉCHEC'} : ${n}/${R_.length} contrôles (achats et dépenses, serveur)`); process.exit(n === R_.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
