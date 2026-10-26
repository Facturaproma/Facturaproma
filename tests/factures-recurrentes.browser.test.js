// Factures récurrentes : calcul des dates, brouillons (jamais émis), idempotence, pause, interface. Mode LOCAL (sans Supabase, sans secret).
// Lancer : node tests/factures-recurrentes.browser.test.js
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const PORT = 8154;
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
  await p.fill('#signupEmail', 'recur@example.invalid'); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345');
  await p.click('#signupBtn'); await sleep(1500);
  await p.evaluate(() => selectStatus(document.querySelector('[onclick*="selectStatus"]').getAttribute('onclick').match(/'(.*?)'/)[1]));
  await p.evaluate(() => onboardingNext(1));
  await p.fill('#onbCompanyName', 'Atelier Atlas SARL'); await p.fill('#onbICE', '001234567000089'); await p.evaluate(() => onboardingNext(2));
  await p.fill('#onbBank', 'Banque test'); await p.fill('#onbRIB', '007 780 0001234567890123 45'); await p.evaluate(() => finishOnboarding()); await sleep(1800);

  // --- dates (pures) ---
  const d = await p.evaluate(() => ({
    a: recurringAddMonths('2026-01-31', 1, 31), b: recurringAddMonths('2026-02-28', 1, 31), c: recurringAddMonths('2026-11-15', 3, 15),
    y: recurringAddMonths('2026-02-28', 12, 29), dec: recurringAddMonths('2026-12-10', 1, 10), leap: recurringAddMonths('2027-12-29', 2, 29), bad: recurringAddMonths('x', 1),
    days: recurringAddDays('2026-10-31', 30),
  }));
  ok('31 janv. + 1 mois = 28 févr. (fin de mois)', d.a === '2026-02-28', d.a);
  ok('jour d\'ancrage conservé : 28 févr. + 1 mois (ancre 31) = 31 mars', d.b === '2026-03-31', d.b);
  ok('trimestre : 15 nov. 2026 + 3 mois = 15 févr. 2027', d.c === '2027-02-15', d.c);
  ok('annuel : 28 févr. 2026 (ancre 29) + 12 mois = 28 févr. 2027', d.y === '2027-02-28', d.y);
  ok('passage d\'année : 10 déc. + 1 mois = 10 janv.', d.dec === '2027-01-10', d.dec);
  ok('année bissextile : 29 déc. 2027 + 2 mois (ancre 29) = 29 févr. 2028', d.leap === '2028-02-29', d.leap);
  ok('date invalide : null (pas d\'exception)', d.bad === null);
  ok('échéance : +30 jours', d.days === '2026-11-30', d.days);

  // --- données ---
  await p.evaluate(() => {
    window.isUserLicensed = () => true;
    Storage.set('clients', [{ id: 'c1', name: 'Karim', createdAt: new Date().toISOString() }]);
    Storage.set('invoices', [{ id: 'f1', number: 'F-2026-001', clientId: 'c1', clientName: 'Karim', clientICE: '001234567000089', date: '2026-09-01', dueDate: '2026-10-01', status: 'sent', type: 'invoice', paymentTerms: '30',
      items: [{ description: 'Abonnement', quantity: 1, unitPrice: 1000, tva: 20, discount: 0, totalHT: 1000, totalTVA: 200, totalTTC: 1200 }], totalHT: 1000, totalTVA: 200, totalTTC: 1200, notes: 'Contrat A' }]);
    Storage.set('recurring', []);
  });

  await p.evaluate(() => navTo('invoices')); await sleep(400);
  ok('liste des factures : bouton « Rendre récurrente » et bouton « Récurrentes »', await p.evaluate(() => /Rendre r.currente/.test(document.getElementById('page-invoices').innerHTML) && /Récurrentes/.test(document.querySelector('#page-invoices .topbar').innerHTML)));
  await p.evaluate(() => makeInvoiceRecurring('f1'));
  await p.selectOption('#recFreq', 'monthly');
  const past = await p.evaluate(() => { const t = new Date(); t.setUTCMonth(t.getUTCMonth() - 2); return t.toISOString().slice(0, 10); });
  await p.fill('#recFirst', past);
  await p.evaluate(() => saveRecurring('f1')); await sleep(300);
  const st = await p.evaluate(() => ({ tpl: Storage.get('recurring'), inv: Storage.get('invoices') }));
  const drafts = st.inv.filter((i) => i.recurringId);
  ok('modèle enregistré (mensuel, actif)', st.tpl.length === 1 && st.tpl[0].frequency === 'monthly' && st.tpl[0].active === true);
  ok('première date il y a 2 mois : 3 brouillons rattrapés (il y a 2 mois, 1 mois, aujourd\'hui)', drafts.length === 3, String(drafts.length));
  ok('ce sont des BROUILLONS non numérotés (BRO-), jamais émis', drafts.every((x) => x.status === 'draft' && /^BRO-/.test(x.number) && x.type === 'invoice'));
  ok('lignes et totaux repris du modèle (1 200 TTC), même client', drafts.every((x) => x.totalTTC === 1200 && x.items.length === 1 && x.clientId === 'c1' && x.clientICE === '001234567000089'));
  ok('facture d\'origine inchangée', st.inv.find((i) => i.id === 'f1').status === 'sent' && st.inv.find((i) => i.id === 'f1').number === 'F-2026-001');
  ok('prochaine échéance dans le futur', st.tpl[0].nextDate > new Date().toISOString().slice(0, 10), st.tpl[0].nextDate);

  const again = await p.evaluate(() => generateDueRecurring(todayISO()));
  ok('second passage : 0 brouillon créé', again === 0);
  const dup = await p.evaluate(() => {
    const t = Storage.get('recurring'); t[0].nextDate = t[0].lastGenerated;   // un autre appareil n'avait pas encore avancé la date
    Storage.set('recurring', t);
    const n = generateDueRecurring(todayISO());
    return { n, total: Storage.get('invoices').filter((i) => i.recurringId).length };
  });
  ok('même échéance déjà créée : aucun doublon (identifiant déterministe)', dup.n === 0 && dup.total === 3, JSON.stringify(dup));

  const pause = await p.evaluate(() => {
    const t = Storage.get('recurring'); t[0].active = false; t[0].nextDate = '2020-01-01'; Storage.set('recurring', t);
    return generateDueRecurring(todayISO());
  });
  ok('modèle en pause : rien généré', pause === 0);

  await p.evaluate(() => openRecurringList());
  ok('liste des récurrences affichée avec le client', await p.evaluate(() => /Karim/.test(document.querySelector('.rec-list').textContent) && /En pause/.test(document.querySelector('.rec-list').textContent)));
  await p.evaluate(() => toggleRecurring(Storage.get('recurring')[0].id));
  ok('reprise : le modèle redevient actif', await p.evaluate(() => Storage.get('recurring')[0].active === true));
  await p.evaluate(() => deleteRecurring(Storage.get('recurring')[0].id));
  const after = await p.evaluate(() => ({ t: Storage.get('recurring').length, d: Storage.get('invoices').filter((i) => i.recurringId).length }));
  ok('suppression du modèle : les brouillons déjà créés sont conservés', after.t === 0 && after.d >= 3, JSON.stringify(after));

  await p.evaluate(() => editInvoice(Storage.get('invoices').find((i) => i.recurringId).id)); await sleep(300);
  ok('brouillon récurrent ouvrable dans l\'éditeur', await p.evaluate(() => document.getElementById('page-invoice-editor').classList.contains('active')));

  ok('aucune erreur JavaScript', errors.length === 0, errors.join(' | '));
  await b.close(); srv.close();
  const fail = results.filter((x) => !x).length;
  console.log(fail ? `${fail} ÉCHEC(S)` : `OK : ${results.length} vérifications`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
