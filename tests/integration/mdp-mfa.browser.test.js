// Changement / réinitialisation du mot de passe pour un compte avec double authentification (aal2 exigé par Supabase). SIMULATION locale, aucune donnée réelle.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8242;
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
  await p.fill('#signupEmail', `mfa-${process.pid}@facturapro-test.invalid`); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500);
  await p.evaluate(() => finishOnboarding()); await sleep(1500);
  // Compte avec double authentification, session aal1
  await p.evaluate(() => { window.__mfa = { realistic: true, factors: [{ id: 'fac-1', status: 'verified', factor_type: 'totp' }], level: 'aal1', log: [] }; });

  // 1) Réinitialisation par lien e-mail
  await p.evaluate(() => { openRecoveryModal(); document.getElementById('rcpNew').value = 'Nouveau#2026x'; document.getElementById('rcpConfirm').value = 'Nouveau#2026x'; });
  await p.evaluate(() => submitRecovery()); await sleep(300);
  ok('réinitialisation : le champ code apparaît (au lieu du message anglais « AAL2 session… »)', await p.isVisible('#rcpMfaWrap') && !/AAL2/.test(await p.innerText('#rcpError')) && /double authentification/.test(await p.innerText('#rcpError')), await p.innerText('#rcpError'));
  await p.fill('#rcpMfa', '000000'); await p.evaluate(() => submitRecovery()); await sleep(300);
  ok('code faux : message clair, mot de passe non changé', /incorrect/.test(await p.innerText('#rcpError')) && await p.isVisible('#rcpMfaWrap'));
  await p.fill('#rcpMfa', '123456'); await p.evaluate(() => { submitRecovery(); }); await sleep(500);
  ok('bon code : session aal2 puis mot de passe enregistré', await p.evaluate(() => window.__mfa.level) === 'aal2' && /modifié/.test(await p.evaluate(() => (document.querySelector('.toast') || {}).textContent || '')));
  await sleep(2500); // l'application se recharge après la réinitialisation
  await p.waitForFunction(() => document.getElementById('mainApp') && document.getElementById('mainApp').offsetParent !== null, null, { timeout: 15000 }).catch(() => {});

  // 2) Changement depuis le compte
  await p.evaluate(() => { window.__mfa = { realistic: true, factors: [{ id: 'fac-1', status: 'verified', factor_type: 'totp' }], level: 'aal1', log: [] }; openChangePasswordModal(); document.getElementById('cpwCurrent').value = 'Test#12345'; document.getElementById('cpwNew').value = 'Autre#2026yz'; document.getElementById('cpwConfirm').value = 'Autre#2026yz'; });
  ok('fenêtre de changement : champ code masqué au départ', !(await p.isVisible('#cpwMfaWrap')));
  await p.evaluate(() => submitChangePassword()); await sleep(3500);
  ok('changement : le champ code apparaît', await p.isVisible('#cpwMfaWrap') && /double authentification/.test(await p.innerText('#cpwError')), await p.innerText('#cpwError') + ' / ' + await p.innerText('#cpwSuccess'));
  await p.fill('#cpwMfa', '123456'); await p.evaluate(() => submitChangePassword()); await sleep(3500);
  ok('changement avec le bon code : succès', /succès/.test(await p.innerText('#cpwSuccess')));

  // 3) Compte sans double authentification : aucun champ code
  await p.evaluate(() => { window.__mfa = { realistic: true, factors: [], level: 'aal1', log: [] }; openChangePasswordModal(); document.getElementById('cpwCurrent').value = 'Autre#2026yz'; document.getElementById('cpwNew').value = 'Encore#2026ab'; document.getElementById('cpwConfirm').value = 'Encore#2026ab'; });
  await p.evaluate(() => submitChangePassword()); await sleep(3500);
  ok('sans double authentification : changement direct, sans champ code', /succès/.test(await p.innerText('#cpwSuccess')) && !(await p.isVisible('#cpwMfaWrap')));
  await browser.close(); srv.close(); try { dropDb(db); } catch (e) {}
  const n = R_.filter(Boolean).length; console.log(`\n${n === R_.length ? 'OK' : 'ÉCHEC'} : ${n}/${R_.length} contrôles (mot de passe + double authentification)`); process.exit(n === R_.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
