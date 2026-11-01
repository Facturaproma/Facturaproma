// Annulation d'un paiement saisi par erreur : ligne inverse (montant négatif) rattachée, facture repasse « à payer », trésorerie, créances, pilotage et journaux corrigés ; double annulation refusée ; plafond toujours appliqué. Compte de test jetable.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8261;
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
  await p.fill('#signupEmail', `pya-${process.pid}@facturapro-test.invalid`); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500);
  if (!(await p.isVisible('#mainApp'))) {
    await p.evaluate(() => selectStatus(document.querySelector('[onclick*="selectStatus"]').getAttribute('onclick').match(/'(.*?)'/)[1])); await p.evaluate(() => onboardingNext(1));
    await p.fill('#onbCompanyName', 'Atelier Atlas SARL'); await p.fill('#onbICE', '001234567000089'); await p.evaluate(() => onboardingNext(2));
    await p.fill('#onbBank', 'Banque test'); await p.fill('#onbRIB', '007 780 0001234567890123 45'); await p.evaluate(() => finishOnboarding()); await sleep(1800);
  }
  await p.evaluate(() => stockRefreshLevels());
  await p.evaluate(() => { Storage.set('clients', [{ id: 'c1', name: 'Client Test', createdAt: new Date().toISOString() }]); });
  const level = (id) => p.evaluate((i) => stockLevel(i), id);

  await p.evaluate(() => {
    Storage.set('products', [{ id: 'ps', name: 'Prestation', price: 1000, tva: 20 }]);
    Storage.set('clients', [{ id: 'c1', name: 'Épicerie Nour' }]);
    window.__t = []; const o = showToast; showToast = (m, t) => { window.__t.push(String(m)); return o(m, t); }; window.confirm = () => true;
  });
  await sleep(600);
  const T = () => p.evaluate(() => window.__t[window.__t.length - 1] || '');
  const today = await p.evaluate(() => todayISO());
  await p.evaluate(async (d) => { await supaClient.rpc('cash_account_create', { p: { name: 'Caisse', kind: 'cash', opening_balance: 0, opening_date: d } }); }, today.slice(0, 8) + '01');
  const fid = await p.evaluate(async () => { navTo('invoices'); newInvoice(); document.getElementById('editorClient').value = 'c1'; document.getElementById('itemsBody').innerHTML = '';
    addItem({ description: 'Prestation', quantity: 1, price: 1000, tva: 20 }); await saveInvoice('sent'); return editingInvoice.id; });
  await sleep(1500);
  const pay = (amt) => p.evaluate(async ([id, a]) => { navTo('payments'); recordPayment(); await new Promise(r => setTimeout(r, 500)); document.getElementById('paymentInvoice').value = id; document.getElementById('paymentAmount').value = String(a); document.getElementById('paymentMethod').value = 'especes'; document.getElementById('paymentMethod').onchange(); savePayment(); }, [fid, amt]);
  await pay(1200); await sleep(1500);
  const st = () => p.evaluate((id) => { const i = Storage.get('invoices', []).find(x => x.id === id); return { status: i.status, rest: invoiceRemaining(getInvoiceWithStatus(i), Storage.get('payments', [])) }; }, fid);
  const bal = () => p.evaluate(async () => { const r = await supaClient.rpc('cash_balances', { p_date: null }); return Number((r.data || []).find(x => x.name === 'Caisse').balance); });
  ok('paiement de 1 200 : facture payée, Caisse 1 200', (await st()).status === 'paid' && (await bal()) === 1200);
  await p.evaluate(() => { navTo('payments'); renderPayments(); });
  ok('historique : bouton « Annuler » sur le paiement', /Annuler/.test(await p.innerText('#paymentsHistoryList')));
  const payId = await p.evaluate(() => Storage.get('payments', [])[0].id);
  await p.evaluate((id) => { window.prompt = () => ''; reversePayment(id); }, payId);
  ok('annulation sans motif : refusée', /Motif obligatoire/.test(await T()) && (await p.evaluate(() => Storage.get('payments', []).length)) === 1);
  await p.evaluate((id) => { window.prompt = () => 'Mauvaise facture'; reversePayment(id); }, payId); await sleep(1800);
  const pays = await p.evaluate(() => Storage.get('payments', []));
  ok('annulation : ligne inverse −1 200 rattachée, même compte, datée du jour', pays.length === 2 && pays[1].amount === -1200 && pays[1].reversesId === payId && pays[1].accountId === pays[0].accountId && pays[1].date === today, JSON.stringify(pays[1]));
  ok('facture repassée « à payer », reste 1 200', JSON.stringify(await st()) === JSON.stringify({ status: 'sent', rest: 1200 }), JSON.stringify(await st()));
  ok('serveur : les deux lignes enregistrées (aucune suppression)', (await be.sql("SELECT jsonb_array_length(value) n FROM user_data WHERE key = 'payments'"))[0].n === 2);
  ok('trésorerie : Caisse revenue à 0', (await bal()) === 0);
  const s = await p.evaluate(async (d) => (await supaClient.rpc('fin_summary', { p_from: d.slice(0, 8) + '01', p_to: d })).data, today);
  ok('pilotage : encaissé net 0, créances 1 200', Number(s.collections) === 0 && Number(s.receivables) === 1200, JSON.stringify([s.collections, s.receivables]));
  const h = await p.innerText('#paymentsHistoryList');
  ok('historique : paiement barré « annulé », ligne « Annulation de paiement », plus de bouton', /annulé/.test(h) && /Annulation de paiement/.test(h) && !/↩️ Annuler/.test(h), h.slice(0, 300));
  await p.evaluate((id) => { window.prompt = () => 'encore'; reversePayment(id); }, payId);
  ok('double annulation : refusée', /déjà annulé/.test(await T()) && (await p.evaluate(() => Storage.get('payments', []).length)) === 2);
  const tj = await p.evaluate(async () => { navTo('treasury'); await renderTreasury(); return document.getElementById('treJournal').innerText; });
  ok('journal de trésorerie : l\'annulation apparaît en sortie (−1 200)', /−1\s?200[.,]00/.test(tj), tj.slice(0, 300));
  await pay(1200); await sleep(1500);
  ok('nouveau paiement correct de 1 200 : accepté, facture payée', (await st()).status === 'paid' && (await bal()) === 1200);
  await pay(1); await sleep(800);
  ok('plafond toujours appliqué : 1 DH de plus refusé', (await p.evaluate(() => Storage.get('payments', []).length)) === 3 && (await st()).status === 'paid', await T());
  await browser.close(); srv.close(); try { dropDb(db); } catch (e) {}
  const n = R_.filter(Boolean).length; console.log(`\n${n === R_.length ? 'OK' : 'ÉCHEC'} : ${n}/${R_.length} contrôles (annulation de paiement)`); process.exit(n === R_.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
