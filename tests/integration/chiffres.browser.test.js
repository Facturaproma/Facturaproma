// Accueil : bloc « Ce mois-ci » (encaissé vs mois précédent, objectif, reste à encaisser). SIMULATION locale (faux client Supabase + PostgreSQL local), aucune donnée réelle.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8253;
const srv = http.createServer((q, r) => {
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
  await p.fill('#signupEmail', `chiffres-${process.pid}@facturapro-test.invalid`); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500);
  await p.evaluate(() => finishOnboarding()); await sleep(1800);
  // Données : facture du mois dernier payée ce mois-ci ; facture + avoir ce mois-ci ; ancienne ligne à 14 %
  await p.evaluate(() => {
    const d = new Date(), cur = d.toISOString().slice(0, 10), y = d.getFullYear(), m = d.getMonth();
    const prev = new Date(y, m - 1, 15, 12).toISOString().slice(0, 10);
    Storage.set('clients', [{ id: 'c1', name: 'Client Un' }]);
    Storage.set('invoices', [
      { id: 'i1', number: 'FAC-T-1', clientId: 'c1', clientName: 'Client Un', date: prev, dueDate: prev, totalHT: 1000, totalTVA: 200, totalTTC: 1200, status: 'paid', paidAt: cur, items: [] },
      { id: 'i2', number: 'FAC-T-2', clientId: 'c1', clientName: 'Client Un', date: cur, dueDate: cur, totalHT: 500, totalTVA: 100, totalTTC: 600, status: 'sent', items: [] },
      { id: 'a2', number: 'AV-T-1', type: 'credit', relatedInvoiceId: 'i2', clientId: 'c1', clientName: 'Client Un', date: cur, dueDate: cur, totalHT: -500, totalTVA: -100, totalTTC: -600, status: 'sent', items: [] },
      { id: 'i3', number: 'FAC-T-3', clientId: 'c1', clientName: 'Client Un', date: cur, dueDate: cur, totalHT: 300, totalTVA: 60, totalTTC: 360, status: 'sent', items: [] },
      { id: 'd1', number: 'BRO-XYZ', clientId: 'c1', clientName: 'Client Un', date: cur, dueDate: cur, totalHT: 9000, totalTVA: 0, totalTTC: 9000, status: 'draft', items: [{ description: 'Ancien', quantity: 1, price: 100, tva: 14, discount: 0, totalHT: 100, totalTVA: 14, totalTTC: 114 }] }
    ]);
    Storage.set('payments', [{ id: 'p1', invoiceId: 'i1', date: cur, amount: 1200, method: 'virement' }]);
  });
  // Rapport Cash Flow, période « ce mois »
  const cf = await p.evaluate(() => { navTo('reports'); const s = document.getElementById('reportPeriod'); if (s) s.value = 'month'; renderReportCashflow(); return { rec: document.getElementById('rpCfReceived').textContent, bil: document.getElementById('rpCfBilled').textContent }; });
  ok('Cash Flow : encaissé = paiement de CE mois (1 200) même si la facture date du mois dernier', /1\s?200,00/.test(cf.rec), cf.rec);
  ok('Cash Flow : facturé = 600 + 360 − 600 (avoir) = 360 ; brouillon exclu', /^360,00/.test(cf.bil.trim()), cf.bil);
  // Tableau de bord
  await p.evaluate(() => { navTo('dashboard'); renderDashboard(); });
  const enc = await p.innerText('#statRevenuePaid');
  const sameYear = await p.evaluate(() => new Date(new Date().getFullYear(), new Date().getMonth() - 1, 15).getFullYear() === new Date().getFullYear());
  ok('Accueil : « CA encaissé » de l\'année compté à la date du paiement', /1\s?200/.test(enc), enc + (sameYear ? '' : ' (janvier)'));
  const bars = await p.evaluate(() => [...document.querySelectorAll('#caChart .chart-bar')].map(b => b.getAttribute('title')));
  ok('Graphique CA : HT par date d\'émission, avoir déduit (mois courant 300 HT, mois précédent 1 000 HT)', /^300,00/.test(bars.at(-1)) && /^1\s?000,00/.test(bars.at(-2)), JSON.stringify(bars.slice(-2)));
  ok('Graphique CA : titre explicite (facturé HT)', /facturé HT/.test(await p.innerText('#page-dashboard')));
  // TVA : nouvelles lignes
  const opts = await p.evaluate(() => { navTo('invoices'); newInvoice(); document.getElementById('itemsBody').innerHTML = ''; addItem(); return [...document.querySelectorAll('#itemsBody tr:last-child .item-tva option')].map(o => o.value); });
  ok('nouvelle ligne de facture : taux 0, 10, 20 seulement (plus de 7 ni 14), 20 par défaut', JSON.stringify(opts) === '["0","10","20"]' && (await p.evaluate(() => document.querySelector('#itemsBody tr:last-child .item-tva').value)) === '20', JSON.stringify(opts));
  const old = await p.evaluate(() => { editInvoice('d1'); const s = document.querySelector('#itemsBody tr .item-tva'); return { v: s.value, t: s.options[s.selectedIndex].textContent }; });
  ok('brouillon ancien à 14 % : taux conservé et signalé « ancien taux »', old.v === '14' && /ancien taux/.test(old.t), JSON.stringify(old));
  // Produit à 0 % : reste à 0 %
  await p.evaluate(() => { Storage.set('products', [{ id: 'z', name: 'Service exonéré', price: 100, tva: 0 }]); navTo('invoices'); newInvoice(); document.getElementById('itemsBody').innerHTML = ''; addItem(); currentPickerRowId = document.getElementById('itemsBody').lastElementChild.id; selectProductForItem('z'); });
  ok('produit à 0 % choisi dans une facture : la ligne reste à 0 % (avant : 20 %)', (await p.evaluate(() => document.querySelector('#itemsBody tr:last-child .item-tva').value)) === '0');
  ok('fiche produit à 0 % : affichée à 0 %', await p.evaluate(() => { editProduct('z'); const v = document.getElementById('modalProductTVA').value; closeModal('productModal'); return v === '0'; }));
  ok('fiche produit : plus de 7 % ni 14 % proposés', await p.evaluate(() => { newProduct(); const o = [...document.getElementById('modalProductTVA').options].map(x => x.value).join(','); closeModal('productModal'); return o === '0,10,20'; }));
  ok('ligne d\'achat : taux 0, 10, 20', await p.evaluate(() => { document.getElementById('purLines').innerHTML = ''; addPurchaseLine(); return [...document.querySelectorAll('#purLines .pl-tva option')].map(o => o.value).join(',') === '0,10,20'; }));
  await browser.close(); srv.close(); try { dropDb(db); } catch (e) {}
  const n = R_.filter(Boolean).length; console.log(`\n${n === R_.length ? 'OK' : 'ÉCHEC'} : ${n}/${R_.length} contrôles (chiffres : dates, avoirs, TVA 2026)`); process.exit(n === R_.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
