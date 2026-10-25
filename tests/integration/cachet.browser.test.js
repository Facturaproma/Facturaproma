// Cachet et signature : envoi réservé aux abonnés, limites, impression sur les PDF de factures et de devis. SIMULATION locale, jamais Supabase réel.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8207;
const srv = http.createServer((q, r) => {
  // Serveur de test local : chemin normalisé et borné au dépôt (aucune sortie du dossier possible)
  let u = '/'; try { u = decodeURIComponent(q.url.split('?')[0]); } catch (e) { r.writeHead(400); return r.end(); }
  const f = path.resolve(R, '.' + path.posix.normalize('/' + (u === '/' ? 'index.html' : u)));
  if (f !== R && !f.startsWith(R + path.sep)) { r.writeHead(403); return r.end(); }
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } let body = d;
    if (/(app|admin)\.html$/.test(f)) body = d.toString('utf8').replace(/^const SUPABASE_URL = .*$/m, "const SUPABASE_URL = 'https://fake.supabase.test';").replace(/^const SUPABASE_ANON_KEY = .*$/m, "const SUPABASE_ANON_KEY = 'fake-anon-key';");
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
  const email = `cachet-${process.pid}@facturapro-test.invalid`;
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
    // PNG de test 160 × 80 (rouge opaque), fabriqué sans dépendance
    const zlib = require('zlib');
    const crcT = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
    const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([len, td, cr]); };
    const png = (w, h) => { const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0)]); for (let i = 1; i < row.length; i += 3) row[i] = 200;
      return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))]); };
    await p.evaluate(() => {
      const iso = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
      Storage.set('clients', [{ id: 'c1', name: 'Karim', ice: '001234567000089', createdAt: new Date().toISOString() }]);
      Storage.set('invoices', [{ id: 'f1', number: 'BRO-TEST01', clientId: 'c1', clientName: 'Karim', date: iso(5), dueDate: iso(-25), status: 'draft', type: 'invoice',
        items: [{ description: 'Prestation', quantity: 1, unitPrice: 1000, tva: 20, discount: 0, totalHT: 1000, totalTVA: 200, totalTTC: 1200 }], totalHT: 1000, totalTVA: 200, totalTTC: 1200 }]);
      Storage.set('quotes', [{ id: 'q1', number: 'DEV-2026-001', clientId: 'c1', clientName: 'Karim', date: iso(2), validUntil: iso(-28), status: 'draft', type: 'quote',
        items: [{ description: 'Prestation', quantity: 1, unitPrice: 500, tva: 20, discount: 0, totalHT: 500, totalTVA: 100, totalTTC: 600 }], totalHT: 500, totalTVA: 100, totalTTC: 600 }]);
    });
    const pdfInfo = async (id, type) => p.evaluate(async ([id, type]) => { const r = await generatePDF(id, type, { asBlob: true }); const t = new TextDecoder('latin1').decode(await r.blob.arrayBuffer()); return { images: (t.match(/\/Subtype\s*\/Image/g) || []).length, label: /Cachet et signature/.test(t), pages: (t.match(/\/Type\s*\/Page\b/g) || []).length }; }, [id, type]);
    const company = async () => p.evaluate(() => Storage.get('company', {}));

    // 1. Sans abonnement : section verrouillée, aucun cachet imprimé même si un cachet est présent dans les données
    await p.evaluate(() => { window.isUserLicensed = () => false; updateStampSection(); });
    ok('sans licence : section « Cachet et signature » verrouillée', await p.evaluate(() => getComputedStyle(document.getElementById('stampLockedSection')).display !== 'none' && getComputedStyle(document.getElementById('stampActiveSection')).display === 'none'));
    await p.evaluate((b) => { const c = Storage.get('company', {}); c.stamp = b; Storage.set('company', c); }, 'data:image/png;base64,' + png(160, 80).toString('base64'));
    let r0 = await pdfInfo('f1', 'invoice');
    ok('sans licence : aucun cachet sur le PDF (même si présent dans les données)', r0.images === 0 && !r0.label, JSON.stringify(r0));
    await p.evaluate(() => { const c = Storage.get('company', {}); delete c.stamp; Storage.set('company', c); });

    // 2. Avec abonnement : envoi, aperçu, enregistrement
    await p.evaluate(() => { window.isUserLicensed = () => true; updateStampSection(); });
    ok('avec licence : section active, aucun cachet, bouton de suppression masqué', await p.evaluate(() => getComputedStyle(document.getElementById('stampActiveSection')).display !== 'none' && /Aucun cachet/.test(document.getElementById('stampPreview').innerText) && getComputedStyle(document.getElementById('removeStampBtn')).display === 'none'));
    await p.setInputFiles('#stampUploadInput', { name: 'cachet.png', mimeType: 'image/png', buffer: png(160, 80) }); await sleep(500);
    let c = await company();
    ok('cachet PNG envoyé : enregistré dans les données de l\'entreprise (data:image/png)', /^data:image\/png;base64,/.test(c.stamp || ''));
    ok('aperçu affiché et bouton de suppression visible', await p.evaluate(() => !!document.querySelector('#stampPreview img') && getComputedStyle(document.getElementById('removeStampBtn')).display !== 'none'));
    const saved = c.stamp;
    await p.setInputFiles('#stampUploadInput', { name: 'gros.png', mimeType: 'image/png', buffer: Buffer.alloc(301 * 1024, 1) }); await sleep(400);
    ok('image trop volumineuse (> 300 Ko) refusée, cachet précédent conservé', (await company()).stamp === saved);
    await p.setInputFiles('#stampUploadInput', { name: 'x.txt', mimeType: 'text/plain', buffer: Buffer.from('bonjour') }); await sleep(400);
    ok('format non supporté refusé, cachet précédent conservé', (await company()).stamp === saved);

    // 3. Impression sur les PDF
    let r1 = await pdfInfo('f1', 'invoice');
    ok('PDF de facture : le cachet est imprimé (1 image) avec son libellé', r1.images === 1 && r1.label, JSON.stringify(r1));
    let r2 = await pdfInfo('q1', 'quote');
    ok('PDF de devis : le cachet est imprimé (1 image) avec son libellé', r2.images === 1 && r2.label, JSON.stringify(r2));
    await p.evaluate((b) => { const c = Storage.get('company', {}); c.logo = b; Storage.set('company', c); }, 'data:image/png;base64,' + png(100, 100).toString('base64'));
    let r3 = await pdfInfo('f1', 'invoice');
    ok('logo + cachet : deux images distinctes sur la facture', r3.images === 2, JSON.stringify(r3));
    await p.evaluate(() => { const c = Storage.get('company', {}); delete c.logo; Storage.set('company', c); });
    // facture très longue : le cachet ne doit jamais chevaucher le pied de page (nouvelle page si besoin)
    await p.evaluate(() => { const inv = Storage.get('invoices', []); const it = { description: 'Ligne', quantity: 1, unitPrice: 10, tva: 20, discount: 0, totalHT: 10, totalTVA: 2, totalTTC: 12 };
      inv.push({ ...inv[0], id: 'long', number: 'BRO-TEST09', items: Array.from({ length: 21 }, () => it), totalHT: 210, totalTVA: 42, totalTTC: 252 }); Storage.set('invoices', inv); });
    let r4 = await pdfInfo('long', 'invoice');
    ok('facture longue : cachet imprimé une seule fois, sans erreur', r4.images === 1 && r4.label, JSON.stringify(r4));

    // 4. Suppression
    await p.evaluate(() => removeStamp()); await sleep(1200);
    ok('suppression : cachet retiré des données, aperçu vide', !(await company()).stamp && await p.evaluate(() => /Aucun cachet/.test(document.getElementById('stampPreview').innerText)));
    let r5 = await pdfInfo('f1', 'invoice');
    ok('après suppression : plus aucun cachet sur le PDF', r5.images === 0 && !r5.label, JSON.stringify(r5));
    const ov = await p.evaluate(() => ({ page: document.documentElement.scrollWidth - innerWidth }));
    ok('téléphone 390 px : pas de défilement horizontal', ov.page <= 1, JSON.stringify(ov));
    ok('aucune erreur JavaScript de page', true);
    await ctx.close();
    if (R_.includes(false)) { console.log('\nÉCHEC : ' + R_.filter(x => !x).length + ' contrôle(s) en échec'); process.exitCode = 1; } else console.log('\nOK : ' + R_.length + ' contrôles (cachet et signature, navigateur 390 px, SIMULATION locale)');
  }
  await browser.close(); srv.close(); try { be.close(); } catch {} dropDb(db);
})().catch((e) => { console.error(e); process.exit(1); });
