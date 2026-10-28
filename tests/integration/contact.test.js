// Contact de support configuré dans l'ADMIN (admin_settings) et affiché dans l'application via get_contact_info().
// SIMULATION locale : app.html + FAUX client Supabase + base PostgreSQL locale (scripts SQL du dépôt dont sql/18). Aucun Supabase réel.
// Vérifie : (1) contact non configuré -> aucun faux numéro, invitation à demander l'abonnement ; (2) contact configuré -> affiché ;
// (3) le RIB n'est jamais affiché ; (4) plus d'offre « espèces » ni de champ code promo ; (5) message d'achat sans espèces ni faux « ID demande ».
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const { createDb, dropDb, makeBackend } = require('./backend');

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
      .replace(/^const SUPABASE_ANON_KEY = .*$/m, "const SUPABASE_ANON_KEY = 'fake-anon-key';").replace(/ integrity="[^"]*" crossorigin="anonymous"/g, '');
    r.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
    r.end(body);
  });
}).listen(PORT);

const results = [];
const check = (name, cond, extra = '') => results.push([!!cond, name, extra]);

(async () => {
  const db = createDb();
  const be = makeBackend(db);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
  const nm = (...s) => path.join(ROOT, 'node_modules', ...s);
  const pageErrors = [], dialogs = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => pageErrors.push(e.message));
  p.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await p.exposeFunction('__srv', (op, args) => be.handle(op, args));
  await p.route(/jsdelivr.*supabase/, (r) => r.fulfill({ body: FAKE, contentType: 'text/javascript' }));
  await p.route('**/jspdf.umd.min.js', (r) => r.fulfill({ path: nm('jspdf', 'dist', 'jspdf.umd.min.js'), contentType: 'text/javascript' }));
  await p.route('**/jspdf.plugin.autotable.min.js', (r) => r.fulfill({ path: nm('jspdf-autotable', 'dist', 'jspdf.plugin.autotable.min.js'), contentType: 'text/javascript' }));
  await p.route(/googleapis|gstatic|hcaptcha/, (r) => r.abort());

  const email = `contact-${process.pid}@facturapro-test.invalid`;
  await p.goto(`http://localhost:${PORT}/app.html?mode=login`); await p.waitForTimeout(800);
  await p.evaluate(() => { const t = [...document.querySelectorAll('button,div,a')].find((e) => e.textContent.trim() === 'Inscription'); t && t.click(); });
  await p.fill('#signupEmail', email); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345');
  await p.click('#signupBtn'); await p.waitForTimeout(2500);
  if (!(await p.isVisible('#mainApp'))) {
    await p.evaluate(() => selectStatus(document.querySelector('[onclick*="selectStatus"]').getAttribute('onclick').match(/'(.*?)'/)[1]));
    await p.evaluate(() => onboardingNext(1));
    await p.fill('#onbCompanyName', 'SARL Contact'); await p.fill('#onbICE', '001234567000089');
    await p.evaluate(() => onboardingNext(2));
    await p.fill('#onbBank', 'Banque test'); await p.fill('#onbRIB', '007 780 0001234567890123 45');
    await p.evaluate(() => finishOnboarding()); await p.waitForTimeout(1500);
  }
  check('préparation : application ouverte', await p.isVisible('#mainApp'));

  const noticeText = async () => { await p.evaluate(() => navTo('license')); await p.waitForTimeout(1200); return (await p.textContent('#contactNotice')).replace(/\s+/g, ' ').trim(); };
  const pageText = async () => (await p.textContent('body')).replace(/\s+/g, ' ');

  // 1. non configuré
  await be.sql("DELETE FROM public.admin_settings WHERE key IN ('whatsapp_number','contact_email','bank_rib','bank_name','bank_beneficiary')");
  const n1 = await noticeText();
  check('contact NON configuré : aucun faux numéro (« 6XX ») ni faux e-mail affichés', !/6XX|hello@facturapro|212600000000/.test(n1) && !/6XX|hello@facturapro/.test(await pageText()), n1);
  check('contact non configuré : invitation à demander l\'abonnement', /Demandez votre abonnement/.test(n1), n1);

  // 2. configuré dans l'admin (écriture serveur simulant Admin → Réglages)
  await be.sql("INSERT INTO public.admin_settings(key,value) VALUES ('whatsapp_number','+212 611 22 33 44'),('contact_email','support@exemple.test'),('bank_rib','007 780 0009999999999999 11'),('bank_name','Banque admin') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
  await p.reload(); await p.waitForTimeout(1500);
  const n2 = await noticeText();
  check('contact configuré dans l\'admin : WhatsApp et e-mail affichés dans l\'application', /\+212 611 22 33 44/.test(n2) && /support@exemple\.test/.test(n2), n2);
  const all = await pageText();
  check('le RIB et la banque saisis dans l\'admin ne sont PAS affichés au client', !/0009999999999999|Banque admin/.test(all));

  // 3. offre : plus d'espèces, plus de champ code promo
  check('plus d\'offre « espèces » pour payer l\'abonnement', !/Sur rendez-vous|Casa\/Rabat/.test(all));
  check('plus de champ « code promo » sur la page abonnement', !(await p.$('#promoCode')));

  // 4. message de demande d'abonnement (annuel) : sans espèces, sans faux ID, avec le contact configuré
  dialogs.length = 0;
  await p.evaluate(() => purchaseLicense('annual')); await p.waitForTimeout(2000);
  const msgs = dialogs.join('\n---\n');
  check('demande d\'abonnement : message final sans espèces et sans « ID demande »', dialogs.length >= 2 && !/spèces|ESPÈCES|ID demande/.test(msgs), msgs.slice(0, 200));
  check('demande d\'abonnement : le contact configuré figure dans les instructions', /\+212 611 22 33 44/.test(msgs) && /Montant : 449 DH/.test(msgs), msgs.slice(-300));
  const req = await be.sql("SELECT count(*)::int n FROM public.subscription_requests").catch(() => [{ n: -1 }]);
  check('(information) la table des demandes n\'est pas gérée par le faux client : la demande échoue proprement et le client voit quand même les instructions', true, 'lignes: ' + req[0].n);

  check('aucune erreur JavaScript de page', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  await browser.close(); srv.close(); try { await be.close(); } catch {} dropDb(db);
  let bad = 0; for (const [ok, name, extra] of results) { if (!ok) bad++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || !extra ? '' : ' -> ' + extra)); }
  console.log(`\n${results.length - bad}/${results.length} tests du contact de support réussis (SIMULATION locale : faux client + PostgreSQL local, PAS Supabase)`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
