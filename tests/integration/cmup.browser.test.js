// CMUP (sql/36) dans l'application : coûts d'achat, sorties valorisées, retours au coût d'origine, valeur du stock. SIMULATION locale, aucune donnée réelle.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8255;
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
  await p.fill('#signupEmail', `cmup-${process.pid}@facturapro-test.invalid`); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500);
  if (!(await p.isVisible('#mainApp'))) {
    await p.evaluate(() => selectStatus(document.querySelector('[onclick*="selectStatus"]').getAttribute('onclick').match(/'(.*?)'/)[1])); await p.evaluate(() => onboardingNext(1));
    await p.fill('#onbCompanyName', 'Atelier Atlas SARL'); await p.fill('#onbICE', '001234567000089'); await p.evaluate(() => onboardingNext(2));
    await p.fill('#onbBank', 'Banque test'); await p.fill('#onbRIB', '007 780 0001234567890123 45'); await p.evaluate(() => finishOnboarding()); await sleep(1800);
  }
  await p.evaluate(() => stockRefreshLevels());
  await p.evaluate(() => { Storage.set('clients', [{ id: 'c1', name: 'Client Test', createdAt: new Date().toISOString() }]); });
  const level = (id) => p.evaluate((i) => stockLevel(i), id);
  const pid = async (n) => p.evaluate((nm) => (Storage.get('products', []).find(x => x.name === nm) || {}).id, n);

  await p.evaluate(() => {
    Storage.set('products', [{ id: 'pa', name: 'Farine', price: 100, tva: 20, unit: 'sac', trackStock: true }]);
    Storage.set('clients', [{ id: 'c1', name: 'Épicerie Nour' }]);
    Storage.set('suppliers', [{ id: 's1', name: 'Minoterie' }]);
  });
  const buy = (qty, price, vat = true) => p.evaluate(async ([q, pr, v]) => {
    openPurchase(); document.getElementById('purSupplier').value = 's1'; const r = document.querySelector('#purLines .pur-line');
    r.querySelector('.pl-prod').value = 'pa'; onPurchaseProduct(r.querySelector('.pl-prod')); r.querySelector('.pl-qty').value = String(q); r.querySelector('.pl-price').value = String(pr);
    document.getElementById('purVat').checked = v; await savePurchase(); return purList()[0].id;
  }, [qty, price, vat]);
  const mv = (key) => be.sql("SELECT unit_cost::float c, cost_known k, cmup_after::float m, return_of r, move_type t, qty::float q FROM stock_movements WHERE idem_key = $1", [key]).then(r => r[0]);
  const cmup = () => p.evaluate(async () => { await stockRefreshLevels(); const v = stockValOf('pa'); return v && v.cmup; });
  const p1 = await buy(10, 50); await sleep(400);
  ok('achat 10 à 50 : CMUP 50', (await cmup()) === 50);
  await buy(10, 62); await sleep(400);
  ok('achat 10 à 62 : CMUP 56', (await cmup()) === 56);
  // Vente : sortie valorisée à 56
  const inv = await p.evaluate(async () => { newInvoice(); document.getElementById('editorClient').value = 'c1'; document.getElementById('itemsBody').innerHTML = ''; addItem({ description: 'x', quantity: 5, price: 100, tva: 20 }); const row = document.getElementById('itemsBody').lastElementChild; currentPickerRowId = row.id; selectProductForItem('pa'); row.querySelector('.item-qty').value = 5; await saveInvoice('sent'); return editingInvoice.id; });
  await sleep(900);
  const out = await mv(`inv:${inv}:0`);
  ok('facture de 5 : sortie au coût 56, coût connu', out && out.c === 56 && out.k === true && out.t === 'out', JSON.stringify(out));
  // Avoir avec retour de 2 : au coût de la sortie d'origine
  await p.evaluate((i) => { createCreditFromInvoice(i); }, inv); await sleep(400);
  await p.evaluate(() => { const m = document.querySelector('.cr-return'); m.querySelector('.cr-ret-on').click(); m.querySelector('.cr-ret-qty').value = '2'; m.querySelector('.cr-ret-ok').click(); }); await sleep(1200);
  const cr = (await be.sql("SELECT unit_cost::float c, return_of r FROM stock_movements WHERE source='credit'"))[0];
  ok('retour d\'avoir : rattaché à la sortie de la facture, au coût 56', cr && cr.c === 56 && cr.r === `inv:${inv}:0`, JSON.stringify(cr));
  // BL puis suppression : remise au coût de la sortie du BL
  await p.evaluate(async () => { openDelivery(); document.getElementById('blClient').value = 'c1'; const r = document.querySelector('#blLines .pur-line'); r.querySelector('.pl-prod').value = 'pa'; onDeliveryProduct(r.querySelector('.pl-prod')); r.querySelector('.pl-qty').value = '3'; await saveDelivery(); });
  await sleep(400);
  const bl = await p.evaluate(() => blList().slice(-1)[0]);
  await p.evaluate(async (id) => { await deleteDelivery(id); }, bl.id); await sleep(500);
  const back = await mv(`bl-del:${bl.id}:0`);
  ok('BL supprimé : remise en stock au coût de sa sortie (56), rattachée à la sortie', back && back.c === 56 && back.r === `bl:${bl.id}:0`, JSON.stringify(back));
  // Achat avec TVA non déductible : coût TTC
  await buy(1, 100, false); await sleep(400);
  const nd = (await be.sql("SELECT unit_cost::float c FROM stock_movements WHERE source='purchase' AND move_type='in' ORDER BY seq DESC LIMIT 1"))[0];
  ok('achat à TVA non déductible : coût d\'entrée = 120 (TVA incluse)', nd && nd.c === 120, JSON.stringify(nd));
  // Entrée manuelle avec et sans coût
  await p.evaluate(async () => { navTo('stock'); await openStockMove('in'); document.getElementById('stockMoveQty').value = '2'; document.getElementById('stockMoveCost').value = '80'; await saveStockMove(); });
  await sleep(300);
  ok('entrée manuelle avec coût 80 : coût connu', (await be.sql("SELECT count(*)::int n FROM stock_movements WHERE source='manual' AND unit_cost = 80 AND cost_known"))[0].n === 1);
  await p.evaluate(async () => { await openStockMove('in'); document.getElementById('stockMoveQty').value = '1'; await saveStockMove(); });
  await sleep(300);
  ok('entrée manuelle sans coût : valorisée au CMUP, signalée « estimé »', (await be.sql("SELECT count(*)::int n FROM stock_movements WHERE source='manual' AND NOT cost_known"))[0].n === 1);
  ok('sortie : le champ coût est masqué', await p.evaluate(async () => { await openStockMove('out'); const h = document.getElementById('stockMoveCostRow').style.display === 'none'; closeModal('stockMoveModal'); return h; }));
  // Écran Stock : coût moyen, valeur, total, astérisque
  await p.evaluate(async () => { setStockPeriod('month'); await renderStock(); });
  const txt = await p.innerText('#stockCurrent');
  ok('écran Stock : colonnes Coût moyen et Valeur, total, avertissement de coût estimé', /Coût moyen/i.test(txt) && /Valeur totale du stock/.test(txt) && /\*/.test(txt), txt.replace(/\s+/g, ' ').slice(0, 200));
  ok('détail des mouvements : coût affiché, « (estimé) » pour l\'entrée sans coût', /coût 56,00/.test(await p.innerText('#stockMoves')) && /\(estimé\)/.test(await p.innerText('#stockMoves')));
  // Suppression du 1er achat : sortie au coût de l'achat (50)
  await p.evaluate(async (id) => { navTo('purchases'); await purLoad(); await cancelPurchase(id); }, p1); await sleep(500);
  const del = await mv(`pur-cancel:${p1}:0`);
  ok('achat supprimé : sortie au coût de l\'achat (50), pas au CMUP', del && del.c === 50 && del.t === 'out', JSON.stringify(del));
  // Cohérence finale : état serveur = somme des mouvements ; valeur = qté × CMUP
  const fin = (await be.sql("SELECT s.qty::float q, s.cmup::float c, (SELECT sum(CASE WHEN move_type='in' THEN qty ELSE -qty END)::float FROM stock_movements) sm FROM stock_cost_state s"))[0];
  ok('invariant serveur : quantité d\'état = somme des mouvements', fin.q === fin.sm, JSON.stringify(fin));
  ok('fiche produits : coût moyen affiché', await p.evaluate(async () => { navTo('products'); await stockRefreshLevels(); renderProducts(); return /coût moyen/.test(document.getElementById('productsList').innerText); }));
  // CSV Situation : coût moyen et valeur
  const dl = p.waitForEvent('download'); await p.evaluate(() => { navTo('stock'); setStockPeriod('month', true); exportStockSituation(); }); const f = await dl; const csv = fs.readFileSync(await f.path(), 'utf8');
  ok('CSV Situation : colonnes Coût moyen et Valeur remplies', /Coût moyen \(DH\);Valeur \(DH\)/.test(csv) && /;\d+,\d+;\d+,\d{2}\s*$/m.test(csv), csv.split('\n')[1]);
  await browser.close(); srv.close(); try { dropDb(db); } catch (e) {}
  const n = R_.filter(Boolean).length; console.log(`\n${n === R_.length ? 'OK' : 'ÉCHEC'} : ${n}/${R_.length} contrôles (CMUP dans l'application)`); process.exit(n === R_.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
