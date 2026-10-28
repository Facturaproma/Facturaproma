// Relances WhatsApp : niveau selon le retard, texte issu des modèles, lien wa.me (numéro marocain local -> international),
// bouton sur la page Relances. Mode LOCAL (sans Supabase, sans secret). Lancer : node tests/relances-whatsapp.browser.test.js
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const PORT = 8153;
const srv = http.createServer((q, r) => {
  let u = '/'; try { u = decodeURIComponent(q.url.split('?')[0]); } catch (e) { r.writeHead(400); return r.end(); }
  const f = path.resolve(ROOT, '.' + path.posix.normalize('/' + (u === '/' ? 'app.html' : u)));
  if (f !== ROOT && !f.startsWith(ROOT + path.sep)) { r.writeHead(403); return r.end(); }
  fs.readFile(f, (e, d) => {
    if (e) { r.writeHead(404); return r.end(); }
    let body = d;
    if (f.endsWith('app.html')) {
      body = d.toString('utf8')
        .replace(/^const SUPABASE_URL = .*$/m, "const SUPABASE_URL = 'YOUR_SUPABASE_URL';")
        .replace(/^const SUPABASE_ANON_KEY = .*$/m, "const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';");
    }
    r.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
    r.end(body);
  });
}).listen(PORT);

const nm = (...s) => path.join(ROOT, 'node_modules', ...s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (n, c, x = '') => { results.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? ' ' + x : '')); };

(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => d.accept());
  await p.route('**/jspdf.umd.min.js', (r) => r.fulfill({ path: nm('jspdf', 'dist', 'jspdf.umd.min.js'), contentType: 'text/javascript' }));
  await p.route('**/jspdf.plugin.autotable.min.js', (r) => r.fulfill({ path: nm('jspdf-autotable', 'dist', 'jspdf.plugin.autotable.min.js'), contentType: 'text/javascript' }));
  await p.route(/googleapis|gstatic|jsdelivr|hcaptcha/, (r) => r.abort());

  await p.goto(`http://localhost:${PORT}/app.html?mode=login`); await sleep(800);
  await p.evaluate(() => { const t = [...document.querySelectorAll('button,div,a')].find((e) => e.textContent.trim() === 'Inscription'); t && t.click(); });
  await p.fill('#signupEmail', 'relance@example.invalid'); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345');
  await p.click('#signupBtn'); await sleep(1500);
  await p.evaluate(() => selectStatus(document.querySelector('[onclick*="selectStatus"]').getAttribute('onclick').match(/'(.*?)'/)[1]));
  await p.evaluate(() => onboardingNext(1));
  await p.fill('#onbCompanyName', 'Atelier Atlas SARL'); await p.fill('#onbICE', '001234567000089'); await p.evaluate(() => onboardingNext(2));
  await p.fill('#onbBank', 'Banque test'); await p.fill('#onbRIB', '007 780 0001234567890123 45'); await p.evaluate(() => finishOnboarding()); await sleep(1800);

  // --- fonctions pures ---
  const pure = await p.evaluate(() => ({
    levels: [0, 7, 14, 15, 29, 30, 90].map(reminderLevelForDays),
    local06: reminderWhatsAppUrl('06 61 23 45 67', 'a b'),
    local07: reminderWhatsAppUrl('0712345678', 'x'),
    intl: reminderWhatsAppUrl('+212 6 61 23 45 67', 'x'),
    none: reminderWhatsAppUrl('', 'x'),
    encoded: reminderWhatsAppUrl('0661234567', 'Bonjour & merci\nà vous'),
  }));
  ok('niveaux : <15 j = 1, 15-29 j = 2, 30 j et plus = 3', JSON.stringify(pure.levels) === JSON.stringify([1, 1, 1, 2, 2, 3, 3]), JSON.stringify(pure.levels));
  ok('numéro 06 local -> 212 (international)', pure.local06.startsWith('https://wa.me/212661234567?text='), pure.local06);
  ok('numéro 07 local -> 212', pure.local07.startsWith('https://wa.me/212712345678?text='));
  ok('numéro déjà international conservé', pure.intl.startsWith('https://wa.me/212661234567?text='));
  ok('sans numéro : wa.me sans contact (l\'utilisateur choisit)', pure.none.startsWith('https://wa.me/?text='));
  ok('texte encodé (esperluette, saut de ligne)', pure.encoded.includes('%26') && pure.encoded.includes('%0A') && !pure.encoded.includes(' &'));

  // --- données : 3 factures en retard (9 j, 20 j, 45 j), la 2e partiellement payée ---
  await p.evaluate(() => {
    window.isUserLicensed = () => true;
    const iso = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    const inv = (id, num, due) => ({ id, number: num, clientId: 'c1', clientName: 'Karim', date: iso(due + 30), dueDate: iso(due), status: 'sent', type: 'invoice',
      items: [{ description: 'Prestation', quantity: 1, unitPrice: 1000, tva: 20, discount: 0, totalHT: 1000, totalTVA: 200, totalTTC: 1200 }], totalHT: 1000, totalTVA: 200, totalTTC: 1200 });
    Storage.set('clients', [{ id: 'c1', name: 'Karim', phone: '0661234567', email: 'k@example.invalid', createdAt: new Date().toISOString() }]);
    Storage.set('invoices', [inv('f1', 'F-2026-001', 9), inv('f2', 'F-2026-002', 20), inv('f3', 'F-2026-003', 45)]);
    Storage.set('payments', [{ id: 'p1', invoiceId: 'f2', date: iso(3), amount: 500, method: 'virement', reference: 'VIR-1', createdAt: new Date().toISOString() }]);
    window.__opened = [];
    window.open = (u) => { window.__opened.push(u); return null; };
    navTo('reminders');
  });
  await sleep(500);

  const decode = (u) => decodeURIComponent(u.split('?text=')[1]);
  const btns = await p.evaluate(() => [...document.querySelectorAll('#remindersList button')].map((x) => x.textContent.trim()));
  ok('page Relances : un bouton WhatsApp et un bouton e-mail par facture en retard', btns.filter((t) => /WhatsApp/.test(t)).length === 3 && btns.filter((t) => /email/i.test(t)).length === 3, JSON.stringify(btns));

  const msg = async (id, lvl) => {
    await p.evaluate(([i, l]) => { window.__opened = []; sendReminderWhatsApp(i, l); }, [id, lvl]);
    const u = await p.evaluate(() => window.__opened[0]);
    return { u, t: decode(u) };
  };
  const m1 = await msg('f1');
  ok('f1 (9 j) : niveau 1, numéro du client, numéro de facture et montant restant', m1.u.startsWith('https://wa.me/212661234567') && /F-2026-001/.test(m1.t) && /1[\s  ]200,00/.test(m1.t), m1.t.slice(0, 120));
  ok('niveau 1 : RIB ajouté pour faciliter le virement', /RIB : 007 780/.test(m1.t));
  const m2 = await msg('f2');
  ok('f2 (20 j, 500 DH payés) : niveau 2 et montant restant 700,00', /Suite à mon précédent message/.test(m2.t) && /700,00/.test(m2.t) && !/1[\s  ]200,00/.test(m2.t), m2.t.slice(0, 160));
  const m3 = await msg('f3');
  ok('f3 (45 j) : mise en demeure, sans RIB', /mise en demeure|procédure de recouvrement/i.test(m3.t) && !/RIB :/.test(m3.t));

  // modèle personnalisé pris en compte
  await p.evaluate(() => Storage.set('reminderTemplates', { level1: 'Salam {CLIENT}, facture {NUMERO} de {MONTANT} DH échue le {ECHEANCE}. {ENTREPRISE}', level2: '', level3: '' }));
  const mc = await msg('f1', 1);
  ok('modèle personnalisé du niveau 1 appliqué (variables remplacées)', /^Salam Karim, facture F-2026-001 de 1[\s  ]200,00 DH échue le /.test(mc.t) && /Atelier Atlas SARL/.test(mc.t), mc.t.slice(0, 100));

  // bouton « Relancer » du tableau de bord = même mécanisme
  await p.evaluate(() => { window.__opened = []; quickRelance('f2'); });
  const q = await p.evaluate(() => window.__opened[0]);
  ok('quickRelance (tableau de bord) passe par le modèle du niveau', q && /wa\.me\/212661234567/.test(q) && /700,00/.test(decode(q)));

  // e-mail : toujours fonctionnel, avec le retard réel affiché
  await p.evaluate(() => generateReminderEmail('f3', 3));
  const email = await p.evaluate(() => ({ to: document.getElementById('emailTo').value, body: document.getElementById('emailBody').value, head: document.getElementById('emailBody').closest('.modal-content').querySelector('p').textContent }));
  ok('e-mail de relance : destinataire, texte et nombre de jours de retard (45)', email.to === 'k@example.invalid' && /F-2026-003/.test(email.body) && /45 jours/.test(email.head), email.head);

  ok('aucune erreur JavaScript', errors.length === 0, errors.join(' | '));
  await b.close(); srv.close();
  const fail = results.filter((x) => !x).length;
  console.log(fail ? `${fail} ÉCHEC(S)` : `OK : ${results.length} vérifications`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
