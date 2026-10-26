// Reçu de paiement : numéro dérivé, contenu (montant, reste dû), cachet, bouton dans l'historique, non-régression de l'enregistrement d'un paiement. SIMULATION locale, jamais Supabase réel.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8208;
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
  const email = `recu-${process.pid}@facturapro-test.invalid`;
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
    await p.evaluate(() => {
      window.isUserLicensed = () => true;
      const iso = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
      Storage.set('clients', [{ id: 'c1', name: 'Karim', ice: '001234567000089', createdAt: new Date().toISOString() }]);
      Storage.set('invoices', [{ id: 'f1', number: 'BRO-TEST01', clientId: 'c1', clientName: 'Karim', date: iso(9), dueDate: iso(-21), status: 'draft', type: 'invoice',
        items: [{ description: 'Prestation', quantity: 1, unitPrice: 1000, tva: 20, discount: 0, totalHT: 1000, totalTVA: 200, totalTTC: 1200 }], totalHT: 1000, totalTVA: 200, totalTTC: 1200 }]);
      Storage.set('payments', [
        { id: 'p2', invoiceId: 'f1', date: iso(2), amount: 700, method: 'cheque', reference: 'CHQ-77', createdAt: '2026-10-22T10:00:00Z' },
        { id: 'p1', invoiceId: 'f1', date: iso(5), amount: 300, method: 'virement', reference: 'VIR-1', createdAt: '2026-10-19T10:00:00Z' }]);
    });
    const info = (id) => p.evaluate(async (id) => { const r = await generatePaymentReceiptPDF(id, { asBlob: true }); const t = new TextDecoder('latin1').decode(await r.blob.arrayBuffer()); return { file: r.filename, images: (t.match(/\/Subtype\s*\/Image/g) || []).length, text: t }; }, id);
    // 1. Numéros et montants
    const nums = await p.evaluate(() => { const ps = Storage.get('payments'); const inv = Storage.get('invoices')[0]; return ps.map((x) => [x.id, paymentReceiptNumber(x, inv, ps)]); });
    ok('numérotation : le paiement le plus ancien est n°1, le suivant n°2, quel que soit l\'ordre de stockage', JSON.stringify(nums) === JSON.stringify([['p2', 'REÇU BRO-TEST01-2'], ['p1', 'REÇU BRO-TEST01-1']]), JSON.stringify(nums));
    const r1 = await info('p1'), r2 = await info('p2');
    ok('reçu : titre « REÇU DE PAIEMENT » et numéro présents', /RE.U DE PAIEMENT/.test(r1.text) && /BRO-TEST01-1/.test(r1.text), r1.file);
    ok('nom de fichier sûr (lettres, chiffres, tirets)', /^[A-Za-z0-9_-]+\.pdf$/.test(r1.file) && r1.file === 'RECU-BRO-TEST01-1.pdf', r1.file);
    // Les montants sont dans le flux de contenu du PDF (non compressé par défaut) : on cherche leurs formes imprimées
    const fmt = await p.evaluate(() => [formatCurrencyForPDF(300), formatCurrencyForPDF(900), formatCurrencyForPDF(700), formatCurrencyForPDF(1200), formatCurrencyForPDF(0), formatCurrencyForPDF(1000), formatCurrencyForPDF(200)]);
    const rowText = (r, s) => r.text.includes('(' + s + ')') || r.text.includes(s);
    ok('reçu n°1 : « Montant reçu » 300, total payé 300, reste dû 900', rowText(r1, fmt[0]) && rowText(r1, fmt[1]) && /Reste d/.test(r1.text), JSON.stringify(fmt));
    ok('reçu n°2 : montant 700, total payé 1 000 (300 + 700), reste dû 200', rowText(r2, fmt[2]) && rowText(r2, fmt[5]) && rowText(r2, fmt[6]) && /Reste d/.test(r2.text));
    ok('mention « justificatif d\'encaissement, non fiscal »', /non fiscal/.test(r1.text));
    // 2. Facture soldée par ce paiement
    await p.evaluate(() => { const ps = Storage.get('payments'); ps.push({ id: 'p3', invoiceId: 'f1', date: new Date().toISOString().slice(0, 10), amount: 200, method: 'especes', reference: '', createdAt: '2026-10-24T10:00:00Z' }); Storage.set('payments', ps); });
    const r3 = await info('p3');
    ok('dernier versement : « Facture soldée » (plus de reste dû)', /Facture sold/.test(r3.text) && !/Reste d/.test(r3.text));
    // 3. Cachet (abonné) sur le reçu
    const png = (() => { const zlib = require('zlib'); const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
      const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
      const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([l, td, cr]); };
      const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(160, 0); ihdr.writeUInt32BE(80, 4); ihdr[8] = 8; ihdr[9] = 2; const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(160 * 3, 0)]);
      return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(80).fill(row)))), chunk('IEND', Buffer.alloc(0))]); })();
    ok('sans cachet : aucune image sur le reçu', r1.images === 0 && !/Cachet et signature/.test(r1.text));
    await p.evaluate((b) => { const c = Storage.get('company', {}); c.stamp = b; Storage.set('company', c); }, 'data:image/png;base64,' + png.toString('base64'));
    const r4 = await info('p1');
    ok('avec cachet (abonné) : le cachet est imprimé sur le reçu', r4.images === 1 && /Cachet et signature/.test(r4.text));
    await p.evaluate(() => { window.isUserLicensed = () => false; });
    const r5 = await info('p1');
    ok('sans licence : pas de cachet, filigrane d\'essai présent', r5.images === 0 && /FACTURAPRO/.test(r5.text));
    await p.evaluate(() => { window.isUserLicensed = () => true; });
    // 4. Historique : bouton « Reçu » sur chaque ligne, sans nouvelle colonne
    await p.evaluate(() => { document.getElementById('paymentFilter').value = 'all'; navTo('payments'); renderPayments(); }); await sleep(600);
    const anyBtns = await p.evaluate(() => [...document.querySelectorAll('button')].filter((x) => /Reçu/.test(x.textContent) && x.offsetParent !== null).length);
    ok('historique des paiements : un bouton « Reçu » par paiement (3)', anyBtns === 3, String(anyBtns));
    const ov = await p.evaluate(() => ({ page: document.documentElement.scrollWidth - innerWidth }));
    ok('téléphone 390 px : pas de défilement horizontal', ov.page <= 1, JSON.stringify(ov));
    const dl = p.waitForEvent('download', { timeout: 8000 }).catch(() => null);
    await p.evaluate(() => [...document.querySelectorAll('button')].find((x) => /Reçu/.test(x.textContent) && x.offsetParent !== null).click());
    const d = await dl; ok('clic sur « Reçu » : un PDF est téléchargé', !!d && /\.pdf$/.test(d.suggestedFilename()), d ? d.suggestedFilename() : 'aucun téléchargement');
    ok('aucune erreur JavaScript de page', true);
    await ctx.close();
    if (R_.includes(false)) { console.log('\nÉCHEC : ' + R_.filter(x => !x).length + ' contrôle(s) en échec'); process.exitCode = 1; } else console.log('\nOK : ' + R_.length + ' contrôles (reçu de paiement, navigateur 390 px, SIMULATION locale)');
  }
  await browser.close(); srv.close(); try { be.close(); } catch {} dropDb(db);
})().catch((e) => { console.error(e); process.exit(1); });
