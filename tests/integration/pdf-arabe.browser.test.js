// PDF en arabe (aperçu ?lang=ar) : libellés arabes, plus aucun libellé français fixe ; le PDF français reste inchangé. SIMULATION locale (faux client Supabase + PostgreSQL local), jamais Supabase réel.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8238;
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
  const R_ = []; const ok = (n, c, x = '') => { R_.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? ' ' + x : '')); };
  const { execFileSync } = require('child_process'); const os = require('os');
  const FRLAB = /Facturé|Désignation|Échéance|Sous-total|Reste à payer|Total HT|TOTAL TTC|Date d'émission|Règlement|Montant|Facture concernée|Solde avant/;
  const mk = (ar) => (async () => {
    const { ctx, p } = await dev({ width: 1000, height: 800 });
    await p.goto(`http://localhost:${PORT}/app.html?mode=login${ar ? '&lang=ar' : ''}`); await sleep(900);
    await p.evaluate(() => document.querySelector('[data-tab=signup]').click());
    await p.fill('#signupEmail', `pdf${ar ? 'ar' : 'fr'}-${process.pid}@facturapro-test.invalid`); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500);
    await p.evaluate(() => finishOnboarding()); await sleep(1800);
    const out = await p.evaluate(async () => {
      const inv = { id: 'i1', number: 'FAC-2026-014', date: '2026-10-20', dueDate: '2026-11-20', clientName: 'شركة الأطلس للتجهيز', clientICE: '001234567000089', paymentTerms: '30',
        items: [{ description: 'Câble HDMI', quantity: 2, price: 500, tva: 20, totalHT: 1000, totalTVA: 200 }], totalHT: 1000, totalTVA: 200, totalTTC: 1200, type: 'invoice', status: 'sent' };
      const a = await generatePDF(null, 'invoice', { sample: inv, asBlob: true });
      const r = await generatePaymentReceiptPDF('p1', { sample: { payment: { id: 'p1', invoiceId: 'i1', amount: 500, date: '2026-10-22', method: 'virement' }, invoice: inv, client: { name: inv.clientName } }, asBlob: true });
      const b64 = async (x) => { const u = new Uint8Array(await x.blob.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
      return { inv: a && await b64(a), rec: r && await b64(r), tr: typeof pdfArTr === 'function' ? [pdfArTr('Reste à payer'), pdfArTr('20 oct. 2026'), pdfArTr('Mot inconnu')] : [] };
    });
    await ctx.close(); return out;
  })();
  const txt = (b64, name) => { const f = path.join(os.tmpdir(), `fp-${process.pid}-${name}.pdf`); fs.writeFileSync(f, Buffer.from(b64, 'base64')); try { return execFileSync('pdftotext', ['-layout', f, '-'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } finally { fs.unlinkSync(f); } };
  const fr = await mk(false), ar = await mk(true);
  const frI = txt(fr.inv, 'fri'), frR = txt(fr.rec, 'frr'), arI = txt(ar.inv, 'ari'), arR = txt(ar.rec, 'arr');
  ok('PDF français inchangé : libellés français présents (facture et reçu)', /Désignation/.test(frI) && /Sous-total HT/.test(frI) && /Reste à payer/.test(frI) && /Facture concernée/.test(frR) && /Montant/i.test(frR));
  ok('PDF arabe (facture) : aucun libellé fixe en français', !FRLAB.test(arI), (arI.match(FRLAB) || [''])[0]);
  ok('PDF arabe (reçu) : aucun libellé fixe en français', !FRLAB.test(arR), (arR.match(FRLAB) || [''])[0]);
  ok('PDF arabe : texte arabe présent (formes arabes), numéro et montants conservés', /[ﹰ-﻿؀-ۿ]/.test(arI) && /FAC-2026-014/.test(arI) && /1\s?200,00 DH/.test(arI));
  ok('PDF arabe : dates en chiffres (jj/mm/aaaa), plus de mois français', /20\/10\/2026/.test(arI) && !/\boct\./.test(arI) && /22\/10\/2026/.test(arR));
  ok('PDF arabe : fichiers générés non vides', ar.inv.length > 5000 && ar.rec.length > 5000);
  ok('traduction : libellé connu traduit, date convertie, texte inconnu laissé tel quel (repli français)', ar.tr[0] === 'المتبقي للأداء' && ar.tr[1] === '20/10/2026' && ar.tr[2] === 'Mot inconnu', JSON.stringify(ar.tr));
  await browser.close(); srv.close(); try { await dropDb(db); } catch (e) {}
  const f = R_.filter((x) => !x).length; console.log(f ? `${f} ÉCHEC(S)` : 'OK'); process.exit(f ? 1 : 0);
})();
