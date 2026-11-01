// Bons de livraison : sortie de stock au BL, facture depuis BL sans double déduction, devis → BL, suppression, PDF. SIMULATION locale, aucune donnée réelle.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8252;
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
  await p.fill('#signupEmail', `bl-${process.pid}@facturapro-test.invalid`); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500);
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
    Storage.set('products', [{ id: 'pf', name: 'Farine 25kg', price: 100, tva: 20, unit: 'sac', trackStock: true }, { id: 'ph', name: 'Huile 5L', price: 60, tva: 20, unit: 'bidon', trackStock: true }, { id: 'ps', name: 'Transport', price: 50, tva: 20 }]);
    Storage.set('clients', [{ id: 'c1', name: 'Épicerie Nour', ice: '001234567000089', address: 'Fès' }, { id: 'c2', name: 'Café Atlas' }]);
    await stockRecord([{ key: 'init-f', productId: 'pf', productName: 'Farine 25kg', unit: 'sac', type: 'in', qty: 50, date: todayISO(), source: 'manual' }, { key: 'init-h', productId: 'ph', productName: 'Huile 5L', unit: 'bidon', type: 'in', qty: 20, date: todayISO(), source: 'manual' }]);
  });
  ok('stock initial : farine 50, huile 20', (await p.evaluate(() => stockLevel('pf'))) === 50 && (await p.evaluate(() => stockLevel('ph'))) === 20);
  const mkBl = (client, lines) => p.evaluate(async ([c, ls]) => {
    openDelivery(); document.getElementById('blClient').value = c; document.getElementById('blLines').innerHTML = '';
    ls.forEach(([pid, qty, desc]) => { addDeliveryLine(); const r = [...document.querySelectorAll('#blLines .pur-line')].pop(); if (pid) { r.querySelector('.pl-prod').value = pid; onDeliveryProduct(r.querySelector('.pl-prod')); } else r.querySelector('.pl-desc').value = desc; r.querySelector('.pl-qty').value = String(qty); });
    await saveDelivery(); return blList().slice(-1)[0];
  }, [client, lines]);
  // BL 1 : 10 farine + 1 transport (non suivi)
  const b1 = await mkBl('c1', [['pf', 10], ['ps', 1]]); await sleep(300);
  ok('BL enregistré : n° BL-AAAA-001, prix repris du produit', /^BL-\d{4}-001$/.test(b1.number) && b1.items[0].price === 100 && b1.items.length === 2, b1.number);
  ok('BL : le stock sort tout de suite (50 → 40), le service non suivi n\'a pas d\'effet', (await p.evaluate(() => stockLevel('pf'))) === 40);
  const mv = await be.sql("SELECT qty::float q, move_type t, ref FROM stock_movements WHERE source = 'delivery'");
  ok('serveur : mouvement « delivery » (sortie de 10)', mv.length === 1 && mv[0].q === 10 && mv[0].t === 'out' && mv[0].ref === b1.number, JSON.stringify(mv));
  // BL 2 même client : 5 huile ; BL 3 autre client
  const b2 = await mkBl('c1', [['ph', 5]]); const b3 = await mkBl('c2', [['pf', 2]]); await sleep(300);
  ok('liste : 3 BL « À facturer », badge = 3', /À facturer/.test(await p.innerText('#deliveriesList')) && (await p.innerText('#badgeDeliveries')).trim() === '3');
  // Facturer BL1 : propose de regrouper avec BL2 (même client), pas BL3
  await p.evaluate((id) => invoiceFromDeliveries(id), b1.id); await sleep(200);
  const pick = await p.evaluate(() => [...document.querySelectorAll('.bl-pick-cb')].map(c => c.value));
  ok('regroupement proposé : BL1 + BL2 (même client), pas le BL de l\'autre client', pick.length === 2 && pick.includes(b2.id) && !pick.includes(b3.id));
  await p.evaluate(() => document.querySelector('.bl-pick .btn-primary').click()); await sleep(500);
  const inv = await p.evaluate(() => editingInvoice);
  ok('facture brouillon : 3 lignes des 2 BL, totaux 1 000 + 50 + 300 HT', inv && inv.items.length === 3 && inv.totalHT === 1350 && inv.status === 'draft' && inv.items.every(i => i.fromDelivery), inv && JSON.stringify([inv.items.length, inv.totalHT]));
  ok('BL rattachés à la facture (plus « À facturer »)', await p.evaluate((ids) => ids.every(i => blList().find(d => d.id === i).invoiceId), [b1.id, b2.id]));
  // Ajout d'une ligne manuelle (huile 2) puis émission
  await p.evaluate(async () => { addItem({ description: 'Huile 5L', quantity: 2, price: 60, tva: 20 }); const row = document.getElementById('itemsBody').lastElementChild; currentPickerRowId = row.id; selectProductForItem('ph'); row.querySelector('.item-qty').value = 2; await saveInvoice('sent'); });
  await sleep(1200);
  const issued = await p.evaluate(() => Storage.get('invoices', []).find(i => i.deliveryIds));
  ok('facture émise avec un n° officiel ; les lignes BL gardent leur marque après passage dans l\'éditeur', issued && !String(issued.number).startsWith('BRO-') && issued.items.filter(i => i.fromDelivery).length === 3 && issued.items.filter(i => !i.fromDelivery).length === 1, issued && issued.number);
  ok('émission : AUCUNE double sortie pour les lignes BL (farine reste 38, huile 20−5−2 = 13)', (await p.evaluate(() => stockLevel('pf'))) === 38 && (await p.evaluate(() => stockLevel('ph'))) === 13, JSON.stringify(await p.evaluate(() => [stockLevel('pf'), stockLevel('ph')])));
  ok('serveur : une seule sortie « invoice » (la ligne ajoutée à la main)', (await be.sql("SELECT count(*)::int n FROM stock_movements WHERE source='invoice'"))[0].n === 1);
  ok('BL : n° officiel de la facture reporté', await p.evaluate((id) => blList().find(d => d.id === id).invoiceNumber === Storage.get('invoices', []).find(i => i.deliveryIds).number, b1.id));
  // BL facturé : suppression refusée
  await p.evaluate((id) => deleteDelivery(id), b1.id);
  ok('BL facturé : suppression refusée', await p.evaluate((id) => blList().some(d => d.id === id), b1.id));
  // BL non facturé : suppression = remise en stock
  await p.evaluate(async (id) => { await deleteDelivery(id); }, b3.id); await sleep(300);
  ok('BL non facturé supprimé : stock remis (38 → 40)', (await p.evaluate(() => stockLevel('pf'))) === 40 && !(await p.evaluate((id) => blList().some(d => d.id === id), b3.id)));
  // Brouillon depuis BL supprimé : BL redevient « à facturer »
  const b4 = await mkBl('c2', [['pf', 1]]); await p.evaluate((id) => createInvoiceFromDeliveries([id]), b4.id); await sleep(300);
  await p.evaluate(() => { const d = Storage.get('invoices', []).find(i => i.status === 'draft' && i.deliveryIds); deleteInvoice(d.id); });
  ok('brouillon supprimé : le BL redevient « à facturer »', await p.evaluate((id) => !blList().find(d => d.id === id).invoiceId, b4.id));
  // Devis → BL
  await p.evaluate(() => { Storage.set('quotes', [{ id: 'q1', number: 'DEV-2026-001', clientId: 'c2', clientName: 'Café Atlas', status: 'sent', items: [{ productId: 'ph', description: 'Huile 5L', quantity: 3, price: 55, tva: 20, totalHT: 165, totalTVA: 33, totalTTC: 198 }], totalTTC: 198 }]); navTo('quotes'); });
  ok('devis : bouton « 🚚 BL »', /🚚 BL/.test(await p.innerText('#page-quotes')));
  await p.evaluate(async () => { openDelivery('q1'); await saveDelivery(); }); await sleep(300);
  const b5 = await p.evaluate(() => blList().slice(-1)[0]);
  ok('BL depuis devis : lignes et prix du devis repris, devis lié et accepté', b5.sourceQuote === 'q1' && b5.items[0].quantity === 3 && b5.items[0].price === 55 && (await p.evaluate(() => Storage.get('quotes', [])[0].status)) === 'accepted');
  // Duplication d'une facture issue de BL : la copie déduira bien le stock
  ok('duplication : la marque BL n\'est pas recopiée', await p.evaluate(() => { duplicateInvoice(Storage.get('invoices', []).find(i => i.deliveryIds && i.status !== 'draft').id); return !getCurrentItems().some(i => i.fromDelivery); }));
  // Client avec BL : suppression refusée
  await p.evaluate(() => { navTo('deliveries'); deleteClient('c2'); });
  ok('client avec BL : suppression refusée', await p.evaluate(() => Storage.get('clients', []).some(c => c.id === 'c2')));
  // PDF
  const dl = p.waitForEvent('download'); await p.evaluate((id) => generateDeliveryPDF(id), b1.id); const f = await dl;
  ok('PDF du BL téléchargé (n° du BL)', /^BL-\d{4}-001\.pdf$/.test(f.suggestedFilename()) && fs.statSync(await f.path()).size > 3000, f.suggestedFilename());
  ok('page Stock : origine « BL »', await p.evaluate(async () => { navTo('stock'); setStockPeriod('month'); await renderStock(); return /BL BL-/.test(document.getElementById('stockMoves').innerText); }));
  ok('injection : nom de client échappé', await p.evaluate(() => { const ds = blList(); ds[0].clientName = '<img src=x onerror=window.__x=1>'; Storage.set('deliveries', ds); navTo('deliveries'); return !document.querySelector('#deliveriesList img') && !window.__x; }));
  if (process.env.SHOT_DIR) { await p.evaluate(() => { const ds = blList(); ds[0].clientName = 'Épicerie Nour'; Storage.set('deliveries', ds); renderDeliveries(); }); await sleep(300); await p.screenshot({ path: process.env.SHOT_DIR + '/bl-liste.png', fullPage: true, animations: 'disabled' }); fs.copyFileSync(await f.path(), process.env.SHOT_DIR + '/bl.pdf'); }
  await browser.close(); srv.close(); try { dropDb(db); } catch (e) {}
  const n = R_.filter(Boolean).length; console.log(`\n${n === R_.length ? 'OK' : 'ÉCHEC'} : ${n}/${R_.length} contrôles (bons de livraison)`); process.exit(n === R_.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
