// Double authentification (TOTP) de la console admin : activation obligatoire, code à la connexion, mauvais code, annulation,
// simple client sans activation, session aal1 non restaurée. SIMULATION locale (faux Supabase + PostgreSQL local).
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8233;
const srv = http.createServer((q, r) => {
  let u = '/'; try { u = decodeURIComponent(q.url.split('?')[0]); } catch (e) { r.writeHead(400); return r.end(); }
  const f = path.resolve(R, '.' + path.posix.normalize('/' + (u === '/' ? 'index.html' : u)));
  if (f !== R && !f.startsWith(R + path.sep)) { r.writeHead(403); return r.end(); }
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } let body = d;
    if (/admin\.html$/.test(f)) body = d.toString('utf8').replace(/^const SUPABASE_URL = .*$/m, "const SUPABASE_URL = 'https://fake.supabase.test';").replace(/^const SUPABASE_ANON_KEY = .*$/m, "const SUPABASE_ANON_KEY = 'fake-anon-key';").replace(/ integrity="[^"]*" crossorigin="anonymous"/g, '');
    const t = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json' }[path.extname(f)] || 'application/octet-stream';
    r.writeHead(200, { 'content-type': t }); r.end(body); });
}).listen(PORT);
const nm = (...s) => path.join(R, 'node_modules', ...s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const db = createDb({}); const be = makeBackend(db);
  const { execFileSync } = require('child_process');
  const sql = (q) => execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A', '-d', db, '-c', q]).toString().trim();
  sql("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES ('f6f6f6f6-0000-0000-0000-000000000001','boss@test.invalid',now()),('f6f6f6f6-0000-0000-0000-000000000002','client@test.invalid',now()),('f6f6f6f6-0000-0000-0000-000000000003','sub@test.invalid',now()); INSERT INTO public.admins(email,password_hash,is_master) VALUES ('boss@test.invalid','x',true),('sub@test.invalid','x',false)");
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const R_ = []; const ok = (n, c, x = '') => { R_.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? ' ' + x : '')); };
  async function page(init) {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 }, serviceWorkers: 'block' }); const p = await ctx.newPage();
    p.on('dialog', (d) => d.dismiss());
    await p.addInitScript(init);
    await p.exposeFunction('__srv', (op, args) => be.handle(op, args));
    await p.route(/jsdelivr.*supabase/, (r) => r.fulfill({ body: FAKE, contentType: 'text/javascript' }));
    await p.route('**/jspdf.umd.min.js', (r) => r.fulfill({ path: nm('jspdf', 'dist', 'jspdf.umd.min.js'), contentType: 'text/javascript' }));
    await p.route('**/jspdf.plugin.autotable.min.js', (r) => r.fulfill({ path: nm('jspdf-autotable', 'dist', 'jspdf.plugin.autotable.min.js'), contentType: 'text/javascript' }));
    await p.route(/googleapis|gstatic|hcaptcha/, (r) => r.abort());
    await p.goto(`http://localhost:${PORT}/admin.html`); await sleep(700);
    return p;
  }
  const login = async (p, email) => { await p.fill('#adminEmail', email); await p.fill('#adminPassword', 'x'); await p.click('#loginScreen button[onclick="adminLogin()"]'); await sleep(900); };
  const overlay = (p) => p.evaluate(() => getComputedStyle(document.getElementById('mfaOverlay')).display !== 'none');
  const appOpen = (p) => p.evaluate(() => document.getElementById('app').classList.contains('active'));

  // 1. Premier passage : aucun facteur → activation obligatoire (QR + clé)
  let p = await page(() => { window.__mfa = { realistic: true, factors: [], level: 'aal1', log: [] }; });
  await login(p, 'boss@test.invalid');
  ok('admin sans facteur : écran d\'activation affiché, console fermée', (await overlay(p)) && !(await appOpen(p)));
  ok('activation : QR code et clé affichés', await p.evaluate(() => document.getElementById('mfaEnroll').style.display === 'block' && /^data:image\//.test(document.getElementById('mfaQr').src) && document.getElementById('mfaSecret').textContent.length > 8));
  await p.fill('#mfaCode', '000000'); await p.click('#mfaBtn'); await sleep(500);
  ok('mauvais code : refusé, console toujours fermée', (await overlay(p)) && !(await appOpen(p)) && /incorrect/i.test(await p.textContent('#mfaError')));
  await p.fill('#mfaCode', '12'); await p.click('#mfaBtn'); await sleep(200);
  ok('code mal formé (2 chiffres) : refusé avant tout appel', /6 chiffres/.test(await p.textContent('#mfaError')));
  await p.fill('#mfaCode', '123456'); await p.click('#mfaBtn'); await sleep(1500);
  ok('bon code : console ouverte', (await appOpen(p)) && !(await overlay(p)));
  ok('un seul facteur créé, vérifié', await p.evaluate(() => window.__mfa.factors.length === 1 && window.__mfa.factors[0].status === 'verified'));
  await p.close();

  // 2. Connexion suivante : facteur existant → simple saisie du code
  p = await page(() => { window.__mfa = { realistic: true, factors: [{ id: 'fac-1', status: 'verified', factor_type: 'totp' }], level: 'aal1', log: [] }; });
  await login(p, 'boss@test.invalid');
  ok('facteur existant : demande du code (pas de QR), console fermée', (await overlay(p)) && !(await appOpen(p)) && await p.evaluate(() => document.getElementById('mfaEnroll').style.display === 'none'));
  await p.click('#mfaOverlay a'); await sleep(600);
  ok('annulation : pas d\'accès, déconnecté', !(await appOpen(p)) && !(await overlay(p)) && await p.evaluate(() => localStorage.getItem('__fake_session') === null));
  await p.fill('#adminPassword', 'x'); await p.click('#loginScreen button[onclick="adminLogin()"]'); await sleep(900);
  await p.fill('#mfaCode', '123456'); await p.click('#mfaBtn'); await sleep(1500);
  ok('nouvel essai avec le bon code : accès', await appOpen(p));
  await p.close();

  // 3. Simple client : jamais d'invitation à activer la 2FA, accès refusé
  p = await page(() => { window.__mfa = { realistic: true, factors: [], level: 'aal1', log: [] }; });
  await login(p, 'client@test.invalid');
  ok('simple client : aucune activation proposée, accès refusé', !(await overlay(p)) && !(await appOpen(p)) && await p.evaluate(() => window.__mfa.factors.length === 0) && /refusé/i.test(await p.textContent('#adminLoginError')));
  await p.close();

  // 4. Fonction d'activation indisponible (TOTP désactivé côté Supabase) : refus explicite, jamais d'accès
  p = await page(() => { window.__mfa = { realistic: true, factors: [], level: 'aal1', log: [], enrollError: 'MFA enroll is disabled for TOTP' }; });
  await login(p, 'boss@test.invalid');
  ok('activation impossible : accès refusé avec explication', !(await appOpen(p)) && !(await overlay(p)) && /Multi-factor|activer/i.test(await p.textContent('#adminLoginError')));
  await p.close();

  // 5. Session restaurée au niveau « mot de passe seul » : pas de console
  p = await page(() => { window.__mfa = { realistic: true, factors: [{ id: 'fac-1', status: 'verified', factor_type: 'totp' }], level: 'aal1', log: [] }; localStorage.setItem('__fake_session', JSON.stringify({ access_token: 'x', user: { id: 'f6f6f6f6-0000-0000-0000-000000000001', email: 'boss@test.invalid' } })); });
  await sleep(300);
  ok('session aal1 rechargée : console fermée', !(await appOpen(p)));
  await p.close();

  // 6. Admin NON propriétaire sans 2FA : aucune activation imposée, accès par mot de passe ; session rechargée conservée
  p = await page(() => { window.__mfa = { realistic: true, factors: [], level: 'aal1', log: [] }; });
  await login(p, 'sub@test.invalid');
  ok('admin non propriétaire sans 2FA : accès direct, aucune activation imposée', (await appOpen(p)) && !(await overlay(p)) && await p.evaluate(() => window.__mfa.factors.length === 0));
  await p.close();
  p = await page(() => { window.__mfa = { realistic: true, factors: [], level: 'aal1', log: [] }; localStorage.setItem('__fake_session', JSON.stringify({ access_token: 'tok_f6f6f6f6-0000-0000-0000-000000000003', user: { id: 'f6f6f6f6-0000-0000-0000-000000000003', email: 'sub@test.invalid' } })); });
  await sleep(1200);
  ok('admin non propriétaire sans 2FA : session rechargée conservée (pas de déconnexion forcée)', await appOpen(p));
  await p.close();
  p = await page(() => { window.__mfa = { realistic: true, factors: [], level: 'aal1', log: [] }; localStorage.setItem('__fake_session', JSON.stringify({ access_token: 'tok_f6f6f6f6-0000-0000-0000-000000000001', user: { id: 'f6f6f6f6-0000-0000-0000-000000000001', email: 'boss@test.invalid' } })); });
  await sleep(1200);
  ok('propriétaire sans 2FA validée, session rechargée : console fermée (activation obligatoire)', !(await appOpen(p)));
  await p.close();
  // 7. Admin non propriétaire qui a activé la 2FA de lui-même : le code lui est demandé
  p = await page(() => { window.__mfa = { realistic: true, factors: [{ id: 'fac-9', status: 'verified', factor_type: 'totp' }], level: 'aal1', log: [] }; });
  await login(p, 'sub@test.invalid');
  ok('admin non propriétaire avec 2FA volontaire : code demandé, console fermée', (await overlay(p)) && !(await appOpen(p)));
  await p.close();

  await browser.close(); srv.close(); try { dropDb(db); } catch (e) {}
  const n = R_.filter(Boolean).length; console.log(`\n${n === R_.length ? 'OK' : 'ÉCHEC'} : ${n}/${R_.length} contrôles (double authentification)`); process.exit(n === R_.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
