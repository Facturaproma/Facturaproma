// Section NAVIGATEUR RÉEL (Chromium) du parcours du premier client (voir scripts/preprod-journey.js).
// app.html (build de préproduction) et admin.html (remplacement de l'URL/clé EN MÉMOIRE, fichier du dépôt inchangé) parlent au VRAI Supabase de préproduction.
// Rien n'est simulé. Seuls window.open (WhatsApp) est intercepté pour lire le message, hCaptcha est bloqué (un script ne peut pas résoudre un défi)
// et les polices externes sont bloquées. Chaque étape est protégée : un échec est consigné et les étapes suivantes continuent quand c'est possible.
const http = require('http'), fs = require('fs'), path = require('path');

exports.run = async function run(h) {
  const { rec, q, q1, CTX, EM, PW, SETTINGS, sleep, clip, jstr, signIn, errOf, T } = h;
  const { chromium } = require('playwright-core');
  const ROOT = path.join(__dirname, '..');
  const BUILD = path.join(ROOT, '.preprod-build');
  if (!fs.existsSync(path.join(BUILD, 'app.html'))) throw new Error('build de préproduction absent : lancer scripts/make-preprod-build.js');
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.ttf': 'font/ttf', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css' };
  const PORT = 8191, BASE = 'http://127.0.0.1:' + PORT;
  const server = http.createServer((rq, rs) => {
    const rel = decodeURIComponent(rq.url.split('?')[0]);
    if (rel === '/admin.html') {   // admin.html du dépôt, URL/clé de PRÉPRODUCTION injectées en mémoire (jamais écrites ; la production n'y figure plus)
      let html = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8')
        .replace(/^const SUPABASE_URL = .*$/m, `const SUPABASE_URL = '${CTX.url}';`)
        .replace(/^const SUPABASE_ANON_KEY = .*$/m, `const SUPABASE_ANON_KEY = '${CTX.key}';`);
      if (html.includes(T.prodRef)) { rs.writeHead(500); return rs.end('REFUS : référence de production présente'); }
      rs.writeHead(200, { 'content-type': TYPES['.html'] }); return rs.end(html);
    }
    const f = path.normalize(path.join(BUILD, rel === '/' ? 'app.html' : rel));
    if (!f.startsWith(BUILD)) { rs.writeHead(403); return rs.end(); }
    fs.readFile(f, (e, d) => { if (e) { rs.writeHead(404); return rs.end('404'); } rs.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); rs.end(d); });
  }).listen(PORT, '127.0.0.1');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const errors = [];
  const until = async (fn, ms = 25000) => { const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t0 > ms) return false; await sleep(250); } };
  const step = async (id, title, fn) => { try { await fn(); } catch (e) { rec(id, title, 'étape exécutée', 'exception : ' + clip(e && e.message, 300), false); } };

  async function newPage(label) {
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(() => { window.__opened = []; window.open = (u) => { window.__opened.push(String(u)); return null; }; });
    const p = await ctx.newPage(); const dlg = [];
    await p.route(/hcaptcha\.com/, (r) => r.abort());
    await p.route(/googleapis|gstatic/, (r) => r.abort());
    p.on('pageerror', (e) => errors.push(label + ' : ' + clip(e.message, 200)));
    p.on('dialog', (d) => { dlg.push(d.message()); d.accept(); });
    return { ctx, p, dlg, label };
  }
  const text = async (p, sel) => ((await p.textContent(sel)) || '').replace(/\s+/g, ' ').trim();
  const body = async (p) => ((await p.textContent('body')) || '').replace(/\s+/g, ' ');

  async function clientLogin(dv) {
    const { p } = dv;
    await p.goto(BASE + '/app.html?mode=login'); await p.waitForTimeout(1500);
    await p.fill('#loginEmail', EM('c')); await p.fill('#loginPassword', PW.c); await p.click('#loginBtn');
    const shown = await until(async () => (await p.isVisible('#mainApp')) || (await p.isVisible('#onbStep1')), 45000);
    if (!shown) throw new Error('connexion client : ni application ni intégration visibles ; texte : ' + clip(await body(p), 200));
    await p.waitForTimeout(800);
    if (!(await p.isVisible('#mainApp'))) {
      await p.evaluate(() => selectStatus(document.querySelector('[onclick*="selectStatus"]').getAttribute('onclick').match(/'(.*?)'/)[1]));
      await p.evaluate(() => onboardingNext(1));
      await p.fill('#onbCompanyName', 'SARL Parcours Test'); await p.fill('#onbICE', '001234567000089');
      await p.evaluate(() => onboardingNext(2));
      await p.fill('#onbBank', 'Banque test'); await p.fill('#onbRIB', '007 780 0001234567890123 45');
      await p.evaluate(() => finishOnboarding()); await p.waitForTimeout(2500);
    }
    await until(() => p.evaluate(() => !!(window.Storage && Storage._currentUserId)), 15000);
  }
  async function openLicense(dv) { await dv.p.evaluate(() => navTo('license')); await dv.p.waitForTimeout(1800); }

  try {
    const cl = await newPage('client'), ad = await newPage('admin');

    // ---------------------------------------------------------------- B1-B2 : connexion du client, contact NON configuré
    let b1 = false;
    await step('B1', 'connexion du client par l\'interface (inscription déjà faite, essai créé)', async () => {
      await clientLogin(cl); b1 = await cl.p.isVisible('#mainApp');
      const lic = await cl.p.evaluate(() => License.get());
      rec('B1', 'connexion du client par l\'interface réelle ; licence d\'essai active', 'application visible, trial active', `${b1 ? 'application visible' : 'absente'} ; ${lic.type}/${lic.status}`, b1 && lic.type === 'trial' && lic.status === 'active', { nature: 'RÉEL (serveur + navigateur)' });
    });
    if (!b1) throw new Error('connexion client impossible : suite du parcours impossible');
    await step('B2', 'contact non configuré', async () => {
      await openLicense(cl);
      const n = await text(cl.p, '#contactNotice'); const b = await body(cl.p);
      rec('B2', 'contact NON configuré : invitation à demander l\'abonnement, aucun faux numéro ni e-mail', 'texte « Demandez votre abonnement » ; pas de 6XX ni hello@', n, /Demandez votre abonnement/.test(n) && !/6XX|hello@facturapro|212600000000/.test(b), { nature: 'RÉEL (serveur + navigateur)' });
      rec('B2b', 'page Licence : aucune offre « espèces » ni champ code promo', 'absents', (await cl.p.$('#promoCode')) ? 'champ promo présent' : (/Sur rendez-vous|Casa\/Rabat/.test(b) ? 'offre espèces présente' : 'absents'), !(await cl.p.$('#promoCode')) && !/Sur rendez-vous|Casa\/Rabat/.test(b), { nature: 'RÉEL (serveur + navigateur)' });
    });

    // ---------------------------------------------------------------- A1-A2 : l'administrateur se connecte et renseigne les réglages (page Réglages réelle)
    let a1 = false;
    await step('A1', 'connexion administrateur', async () => {
      await ad.p.goto(BASE + '/admin.html'); await ad.p.waitForTimeout(1500);
      await ad.p.fill('#adminEmail', EM('a')); await ad.p.fill('#adminPassword', PW.a);
      await ad.p.click('#loginScreen button[onclick="adminLogin()"]');
      a1 = !!(await until(async () => ad.p.evaluate(() => document.getElementById('app').classList.contains('active')), 45000));
      rec('A1', 'connexion de l\'administrateur de test sur admin.html (admin_whoami réel)', 'espace admin visible', a1 ? 'espace admin visible' : 'refus : ' + clip(await text(ad.p, '#adminLoginError').catch(() => ''), 160), a1, { nature: 'RÉEL (serveur + navigateur)' });
    });
    if (a1) {
      await step('A2', 'réglages admin', async () => {
        await ad.p.evaluate(() => navTo('settings')); await ad.p.waitForTimeout(1500);
        await ad.p.fill('#settingsWhatsapp', SETTINGS.whatsapp_number); await ad.p.fill('#settingsBeneficiary', SETTINGS.bank_beneficiary);
        await ad.p.fill('#settingsRIB', SETTINGS.bank_rib); await ad.p.fill('#settingsBank', SETTINGS.bank_name); await ad.p.fill('#settingsEmail', SETTINGS.contact_email);
        await ad.p.evaluate(() => saveSettings()); await ad.p.waitForTimeout(3000);
        const got = Object.fromEntries((await q('SELECT key, value FROM public.admin_settings WHERE key = ANY($1)', [Object.keys(SETTINGS)])).map((r) => [r.key, r.value]));
        rec('A2', 'Admin → Réglages : les 5 réglages sont réellement enregistrés en base (page réelle)', '5 clés avec les valeurs saisies', `${Object.keys(got).length} clés ; identiques : ${Object.keys(SETTINGS).every((k) => got[k] === SETTINGS[k])}`, Object.keys(SETTINGS).every((k) => got[k] === SETTINGS[k]), { nature: 'RÉEL (serveur + navigateur)' });
      });
    }

    // ---------------------------------------------------------------- B3-B5 : contact visible, demande d'abonnement
    await step('B3', 'contact configuré', async () => {
      await cl.p.reload(); await cl.p.waitForTimeout(2500);
      await until(() => cl.p.isVisible('#mainApp'), 30000);
      await openLicense(cl);
      const n = await text(cl.p, '#contactNotice'); const b = await body(cl.p);
      rec('B3', 'contact configuré dans l\'admin : WhatsApp et e-mail affichés au client ; RIB et banque jamais affichés', 'numéro + e-mail visibles ; RIB absent', n, n.includes(SETTINGS.whatsapp_number) && n.includes(SETTINGS.contact_email) && !b.includes(SETTINGS.bank_rib.replace(/\s/g, '')) && !b.includes(SETTINGS.bank_name), { nature: 'RÉEL (serveur + navigateur)' });
    });
    await step('B4', 'demande', async () => {
      cl.dlg.length = 0;
      await cl.p.evaluate(() => purchaseLicense('annual')); await cl.p.waitForTimeout(3500);
      const rowsReq = await q("SELECT id::text id, tier, final_price::float f, status, license_code FROM public.subscription_requests WHERE client_email=$1", [EM('c')]);
      const msgs = cl.dlg.join('\n---\n');
      rec('B4', 'demande d\'abonnement annuel (449 DH) : une ligne « pending » en base, message sans espèces ni faux ID, avec le contact configuré', '1 ligne annual 449 pending ; message avec contact', `${rowsReq.length} ligne(s) ${jstr(rowsReq[0] && { tier: rowsReq[0].tier, f: rowsReq[0].f, status: rowsReq[0].status })} ; message contient le contact: ${msgs.includes(SETTINGS.whatsapp_number)}`,
        rowsReq.length === 1 && rowsReq[0].tier === 'annual' && rowsReq[0].f === 449 && rowsReq[0].status === 'pending' && !rowsReq[0].license_code && msgs.includes(SETTINGS.whatsapp_number) && !/spèces|ESPÈCES|ID demande/.test(msgs) && /Demande envoyée/.test(msgs), { nature: 'RÉEL (serveur + navigateur)' });
    });
    await step('B5', 'doublon', async () => {
      cl.dlg.length = 0;
      await cl.p.evaluate(() => purchaseLicense('annual')); await cl.p.waitForTimeout(3000);
      const n = (await q('SELECT 1 FROM public.subscription_requests WHERE client_email=$1', [EM('c')])).length;
      const msgs = cl.dlg.join('\n---\n');
      rec('B5', 'seconde demande pendant qu\'une est en attente : refusée par le serveur, message « demande déjà en cours », toujours 1 seule ligne', '1 ligne ; message « déjà une demande »', `${n} ligne(s) ; ${/déjà une demande/.test(msgs) ? 'message clair' : clip(msgs, 120)}`, n === 1 && /déjà une demande/.test(msgs) && !/n'a pas pu être envoyée/.test(msgs), { nature: 'RÉEL (serveur + navigateur)' });
    });

    // ---------------------------------------------------------------- A3-A4 : virement (message admin avec RIB de TEST), création du code
    let code = null;
    if (a1) {
      await step('A3', 'message virement', async () => {
        await ad.p.evaluate(() => loadAllData()); await ad.p.waitForTimeout(2500);
        ad.p.evaluate(([e]) => { window.__opened.length = 0; return contactByWhatsApp(e, 'annual', 449); }, [EM('c')]).catch(() => {});
        await ad.p.waitForTimeout(3000);
        const url = (await ad.p.evaluate(() => window.__opened))[0] || '';
        const msg = (() => { try { return decodeURIComponent(url.split('text=')[1] || ''); } catch { return ''; } })();
        rec('A3', 'message WhatsApp de l\'admin (virement) : RIB, bénéficiaire et banque lus dans les Réglages ; jamais « [À COMPLÉTER] »', 'RIB de test présent, pas de « À COMPLÉTER »', `message ${msg ? 'généré' : 'ABSENT'} ; RIB: ${msg.includes(SETTINGS.bank_rib)} ; bénéficiaire: ${msg.includes(SETTINGS.bank_beneficiary)} ; banque: ${msg.includes(SETTINGS.bank_name)} ; placeholder: ${/COMPLÉTER/i.test(msg)}`,
          !!msg && msg.includes(SETTINGS.bank_rib) && msg.includes(SETTINGS.bank_beneficiary) && msg.includes(SETTINGS.bank_name) && !/COMPLÉTER/i.test(msg) && msg.includes(EM('c')), { nature: 'RÉEL (serveur + navigateur)' });
      });
      await step('A4', 'création du code', async () => {
        const req = await q1("SELECT id::text id FROM public.subscription_requests WHERE client_email=$1 AND status='pending'", [EM('c')]);
        if (!req) throw new Error('demande en attente introuvable');
        ad.dlg.length = 0;
        await ad.p.evaluate(() => { window.__opened.length = 0; });
        ad.p.evaluate(([id, e]) => processRequest(id, e, 'annual'), [req.id, EM('c')]).catch(() => {});
        await ad.p.waitForTimeout(4500);
        const r = await q1("SELECT status, license_code FROM public.subscription_requests WHERE client_email=$1", [EM('c')]);
        const cr = await q1("SELECT code, type, status, client_email FROM public.admin_codes WHERE lower(client_email)=$1", [EM('c')]);
        code = cr && cr.code;
        const opened = (await ad.p.evaluate(() => window.__opened))[0] || '';
        const msg = (() => { try { return decodeURIComponent(opened.split('text=')[1] || ''); } catch { return ''; } })();
        rec('A4', 'Admin → Demandes → « Générer le code » : code au format attendu par l\'application, lié à l\'e-mail du client ; demande « processed » ; message prêt à envoyer', 'code FP-XXXX-XXXX-XXXX annual pending ; demande processed ; message contenant le code', `${code ? 'code ' + code.replace(/.(?=.{4})/g, '*') : 'AUCUN code'} ; ${jstr(cr && { type: cr.type, status: cr.status })} ; demande ${r && r.status} ; message avec code: ${!!code && msg.includes(code)}`,
          !!code && /^FP-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code) && cr.type === 'annual' && cr.status === 'pending' && r.status === 'processed' && r.license_code === code && msg.includes(code), { nature: 'RÉEL (serveur + navigateur)' });
      });
    }

    // ---------------------------------------------------------------- C : activation
    if (code) {
      await step('C0', 'autre compte', async () => {
        const O = await signIn('o'); const r = await O.c.rpc('activate_license', { p_code: code });
        rec('C0', 'le code n\'est pas utilisable par un autre compte (wrong_email), il reste « pending »', 'wrong_email', (r.data && r.data.reason) || errOf(r), r.data && r.data.reason === 'wrong_email' && (await q1('SELECT status FROM public.admin_codes WHERE code=$1', [code])).status === 'pending');
      });
      await step('C1', 'activation par le client', async () => {
        await openLicense(cl);
        cl.dlg.length = 0;
        await cl.p.fill('#licenseCodeInput', code);
        await cl.p.evaluate(() => activateLicense()); await cl.p.waitForTimeout(4500);
        const lic = await q1("SELECT type, status, extract(day FROM expires_at - now())::int days FROM public.licenses WHERE user_id=(SELECT id FROM auth.users WHERE email=$1)", [EM('c')]);
        const used = (await q1('SELECT status FROM public.admin_codes WHERE code=$1', [code])).status;
        const ui = await cl.p.evaluate(() => License.get());
        rec('C1', 'activation du code dans l\'application : licence annuelle active (~365 jours) en base ET dans l\'interface ; code « used »', 'annual active ≈365 j ; code used ; interface annual/active', `base ${jstr(lic)} ; code ${used} ; interface ${ui.type}/${ui.status}`, lic && lic.type === 'annual' && lic.status === 'active' && lic.days >= 363 && lic.days <= 365 && used === 'used' && ui.type === 'annual' && ui.status === 'active', { nature: 'RÉEL (serveur + navigateur)' });
      });
      await step('C2', 'réutilisation', async () => {
        const C = await signIn('c'); const O = await signIn('o');
        const r1 = await C.c.rpc('activate_license', { p_code: code }), r2 = await O.c.rpc('activate_license', { p_code: code });
        rec('C2', 'réutilisation du code refusée (used) pour le client et pour un autre compte', 'used / used', `${r1.data && r1.data.reason} / ${r2.data && r2.data.reason}`, r1.data && r1.data.reason === 'used' && r2.data && r2.data.reason === 'used');
      });
      await step('C3', 'assistance après activation', async () => {
        await openLicense(cl);
        const n = await text(cl.p, '#contactNotice'); const b = await body(cl.p);
        rec('C3', 'assistance : après activation, la page Licence affiche toujours le contact configuré et l\'abonnement actif', 'contact visible ; abonnement annuel actif', `${n.includes(SETTINGS.whatsapp_number) && n.includes(SETTINGS.contact_email) ? 'contact visible' : 'contact ABSENT'} ; ${/Annuel|annuel/.test(b) ? 'abonnement annuel affiché' : 'abonnement non affiché'}`, n.includes(SETTINGS.whatsapp_number) && n.includes(SETTINGS.contact_email) && /Annuel|annuel/.test(b), { nature: 'RÉEL (serveur + navigateur)' });
      });
    }
    rec('B9', 'aucune erreur JavaScript de page pendant le parcours (client et admin)', '0', errors.length ? clip(errors.slice(0, 3).join(' | '), 300) : '0', errors.length === 0, { nature: 'RÉEL (navigateur)' });
  } finally {
    await browser.close(); server.close();
  }
};
