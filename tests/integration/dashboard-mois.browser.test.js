// Accueil : bloc « Ce mois-ci » (encaissé vs mois précédent, objectif, reste à encaisser). SIMULATION locale (faux client Supabase + PostgreSQL local), aucune donnée réelle.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8241;
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
  const db = createDb(); const be = makeBackend(db);
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
  await p.fill('#signupEmail', `mois-${process.pid}@facturapro-test.invalid`); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500);
  await p.evaluate(() => finishOnboarding()); await sleep(1800);
  ok('sans facture : bloc « Ce mois-ci » masqué', (await p.innerHTML('#monthCard')).trim() === '');
  const iso = (dy, dd) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + dy); d.setDate(dd); return d.toISOString().slice(0, 10); };
  await p.evaluate(([cur, prev]) => {
    Storage.set('invoices', [
      { id: 'i1', number: 'T-1', clientName: 'A', date: cur, totalTTC: 1500, status: 'paid', paidAt: cur },
      { id: 'i2', number: 'T-2', clientName: 'B', date: prev, totalTTC: 1000, status: 'paid', paidAt: prev },
      { id: 'i3', number: 'T-3', clientName: 'C', date: cur, totalTTC: 800, status: 'sent' }
    ]);
    Storage.set('payments', []); renderDashboard();
  }, [iso(0, 1), iso(-1, 15)]);
  const t = await p.innerText('#monthCard');
  ok('encaissé du mois = 1 500 DH', /1\s?500,00/.test(await p.innerText('#mcCollected')), await p.innerText('#mcCollected'));
  ok('comparaison au mois précédent : +50 %', /\+50 %/.test(t), t.replace(/\s+/g, ' ').slice(0, 160));
  ok('reste à encaisser = 800 DH', /800,00/.test(await p.innerText('#mcPending')));
  await p.fill('#monthlyGoalInput', '3000'); await p.dispatchEvent('#monthlyGoalInput', 'change'); await sleep(200);
  ok('objectif 3 000 DH : progression 50 %', /50 %/.test(await p.innerText('#monthCard')) && /width:\s*50%/.test(await p.getAttribute('#mcBar', 'style')));
  ok('objectif mémorisé après rechargement de l\'écran', await p.evaluate(() => { renderDashboard(); return document.getElementById('monthlyGoalInput').value; }) === '3000');
  await p.evaluate(() => Storage.set('payments', [{ id: 'p1', invoiceId: 'i3', amount: 300, date: new Date().toISOString().slice(0, 10) }])); await p.evaluate(() => renderDashboard());
  ok('paiement partiel pris en compte (1 800 encaissés, 500 restants)', /1\s?800,00/.test(await p.innerText('#mcCollected')) && /500,00/.test(await p.innerText('#mcPending')), await p.innerText('#mcCollected') + ' / ' + await p.innerText('#mcPending'));
  await browser.close(); srv.close(); try { dropDb(db); } catch (e) {}
  const n = R_.filter(Boolean).length; console.log(`\n${n === R_.length ? 'OK' : 'ÉCHEC'} : ${n}/${R_.length} contrôles (accueil, ce mois-ci)`); process.exit(n === R_.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
