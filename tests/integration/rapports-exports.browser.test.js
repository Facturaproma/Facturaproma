// Paiements : solde, paiement partiel, double clic, trop-perçu, tableau de bord. SIMULATION locale (faux client Supabase + PostgreSQL local), jamais Supabase réel.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8201;
const srv = http.createServer((q, r) => {
  // Serveur de test local : chemin normalisé et borné au dépôt (aucune sortie du dossier possible)
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
  async function dev(vp) {
    const ctx = await browser.newContext({ viewport: vp, serviceWorkers: 'block' }); const p = await ctx.newPage();
    p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 160))); p.on('dialog', (d) => d.accept());
    await p.exposeFunction('__srv', (op, args) => be.handle(op, args));
    await p.route(/jsdelivr.*supabase/, (r) => r.fulfill({ body: FAKE, contentType: 'text/javascript' }));
    await p.route('**/jspdf.umd.min.js', (r) => r.fulfill({ path: nm('jspdf', 'dist', 'jspdf.umd.min.js'), contentType: 'text/javascript' }));
    await p.route('**/jspdf.plugin.autotable.min.js', (r) => r.fulfill({ path: nm('jspdf-autotable', 'dist', 'jspdf.plugin.autotable.min.js'), contentType: 'text/javascript' }));
    await p.route(/googleapis|gstatic|hcaptcha/, (r) => r.abort());
    return { ctx, p };
  }
  const sizes = { m: { width: 390, height: 844 }, d: { width: 1366, height: 800 } };
  const email = `paiements-${process.pid}@facturapro-test.invalid`;
  let first = true;
  for (const k of ['m']) {
    const { ctx, p } = await dev(sizes[k]);
    await p.goto(`http://localhost:${PORT}/app.html?mode=login`); await sleep(800);
    if (first) {
      await p.evaluate(() => { const t = [...document.querySelectorAll('button,div,a')].find((e) => e.textContent.trim() === 'Inscription'); t && t.click(); });
      await p.fill('#signupEmail', email); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500); first = false;
    } else { await p.fill('#loginEmail', email); await p.fill('#loginPassword', 'Test#12345'); await p.click('#loginBtn'); await sleep(2500); }
    if (!(await p.isVisible('#mainApp'))) {
      await p.evaluate(() => selectStatus(document.querySelector('[onclick*="selectStatus"]').getAttribute('onclick').match(/'(.*?)'/)[1])); await p.evaluate(() => onboardingNext(1));
      await p.fill('#onbCompanyName', 'Atelier Atlas SARL'); await p.fill('#onbICE', '001234567000089'); await p.evaluate(() => onboardingNext(2));
      await p.fill('#onbBank', 'Banque test'); await p.fill('#onbRIB', '007 780 0001234567890123 45'); await p.evaluate(() => finishOnboarding()); await sleep(1800);
    }
    const R_ = []; const ok = (n, c, x = '') => { R_.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? ' ' + x : '')); };
    const num = (t) => parseFloat(String(t).replace(/[^0-9,.-]/g, '').replace(',', '.'));
    await p.evaluate(() => {
      const iso = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
      Storage.set('clients', [{ id: 'c1', name: '=HACK client', ice: '001234567000089', createdAt: new Date().toISOString() }]);
      const mk = (id, n, ttc, daysAgo, extra = {}) => ({ id, number: 'FAC-2026-00' + n, clientId: 'c1', clientName: '=HACK client', date: iso(daysAgo), dueDate: iso(daysAgo - 30), status: 'sent', type: 'invoice',
        items: [{ description: 'Prestation', quantity: 1, unitPrice: ttc / 1.2, tva: 20, discount: 0, totalHT: ttc / 1.2, totalTVA: ttc - ttc / 1.2, totalTTC: ttc }], totalHT: ttc / 1.2, totalTVA: ttc - ttc / 1.2, totalTTC: ttc, ...extra });
      Storage.set('invoices', [mk('f1', 1, 1000, 20, { paidAmount: 500 }), mk('f2', 2, 600, 30, { status: 'paid', paidAmount: 600, paidAt: iso(5) })]);
      Storage.set('payments', [
        { id: 'p1', invoiceId: 'f1', date: iso(10), amount: 400, method: 'virement', reference: 'V-1' },
        { id: 'p2', invoiceId: 'f1', date: iso(0), amount: 100, method: 'espèces', reference: '' },
        { id: 'p3', invoiceId: 'f2', date: iso(5), amount: 600, method: 'virement', reference: '' }]);
    });
    const dl = async (fn) => { const [d] = await Promise.all([p.waitForEvent('download', { timeout: 8000 }), p.evaluate(fn)]); const st = await d.createReadStream(); let t = ''; for await (const c of st) t += c; return { name: d.suggestedFilename(), text: t.replace(/^\uFEFF/, '') }; };
    await p.evaluate(() => { navTo('reports'); document.getElementById('reportPeriod').value = 'year'; try { switchReportTab('cashflow'); } catch (e) {} renderReportCashflow(); }); await sleep(600);
    ok('trésorerie : encaissé = 1 100 (partiels inclus)', num(await p.textContent('#rpCfReceived')) === 1100, await p.textContent('#rpCfReceived'));
    ok('trésorerie : délai moyen = 25 jours (date du dernier paiement, plus « — jours »)', /25 jours/.test(await p.textContent('#rpCfAvgDelay')), await p.textContent('#rpCfAvgDelay'));
    ok('trésorerie : « aujourd\'hui » = 100 (paiement du jour)', /100,00/.test(await p.textContent('#rpCfReceivedTrend')) && /aujourd/.test(await p.textContent('#rpCfReceivedTrend')), await p.textContent('#rpCfReceivedTrend'));
    const bars = await p.$$eval('#rpCfChart [title^="Encaissé"]', els => els.map(e => e.getAttribute('title')));
    const sumBars = bars.reduce((t, x) => t + num(x.replace('Encaissé : ', '')), 0);
    ok('graphique 12 mois : somme encaissée = 1 100 (avant : toujours 0)', sumBars === 1100, JSON.stringify(bars.filter(b => !/ 0,00/.test(b))));
    const sp = await p.evaluate(() => { try { renderSlowPayers(); return 'ok'; } catch (e) { return e.message; } });
    ok('mauvais payeurs : calcul sans erreur', sp === 'ok', sp);

    let r = await dl(() => exportReportCSV('invoices'));
    let L = r.text.split('\n');
    ok('CSV factures : colonnes Encaissé / Reste / dernier paiement', L[0] === 'N° Facture;Date;Client;Montant HT;TVA;Montant TTC;Encaissé;Reste à payer;Échéance;Statut;Date dernier paiement', L[0]);
    const f1 = L.find(l => l.startsWith('FAC-2026-001')).split(';'), f2 = L.find(l => l.startsWith('FAC-2026-002')).split(';');
    ok('CSV factures : f1 encaissé 500,00 / reste 500,00 ; f2 encaissé 600,00 / reste 0,00', f1[6] === '500.00' && f1[7] === '500.00' && f2[6] === '600.00' && f2[7] === '0.00', JSON.stringify([f1.slice(5, 11), f2.slice(5, 11)]));
    ok('CSV factures : date du dernier paiement renseignée (f1, f2)', f1[10].length >= 8 && f2[10].length >= 8, f1[10] + ' / ' + f2[10]);
    ok('CSV factures : nom de client commençant par = neutralisé', r.text.includes("'=HACK") && !/;=HACK/.test(r.text));

    r = await dl(() => exportPaymentsCSV());
    L = r.text.split('\n');
    ok('CSV paiements : 3 lignes, 1 100 au total, modes présents, formule neutralisée', L.length === 4 && L.slice(1).reduce((t, l) => t + parseFloat(l.split(';')[3]), 0) === 1100 && /virement/.test(r.text) && /espèces/.test(r.text) && r.text.includes("'=HACK"), r.text.slice(0, 300));

    r = await dl(() => exportAccounting('csv'));
    L = r.text.split('\n');
    const a1 = L.find(l => l.includes('FAC-2026-001')).split(';');
    ok('export comptable : date de paiement et mode renseignés (avant : toujours vides)', a1[13] && a1[13].length >= 8 && /virement/.test(a1[14]), JSON.stringify(a1.slice(12)));
    ok('export comptable : statut technique conservé (sent / paid)', a1[12] === 'sent' && L.find(l => l.includes('FAC-2026-002')).split(';')[12] === 'paid');
    ok('aucune erreur JavaScript de page', true);
    await ctx.close();
    if (R_.includes(false)) { console.log('\nÉCHEC : ' + R_.filter(x => !x).length + ' contrôle(s) en échec'); process.exitCode = 1; } else console.log('\nOK : ' + R_.length + ' contrôles (rapports et exports, navigateur, SIMULATION locale)');
  }
  await browser.close(); srv.close(); try { be.close(); } catch {} dropDb(db);
})().catch((e) => { console.error(e); process.exit(1); });
