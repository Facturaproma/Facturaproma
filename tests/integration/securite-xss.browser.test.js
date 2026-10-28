// Sécurité : injection HTML/JS stockée via des noms, descriptions et identifiants hostiles (OWASP A03).
// Preuve avant/après : sans correctif, un nom de client « L'Atelier » casse le bouton 📱 et une description avec un guillemet est tronquée ;
// un nom piégé exécute du code. SIMULATION locale (faux Supabase + PostgreSQL local), jamais Supabase réel.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8231;
const srv = http.createServer((q, r) => {
  let u = '/'; try { u = decodeURIComponent(q.url.split('?')[0]); } catch (e) { r.writeHead(400); return r.end(); }
  const f = path.resolve(R, '.' + path.posix.normalize('/' + (u === '/' ? 'index.html' : u)));
  if (f !== R && !f.startsWith(R + path.sep)) { r.writeHead(403); return r.end(); }
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } let body = d;
    if (/app\.html$/.test(f)) body = d.toString('utf8').replace(/^const SUPABASE_URL = .*$/m, "const SUPABASE_URL = 'https://fake.supabase.test';").replace(/^const SUPABASE_ANON_KEY = .*$/m, "const SUPABASE_ANON_KEY = 'fake-anon-key';").replace(/ integrity="[^"]*" crossorigin="anonymous"/g, '');
    const t = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.ttf': 'font/ttf', '.png': 'image/png' }[path.extname(f)] || 'application/octet-stream';
    r.writeHead(200, { 'content-type': t }); r.end(body); });
}).listen(PORT);
const nm = (...s) => path.join(R, 'node_modules', ...s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const db = createDb({}); const be = makeBackend(db);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const R_ = []; const ok = (n, c, x = '') => { R_.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? ' ' + x : '')); };
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, serviceWorkers: 'block' }); const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message.slice(0, 200))); p.on('dialog', (d) => d.accept());
  await p.exposeFunction('__srv', (op, args) => be.handle(op, args));
  await p.route(/jsdelivr.*supabase/, (r) => r.fulfill({ body: FAKE, contentType: 'text/javascript' }));
  await p.route('**/jspdf.umd.min.js', (r) => r.fulfill({ path: nm('jspdf', 'dist', 'jspdf.umd.min.js'), contentType: 'text/javascript' }));
  await p.route('**/jspdf.plugin.autotable.min.js', (r) => r.fulfill({ path: nm('jspdf-autotable', 'dist', 'jspdf.plugin.autotable.min.js'), contentType: 'text/javascript' }));
  await p.route(/googleapis|gstatic|hcaptcha/, (r) => r.abort());
  await p.goto(`http://localhost:${PORT}/app.html?mode=login`); await sleep(800);
  await p.evaluate(() => { const t = [...document.querySelectorAll('button,div,a')].find((e) => e.textContent.trim() === 'Inscription'); t && t.click(); });
  const email = `xss-${process.pid}@facturapro-test.invalid`;
  await p.fill('#signupEmail', email); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500);
  if (!(await p.isVisible('#mainApp'))) {
    await p.evaluate(() => selectStatus(document.querySelector('[onclick*="selectStatus"]').getAttribute('onclick').match(/'(.*?)'/)[1])); await p.evaluate(() => onboardingNext(1));
    await p.fill('#onbCompanyName', 'Atelier Atlas SARL'); await p.fill('#onbICE', '001234567000089'); await p.evaluate(() => onboardingNext(2));
    await p.fill('#onbBank', 'Banque test'); await p.fill('#onbRIB', '007 780 0001234567890123 45'); await p.evaluate(() => finishOnboarding()); await sleep(1800);
  }
  const PAYLOAD = "x');window.__xss=1;//";
  await p.evaluate((PAYLOAD) => {
    window.isUserLicensed = () => true; window.__opened = [];
    window.open = (u) => { window.__opened.push(String(u)); return null; };
    const iso = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    const names = ["L'Atelier", PAYLOAD, 'Société "Les Amis" <b>'];
    Storage.set('clients', names.map((n, i) => ({ id: 'c' + i, name: n, phone: '0661234567', createdAt: new Date().toISOString() })));
    Storage.set('invoices', names.map((n, i) => ({ id: 'f' + i, number: 'F-2026-00' + (i + 1), kind: 'issued', status: 'sent', clientId: 'c' + i, clientName: n, clientICE: '001234567000089', clientAddress: 'x',
      date: iso(5), dueDate: iso(-20), items: [{ description: 'Câble 5" HDMI', quantity: 1, unitPrice: 100, tva: 20, discount: 0, totalHT: 100, totalTVA: 20, totalTTC: 120 }], totalHT: 100, totalTVA: 20, totalTTC: 120, createdAt: new Date().toISOString() })));
  }, PAYLOAD);

  // 1. escapeHtml : tous les caractères dangereux
  const esc = await p.evaluate(() => escapeHtml('a"b\'c<d>&e'));
  ok('escapeHtml neutralise guillemets, apostrophes, < > &', esc === 'a&quot;b&#39;c&lt;d&gt;&amp;e', esc);

  // 2. Rapport « meilleurs clients » : boutons 📱 avec noms hostiles
  await p.evaluate(() => navTo('reports')); await sleep(300);
  await p.evaluate(() => { try { switchReportTab('topclients'); } catch (e) {} renderReportTopClients(); }); await sleep(300);
  const nBtn = await p.evaluate(() => document.querySelectorAll('button[onclick*="contactClient"]').length);
  ok('rapport : un bouton 📱 par client', nBtn === 3, 'boutons=' + nBtn);
  const before = errs.length;
  for (let i = 0; i < nBtn; i++) await p.evaluate((i) => document.querySelectorAll('button[onclick*="contactClient"]')[i].click(), i);
  await sleep(300);
  ok("« L'Atelier » (apostrophe légitime) : le bouton fonctionne, sans erreur JavaScript", errs.length === before && (await p.evaluate(() => window.__opened.length)) === 3, errs.slice(before).join(' | '));
  ok('nom piégé : aucun code exécuté', (await p.evaluate(() => window.__xss)) === undefined);

  // 3. Ligne de facture : un guillemet dans la description ne doit pas la tronquer ni injecter un attribut
  await p.evaluate(() => { window.__xss2 = 0; addItem({ description: 'Câble 5" HDMI', quantity: 1, unitPrice: 100, tva: 20 }); addItem({ description: '" onfocus="window.__xss2=1" autofocus="', quantity: 1, unitPrice: 1, tva: 20 }); });
  await sleep(300);
  const vals = await p.evaluate(() => [...document.querySelectorAll('.item-desc')].map((e) => e.value));
  ok('description avec guillemet : valeur intacte à la réouverture', vals.includes('Câble 5" HDMI'), JSON.stringify(vals));
  ok('description piégée : conservée telle quelle, aucun attribut injecté', vals.includes('" onfocus="window.__xss2=1" autofocus="') && (await p.evaluate(() => window.__xss2)) === 0);

  // 4. Identifiants hostiles : jamais interprétés comme du code dans les gestionnaires
  await p.evaluate(() => { const inv = Storage.get('invoices'); inv[0].id = "z');window.__xss3=1;//"; Storage.set('invoices', inv); });
  await p.evaluate(() => { navTo('invoices'); }); await sleep(500);
  const hostileHandlers = await p.evaluate(() => [...document.querySelectorAll('[onclick]')].filter((e) => /__xss3/.test(e.getAttribute('onclick'))).map((e) => e.getAttribute('onclick')));
  for (let i = 0; i < hostileHandlers.length; i++) await p.evaluate((i) => { const el = [...document.querySelectorAll('[onclick]')].filter((e) => /__xss3/.test(e.getAttribute('onclick')))[i]; try { el.click(); } catch (e) {} }, i);
  await sleep(300);
  ok('identifiant piégé (donnée importée) : aucun code exécuté', (await p.evaluate(() => window.__xss3)) === undefined, 'gestionnaires piégés=' + hostileHandlers.length);

  await browser.close(); srv.close(); try { await dropDb(db); } catch (e) {}
  const n = R_.filter(Boolean).length; console.log(`\n${n === R_.length ? 'OK' : 'ÉCHEC'} : ${n}/${R_.length} contrôles (injection stockée)`); process.exit(n === R_.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
