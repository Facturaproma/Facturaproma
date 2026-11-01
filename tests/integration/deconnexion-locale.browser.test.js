// Copie locale à la déconnexion (alertes CodeQL « stockage en clair ») : sur un appareil partagé, la déconnexion retire de localStorage les données du compte ; jamais si des modifications ne sont pas encore envoyées ; la reconnexion recharge tout depuis le serveur. Compte de test jetable.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8262;
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
  await p.fill('#signupEmail', `loc-${process.pid}@facturapro-test.invalid`); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500);
  if (!(await p.isVisible('#mainApp'))) {
    await p.evaluate(() => selectStatus(document.querySelector('[onclick*="selectStatus"]').getAttribute('onclick').match(/'(.*?)'/)[1])); await p.evaluate(() => onboardingNext(1));
    await p.fill('#onbCompanyName', 'Atelier Atlas SARL'); await p.fill('#onbICE', '001234567000089'); await p.evaluate(() => onboardingNext(2));
    await p.fill('#onbBank', 'Banque test'); await p.fill('#onbRIB', '007 780 0001234567890123 45'); await p.evaluate(() => finishOnboarding()); await sleep(1800);
  }
  await p.evaluate(() => stockRefreshLevels());
  await p.evaluate(() => { Storage.set('clients', [{ id: 'c1', name: 'Client Test', createdAt: new Date().toISOString() }]); });
  const level = (id) => p.evaluate((i) => stockLevel(i), id);
  const pid = async (n) => p.evaluate((nm) => (Storage.get('products', []).find(x => x.name === nm) || {}).id, n);

  const email = `loc-${process.pid}@facturapro-test.invalid`;
  await p.evaluate(() => { Storage.set('clients', [{ id: 'c1', name: 'Client Confidentiel', ice: '009999999000001' }]); Storage.set('products', [{ id: 'p1', name: 'Produit secret', price: 10, tva: 20 }]); window.confirm = () => true; });
  await sleep(1500);
  const uid = await p.evaluate(() => Storage._currentUserId);
  const localKeys = () => p.evaluate((u) => Object.keys(localStorage).filter(k => k.includes(u)), uid);
  const anyLeak = () => p.evaluate(() => Object.keys(localStorage).some(k => /Client Confidentiel|Produit secret/.test(localStorage.getItem(k) || '')));
  ok('connecté : la copie locale existe (fonctionnement hors ligne)', (await localKeys()).length > 0 && await anyLeak());
  ok('données bien enregistrées sur le serveur avant déconnexion', (await be.sql("SELECT count(*)::int n FROM user_data WHERE key = 'clients' AND value::text LIKE '%Client Confidentiel%'"))[0].n === 1);
  await p.evaluate(async () => { await handleLogout(); }); await sleep(1500);
  ok('déconnexion : plus aucune donnée du compte dans le navigateur (appareil partagé)', (await localKeys()).length === 0 && !(await anyLeak()), JSON.stringify(await localKeys()));
  await p.goto(`http://localhost:${PORT}/app.html?mode=login`); await sleep(800);
  await p.fill('#loginEmail', email); await p.fill('#loginPassword', 'Test#12345'); await p.click('#loginBtn'); await sleep(3000);
  ok('reconnexion : les données reviennent du serveur', await p.evaluate(() => (Storage.get('clients', []) || []).some(c => c.name === 'Client Confidentiel')));
  // Modification non envoyée (hors ligne) : la déconnexion ne doit RIEN effacer
  await p.evaluate(() => { SyncManager.isOnline = false; SyncManager.addPendingChange({ type: 'storage', key: 'clients' }); });
  await p.evaluate(async () => { const orig = SyncManager.syncPending; SyncManager.syncPending = async () => {}; await handleLogout(); SyncManager.syncPending = orig; }); await sleep(1200);
  ok('modification non envoyée : déconnexion sans effacement (aucune perte)', (await localKeys()).length > 0 && await anyLeak());
  await browser.close(); srv.close(); try { dropDb(db); } catch (e) {}
  const n = R_.filter(Boolean).length; console.log(`\n${n === R_.length ? 'OK' : 'ÉCHEC'} : ${n}/${R_.length} contrôles (copie locale et déconnexion)`); process.exit(n === R_.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
