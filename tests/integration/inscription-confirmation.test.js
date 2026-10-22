// Inscription avec confirmation d'e-mail : message clair après l'inscription, message distinct si l'e-mail n'est pas confirmé,
// renvoi du lien. SIMULATION locale : faux client Supabase dont les réponses sont forcées ; aucun réseau, aucune base.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8197;
const srv = http.createServer((q, r) => {
  const f = path.join(ROOT, q.url.split('?')[0] === '/' ? 'app.html' : q.url.split('?')[0]);
  fs.readFile(f, (e, d) => {
    if (e) { r.writeHead(404); return r.end(); }
    let body = d;
    if (f.endsWith('app.html')) body = d.toString('utf8')
      .replace(/^const SUPABASE_URL = .*$/m, "const SUPABASE_URL = 'https://fake.supabase.test';")
      .replace(/^const SUPABASE_ANON_KEY = .*$/m, "const SUPABASE_ANON_KEY = 'fake-anon-key';");
    r.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : 'text/javascript' });
    r.end(body);
  });
}).listen(PORT);
const results = [];
const check = (n, c, x = '') => results.push([!!c, n, x]);

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const nm = (...s) => path.join(ROOT, 'node_modules', ...s);
  await p.exposeFunction('__srv', async () => ({}));
  await p.route(/jsdelivr.*supabase/, r => r.fulfill({ body: FAKE, contentType: 'text/javascript' }));
  await p.route('**/jspdf.umd.min.js', r => r.fulfill({ path: nm('jspdf', 'dist', 'jspdf.umd.min.js'), contentType: 'text/javascript' }));
  await p.route('**/jspdf.plugin.autotable.min.js', r => r.fulfill({ path: nm('jspdf-autotable', 'dist', 'jspdf.plugin.autotable.min.js'), contentType: 'text/javascript' }));
  await p.route(/googleapis|gstatic/, r => r.abort());
  await p.route(/hcaptcha/, r => r.fulfill({ contentType: 'text/javascript', body: "window.hcaptcha = { render() { return 1; }, execute() { return Promise.resolve({ response: 'jeton-test' }); }, reset() {} };" }));
  await p.goto(`http://localhost:${PORT}/app.html?mode=login`); await p.waitForTimeout(900);
  const txt = (id) => p.evaluate((i) => document.getElementById(i).textContent, id);
  const vis = (id) => p.evaluate((i) => { const e = document.getElementById(i); return e.classList.contains('show') || (e.style.display !== 'none' && getComputedStyle(e).display !== 'none'); }, id);
  const goSignup = () => p.evaluate(() => switchAuthTab('signup'));
  const fillSignup = async (mail) => { await goSignup(); await p.fill('#signupEmail', mail); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); };

  // 1. inscription : aucune session (confirmation exigée)
  await p.evaluate(() => { supaClient.auth.signUp = async ({ email }) => ({ data: { user: { id: 'u1', email, identities: [{ id: 'i1' }] }, session: null }, error: null }); });
  await fillSignup('Nouveau@Exemple.com'); await p.click('#signupBtn'); await p.waitForTimeout(600);
  const ok = await txt('authSuccess');
  check('inscription : message « e-mail de confirmation envoyé à … »', /confirmation/i.test(ok) && /nouveau@exemple\.com/.test(ok) && /spam/i.test(ok), ok);
  check('inscription : plus de « Redirection... » trompeuse', !/Redirection/.test(ok));
  check('inscription : bascule sur l\'onglet Connexion, e-mail prérempli', await p.evaluate(() => document.getElementById('loginForm').classList.contains('active') && document.getElementById('loginEmail').value === 'nouveau@exemple.com'));
  check('inscription : bouton « Renvoyer l\'e-mail » visible', await vis('authResend'));
  check('inscription : bouton de création de nouveau actif', await p.evaluate(() => !document.getElementById('signupBtn').disabled));

  // 2. adresse déjà inscrite (Supabase renvoie un utilisateur sans identité)
  await p.evaluate(() => { supaClient.auth.signUp = async ({ email }) => ({ data: { user: { id: 'u2', email, identities: [] }, session: null }, error: null }); });
  await fillSignup('deja@exemple.com'); await p.click('#signupBtn'); await p.waitForTimeout(500);
  check('adresse déjà inscrite : « déjà utilisé » (et non un faux succès)', /déjà utilisé/.test(await txt('authError')), await txt('authError'));

  // 3. connexion avant confirmation, puis mauvais mot de passe
  await p.evaluate(() => { switchAuthTab('login'); supaClient.auth.signInWithPassword = async () => ({ data: { user: null, session: null }, error: { code: 'email_not_confirmed', message: 'Email not confirmed' } }); });
  await p.fill('#loginEmail', 'nouveau@exemple.com'); await p.fill('#loginPassword', 'Test#12345'); await p.click('#loginBtn'); await p.waitForTimeout(500);
  const e3 = await txt('authError');
  check('connexion non confirmée : message « pas encore confirmée » (pas « mot de passe incorrect »)', /pas encore confirmée/.test(e3) && !/incorrect/.test(e3), e3);
  check('connexion non confirmée : renvoi proposé', await vis('authResend'));
  await p.evaluate(() => { supaClient.auth.signInWithPassword = async () => ({ data: { user: null, session: null }, error: { code: 'invalid_credentials', message: 'Invalid login credentials' } }); });
  await p.click('#loginBtn'); await p.waitForTimeout(500);
  check('mauvais mot de passe : message inchangé, pas de renvoi', /incorrect/.test(await txt('authError')) && !(await vis('authResend')));

  // 4. renvoi du lien
  await p.evaluate(() => { window.__resent = null; supaClient.auth.resend = async (a) => { window.__resent = a; return { data: {}, error: null }; };
    supaClient.auth.signInWithPassword = async () => ({ data: { user: null, session: null }, error: { code: 'email_not_confirmed', message: 'Email not confirmed' } }); });
  await p.click('#loginBtn'); await p.waitForTimeout(400);
  await p.click('#authResendLink'); await p.waitForTimeout(500);
  const rs = await p.evaluate(() => window.__resent);
  check('renvoi : auth.resend(type signup, e-mail, captcha, redirection app.html)', rs && rs.type === 'signup' && rs.email === 'nouveau@exemple.com' && rs.options.captchaToken === 'jeton-test' && /app\.html$/.test(rs.options.emailRedirectTo), JSON.stringify(rs));
  check('renvoi : confirmation affichée', /renvoyé/.test(await txt('authSuccess')));
  check('mobile : pas de débordement horizontal', await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  check('aucune erreur JavaScript', errs.length === 0, errs.join(' | '));

  let fail = 0; for (const [o, n, x] of results) { if (!o) fail++; console.log((o ? 'PASS ' : 'FAIL ') + n + (o || !x ? '' : '  -> ' + x)); }
  console.log(`\n${results.length - fail}/${results.length} tests réussis`);
  await browser.close(); srv.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERREUR HARNAIS', e); process.exit(2); });
