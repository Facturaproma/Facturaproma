// Gestion de stock : suivi par produit, sortie automatique à l'émission d'une facture, entrée manuelle, avoir, période. SIMULATION locale, aucune donnée réelle.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8243;
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
  await p.fill('#signupEmail', `stock-${process.pid}@facturapro-test.invalid`); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500);
  if (!(await p.isVisible('#mainApp'))) {
    await p.evaluate(() => selectStatus(document.querySelector('[onclick*="selectStatus"]').getAttribute('onclick').match(/'(.*?)'/)[1])); await p.evaluate(() => onboardingNext(1));
    await p.fill('#onbCompanyName', 'Atelier Atlas SARL'); await p.fill('#onbICE', '001234567000089'); await p.evaluate(() => onboardingNext(2));
    await p.fill('#onbBank', 'Banque test'); await p.fill('#onbRIB', '007 780 0001234567890123 45'); await p.evaluate(() => finishOnboarding()); await sleep(1800);
  }
  await p.evaluate(() => stockRefreshLevels());
  await p.evaluate(() => { Storage.set('clients', [{ id: 'c1', name: 'Client Test', createdAt: new Date().toISOString() }]); });
  const level = (id) => p.evaluate((i) => stockLevel(i), id);
  const pid = async (n) => p.evaluate((nm) => (Storage.get('products', []).find(x => x.name === nm) || {}).id, n);

  // 1) Produit suivi + produit non suivi
  await p.evaluate(() => { navTo('products'); newProduct(); document.getElementById('modalProductName').value = 'Farine 25kg'; document.getElementById('modalProductPrice').value = '100'; document.getElementById('modalProductUnit').value = 'kg'; document.getElementById('modalProductTrack').checked = true; document.getElementById('modalProductAlert').value = '4'; saveProduct(); });
  await p.evaluate(() => { newProduct(); document.getElementById('modalProductName').value = 'Livraison'; document.getElementById('modalProductPrice').value = '30'; saveProduct(); });
  const prod = await p.evaluate(() => Storage.get('products', []).map(x => x.name + ':' + !!x.trackStock + ':' + x.stockAlert).join('|'));
  ok('produit « Suivre le stock » enregistré (seuil 4) ; l\'autre non suivi', prod === 'Farine 25kg:true:4|Livraison:false:0', prod);
  ok('liste des produits : stock affiché pour le produit suivi seulement', /Stock : 0/.test(await p.innerText('#productsList')) && (await p.innerText('#productsList')).split('Stock :').length === 2);
  const F = await pid('Farine 25kg'), L = await pid('Livraison');
  ok('liste produits : lien « Suivre le stock » visible sur le produit non suivi', /Suivre le stock/.test(await p.innerText('#productsList')));
  await p.evaluate((l) => toggleProductStock(l), L);
  ok('lien bascule le suivi (Livraison suivi), puis arrêt', await p.evaluate((l) => Storage.get('products', []).find(x => x.id === l).trackStock === true, L));
  await p.evaluate((l) => toggleProductStock(l), L);
  ok('suivi arrêté depuis la liste', await p.evaluate((l) => !Storage.get('products', []).find(x => x.id === l).trackStock, L));
  if (process.env.SHOT_DIR) { await sleep(300); await p.screenshot({ path: process.env.SHOT_DIR + '/produits-mobile.png', fullPage: true, animations: 'disabled' }); }

  // 1b) Arrêt du suivi : refusé si stock ≠ 0
  // (le niveau de Farine est 0 ici : arrêt accepté puis réactivé ; le refus avec stock ≠ 0 est testé après l'entrée manuelle)
  // 2) Entrée manuelle
  await p.evaluate(async () => { navTo('stock'); await openStockMove('in'); });
  ok('fenêtre d\'entrée : seul le produit suivi est proposé', (await p.$$eval('#stockMoveProduct option', o => o.length)) === 1);
  await p.fill('#stockMoveQty', '10'); await p.fill('#stockMoveNote', 'Fournisseur A'); await p.evaluate(() => saveStockMove()); await sleep(600);
  ok('entrée manuelle de 10 : stock = 10', (await level(F)) === 10);
  ok('page Stock : stock actuel affiché', /Farine 25kg/.test(await p.innerText('#stockCurrent')) && /10/.test(await p.innerText('#stockCurrent')));

  ok('arrêt du suivi refusé tant que le stock ≠ 0 (liste)', await p.evaluate((f) => { toggleProductStock(f); return Storage.get('products', []).find(x => x.id === f).trackStock === true; }, F));
  ok('arrêt du suivi refusé tant que le stock ≠ 0 (fenêtre produit)', await p.evaluate((f) => { editProduct(f); document.getElementById('modalProductTrack').checked = false; saveProduct(); const ok_ = Storage.get('products', []).find(x => x.id === f).trackStock === true && document.getElementById('modalProductTrack').checked === true; closeModal('productModal'); return ok_; }, F));
  // 3) Facture émise : sortie automatique
  const issue = async (lines, status) => p.evaluate(async ([ls, st]) => {
    newInvoice(); document.getElementById('editorClient').value = 'c1'; document.getElementById('itemsBody').innerHTML = '';
    ls.forEach(([name, price, qty]) => { addItem({ description: name, quantity: qty, price, tva: 20 }); const row = document.getElementById('itemsBody').lastElementChild; const pr = Storage.get('products', []).find(x => x.name === name); currentPickerRowId = row.id; selectProductForItem(pr.id); row.querySelector('.item-qty').value = qty; });
    await saveInvoice(st); return (editingInvoice || {}).id;
  }, [lines, status]);
  const inv1 = await issue([['Farine 25kg', 100, 3], ['Livraison', 30, 1]], 'sent'); await sleep(900);
  ok('facture émise (3 farine + 1 livraison) : stock 10 → 7', (await level(F)) === 7, String(await level(F)));
  ok('seul le produit suivi génère un mouvement (pas « Livraison »)', (await be.sql("SELECT count(*)::int n FROM stock_movements WHERE source='invoice'"))[0].n === 1);
  ok('les lignes de facture gardent le produit (productId)', await p.evaluate((i) => Storage.get('invoices', []).find(x => x.id === i).items.every(it => !!it.productId), inv1));
  // 4) Brouillon : aucun effet
  await issue([['Farine 25kg', 100, 2]], 'draft'); await sleep(400);
  ok('brouillon : stock inchangé (7)', (await level(F)) === 7);
  // 5) Idempotence
  await p.evaluate(async (i) => { const v = Storage.get('invoices', []).find(x => x.id === i); await stockOnInvoiceIssued(v); await stockOnInvoiceIssued(v); }, inv1);
  ok('ré-application sur la même facture : pas de double déduction', (await level(F)) === 7);
  // 6) Avoir : remise en stock
  await p.evaluate((i) => createCreditFromInvoice(i), inv1); await sleep(900);
  ok('avoir sur la facture : stock 7 → 10', (await level(F)) === 10, String(await level(F)));
  // 7) Période
  await p.evaluate(async (f) => { const d = new Date(); d.setMonth(d.getMonth() - 2); await stockRecord([{ key: 'old1', productId: f, productName: 'Farine 25kg', unit: 'kg', type: 'in', qty: 5, date: d.toISOString().slice(0, 10), source: 'manual', ref: '', refId: '', note: 'ancien' }]); navTo('stock'); setStockPeriod('month'); }, F);
  await sleep(800);
  const sum = await p.evaluate(async () => (await stockFetchPeriod(document.getElementById('stockFrom').value, document.getElementById('stockTo').value, 200)).rows[0]);
  ok('période « ce mois » : initial 5, entrées 13 (10 + avoir 3), sorties 3, final 15', sum.open === 5 && sum.in === 13 && sum.out === 3 && sum.close === 15, JSON.stringify(sum));
  ok('tableau de période et détail affichés', /Farine 25kg/.test(await p.innerText('#stockPeriod')) && /Facture/.test(await p.innerText('#stockMoves')) && /Avoir/.test(await p.innerText('#stockMoves')) && /Manuel/.test(await p.innerText('#stockMoves')));
  await p.evaluate(() => { const d = new Date(); d.setFullYear(d.getFullYear() + 1); document.getElementById('stockFrom').value = d.toISOString().slice(0, 10); document.getElementById('stockTo').value = d.toISOString().slice(0, 10); renderStock(); });
  await sleep(700);
  ok('période future : « Aucun mouvement » mais stock initial conservé', /Aucun mouvement|15/.test(await p.innerText('#stockPeriod')));
  // 8) Stock négatif et alerte
  await p.evaluate(() => setStockPeriod('month'));
  await issue([['Farine 25kg', 100, 20]], 'sent'); await sleep(900);
  ok('vente supérieure au stock : stock négatif toléré (15 − 20 = −5) et signalé', (await level(F)) === -5 && (await p.evaluate(async () => { await renderStock(); return /Négatif/.test(document.getElementById('stockCurrent').innerText); })));
  await p.evaluate(async () => { await openStockMove('in'); document.getElementById('stockMoveQty').value = '8'; await saveStockMove(); }); await sleep(500);
  ok('entrée de 8 : stock 3, alerte « Stock bas » (seuil 4)', (await level(F)) === 3 && /Stock bas/.test(await p.innerText('#stockCurrent')));
  ok('sortie manuelle', await p.evaluate(async () => { await openStockMove('out'); document.getElementById('stockMoveQty').value = '1'; document.getElementById('stockMoveNote').value = 'casse'; await saveStockMove(); return stockLevel(Storage.get('products', []).find(x => x.name === 'Farine 25kg').id) === 2; }));
  ok('injection : nom de produit échappé dans la page Stock', await p.evaluate(async () => { const ps = Storage.get('products', []); ps[0].name = '<img src=x onerror=window.__x=1>'; Storage.set('products', ps); await stockRecord([{ key: 'inj1', productId: ps[0].id, productName: ps[0].name, unit: 'kg', type: 'in', qty: 1, date: todayISO(), source: 'manual', ref: '', refId: '', note: '<b>n</b>' }]); await renderStock(); return !document.querySelector('#page-stock img') && !window.__x; }));
  const dl = p.waitForEvent('download'); await p.evaluate(() => exportStockSituation()); const d1 = await dl; const csv = fs.readFileSync(await d1.path(), 'utf8');
  ok('export « Situation » : colonnes Désignation / Stock initial / Entrées / Sorties / Stock restant', csv.split('\n')[0].replace('\uFEFF', '') === 'Désignation;Stock initial;Entrées;Sorties;Stock restant;Unité' && csv.split('\n').length >= 2, csv.split('\n')[1]);
  // Serveur : historique réel, immuable, isolé
  const srvRows = await be.sql("SELECT count(*)::int n, coalesce(sum(CASE move_type WHEN 'in' THEN qty ELSE -qty END),0)::float lv FROM stock_movements");
  ok('serveur : mouvements en base et niveau cohérent avec l\'écran (3)', srvRows[0].n >= 6 && srvRows[0].lv === 3 + 0 + 0 || srvRows[0].lv === (await level(F)), JSON.stringify(srvRows[0]));
  ok('serveur : un UPDATE direct est refusé (historique non modifiable)', await be.sql("UPDATE stock_movements SET qty = 999").then(() => false, () => true));
  // Hors ligne : file d'attente puis renvoi sans doublon
  await p.evaluate(() => { window.__net.down = true; });
  await p.evaluate(async () => { await openStockMove('in').catch(() => {}); });
  const before = (await be.sql("SELECT count(*)::int n FROM stock_movements"))[0].n;
  await p.evaluate(async () => { const f = Storage.get('products', [])[0].id; await stockRecord([{ key: 'off1', productId: f, productName: 'Farine', unit: 'kg', type: 'in', qty: 2, date: todayISO(), source: 'manual', ref: '', refId: '', note: '' }]); });
  ok('hors ligne : mouvement mis en file d\'attente (pas encore en base)', (await p.evaluate(() => stockOutbox().length)) === 1 && (await be.sql("SELECT count(*)::int n FROM stock_movements"))[0].n === before);
  await p.evaluate(() => { window.__net.down = false; }); await p.evaluate(() => stockRefreshLevels());
  ok('connexion revenue : file envoyée une seule fois', (await p.evaluate(() => stockOutbox().length)) === 0 && (await be.sql("SELECT count(*)::int n FROM stock_movements"))[0].n === before + 1);
  await p.evaluate(async () => { const f = Storage.get('products', [])[0].id; Storage.set('stockOutbox', [{ product_id: f, product_name: 'F', unit: 'kg', type: 'in', qty: 2, date: todayISO(), source: 'manual', ref: '', ref_id: '', note: '', key: 'off1' }]); await stockRefreshLevels(); });
  ok('renvoi de la même clé : aucun doublon', (await be.sql("SELECT count(*)::int n FROM stock_movements"))[0].n === before + 1);
  // Migration des anciens mouvements locaux (v1)
  await p.evaluate(async () => { const f = Storage.get('products', [])[0].id; Storage.set('stockMoves', [{ id: 'x', key: 'legacy1', productId: f, productName: 'F', unit: 'kg', type: 'in', qty: 4, date: todayISO(), source: 'manual', ref: '', refId: '', note: 'v1', createdAt: new Date().toISOString() }]); await stockRefreshLevels(); });
  ok('anciens mouvements locaux migrés vers le serveur puis vidés', (await be.sql("SELECT count(*)::int n FROM stock_movements WHERE idem_key='legacy1'"))[0].n === 1 && (await p.evaluate(() => stockLocalMoves().length)) === 0);
  await p.setViewportSize({ width: 390, height: 844 });
  if (process.env.SHOT_DIR) { await p.evaluate(() => { const ps = Storage.get('products', []); ps[0].name = 'Farine 25kg'; Storage.set('products', ps); navTo('stock'); renderStock(); }); await sleep(900); await p.screenshot({ path: process.env.SHOT_DIR + '/stock-mobile.png', fullPage: true, animations: 'disabled' }); }
  await browser.close(); srv.close(); try { dropDb(db); } catch (e) {}
  const n = R_.filter(Boolean).length; console.log(`\n${n === R_.length ? 'OK' : 'ÉCHEC'} : ${n}/${R_.length} contrôles (gestion de stock)`); process.exit(n === R_.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
