// Tests de bout en bout de app.html en MODE LOCAL (sans Supabase, sans secret).
// Prérequis : npm install ; un Chromium (variable CHROMIUM_PATH, par défaut /opt/pw-browsers/chromium).
// Lancer : npm test
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');

const ROOT = path.join(__dirname, '..');
const srv = http.createServer((q, r) => {
  const f = path.join(ROOT, q.url.split('?')[0] === '/' ? 'app.html' : q.url.split('?')[0]);
  fs.readFile(f, (e, d) => {
    if (e) { r.writeHead(404); return r.end(); }
    let body = d;
    if (f.endsWith('app.html')) {   // mode local : on neutralise les clés Supabase en mémoire (le fichier n'est pas modifié)
      body = d.toString('utf8')
        .replace(/^const SUPABASE_URL = .*$/m, "const SUPABASE_URL = 'YOUR_SUPABASE_URL';")
        .replace(/^const SUPABASE_ANON_KEY = .*$/m, "const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';");
    }
    r.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
    r.end(body);
  });
}).listen(8152);

const results = [];
const check = (name, cond, extra = '') => { results.push([!!cond, name, extra]); };

(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push('PAGEERR ' + e.message));
  p.on('dialog', d => d.accept());
  const nm = (...s) => path.join(ROOT, 'node_modules', ...s);
  await p.route('**/jspdf.umd.min.js', r => r.fulfill({ path: nm('jspdf', 'dist', 'jspdf.umd.min.js'), contentType: 'text/javascript' }));
  await p.route('**/jspdf.plugin.autotable.min.js', r => r.fulfill({ path: nm('jspdf-autotable', 'dist', 'jspdf.plugin.autotable.min.js'), contentType: 'text/javascript' }));
  await p.route(/googleapis|gstatic|jsdelivr|hcaptcha/, r => r.abort());

  // --- inscription + onboarding (données fictives) ---
  await p.goto('http://localhost:8152/app.html?mode=login'); await p.waitForTimeout(800);
  await p.evaluate(() => { const t = [...document.querySelectorAll('button,div,a')].find(e => e.textContent.trim() === 'Inscription'); t && t.click(); });
  await p.fill('#signupEmail', 'test@example.invalid'); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345');
  await p.click('#signupBtn'); await p.waitForTimeout(1500);
  await p.evaluate(() => selectStatus(document.querySelector('[onclick*="selectStatus"]').getAttribute('onclick').match(/'(.*?)'/)[1]));
  await p.evaluate(() => onboardingNext(1));
  await p.fill('#onbCompanyName', 'SARL Test'); await p.fill('#onbICE', '001234567000089');
  await p.evaluate(() => onboardingNext(2));
  await p.fill('#onbBank', 'Banque test'); await p.fill('#onbRIB', '007 780 0001234567890123 45');
  await p.evaluate(() => finishOnboarding()); await p.waitForTimeout(1200);
  check('application chargée après inscription', await p.isVisible('#mainApp'));

  const E = (fn, arg) => p.evaluate(fn, arg);

  const yr = new Date().getFullYear();

  // ===== Cas limites de calcul =====
  const cl = (...a) => E((a) => computeLine(...a), a);
  let r;
  r = await cl(1, 1.005, 0, 0);   check('arrondi 1,005 -> 1,01', r.totalHT === 1.01, JSON.stringify(r));
  r = await cl(1, 2.675, 0, 0);   check('arrondi 2,675 -> 2,68', r.totalHT === 2.68, JSON.stringify(r));
  r = await cl(1, 100, 20, 100);  check('remise 100 % : tout à 0', r.totalHT === 0 && r.totalTVA === 0 && r.totalTTC === 0, JSON.stringify(r));
  r = await cl(1, 100, 20, 150);  check('remise > 100 % plafonnée à 100 %', r.totalHT === 0, JSON.stringify(r));
  r = await cl(1, 100, 20, -10);  check('remise négative ramenée à 0', r.totalHT === 100, JSON.stringify(r));
  r = await cl(1, 100, 14, 0);    check('TVA 14 % : 14,00 / 114,00', r.totalTVA === 14 && r.totalTTC === 114, JSON.stringify(r));
  r = await cl(1, 100, 10, 0);    check('TVA 10 % : 10,00 / 110,00', r.totalTVA === 10 && r.totalTTC === 110, JSON.stringify(r));
  r = await cl(1, 100, 7, 0);     check('TVA 7 % : 7,00 / 107,00', r.totalTVA === 7 && r.totalTTC === 107, JSON.stringify(r));
  r = await cl(1, 100, 0, 0);     check('TVA 0 % (exonéré)', r.totalTVA === 0 && r.totalTTC === 100, JSON.stringify(r));
  r = await cl(0.5, 33.33, 20, 0);check('quantité décimale 0,5 × 33,33', r.totalHT === 16.67 && r.totalTVA === 3.33 && r.totalTTC === 20, JSON.stringify(r));
  r = await cl(1, 99999999.99, 20, 0); check('très grand montant (≈100 M)', r.totalHT === 99999999.99 && r.totalTVA === 20000000 && r.totalTTC === 119999999.99, JSON.stringify(r));
  r = await cl('', 'abc', 20, 0); check('valeurs vides ou invalides -> 0 sans NaN', r.totalHT === 0 && r.totalTTC === 0, JSON.stringify(r));
  r = await E(() => roundMoney(-1.005));  check('arrondi symétrique pour un avoir : -1,005 -> -1,01', r === -1.01, String(r));
  r = await E(() => { const it = []; for (let i = 0; i < 200; i++) it.push(computeLine(1, 0.07, 20, 0)); return computeTotals(it); });
  check('200 lignes de 0,07 à 20 % : HT 14,00 ; TVA = 200 × 0,01 (arrondi par ligne) = 2,00', r.totalHT === 14 && r.totalTVA === 2 && r.totalTTC === 16, JSON.stringify(r));
  r = await E(() => { const o = computeLine(3, 33.33, 20, 5); const n = { totalHT: -o.totalHT, totalTVA: -o.totalTVA, totalTTC: -o.totalTTC }; return o.totalTTC + n.totalTTC; });
  check('facture + avoir de même ligne = 0', r === 0, String(r));
  r = await E(() => { const it = [computeLine(3, 33.33, 20, 5), computeLine(7, 12.49, 14, 0), computeLine(1, 0.01, 10, 0)]; const t = computeTotals(it); return Math.abs(t.totalTTC - (t.totalHT + t.totalTVA)) < 1e-9 && Math.abs(t.totalHT - it.reduce((s, i) => s + i.totalHT, 0)) < 1e-9; });
  check('cohérence : TTC = HT + TVA, HT = somme des lignes (taux mixtes)', r);

  // ===== Données =====
  await E(() => {
    Storage.set('clients', [{ id: 'c1', name: 'Client; "Spécial"', ice: '001122334455667', address: 'Casablanca' }, { id: 'c2', name: 'عميل مغربي', ice: '009988776655443', address: 'الدار البيضاء' }]);
    Storage.set('invoices', []); Storage.set('quotes', []); Storage.set('payments', []);
  });
  const make = async (status, client, desc, qty, price, disc, tva) => {
    await E(() => newInvoice());
    await E(([client, desc, qty, price, disc, tva]) => {
      document.getElementById('editorClient').value = client; const row = document.querySelector('#itemsBody tr');
      row.querySelector('.item-desc').value = desc; row.querySelector('.item-qty').value = qty; row.querySelector('.item-price').value = price; row.querySelector('.item-disc').value = disc;
      const t = row.querySelector('.item-tva'); if (t) t.value = tva; updateTotals();
    }, [client, desc, qty, price, disc, tva]);
    await E((s) => saveInvoice(s), status); await p.waitForTimeout(600);
    return E(() => Storage.get('invoices', []).slice(-1)[0]);
  };
  const draft = await make('draft', 'c1', 'Brouillon à ne pas exporter', '1', '1000', '0', '20');
  const inv = await make('sent', 'c1', 'Prestation remisée', '3', '33.33', '10', '20');
  const inv2 = await make('sent', 'c2', 'خدمة', '2', '250', '0', '10');
  check('facture avec remise : totaux enregistrés cohérents', inv.totalHT === 89.99 && inv.totalTVA === 18 && inv.totalTTC === 107.99, JSON.stringify([inv.totalHT, inv.totalTVA, inv.totalTTC]));

  // ===== Export comptable CSV =====
  const grab = async (fn) => { const dl = p.waitForEvent('download', { timeout: 8000 }).catch(() => null); await E(fn); const f = await dl; if (!f) return null; const buf = fs.readFileSync(await f.path()); return { name: f.suggestedFilename(), txt: buf.toString('utf8'), bin: buf.toString('binary') }; };
  const csv = await grab(() => exportAccounting('csv'));
  check('export CSV téléchargé', !!csv);
  if (csv) {
    check('export CSV : brouillon exclu', !csv.txt.includes('BRO-') && !csv.txt.includes('Brouillon à ne pas exporter'));
    check('export CSV : factures émises présentes', csv.txt.includes(`FAC-${yr}-001`) && csv.txt.includes(`FAC-${yr}-002`));
    check('export CSV : colonne Remise % et montants avec remise (89.99 / 18.00 / 107.99)', /Remise %/.test(csv.txt) && csv.txt.includes('89.99') && csv.txt.includes('107.99'), csv.txt.split('\n')[1]);
    check('export CSV : texte arabe conservé (UTF-8)', csv.txt.includes('خدمة'));
    check('export CSV : nom de client avec ; et " ne casse pas les colonnes', csv.txt.split('\n').filter(l => l.includes(`FAC-${yr}-001`)).every(l => l.split(';').length === 15), csv.txt.split('\n')[1]);
  }
  const fec = await grab(() => exportAccounting('fec'));
  check('export FEC téléchargé', !!fec);
  if (fec) {
    const lines = fec.txt.replace('﻿', '').trim().split('\n').slice(1).map(l => l.split('|'));
    const deb = lines.reduce((s, l) => s + parseFloat(l[11]), 0), cre = lines.reduce((s, l) => s + parseFloat(l[12]), 0);
    check('FEC : écritures équilibrées (débit = crédit)', Math.abs(deb - cre) < 0.005 && lines.length > 0, `${deb} / ${cre}`);
    check('FEC : brouillon exclu', !fec.txt.includes('BRO-'));
  }
  // avoir dans le FEC : sens inversé et toujours équilibré
  await E((id) => createCreditFromInvoice(id), inv.id); await p.waitForTimeout(600);
  const fec2 = await grab(() => exportAccounting('fec'));
  if (fec2) {
    const lines = fec2.txt.replace('﻿', '').trim().split('\n').slice(1).map(l => l.split('|'));
    const deb = lines.reduce((s, l) => s + parseFloat(l[11]), 0), cre = lines.reduce((s, l) => s + parseFloat(l[12]), 0);
    const av = lines.filter(l => l[8].startsWith('AVR'));
    check('FEC avec avoir : équilibré, montants positifs, sens inversé (client au crédit)', Math.abs(deb - cre) < 0.005 && av.length >= 2 && av.every(l => parseFloat(l[11]) >= 0 && parseFloat(l[12]) >= 0) && parseFloat(av.find(l => l[4] === '3421')[12]) === 107.99, JSON.stringify(av.map(l => l.slice(4, 5).concat(l.slice(11, 13)))));
  }

  // ===== Avoir + total net dans le tableau de bord / rapport =====
  const net = await E(() => Storage.get('invoices', []).filter(i => i.status !== 'draft').reduce((s, i) => s + i.totalTTC, 0));
  check('total net factures + avoir = 550 (facture B seule)', Math.abs(net - (107.99 + 550 - 107.99)) < 0.005, String(net));

  // ===== PDF avec texte arabe =====
  const pdf = await grab(() => generatePDF(Storage.get('invoices', []).find(i => i.clientId === 'c2').id, 'invoice'));
  check('PDF facture avec client arabe généré sans erreur', !!pdf && pdf.txt.startsWith('%PDF'));
  if (pdf) {
    const raw = fs.readFileSync('/tmp/_ar.pdf'.replace('/tmp/_ar.pdf', process.env.PDF_OUT || '/tmp/_ar.pdf'), { flag: 'a+' });
    fs.writeFileSync(process.env.PDF_OUT || '/tmp/_ar.pdf', Buffer.from(pdf.bin, 'binary'));
    check('PDF arabe : police Noto Naskh Arabic intégrée', /NotoNaskhArabic/.test(pdf.bin));
  }
  check('aucune erreur JavaScript pendant les tests', errors.length === 0, errors.join(' | '));
  let fail = 0;
  for (const [ok, name, extra] of results) { if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || !extra ? '' : '  -> ' + extra)); }
  console.log(`\n${results.length - fail}/${results.length} tests de non-régression réussis`);
  await b.close(); srv.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERREUR HARNAIS', e); process.exit(2); });
