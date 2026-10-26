// Reproduction MINIMALE du blocage « Connexion... » observé au run réel 39774301049 (navigateur automatisé, préproduction).
// SIMULATION locale : app.html + FAUX client Supabase + base PostgreSQL locale. Aucun Supabase réel, aucun réseau externe.
// Cause examinée : Auth.login() appelle d'abord getCaptchaToken() (hCaptcha invisible). Un navigateur automatisé ne peut pas résoudre un défi
// hCaptcha : si window.hcaptcha.execute() ne se termine jamais, signInWithPassword n'est JAMAIS appelé et le bouton reste sur « Connexion... ».
// Prérequis : PostgreSQL local (PGHOST/PGPORT/PGUSER), playwright-core, Chromium (CHROMIUM_PATH).
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const { createDb, dropDb, makeBackend } = require('./backend');

const ROOT = path.join(__dirname, '..', '..');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8196;
const srv = http.createServer((q, r) => {
  const f = path.join(ROOT, q.url.split('?')[0] === '/' ? 'app.html' : q.url.split('?')[0]);
  fs.readFile(f, (e, d) => {
    if (e) { r.writeHead(404); return r.end(); }
    let body = d;
    if (f.endsWith('app.html')) body = d.toString('utf8')
      .replace(/^const SUPABASE_URL = .*$/m, "const SUPABASE_URL = 'https://fake.supabase.test';")
      .replace(/^const SUPABASE_ANON_KEY = .*$/m, "const SUPABASE_ANON_KEY = 'fake-anon-key';").replace(/ integrity="[^"]*" crossorigin="anonymous"/g, '');
    r.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
    r.end(body);
  });
}).listen(PORT);

const results = [];
const check = (name, cond, extra = '') => results.push([!!cond, name, extra]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const db = createDb();
  const be = makeBackend(db);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
  const nm = (...s) => path.join(ROOT, 'node_modules', ...s);
  const pageErrors = [];

  // hcaptcha : 'hang' = script remplacé par un faux hCaptcha dont execute() n'aboutit jamais (défi non résoluble) ;
  //            'abort' = script bloqué (comme les autres tests) ; 'token' = faux hCaptcha qui répond tout de suite.
  async function device(hc, ops) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => pageErrors.push(e.message));
    p.on('dialog', (d) => d.accept());
    await p.exposeFunction('__srv', (op, args) => { ops.push(op); return be.handle(op, args); });
    await p.route(/jsdelivr.*supabase/, (r) => r.fulfill({ body: FAKE, contentType: 'text/javascript' }));
    await p.route('**/jspdf.umd.min.js', (r) => r.fulfill({ path: nm('jspdf', 'dist', 'jspdf.umd.min.js'), contentType: 'text/javascript' }));
    await p.route('**/jspdf.plugin.autotable.min.js', (r) => r.fulfill({ path: nm('jspdf-autotable', 'dist', 'jspdf.plugin.autotable.min.js'), contentType: 'text/javascript' }));
    await p.route(/googleapis|gstatic/, (r) => r.abort());
    if (hc === 'abort') await p.route(/hcaptcha/, (r) => r.abort());
    else await p.route(/hcaptcha/, (r) => r.fulfill({ contentType: 'text/javascript', body: hc === 'hang'
      ? "window.hcaptcha = { render() { return 1; }, execute() { return new Promise(() => {}); }, reset() {} };"
      : "window.hcaptcha = { render() { return 1; }, execute() { return Promise.resolve({ response: 'jeton-test' }); }, reset() {} };" }));
    return { ctx, p };
  }
  const email = `captcha-${process.pid}@facturapro-test.invalid`;
  const finishOnboardingIfShown = async (p) => {
    if (await p.isVisible('#mainApp')) return;
    await p.evaluate(() => selectStatus(document.querySelector('[onclick*="selectStatus"]').getAttribute('onclick').match(/'(.*?)'/)[1]));
    await p.evaluate(() => onboardingNext(1));
    await p.fill('#onbCompanyName', 'SARL Captcha'); await p.fill('#onbICE', '001234567000089');
    await p.evaluate(() => onboardingNext(2));
    await p.fill('#onbBank', 'Banque test'); await p.fill('#onbRIB', '007 780 0001234567890123 45');
    await p.evaluate(() => finishOnboarding()); await p.waitForTimeout(1500);
  };
  const shown = async (p, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if ((await p.isVisible('#mainApp')) || (await p.isVisible('#onbStep1'))) return true; await sleep(200); } return false; };

  // 0. création du compte (captcha bloqué) puis déconnexion : on teste ensuite la CONNEXION seule
  const ops0 = []; const d0 = await device('abort', ops0);
  await d0.p.goto(`http://localhost:${PORT}/app.html?mode=login`); await d0.p.waitForTimeout(800);
  await d0.p.evaluate(() => { const t = [...document.querySelectorAll('button,div,a')].find((e) => e.textContent.trim() === 'Inscription'); t && t.click(); });
  await d0.p.fill('#signupEmail', email); await d0.p.fill('#signupPassword', 'Test#12345'); await d0.p.fill('#signupConfirm', 'Test#12345');
  await d0.p.click('#signupBtn'); await d0.p.waitForTimeout(2500); await finishOnboardingIfShown(d0.p);
  check('préparation : compte local créé', ops0.includes('signUp'));
  await d0.ctx.close();

  // 1. REPRODUCTION : hCaptcha qui ne se termine jamais -> le bouton reste « Connexion... » et AUCUN appel d'authentification n'est émis
  const ops1 = []; const d1 = await device('hang', ops1);
  await d1.p.goto(`http://localhost:${PORT}/app.html?mode=login`); await d1.p.waitForTimeout(800);
  await d1.p.fill('#loginEmail', email); await d1.p.fill('#loginPassword', 'Test#12345'); await d1.p.click('#loginBtn');
  const ok1 = await shown(d1.p, 6000);
  const label1 = await d1.p.evaluate(() => document.getElementById('loginBtn').textContent);
  check('REPRODUCTION : captcha qui ne se résout pas -> bouton bloqué sur « Connexion... »', label1 === 'Connexion...' && !ok1, `bouton « ${label1} », écran atteint : ${ok1}`);
  check('REPRODUCTION : aucun appel signIn n\'est émis tant que le captcha n\'est pas résolu (le serveur n\'est jamais joint)', !ops1.includes('signIn'), 'opérations : ' + ops1.join(','));
  await d1.ctx.close();

  // 2. CORRECTIF DU HARNAIS : script hCaptcha bloqué -> getCaptchaToken() renvoie undefined, la connexion aboutit
  const ops2 = []; const d2 = await device('abort', ops2);
  await d2.p.goto(`http://localhost:${PORT}/app.html?mode=login`); await d2.p.waitForTimeout(800);
  await d2.p.fill('#loginEmail', email); await d2.p.fill('#loginPassword', 'Test#12345'); await d2.p.click('#loginBtn');
  const ok2 = await shown(d2.p, 8000);
  check('script hCaptcha bloqué : la connexion aboutit (application ou intégration visibles)', ok2 && ops2.includes('signIn'), 'opérations : ' + ops2.join(','));
  await d2.ctx.close();

  // 3. captcha qui répond : la connexion aboutit aussi (le chemin avec jeton fonctionne)
  const ops3 = []; const d3 = await device('token', ops3);
  await d3.p.goto(`http://localhost:${PORT}/app.html?mode=login`); await d3.p.waitForTimeout(800);
  await d3.p.fill('#loginEmail', email); await d3.p.fill('#loginPassword', 'Test#12345'); await d3.p.click('#loginBtn');
  const ok3 = await shown(d3.p, 8000);
  check('captcha qui répond : la connexion aboutit', ok3 && ops3.includes('signIn'), 'opérations : ' + ops3.join(','));
  await d3.ctx.close();

  check('aucune erreur JavaScript de page', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  await browser.close(); srv.close(); try { be.close(); } catch {} dropDb(db);
  let bad = 0; for (const [ok, name, extra] of results) { if (!ok) bad++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || !extra ? '' : ' -> ' + extra)); }
  console.log(`\n${results.length - bad}/${results.length} tests de connexion et hCaptcha réussis (SIMULATION locale : faux client + PostgreSQL local, PAS Supabase)`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
