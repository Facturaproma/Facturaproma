// Pilotage (sql/41) : indicateurs calculés par le serveur à partir d'un parcours réel (achats, facture émise avec sortie de stock, paiement), affichage, alertes de fiabilité, export CSV. SIMULATION locale, aucune donnée réelle.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8258;
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
  await p.fill('#signupEmail', `pil-${process.pid}@facturapro-test.invalid`); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500);
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
    Storage.set('products', [{ id: 'pa', name: 'Farine', price: 200, tva: 20, unit: 'sac', trackStock: true }]);
    Storage.set('suppliers', [{ id: 's1', name: 'Minoterie' }]); Storage.set('clients', [{ id: 'c1', name: 'Épicerie Nour' }]);
  });
  await sleep(800);
  await p.evaluate(async () => { const d = todayISO(), r = (p) => supaClient.rpc('purchase_record', { p });
    await r({ key: 'k1', supplier_id: 's1', supplier_name: 'Minoterie', date: d, lines: [{ nature: 'goods', product_id: 'pa', product_name: 'Farine', track_stock: true, description: 'Farine', qty: 10, unit_price: 50, tva_rate: 20 }] });
    await r({ key: 'k2', supplier_id: 's1', supplier_name: 'Minoterie', date: d, lines: [{ nature: 'goods', product_id: 'pa', product_name: 'Farine', track_stock: true, description: 'Farine', qty: 10, unit_price: 62, tva_rate: 20 }] });
    await r({ key: 'k3', supplier_name: 'Bailleur', date: d, lines: [{ nature: 'expense', category: 'Loyer', description: 'Loyer', qty: 1, unit_price: 2000, tva_rate: 0 }] });
    await r({ key: 'k4', supplier_name: 'Info', date: d, lines: [{ nature: 'asset', description: 'Ordinateur', qty: 1, unit_price: 8000, tva_rate: 20 }] }); });
  // Facture émise dans l'application : 5 sacs à 200 DH HT → sortie de stock au coût moyen 56
  await p.evaluate(async () => { navTo('invoices'); newInvoice(); document.getElementById('editorClient').value = 'c1'; document.getElementById('itemsBody').innerHTML = '';
    addItem({ description: 'Farine', quantity: 5, price: 200, tva: 20 }); const row = document.getElementById('itemsBody').lastElementChild; currentPickerRowId = row.id; selectProductForItem('pa'); row.querySelector('.item-qty').value = 5; row.querySelector('.item-price').value = 200;
    await saveInvoice('sent'); });
  await sleep(1500);
  const inv = await p.evaluate(() => Storage.get('invoices', []).find(i => i.status !== 'draft'));
  ok('facture émise : 1 000 HT, numéro serveur', inv && inv.totalHT === 1000 && /^FAC-/.test(inv.number), JSON.stringify(inv && [inv.totalHT, inv.number]));
  await p.evaluate(async (id) => { navTo('payments'); recordPayment(); await new Promise(r => setTimeout(r, 300)); document.getElementById('paymentInvoice').value = id; document.getElementById('paymentAmount').value = '600'; savePayment(); }, inv.id);
  await sleep(1500);
  await p.evaluate(() => { const l = Storage.get('invoices', []); l.push({ id: 'dr', number: 'BRO-9', clientId: 'c1', clientName: 'Épicerie Nour', date: todayISO(), totalHT: 999, totalTVA: 0, totalTTC: 999, status: 'draft', items: [] }); Storage.set('invoices', l); });
  await sleep(1200);
  await p.evaluate(async () => { navTo('pilotage'); await new Promise(r => setTimeout(r, 200)); await renderPilotage(); });
  ok('période par défaut : ce mois', (await p.inputValue('#pilPreset')) === 'month' && (await p.inputValue('#pilFrom')).endsWith('-01'));
  const s = await p.evaluate(() => _pilData);
  ok('serveur : CA 1 000, coût des ventes 5 × 56 = 280, marge 720 (72 %)', Number(s.sales_ht) === 1000 && Number(s.cogs) === 280 && Number(s.gross_margin) === 720 && Number(s.gross_margin_rate) === 72, JSON.stringify([s.sales_ht, s.cogs, s.gross_margin, s.gross_margin_rate]));
  ok('serveur : charges 2 000, résultat −1 280, investissement 8 000 hors résultat', Number(s.charges) === 2000 && Number(s.result) === -1280 && Number(s.investments) === 8000);
  ok('serveur : encaissé 600, créances 1 200 − 600 = 600', Number(s.collections) === 600 && Number(s.receivables) === 600);
  ok('serveur : dettes 600 + 744 + 2 000 + 9 600 = 12 944, stock 15 × 56 = 840', Number(s.payables) === 12944 && Number(s.stock_value) === 840, JSON.stringify([s.payables, s.stock_value]));
  const txt = await p.innerText('#pilResult');
  ok('écran : CA, coût des ventes, marge et taux affichés', /1\s?000[.,]00/.test(txt) && /280[.,]00/.test(txt) && /720[.,]00/.test(txt) && /72 %/.test(txt), txt.slice(0, 300));
  ok('écran : résultat négatif « estimé », mention avant impôt', /−?-?1\s?280[.,]00/.test(txt) && /estimé/i.test(txt) && /avant impôt/i.test(txt));
  ok('écran : situation (dettes 12 944, stock 840)', /12\s?944[.,]00/.test(await p.innerText('#pilPosition')) && /840[.,]00/.test(await p.innerText('#pilPosition')));
  const chk = await p.innerText('#pilChecks');
  ok('fiabilité : brouillon signalé, absence de compte de trésorerie signalée', /brouillon/.test(chk) && /Aucun compte de trésorerie/.test(chk), chk);
  ok('mois par mois : 12 mois, le mois courant porte le CA', (await p.evaluate(() => _pilMonthly.length)) === 12 && (await p.evaluate(() => Number(_pilMonthly[_pilMonthly.length - 1].sales_ht))) === 1000);
  const csv = await p.evaluate(async () => { let out = ''; const o = URL.createObjectURL; URL.createObjectURL = (b) => { b.text().then(t => { out = t; }); return 'blob:x'; }; HTMLAnchorElement.prototype.click = function () {}; exportPilotageCsv(); await new Promise(r => setTimeout(r, 200)); URL.createObjectURL = o; return out; });
  ok('export CSV : indicateurs et mois, format français', /Chiffre d'affaires HT;1000,00/.test(csv) && /Résultat de gestion estimé \(non fiscal\);-1280,00/.test(csv) && /Mois;CA HT/.test(csv), csv.slice(0, 200));
  await p.evaluate(async () => { document.getElementById('pilPreset').value = 'prev'; onPilotagePreset(); await new Promise(r => setTimeout(r, 800)); });
  ok('mois dernier : aucun chiffre (tout est daté de ce mois)', Number((await p.evaluate(() => _pilData)).sales_ht) === 0);
  await p.evaluate(async () => { document.getElementById('pilFrom').value = '2026-12-31'; document.getElementById('pilTo').value = '2026-01-01'; await renderPilotage(); });
  ok('période inversée : message, aucun appel', /invalide/.test(await p.innerText('#pilResult')));
  if (process.env.SHOT_DIR) { await p.evaluate(() => onPilotagePreset()); await sleep(800); await p.screenshot({ path: process.env.SHOT_DIR + '/pilotage.png', fullPage: true, animations: 'disabled' }); }
  await browser.close(); srv.close(); try { dropDb(db); } catch (e) {}
  const n = R_.filter(Boolean).length; console.log(`\n${n === R_.length ? 'OK' : 'ÉCHEC'} : ${n}/${R_.length} contrôles (pilotage)`); process.exit(n === R_.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
