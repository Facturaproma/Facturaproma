// Numérotation de départ, exemples PDF, sauvegarde technique (export/import). SIMULATION locale (faux Supabase), pas une validation réelle.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8209;
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
  const email = `ent-${process.pid}@facturapro-test.invalid`;
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
    await p.evaluate(() => { window.isUserLicensed = () => true; });
    // ---------- 1. Numérotation de départ ----------
    await p.evaluate(() => { navTo('company'); });
    const f = async (sel, v) => { await p.evaluate(([s, x]) => { const e = document.querySelector(s); e.disabled = false; e.value = x; }, [sel, v]); };
    const y = new Date().getFullYear();
    ok('champs de départ présents et à 0', await p.evaluate(() => ['cmpStartInvoice', 'cmpStartQuote', 'cmpStartCredit'].every((i) => document.getElementById(i) && document.getElementById(i).value === '0' && !document.getElementById(i).disabled)));
    await f('#cmpStartInvoice', '42'); await f('#cmpStartQuote', '7');
    await p.evaluate(() => saveCompany());
    const prev = await p.evaluate(() => [getNextNumberPreview('invoice'), getNextNumberPreview('quote'), getNextNumberPreview('credit')]);
    ok('départ 42 → prochaine facture 043, devis 008, avoir 001', prev[0].endsWith('-' + y + '-043') && prev[1].endsWith('-' + y + '-008') && prev[2].endsWith('-' + y + '-001'), JSON.stringify(prev));
    for (const bad of ['-1', '1.5', '1000001']) {
      await f('#cmpStartInvoice', bad);
      const r = await p.evaluate(() => { const before = JSON.stringify(Storage.get('counter')); const okk = applyStartNumbers(); return { okk, same: before === JSON.stringify(Storage.get('counter')) }; });
      ok('valeur refusée « ' + bad + ' » (rien modifié)', r.okk === false && r.same);
    }
    await f('#cmpStartInvoice', '42');
    // première émission : le serveur reçoit le plancher 42 puis attribue 43
    await p.evaluate(() => {
      Storage.set('clients', [{ id: 'c1', name: 'Karim', createdAt: new Date().toISOString() }]);
    });
    const issued = await p.evaluate(async () => { try { return await getNextNumber('invoice'); } catch (e) { return 'ERR ' + e.message; } });
    ok('première attribution serveur = 43 (plancher 42 + 1)', issued.endsWith('-' + y + '-043'), issued);
    // un document émis verrouille le champ
    await p.evaluate(() => { const g = Storage.get.bind(Storage); window.__g = g; Storage.get = (k, d) => k === 'invoices' ? [{ id: 'z1', number: 'FAC-' + new Date().getFullYear() + '-043', type: 'invoice', status: 'sent' }] : g(k, d); updateStartNumbersSection(); });
    ok('après émission : champ factures verrouillé, devis encore libre', await p.evaluate(() => document.getElementById('cmpStartInvoice').disabled === true && document.getElementById('cmpStartQuote').disabled === false));
    await p.evaluate(() => { Storage.get = window.__g; });
    // ---------- 2. Exemples ----------
    const before = await p.evaluate(() => JSON.stringify([Storage.get('invoices'), Storage.get('payments'), Storage.get('counter'), Storage.get('docLog')]));
    const sample = async (kind) => p.evaluate(async (kind) => { const sm = buildSampleData(); const r = kind === 'inv' ? await generatePDF(sm.invoice.id, 'invoice', { sample: sm.invoice, asBlob: true }) : await generatePaymentReceiptPDF(sm.payment.id, { sample: sm, asBlob: true }); const t = new TextDecoder('latin1').decode(await r.blob.arrayBuffer()); return { file: r.filename, text: t, size: r.blob.size }; }, kind);
    const si = await sample('inv'), sr = await sample('rec');
    ok('facture d\'exemple : fichier EXEMPLE-facture.pdf, filigrane EXEMPLE, client fictif', si.file === 'EXEMPLE-facture.pdf' && /EXEMPLE/.test(si.text) && /CLIENT EXEMPLE/.test(si.text) && si.size > 2000, si.file);
    ok('reçu d\'exemple : fichier EXEMPLE-recu.pdf, filigrane EXEMPLE', sr.file === 'EXEMPLE-recu.pdf' && /EXEMPLE/.test(sr.text) && /RE.U DE PAIEMENT/.test(sr.text), sr.file);
    const after = await p.evaluate(() => JSON.stringify([Storage.get('invoices'), Storage.get('payments'), Storage.get('counter'), Storage.get('docLog')]));
    ok('exemples : aucune facture, paiement, compteur ni journal modifié', before === after);
    const dl = p.waitForEvent('download', { timeout: 8000 }).catch(() => null);
    await p.evaluate(() => document.getElementById('sampleInvoiceBtn').click());
    const d1 = await dl; ok('bouton « Facture d\'exemple » : un PDF est téléchargé', !!d1 && d1.suggestedFilename() === 'EXEMPLE-facture.pdf');
    // ---------- 3. Sauvegarde technique ----------
    ok('export retiré de la zone de danger, carte dédiée présente', await p.evaluate(() => { const danger = [...document.querySelectorAll('.aside-card')].find((c) => /Zone de danger/.test(c.textContent)); return !!danger && !/exportData/.test(danger.innerHTML) && !!document.getElementById('techBackupCard') && /Sauvegarde technique \(JSON\)/.test(document.getElementById('techBackupCard').textContent); }));
    const exp = await p.evaluate(() => new Promise((res) => { const orig = URL.createObjectURL; URL.createObjectURL = (b) => { b.text().then((t) => res({ t })); return orig.call(URL, b); }; exportData(); }));
    const ej = JSON.parse(exp.t);
    ok('export : format et version déclarés', ej.format === 'facturapro-sauvegarde-technique' && ej.version === 1 && Array.isArray(ej.clients));
    const plan = (obj) => p.evaluate((o) => { const cur = { clients: Storage.get('clients', []), products: Storage.get('products', []), invoices: Storage.get('invoices', []), quotes: Storage.get('quotes', []) }; return planTechnicalImport(JSON.parse(JSON.stringify(o)), cur); }, obj);
    ok('import : texte non reconnu refusé', (await plan(['x'])).errors.length === 1 && (await plan({ a: 1 })).errors.length === 1);
    ok('import : version inconnue refusée', (await plan({ format: 'facturapro-sauvegarde-technique', version: 9, clients: [] })).errors.length === 1);
    ok('import : champ non-liste refusé', (await plan({ format: 'facturapro-sauvegarde-technique', version: 1, clients: {} })).errors.length === 1);
    const pl = await plan({ format: 'facturapro-sauvegarde-technique', version: 1,
      clients: [{ id: 'c1', name: 'Doublon' }, { id: 'c9', name: 'Nouveau' }, { id: 'c10' }, { name: 'sans id' }],
      invoices: [{ id: 'z1', number: 'FAC-1', status: 'sent', items: [] }, { id: 'zN', number: 'FAC-2', status: 'sent', items: [] }, { id: 'b1', number: 'BRO-AAAAAA', status: 'draft', items: [], clientName: 'x', __proto__: { evil: 1 } }],
      quotes: [{ id: 'q1', number: 'DEV-1', items: [] }], payments: [{ id: 'p1' }, { id: 'p2' }], counter: { invoice: 9999 }, company: { name: 'Pirate' } });
    ok('plan : 1 client ajouté, 1 doublon, 2 invalides', pl.add.clients.length === 1 && pl.add.clients[0].id === 'c9' && pl.skipped.duplicates >= 1 && pl.skipped.invalid >= 2, JSON.stringify(pl.skipped));
    ok('plan : factures émises jamais importées, brouillon accepté', pl.add.invoices.length === 1 && pl.add.invoices[0].id === 'b1' && pl.skipped.issuedInvoices === 2);
    ok('plan : paiements non importés (2 ignorés), devis ajouté', pl.skipped.payments === 2 && pl.add.quotes.length === 1);
    ok('plan : le plan ne contient ni compteur ni entreprise', !('counter' in pl.add) && !('company' in pl.add));
    // import réel via le champ fichier
    const file = { format: 'facturapro-sauvegarde-technique', version: 1, clients: [{ id: 'c9', name: 'Nouveau' }, { id: 'c1', name: 'ECRASE?' }], products: [{ id: 'pr1', name: 'Produit importé' }], counter: { invoice: 9999 }, company: { name: 'Pirate' } };
    const snapC = await p.evaluate(() => JSON.stringify([Storage.get('company'), Storage.get('counter')]));
    await p.setInputFiles('#techBackupFile', { name: 'sauv.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) }); await sleep(600);
    const imp = await p.evaluate(() => ({ cl: Storage.get('clients').map((c) => c.id + ':' + c.name), pr: Storage.get('products').map((x) => x.id), snap: JSON.stringify([Storage.get('company'), Storage.get('counter')]) }));
    ok('import réel : client et produit ajoutés, client existant NON écrasé', imp.cl.includes('c9:Nouveau') && imp.cl.includes('c1:Karim') && !imp.cl.some((x) => /ECRASE/.test(x)) && imp.pr.includes('pr1'), JSON.stringify(imp.cl));
    ok('import réel : entreprise et compteur inchangés', imp.snap === snapC);
    await p.setInputFiles('#techBackupFile', { name: 'mauvais.json', mimeType: 'application/json', buffer: Buffer.from('{pas du json') }); await sleep(400);
    ok('fichier illisible : rien modifié', JSON.stringify(await p.evaluate(() => Storage.get('clients').length)) === '2');
    const ov = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    ok('téléphone 390 px : pas de défilement horizontal', ov <= 1, String(ov));
    await ctx.close();
    if (R_.includes(false)) { console.log('\nÉCHEC : ' + R_.filter(x => !x).length + ' contrôle(s) en échec'); process.exitCode = 1; } else console.log('\nOK : ' + R_.length + ' contrôles (simulation locale)');
  }
  await browser.close(); srv.close(); try { be.close(); } catch {} dropDb(db);
})().catch((e) => { console.error(e); process.exit(1); });
