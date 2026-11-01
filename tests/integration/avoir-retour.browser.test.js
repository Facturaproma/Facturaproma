// Avoir commercial ≠ retour physique : l'avoir ne remet le stock que si la marchandise est déclarée revenue. SIMULATION locale, aucune donnée réelle.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8254;
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
  await p.fill('#signupEmail', `avret-${process.pid}@facturapro-test.invalid`); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500);
  if (!(await p.isVisible('#mainApp'))) {
    await p.evaluate(() => selectStatus(document.querySelector('[onclick*="selectStatus"]').getAttribute('onclick').match(/'(.*?)'/)[1])); await p.evaluate(() => onboardingNext(1));
    await p.fill('#onbCompanyName', 'Atelier Atlas SARL'); await p.fill('#onbICE', '001234567000089'); await p.evaluate(() => onboardingNext(2));
    await p.fill('#onbBank', 'Banque test'); await p.fill('#onbRIB', '007 780 0001234567890123 45'); await p.evaluate(() => finishOnboarding()); await sleep(1800);
  }
  await p.evaluate(() => stockRefreshLevels());
  await p.evaluate(() => { Storage.set('clients', [{ id: 'c1', name: 'Client Test', createdAt: new Date().toISOString() }]); });
  const level = (id) => p.evaluate((i) => stockLevel(i), id);
  const pid = async (n) => p.evaluate((nm) => (Storage.get('products', []).find(x => x.name === nm) || {}).id, n);

  await p.evaluate(async () => {
    Storage.set('products', [{ id: 'pf', name: 'Farine 25kg', price: 100, tva: 20, unit: 'sac', trackStock: true }, { id: 'ps', name: 'Conseil', price: 500, tva: 20 }]);
    Storage.set('clients', [{ id: 'c1', name: 'Épicerie Nour' }]);
    await stockRecord([{ key: 'init', productId: 'pf', productName: 'Farine 25kg', unit: 'sac', type: 'in', qty: 20, date: todayISO(), source: 'manual' }]);
  });
  const issue = async (lines) => p.evaluate(async (ls) => {
    newInvoice(); document.getElementById('editorClient').value = 'c1'; document.getElementById('itemsBody').innerHTML = '';
    ls.forEach(([pid, qty]) => { addItem({ description: 'x', quantity: qty, price: 100, tva: 20 }); const row = document.getElementById('itemsBody').lastElementChild; currentPickerRowId = row.id; selectProductForItem(pid); row.querySelector('.item-qty').value = qty; });
    await saveInvoice('sent'); return editingInvoice.id;
  }, lines);
  const lv = () => p.evaluate(() => stockLevel('pf'));
  const f1 = await issue([['pf', 3]]); await sleep(900);
  ok('facture de 3 sacs : stock 20 → 17', (await lv()) === 17);
  // S6 : avoir commercial, case non cochée
  await p.evaluate((i) => { createCreditFromInvoice(i); }, f1); await sleep(400);
  await p.evaluate(() => document.querySelector('.cr-return .cr-ret-ok').click()); await sleep(900);
  const c1 = await p.evaluate((i) => Storage.get('invoices', []).find(x => x.type === 'credit' && x.relatedInvoiceId === i), f1);
  ok('avoir commercial créé, sans retour : returnLines vide', c1 && Array.isArray(c1.returnLines) && c1.returnLines.length === 0);
  ok('avoir commercial : stock INCHANGÉ (17)', (await lv()) === 17);
  ok('serveur : aucune entrée « credit »', (await be.sql("SELECT count(*)::int n FROM stock_movements WHERE source='credit'"))[0].n === 0);
  // S7 : avoir avec retour partiel (2 sur 3)
  const f2 = await issue([['pf', 3], ['ps', 1]]); await sleep(900);
  ok('2e facture : stock 17 → 14 (le service non suivi ne bouge rien)', (await lv()) === 14);
  await p.evaluate((i) => { createCreditFromInvoice(i); }, f2); await sleep(400);
  ok('fenêtre de retour : seule la ligne suivie est proposée', await p.evaluate(() => document.querySelectorAll('.cr-return .cr-ret-qty').length === 1));
  await p.evaluate(() => { const m = document.querySelector('.cr-return'); m.querySelector('.cr-ret-on').click(); m.querySelector('.cr-ret-qty').value = '5'; m.querySelector('.cr-ret-ok').click(); }); await sleep(300);
  ok('quantité retournée > facturée : refusée, fenêtre toujours ouverte', await p.evaluate(() => !!document.querySelector('.cr-return')));
  await p.evaluate(() => { const m = document.querySelector('.cr-return'); m.querySelector('.cr-ret-qty').value = '2'; m.querySelector('.cr-ret-ok').click(); }); await sleep(1200);
  ok('retour de 2 sacs : stock 14 → 16', (await lv()) === 16, String(await lv()));
  const mv = await be.sql("SELECT qty::float q, move_type t FROM stock_movements WHERE source='credit'");
  ok('serveur : une entrée « credit » de 2', mv.length === 1 && mv[0].q === 2 && mv[0].t === 'in', JSON.stringify(mv));
  // Rejouer l'entrée de stock de l'avoir : aucun doublon
  await p.evaluate(async (i) => { const c = Storage.get('invoices', []).find(x => x.type === 'credit' && x.relatedInvoiceId === i); await stockOnCreditIssued(c); }, f2);
  ok('rejeu de l\'avoir : aucune double entrée', (await lv()) === 16);
  // Annulation de la fenêtre : aucun avoir
  const f3 = await issue([['pf', 1]]); await sleep(900);
  await p.evaluate((i) => { createCreditFromInvoice(i); }, f3); await sleep(400);
  await p.evaluate(() => document.querySelector('.cr-return .cr-ret-cancel').click()); await sleep(500);
  ok('fenêtre annulée : aucun avoir créé', await p.evaluate((i) => !Storage.get('invoices', []).some(x => x.type === 'credit' && x.relatedInvoiceId === i), f3));
  // Facture sans produit suivi : pas de fenêtre, avoir direct
  const f4 = await issue([['ps', 1]]); await sleep(700);
  await p.evaluate(async (i) => { await createCreditFromInvoice(i); }, f4); await sleep(500);
  ok('facture sans produit suivi : avoir créé sans fenêtre de retour', await p.evaluate((i) => !document.querySelector('.cr-return') && Storage.get('invoices', []).some(x => x.type === 'credit' && x.relatedInvoiceId === i), f4));
  // Ancien avoir (avant la règle, sans returnLines) : pas de nouvelle entrée
  ok('ancien avoir sans returnLines : aucune entrée recréée', await p.evaluate(async () => { const r = await stockOnCreditIssued({ id: 'old', number: 'AV-OLD', type: 'credit', date: todayISO(), items: [{ productId: 'pf', description: 'x', quantity: -4 }] }); return r.length === 0 && stockLevel('pf') === 15; }));
  await browser.close(); srv.close(); try { dropDb(db); } catch (e) {}
  const n = R_.filter(Boolean).length; console.log(`\n${n === R_.length ? 'OK' : 'ÉCHEC'} : ${n}/${R_.length} contrôles (avoir commercial et retour de marchandise)`); process.exit(n === R_.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
