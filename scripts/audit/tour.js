// Tour visuel de l'application : captures de chaque page (ordinateur, tablette, mobile) avec un compte de démonstration fictif, base locale.
// Usage : FRAMES_DIR=<dossier> node scripts/audit/tour.js   (sert au contrôle visuel avant / après une refonte)
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('../../tests/integration/backend');
const FAKE = fs.readFileSync(path.join(R, 'tests', 'integration', 'fake_supabase.js'), 'utf8');
const PORT = 8291;
const srv = http.createServer((q, r) => {
  let u = '/'; try { u = decodeURIComponent(q.url.split('?')[0]); } catch (e) { r.writeHead(400); return r.end(); }
  const f = path.resolve(R, '.' + path.posix.normalize('/' + (u === '/' ? 'index.html' : u)));
  if (f !== R && !f.startsWith(R + path.sep)) { r.writeHead(403); return r.end(); }
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } let body = d;
    if (/(app|admin)\.html$/.test(f)) body = d.toString('utf8').replace(/^const SUPABASE_URL = .*$/m, "const SUPABASE_URL = 'https://fake.supabase.test';").replace(/^const SUPABASE_ANON_KEY = .*$/m, "const SUPABASE_ANON_KEY = 'fake-anon-key';").replace(/ integrity="[^"]*" crossorigin="anonymous"/g, '');
    const t = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.ttf': 'font/ttf', '.png': 'image/png', '.css': 'text/css', '.woff2': 'font/woff2' }[path.extname(f)] || 'application/octet-stream';
    r.writeHead(200, { 'content-type': t }); r.end(body); });
}).listen(PORT);
const nm = (...s) => path.join(R, 'node_modules', ...s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const OUT = process.env.FRAMES_DIR || path.join(require('os').tmpdir(), 'fp-tour');
  fs.mkdirSync(OUT, { recursive: true });
  const db = createDb({ stock: true }); const be = makeBackend(db);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const mk = async (vw, vh) => {
    const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1, serviceWorkers: 'block', locale: 'fr-FR' }); const p = await ctx.newPage();
    p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200))); p.on('dialog', (d) => d.accept());
    await p.exposeFunction('__srv', (op, args) => be.handle(op, args));
    await p.route(/jsdelivr.*supabase/, (r) => r.fulfill({ body: FAKE, contentType: 'text/javascript' }));
    await p.route('**/jspdf.umd.min.js', (r) => r.fulfill({ path: nm('jspdf', 'dist', 'jspdf.umd.min.js'), contentType: 'text/javascript' }));
    await p.route('**/jspdf.plugin.autotable.min.js', (r) => r.fulfill({ path: nm('jspdf-autotable', 'dist', 'jspdf.plugin.autotable.min.js'), contentType: 'text/javascript' }));
    if (!process.env.TOUR_FONTS) await p.route(/googleapis|gstatic|hcaptcha/, (r) => r.abort()); else await p.route(/hcaptcha/, (r) => r.abort());
    return { ctx, p };
  };
  const EMAIL = `tour-${process.pid}@facturapro-test.invalid`, PASS = 'Demo#12345';
  // ---- compte de démonstration (fictif), créé sur ordinateur ----
  let { ctx, p } = await mk(1440, 900);
  await p.goto(`http://localhost:${PORT}/app.html?mode=login`); await sleep(900);
  await p.screenshot({ path: path.join(OUT, 'desktop-00-connexion.png') });
  await p.click('[data-tab=signup]'); await sleep(200);
  await p.screenshot({ path: path.join(OUT, 'desktop-00-inscription.png') });
  await p.fill('#signupEmail', EMAIL); await p.fill('#signupPassword', PASS); await p.fill('#signupConfirm', PASS); await p.click('#signupBtn'); await sleep(2500);
  if (!(await p.isVisible('#mainApp'))) {
    await p.screenshot({ path: path.join(OUT, 'desktop-00-onboarding.png') });
    await p.evaluate(() => selectStatus(document.querySelector('[onclick*="selectStatus"]').getAttribute('onclick').match(/'(.*?)'/)[1])); await p.evaluate(() => onboardingNext(1));
    await p.fill('#onbCompanyName', 'Atelier Atlas SARL'); await p.fill('#onbICE', '001234567000089'); await p.evaluate(() => onboardingNext(2));
    await p.fill('#onbBank', 'Banque Exemple'); await p.fill('#onbRIB', '007 780 0001234567890123 45'); await p.evaluate(() => finishOnboarding()); await sleep(1800);
  }
  await p.evaluate(async () => {
    Storage.set('guideSeen', true);
    const c = Storage.get('company', {}) || {}; Object.assign(c, { if: '33666706', rc: '445566 Casablanca', address: '12 rue des Orangers', city: 'Casablanca', phone: '05 22 00 00 00', email: 'contact@atelier-atlas.example' }); Storage.set('company', c);
    Storage.set('products', [{ id: 'p1', name: 'Entretien machine à café', price: 1500, tva: 20, unit: 'forfait' }, { id: 'p2', name: 'Capsules café (boîte)', price: 45, tva: 20, unit: 'boîte' },
      { id: 'p3', name: 'Installation et mise en service', price: 3200, tva: 20, unit: 'forfait' }, { id: 'p4', name: 'Filtre à eau', price: 180, tva: 20, unit: 'pièce' }]);
    const cl = (id, name, city, ice) => ({ id, kind: 'societe', name, ice, if: '4567' + id.slice(1) + '912', rc: '1122' + id.slice(1) + ' ' + city, address: '24 bd Zerktouni', city, phone: '06 61 00 00 0' + id.slice(1), email: '' });
    Storage.set('clients', [cl('c1', 'Café Nour', 'Casablanca', '001122334455667'), cl('c2', 'Riad Yasmine', 'Marrakech', '002233445566778'), cl('c3', 'Boulangerie El Fath', 'Rabat', '003344556677889'), cl('c4', 'Hôtel Les Palmiers', 'Agadir', '004455667788990')]);
    Storage.set('suppliers', [{ id: 's1', kind: 'societe', name: 'Grossiste Café Maroc', if: '1620155', ice: '000094033000084', address: 'Zone industrielle', city: 'Casablanca', phone: '05 22 11 11 11' }]);
  });
  const mkInv = async (clientId, items, status, daysAgo, dueIn) => {
    await p.evaluate(() => { navTo('invoices'); newInvoice(); }); await sleep(350);
    await p.selectOption('#editorClient', clientId);
    await p.evaluate(([items, daysAgo, dueIn]) => { document.getElementById('itemsBody').innerHTML = ''; items.forEach(i => addItem(i));
      const d = new Date(); d.setDate(d.getDate() - daysAgo); const iso = d.toISOString().slice(0, 10); const dt = document.getElementById('editorDate'); if (dt) { dt.value = iso; dt.dispatchEvent(new Event('change')); }
      const du = document.getElementById('editorDueDate'); if (du) { const e = new Date(d); e.setDate(e.getDate() + dueIn); du.value = e.toISOString().slice(0, 10); } }, [items, daysAgo, dueIn]);
    await p.evaluate(async (st) => { await saveInvoice(st); }, status); await sleep(900);
    await p.evaluate(() => document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active')));
  };
  const L = (description, quantity, price) => ({ description, quantity, price, tva: 20 });
  await mkInv('c1', [L('Entretien machine à café', 1, 1500), L('Capsules café (boîte)', 10, 45)], 'sent', 3, 30);
  await mkInv('c2', [L('Installation et mise en service', 1, 3200)], 'sent', 2, 30);
  await mkInv('c3', [L('Filtre à eau', 6, 180)], 'sent', 1, 15);
  await mkInv('c4', [L('Entretien machine à café', 2, 1500), L('Filtre à eau', 2, 180)], 'sent', 0, 30);
  await mkInv('c1', [L('Capsules café (boîte)', 40, 45)], 'draft', 0, 30);
  // paiement de la première, devis, achat
  const fid = await p.evaluate(() => (Storage.get('invoices', []).find(i => i.clientId === 'c1' && i.status !== 'draft') || {}).id);
  if (fid) {
    await p.evaluate(() => { navTo('payments'); recordPayment(); }); await sleep(400);
    await p.evaluate((id) => { const s = document.getElementById('paymentInvoice'); s.value = id; s.dispatchEvent(new Event('change')); document.getElementById('paymentMethod').value = 'virement'; }, fid); await sleep(200);
    await p.fill('#paymentAmount', '2340'); await p.evaluate(() => savePayment()); await sleep(1200);
    await p.evaluate(() => document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active')));
  }
  await p.evaluate(async () => {
    try { navTo('quotes'); newQuote(); await new Promise(r => setTimeout(r, 350)); document.getElementById('editorClient').value = 'c2'; document.getElementById('itemsBody').innerHTML = '';
      addItem({ description: 'Contrat d\'entretien annuel', quantity: 1, price: 9600, tva: 20 }); await saveInvoice('sent'); } catch (e) { console.log('devis', e.message); }
    await new Promise(r => setTimeout(r, 800)); document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
    try {
      const today = todayISO();
      await supaClient.rpc('cash_account_create', { p: { key: 't-b', name: 'Banque', kind: 'bank', opening_balance: 25000, opening_date: today.slice(0, 8) + '01' } });
      await supaClient.rpc('cash_account_create', { p: { key: 't-c', name: 'Caisse', kind: 'cash', opening_balance: 1500, opening_date: today.slice(0, 8) + '01' } });
      const r = await supaClient.rpc('purchase_record', { p: { key: 't-p1', supplier_id: 's1', supplier_name: 'Grossiste Café Maroc', supplier_ref: 'FA-2291', date: today,
        lines: [{ nature: 'expense', category: 'Fournitures', description: 'Capsules en gros', qty: 1, unit_price: 2400, tva_rate: 20 }] } });
      await supaClient.rpc('purchase_record', { p: { key: 't-p2', supplier_id: 's1', supplier_name: 'Grossiste Café Maroc', supplier_ref: 'FA-2305', date: today,
        lines: [{ nature: 'expense', category: 'Loyer', description: 'Loyer atelier', qty: 1, unit_price: 4000, tva_rate: 20 }] } });
      await cashLoadAccounts(true); await purLoad(true);
      if (r.data) await supaClient.rpc('supplier_settle', { p: { purchase_id: r.data.id, account_id: cashActive()[0].id, date: today, amount: 2880, mode: 'virement' } });
      await purLoad(true);
    } catch (e) { console.log('achats', e.message); }
  });
  await sleep(800);
  await ctx.storageState({ path: path.join(OUT, 'state.json') });

  const PAGES = ['dashboard', 'invoices', 'quotes', 'deliveries', 'clients', 'products', 'stock', 'purchases', 'payments', 'treasury', 'pilotage', 'reminders', 'reports', 'cnss', 'taxes', 'company', 'messages', 'license'];
  const tour = async (label, p) => {
    let i = 1;
    const snap = async (name, full = true) => { await p.screenshot({ path: path.join(OUT, `${label}-${String(i++).padStart(2, '0')}-${name}.png`), fullPage: full }); };
    for (const pg of PAGES) {
      await p.evaluate((x) => { document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active')); navTo(x); window.scrollTo(0, 0); }, pg); await sleep(pg === 'dashboard' || pg === 'pilotage' || pg === 'taxes' ? 1300 : 700);
      await snap(pg);
    }
    await p.evaluate(() => { navTo('invoices'); newInvoice(); }); await sleep(500);
    await p.evaluate(() => { document.getElementById('editorClient').value = 'c3'; document.getElementById('itemsBody').innerHTML = ''; addItem({ description: 'Entretien machine à café', quantity: 1, price: 1500, tva: 20 }); addItem({ description: 'Filtre à eau', quantity: 3, price: 180, tva: 20 }); });
    await sleep(300); await snap('editeur-facture');
    await p.evaluate(() => { navTo('clients'); newClient(); }); await sleep(400); await snap('modale-client', false);
    await p.evaluate(() => { document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active')); navTo('payments'); recordPayment(); }); await sleep(400); await snap('modale-paiement', false);
    await p.evaluate(() => { document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active')); navTo('purchases'); if (typeof newPurchase === 'function') newPurchase(); }); await sleep(500); await snap('modale-achat', false);
    await p.evaluate(() => { document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active')); navTo('dashboard'); if (typeof toggleSidebar === 'function' && window.innerWidth < 1000) toggleSidebar(); }); await sleep(400);
    if (label !== 'desktop') await snap('menu', false);
  };
  await p.evaluate(() => navTo('dashboard')); await sleep(600);
  await tour('desktop', p);
  // PDF réels (facture, devis)
  for (const [kind, key] of [['invoice', 'invoices'], ['quote', 'quotes']]) {
    try {
      const id = await p.evaluate((k) => ((Storage.get(k, []) || []).find(x => x.status !== 'draft') || {}).id, key);
      if (!id) continue;
      const b64 = await p.evaluate(async ([id, kind]) => { const r = await generatePDF(id, kind, { asBlob: true }); const b = new Uint8Array(await r.blob.arrayBuffer()); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); }, [id, kind]);
      const f = path.join(OUT, `pdf-${kind}.pdf`); fs.writeFileSync(f, Buffer.from(b64, 'base64'));
      require('child_process').execFileSync('pdftoppm', ['-png', '-r', '80', '-f', '1', '-l', '1', f, path.join(OUT, `pdf-${kind}`)]);
    } catch (e) { console.log('pdf', kind, e.message); }
  }
  await ctx.close();
  for (const [label, w, h] of [['tablette', 820, 1180], ['mobile', 390, 844]]) {
    const c2 = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, serviceWorkers: 'block', locale: 'fr-FR', storageState: path.join(OUT, 'state.json'), isMobile: label === 'mobile', hasTouch: true });
    const q = await c2.newPage(); q.on('pageerror', (e) => console.log('PAGEERROR', label, e.message.slice(0, 200))); q.on('dialog', (d) => d.accept());
    await q.exposeFunction('__srv', (op, args) => be.handle(op, args));
    await q.route(/jsdelivr.*supabase/, (r) => r.fulfill({ body: FAKE, contentType: 'text/javascript' }));
    await q.route('**/jspdf.umd.min.js', (r) => r.fulfill({ path: nm('jspdf', 'dist', 'jspdf.umd.min.js'), contentType: 'text/javascript' }));
    await q.route('**/jspdf.plugin.autotable.min.js', (r) => r.fulfill({ path: nm('jspdf-autotable', 'dist', 'jspdf.plugin.autotable.min.js'), contentType: 'text/javascript' }));
    if (!process.env.TOUR_FONTS) await q.route(/googleapis|gstatic|hcaptcha/, (r) => r.abort()); else await q.route(/hcaptcha/, (r) => r.abort());
    await q.goto(`http://localhost:${PORT}/app.html`); await sleep(2500);
    if (!(await q.isVisible('#mainApp'))) { try { await q.fill('#loginEmail', EMAIL); await q.fill('#loginPassword', PASS); await q.click('#loginBtn'); await sleep(2500); } catch (e) { console.log('login', label, e.message.slice(0, 120)); } }
    await tour(label, q);
    if (label === 'mobile') { await q.goto(`http://localhost:${PORT}/index.html`); await sleep(1200); await q.screenshot({ path: path.join(OUT, 'mobile-accueil.png'), fullPage: true }); }
    await c2.close();
  }
  const c3 = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' }); const h = await c3.newPage();
  if (!process.env.TOUR_FONTS) await h.route(/googleapis|gstatic/, (r) => r.abort());
  await h.goto(`http://localhost:${PORT}/index.html`); await sleep(1200); await h.screenshot({ path: path.join(OUT, 'desktop-accueil.png'), fullPage: true });
  await browser.close(); srv.close(); dropDb(db);
  console.log('captures :', fs.readdirSync(OUT).filter(f => f.endsWith('.png')).length, '→', OUT);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
