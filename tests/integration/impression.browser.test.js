// Impression directe (facture, devis, BL) et nettoyage des jetons de connexion dans la barre d'adresse. SIMULATION locale.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8267;
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
  await p.fill('#signupEmail', `imp-${process.pid}@facturapro-test.invalid`); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500);
  if (!(await p.isVisible('#mainApp'))) {
    await p.evaluate(() => selectStatus(document.querySelector('[onclick*="selectStatus"]').getAttribute('onclick').match(/'(.*?)'/)[1])); await p.evaluate(() => onboardingNext(1));
    await p.fill('#onbCompanyName', 'Atelier Atlas SARL'); await p.fill('#onbICE', '001234567000089'); await p.evaluate(() => onboardingNext(2));
    await p.fill('#onbBank', 'Banque test'); await p.fill('#onbRIB', '007 780 0001234567890123 45'); await p.evaluate(() => finishOnboarding()); await sleep(1800);
  }
  await p.evaluate(() => { Storage.set('clients', [{ id: 'c1', name: 'Color Printing Center' }]); });
  const fid = await p.evaluate(async () => { navTo('invoices'); newInvoice(); document.getElementById('editorClient').value = 'c1'; document.getElementById('itemsBody').innerHTML = '';
    addItem({ description: 'Impression', quantity: 1, price: 500, tva: 20 }); await saveInvoice('sent'); return editingInvoice.id; });
  await sleep(1200);
  await p.evaluate(() => navTo('invoices')); await sleep(500);
  ok('liste des factures : bouton « 🖨️ Imprimer »', await p.evaluate(() => /printDocument\('invoice'/.test(document.getElementById('page-invoices').innerHTML)));
  // Ordinateur : cadre caché + boîte d'impression
  const desk = await p.evaluate(async (id) => {
    let printed = 0; const orig = HTMLIFrameElement.prototype;
    await printDocument('invoice', id);
    const f = document.querySelector('iframe.fp-print');
    if (!f) return { f: false };
    const src = f.src; const b = await (await fetch(src)).blob(); const head = await b.slice(0, 5).text();
    return { f: true, blob: /^blob:/.test(src), pdf: head === '%PDF-', hidden: f.style.visibility === 'hidden' };
  }, fid);
  ok('ordinateur : PDF chargé dans un cadre invisible pour impression', desk.f && desk.blob && desk.pdf && desk.hidden, JSON.stringify(desk));
  // Téléphone : nouvel onglet ouvert tout de suite puis dirigé vers le PDF
  const mob = await p.evaluate(async (id) => {
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Linux; Android 14) Mobile', configurable: true });
    const tab = { closed: false, location: { href: '' }, close() { this.closed = true; } }; let opened = 0;
    const o = window.open; window.open = () => { opened++; return tab; };
    await printDocument('invoice', id); window.open = o;
    return { opened, href: tab.location.href };
  }, fid);
  ok('téléphone : un onglet ouvert, PDF affiché pour impression', mob.opened === 1 && /^blob:/.test(mob.href), JSON.stringify(mob));
  ok('BL : génération du PDF sans téléchargement disponible pour l\'impression', await p.evaluate(() => typeof generateDeliveryPDF === 'function' && generateDeliveryPDF.length === 2 && /printDocument\('delivery'/.test(String(renderDeliveries))));
  // Jetons de connexion dans l'adresse
  await p.evaluate(() => { history.replaceState(null, '', location.pathname + '#access_token=abc.def.ghi&refresh_token=xyz&type=signup'); stripAuthHash(); });
  await sleep(2000);
  ok('jetons de connexion retirés de la barre d\'adresse', await p.evaluate(() => !/access_token|refresh_token/.test(location.href)), await p.evaluate(() => location.href));
  await p.evaluate(() => { history.replaceState(null, '', location.pathname + '#page=invoices'); stripAuthHash(); }); await sleep(1800);
  ok('ancre ordinaire conservée', await p.evaluate(() => location.hash === '#page=invoices'));

  const nOk = R_.filter(Boolean).length;
  console.log(`${nOk === R_.length ? 'OK' : 'ECHEC'} : ${nOk}/${R_.length} contrôles (impression, SIMULATION locale)`);
  await browser.close(); srv.close(); dropDb(db); process.exit(nOk === R_.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
