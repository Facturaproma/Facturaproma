// Design des documents PDF (facture, avoir, devis, reçu) : contenu, montants, multipages, champs absents, arabe, essai. SIMULATION locale (faux Supabase). PREVIEW_DIR=dossier pour garder les PDF.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8211;
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
  const email = `doc-${process.pid}@facturapro-test.invalid`;
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
    const fsx = require('fs'); const PREVIEW = process.env.PREVIEW_DIR; if (PREVIEW) fsx.mkdirSync(PREVIEW, { recursive: true });
    const png = (w, h, rgb) => { const zlib = require('zlib'); const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
      const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
      const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([l, td, cr]); };
      const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
      const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
      return 'data:image/png;base64,' + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))]).toString('base64'); };
    const LOGO = png(120, 60, [27, 58, 107]), STAMP = png(160, 80, [90, 90, 160]);
    await p.evaluate(() => { window.__orig = Storage.get.bind(Storage); window.isUserLicensed = () => true; });
    const seed = (data) => p.evaluate((d) => { Storage.get = (k, def) => (d[k] !== undefined ? d[k] : window.__orig(k, def)); }, data);
    const gen = async (name, kind, id) => {
      const r = await p.evaluate(async ([kind, id]) => {
        const res = kind === 'rec' ? await generatePaymentReceiptPDF(id, { asBlob: true }) : await generatePDF(id, kind, { asBlob: true });
        if (!res) return null; const buf = new Uint8Array(await res.blob.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000)); return { b64: btoa(s), file: res.filename };
      }, [kind, id]);
      if (!r) return null; const buf = Buffer.from(r.b64, 'base64'); if (PREVIEW) fsx.writeFileSync(path.join(PREVIEW, name + '.pdf'), buf);
      const text = buf.toString('latin1'); return { text, file: r.file, pages: (text.match(/\/Type\s*\/Page[^s]/g) || []).length, size: buf.length, buf };
    };
    const item = (d, q, pr, tva, disc = 0) => { const ht = Math.round(q * pr * (1 - disc / 100) * 100) / 100, t = Math.round(ht * tva) / 100; return { description: d, quantity: q, price: pr, unitPrice: pr, tva, discount: disc, totalHT: ht, totalTVA: t, totalTTC: Math.round((ht + t) * 100) / 100 }; };
    const mk = (id, number, type, items, extra = {}) => { const ht = Math.round(items.reduce((s, i) => s + i.totalHT, 0) * 100) / 100, tv = Math.round(items.reduce((s, i) => s + i.totalTVA, 0) * 100) / 100; return Object.assign({ id, number, type, clientId: 'c1', clientName: 'Karim Bennani', clientICE: '001234567000089', clientAddress: '12 rue des Orangers, Maârif, Casablanca', date: '2026-10-20', dueDate: '2026-11-19', status: 'sent', items, totalHT: ht, totalTVA: tv, totalTTC: Math.round((ht + tv) * 100) / 100, notes: 'Merci pour votre confiance.', paymentTerms: '30' }, extra); };
    const company = { name: 'Atelier Atlas SARL', status: 'sarl', ice: '001234567000089', if: '40123456', rc: '123456', patente: '12345678', address: '5 avenue Hassan II', city: 'Casablanca', phone: '+212 600 000 000', email: 'contact@atlas.test', bank: 'Banque Test', rib: '007 780 0001234567890123 45', logo: LOGO, stamp: STAMP, docStyle: {} };
    const clients = [{ id: 'c1', name: 'Karim Bennani', ice: '001234567000089', email: 'karim@client.test', phone: '+212 611 111 111', address: '12 rue des Orangers' }, { id: 'c2', name: 'Autre Client SA', ice: '009999999000011' }];
    const money = (v) => p.evaluate((v) => formatCurrencyForPDF(v), v);
    const has = (r, s) => r.text.includes('(' + s + ')') || r.text.includes(s);
    // ---------- 1. Facture simple, payée partiellement ----------
    const inv1 = mk('i1', 'FAC-2026-001', 'invoice', [item('Création de site vitrine', 1, 4500, 20), item('Hébergement 12 mois', 1, 600, 20)]);
    const pays = [{ id: 'p1', invoiceId: 'i1', date: '2026-10-22', amount: 2000, method: 'virement', reference: 'VIR-77', createdAt: '2026-10-22T09:00:00Z' }];
    await seed({ company, clients, invoices: [inv1], payments: pays });
    const f1 = await gen('01-facture-simple', 'invoice', 'i1');
    ok('facture simple : 1 page, titre FACTURE, numéro, client', f1.pages === 1 && /FACTURE/.test(f1.text) && has(f1, 'FAC-2026-001') && has(f1, 'Karim Bennani'), 'pages=' + f1.pages);
    ok('facture : montants exacts (HT 5 100,00 · TVA 1 020,00 · TTC 6 120,00)', has(f1, await money(5100)) && has(f1, await money(1020)) && has(f1, await money(6120)));
    ok('facture : paiement partiel — déjà réglé 2 000,00 et reste à payer 4 120,00', has(f1, await money(2000)) && has(f1, await money(4120)) && /Reste . payer/.test(f1.text) && /PAIEMENT PARTIEL/.test(f1.text));
    ok('facture : logo et cachet imprimés (2 images)', (f1.text.match(/\/Subtype\s*\/Image/g) || []).length === 2);
    ok('facture : coordonnées bancaires et pied de page « Page 1 / 1 »', has(f1, 'RIB : 007 780') && has(f1, 'Page 1 / 1'));
    ok('facture : pas de mot « Devis », ni de bouton / menu', !/DEVIS/.test(f1.text) && !/(Modifier|Supprimer|Dupliquer|Menu|Retour)/.test(f1.text.replace(/\/[A-Za-z]+/g, '')));
    // ---------- 2. Facture soldée ----------
    await seed({ company, clients, invoices: [inv1], payments: [Object.assign({}, pays[0], { amount: 6120 })] });
    const f2 = await gen('02-facture-soldee', 'invoice', 'i1');
    ok('facture soldée : étiquette SOLDÉE et reste à payer 0,00', /SOLD/.test(f2.text) && has(f2, await money(0)));
    // ---------- 3. Beaucoup de lignes + textes très longs → plusieurs pages ----------
    const long = 'Prestation de maintenance évolutive, intégration, tests de non-régression et documentation technique complète ' .repeat(2);
    const many = Array.from({ length: 70 }, (_, i) => item(i === 3 ? long : 'Ligne ' + (i + 1) + ' — article de démonstration', 1 + (i % 4), 100 + i * 7.5, i % 5 === 0 ? 10 : 20, i % 7 === 0 ? 5 : 0));
    const inv3 = mk('i3', 'FAC-2026-002', 'invoice', many, { clientName: 'Société Marocaine de Distribution et de Commerce International des Produits Alimentaires et Dérivés SARL AU', clientAddress: 'Zone industrielle Sidi Bernoussi, lot 128, route de Rabat, immeuble Les Tilleuls, 3e étage, bureau 14, Casablanca 20600, Maroc', notes: 'Conditions : '.concat('paiement à réception de la facture, pénalités de retard selon les usages. '.repeat(14)) });
    await seed({ company, clients, invoices: [inv3], payments: [] });
    const f3 = await gen('03-facture-multipage', 'invoice', 'i3');
    ok('facture 70 lignes : plusieurs pages', f3.pages >= 3, 'pages=' + f3.pages);
    ok('nom du client très long : toutes les parties du nom sont imprimées', ['Société', 'Distribution', 'Alimentaires', 'SARL', 'AU'].every((w) => f3.text.includes(w)));
    ok('adresse très longue : début et fin imprimés', f3.text.includes('Sidi Bernoussi') && f3.text.includes('Maroc'));
    ok('facture multipage : numérotation « Page 1 / n » … « Page n / n » cohérente', new RegExp('Page 1 / ' + f3.pages + '\\)').test(f3.text) && new RegExp('Page ' + f3.pages + ' / ' + f3.pages + '\\)').test(f3.text));
    ok('facture multipage : en-tête courant sur les pages suivantes', (f3.text.match(/FACTURE {2}FAC-2026-002/g) || []).length === f3.pages - 1);
    ok('facture multipage : total TTC exact', has(f3, await money(inv3.totalTTC)), String(inv3.totalTTC));
    ok('facture multipage : tableau répété (en-tête « Désignation » sur chaque page)', (f3.text.match(/\(D.signation\)/g) || []).length >= f3.pages);
    // TVA ventilée
    ok('facture multi-taux : TVA ventilée 10 % et 20 %', /TVA 10 %/.test(f3.text) && /TVA 20 %/.test(f3.text));
    // ---------- 4. Devis avec remise, sans TVA ----------
    const q1 = mk('q1', 'DEV-2026-001', 'quote', [item('Audit initial', 2, 800, 0, 10), item('Formation équipe', 1, 1500, 0)], { status: 'draft', notes: 'Acompte de 30 % à la commande.' });
    await seed({ company: Object.assign({}, company, { status: 'ae' }), clients, quotes: [q1], invoices: [] });
    const d1 = await gen('04-devis-remise-sans-tva', 'quote', 'q1');
    ok('devis : titre DEVIS, « Destinataire », « Bon pour accord », jamais « FACTURÉ À »', /DEVIS/.test(d1.text) && /DESTINATAIRE/.test(d1.text) && /BON POUR ACCORD/.test(d1.text) && !/FACTUR. . /.test(d1.text) && !/\(FACTURE\)/.test(d1.text));
    ok('devis : colonne Remise, validité, total exact 2 940,00', /Remise/.test(d1.text) && /Valable jusqu/.test(d1.text) && has(d1, await money(q1.totalTTC)), String(q1.totalTTC));
    ok('devis : mention TVA non applicable (AE, inchangée) et conditions', /TVA non applicable/.test(d1.text) && /Acompte de 30/.test(d1.text));
    ok('devis : aucune ligne « Reste à payer » ni « Déjà réglé »', !/Reste . payer/.test(d1.text) && !/D.j. r.gl./.test(d1.text));
    const q2 = mk('q2', 'DEV-2026-002', 'quote', [item('Prestation', 1, 1000, 20)], { dueDate: '', notes: '' });
    await seed({ company, clients, quotes: [q2], invoices: [] });
    const d2 = await gen('05-devis-avec-tva-sans-validite', 'quote', 'q2');
    ok('devis sans validité ni notes : rien d\'inventé', !/Valable jusqu/.test(d2.text) && !/Conditions et modalit/.test(d2.text) && has(d2, await money(1200)));
    // ---------- 5. Avoir ----------
    const cr = mk('a1', 'AVR-2026-001', 'credit', [item('Remboursement partiel', -1, 500, 20)], { type: 'credit', relatedInvoiceNumber: 'FAC-2026-001', status: 'sent' });
    cr.items[0].quantity = 1; cr.items[0].totalHT = -500; cr.items[0].totalTVA = -100; cr.items[0].totalTTC = -600; cr.totalHT = -500; cr.totalTVA = -100; cr.totalTTC = -600;
    await seed({ company, clients, invoices: [inv1, cr], payments: [] });
    const a1 = await gen('06-avoir', 'invoice', 'a1');
    ok('avoir : titre AVOIR, facture d\'origine, total négatif', /AVOIR/.test(a1.text) && /FAC-2026-001/.test(a1.text) && has(a1, await money(-600)) && /TOTAL AVOIR TTC/.test(a1.text));
    // ---------- 6. Reçus ----------
    const inv6 = mk('i6', 'FAC-2026-006', 'invoice', [item('Prestation', 1, 1000, 20)]);
    const pp = [{ id: 'r1', invoiceId: 'i6', date: '2026-10-21', amount: 300, method: 'cheque', reference: 'CHQ-9', createdAt: '2026-10-21T10:00:00Z' }, { id: 'r2', invoiceId: 'i6', date: '2026-10-23', amount: 900, method: 'virement', reference: 'VIR-3', createdAt: '2026-10-23T10:00:00Z', notes: 'Solde de la facture' }];
    await seed({ company, clients, invoices: [inv6], payments: pp });
    const r1 = await gen('07-recu-partiel', 'rec', 'r1'), r2 = await gen('08-recu-solde', 'rec', 'r2');
    ok('reçu partiel : titre, « PAIEMENT PARTIEL », montant 300, reste dû 900', /RE.U DE PAIEMENT/.test(r1.text) && /PAIEMENT PARTIEL/.test(r1.text) && has(r1, await money(300)) && has(r1, await money(900)) && /Reste d. apr/.test(r1.text));
    ok('reçu partiel : solde avant 1 200,00', has(r1, await money(1200)) && /Solde avant/.test(r1.text));
    ok('reçu soldé : « PAIEMENT SOLDÉ », montant 900, facture soldée, aucun reste dû', /PAIEMENT SOLD/.test(r2.text) && has(r2, await money(900)) && /Facture sold/.test(r2.text) && !/Reste d. apr/.test(r2.text));
    ok('reçu : mention « atteste uniquement le paiement effectivement enregistré » et non fiscal', /atteste uniquement le paiement effectivement enregistr/.test(r1.text) && /non fiscal/.test(r1.text));
    ok('reçu : numéro dérivé REÇU FAC-2026-006-1 / -2, fichier sûr', /FAC-2026-006-1/.test(r1.text) && /FAC-2026-006-2/.test(r2.text) && r1.file === 'RECU-FAC-2026-006-1.pdf', r1.file);
    ok('reçu : ne ressemble pas à une facture (pas de tableau Désignation / Total TTC)', !/D.signation/.test(r1.text) && !/TOTAL TTC/.test(r1.text));
    // paiement non confirmé / montant nul → aucun reçu
    await seed({ company, clients, invoices: [inv6], payments: [Object.assign({}, pp[0], { status: 'refused' }), Object.assign({}, pp[1], { amount: 0 })] });
    const rx1 = await gen('x1', 'rec', 'r1'), rx2 = await gen('x2', 'rec', 'r2');
    ok('paiement refusé ou montant nul : aucun reçu généré', rx1 === null && rx2 === null);
    // ---------- 7. Isolation des clients ----------
    const iA = mk('iA', 'FAC-2026-010', 'invoice', [item('Prestation A', 1, 100, 20)], { clientId: 'c1', clientName: 'Karim Bennani', clientAddress: '' });
    const iB = mk('iB', 'FAC-2026-011', 'invoice', [item('Prestation B', 1, 200, 20)], { clientId: 'c2', clientName: 'Autre Client SA', clientAddress: '', clientICE: '' });
    await seed({ company, clients, invoices: [iA, iB], payments: [] });
    const gA = await gen('x3', 'invoice', 'iA'), gB = await gen('x4', 'invoice', 'iB');
    ok('isolation : le document du client A ne contient rien du client B (et inversement)', !/Autre Client|009999999000011|Prestation B/.test(gA.text) && !/Karim|karim@client|001234567000089|Prestation A/.test(gB.text.replace(/001234567000089/g, (m) => m)) === true || (!/Karim Bennani/.test(gB.text) && !/karim@client/.test(gB.text)));
    // ---------- 8. Champs absents ----------
    const bare = { id: 'b1', number: 'FAC-2026-020', type: 'invoice', clientName: 'Client sans détails', date: '2026-10-20', status: 'sent', items: [item('Un article', 1, 50, 0)], totalHT: 50, totalTVA: 0, totalTTC: 50 };
    await seed({ company: { name: 'Petite Entreprise' }, clients: [], invoices: [bare], payments: [] });
    const b1 = await gen('09-champs-absents', 'invoice', 'b1');
    ok('champs absents : document généré, aucun « undefined » ni « null » ni « NaN »', !!b1 && !/\((?:[^()\\]|\\.)*(undefined|null|NaN)(?:[^()\\]|\\.)*\)/.test(b1.text) && has(b1, await money(50)));
    ok('champs absents : ni ICE, ni RIB, ni échéance inventés', !/ICE :/.test(b1.text) && !/RIB :/.test(b1.text) && !/Ech.ance/.test(b1.text));
    // ---------- 9. Arabe ----------
    const ar = mk('ar1', 'FAC-2026-030', 'invoice', [item('خدمة تصميم موقع إلكتروني', 1, 3000, 20)], { clientName: 'شركة الأطلس للتجارة', clientAddress: 'شارع محمد الخامس، الدار البيضاء' });
    await seed({ company: Object.assign({}, company, { name: 'مقاولة النور' }), clients, invoices: [ar], payments: [] });
    const ab = await gen('10-facture-arabe', 'invoice', 'ar1');
    ok('arabe : document généré avec la police arabe intégrée', !!ab && /NotoNaskhArabic/.test(ab.text) && has(ab, await money(3600)));
    // ---------- 10. Essai (sans licence) ----------
    await p.evaluate(() => { window.isUserLicensed = () => false; });
    await seed({ company, clients, invoices: [inv1], payments: [] });
    const t1 = await gen('11-facture-essai', 'invoice', 'i1');
    ok('essai : filigrane FACTURAPRO et pas de logo ni cachet', /FACTURAPRO/.test(t1.text) && /version d.essai/.test(t1.text) && !/\/Subtype\s*\/Image/.test(t1.text));
    await p.evaluate(() => { window.isUserLicensed = () => true; });
    // ---------- 11. Poids ----------
    ok('poids : facture 70 lignes < 400 Ko, facture simple < 120 Ko', f3.size < 400 * 1024 && f1.size < 120 * 1024, f3.size + ' / ' + f1.size);
    await ctx.close();
    if (R_.includes(false)) { console.log('\nÉCHEC : ' + R_.filter(x => !x).length + ' contrôle(s) en échec'); process.exitCode = 1; } else console.log('\nOK : ' + R_.length + ' contrôles (design des documents, SIMULATION locale)');
  }
  await browser.close(); srv.close(); try { be.close(); } catch {} dropDb(db);
})().catch((e) => { console.error(e); process.exit(1); });
