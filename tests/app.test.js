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
}).listen(8151);

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
  await p.goto('http://localhost:8151/app.html?mode=login'); await p.waitForTimeout(800);
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

  // --- 1. Calculs HT / TVA / remise / TTC ---
  const c1 = await E(() => computeLine(3, 33.33, 20, 0));
  check('ligne 3 × 33,33 à 20 % : HT 99,99 / TVA 20,00 / TTC 119,99', c1.totalHT === 99.99 && c1.totalTVA === 20 && c1.totalTTC === 119.99, JSON.stringify(c1));
  const c2 = await E(() => computeLine(2, 100, 20, 10));
  check('remise 10 % : HT 180 / TVA 36 / TTC 216', c2.totalHT === 180 && c2.totalTVA === 36 && c2.totalTTC === 216, JSON.stringify(c2));
  const c3 = await E(() => computeLine(1, 0.1, 20, 0));
  check('arrondi au centime (0,1 à 20 %)', c3.totalHT === 0.1 && c3.totalTVA === 0.02 && c3.totalTTC === 0.12, JSON.stringify(c3));
  const t1 = await E(() => computeTotals([computeLine(1, 0.1, 20, 0), computeLine(1, 0.2, 20, 0)]));
  check('0,1 + 0,2 = 0,30 exactement (pas 0,30000000000000004)', t1.totalHT === 0.3 && t1.totalTVA === 0.06 && t1.totalTTC === 0.36, JSON.stringify(t1));
  const t2 = await E(() => computeTotals([computeLine(3, 33.33, 20, 0), computeLine(1, 10.05, 7, 0)]));
  check('totaux = somme des lignes arrondies', t2.totalTTC === Math.round((t2.totalHT + t2.totalTVA) * 100) / 100, JSON.stringify(t2));

  // --- 2. Données de base ---
  await E(() => {
    Storage.set('clients', [{ id: 'c1', name: 'Client Test', ice: '001122334455667', address: 'Casablanca' }]);
    Storage.set('invoices', []); Storage.set('quotes', []); Storage.set('payments', []);
  });

  // création d'une facture via l'éditeur : brouillon -> numéro provisoire
  const createViaEditor = async (status) => {
    await E(() => newInvoice());
    await E(() => { document.getElementById('editorClient').value = 'c1'; const r = document.querySelector('#itemsBody tr'); r.querySelector('.item-desc').value = 'Prestation'; r.querySelector('.item-qty').value = '2'; r.querySelector('.item-price').value = '100'; r.querySelector('.item-disc').value = '10'; updateTotals(); });
    await E((s) => saveInvoice(s), status); await p.waitForTimeout(700);
    return E(() => Storage.get('invoices', []).slice(-1)[0]);
  };
  const d1 = await createViaEditor('draft');
  check('brouillon : numéro provisoire BRO-', d1 && d1.number.startsWith('BRO-'), d1 && d1.number);
  check('brouillon : remise appliquée (HT 180, TTC 216)', d1.totalHT === 180 && d1.totalTTC === 216 && d1.items[0].discount === 10, JSON.stringify([d1.totalHT, d1.totalTTC]));
  const yr = new Date().getFullYear();
  const i1 = await createViaEditor('sent');
  check('1re facture émise : FAC-' + yr + '-001', i1.number === `FAC-${yr}-001`, i1.number);
  // supprimer le brouillon ne crée pas de trou
  await E((id) => deleteInvoice(id), d1.id);
  const i2 = await createViaEditor('sent');
  check('2e facture émise : FAC-' + yr + '-002 (pas de trou après suppression d\'un brouillon)', i2.number === `FAC-${yr}-002`, i2.number);

  // --- 3. Verrouillage ---
  await E((id) => deleteInvoice(id), i1.id);
  const stillThere = await E((id) => !!Storage.get('invoices', []).find(i => i.id === id), i1.id);
  check('facture émise : suppression refusée', stillThere);
  await E((id) => editInvoice(id), i1.id); await p.waitForTimeout(300);
  check('facture émise : champs désactivés dans l\'éditeur', await E(() => document.getElementById('editorNotes').disabled === true && document.querySelector('#itemsBody .item-qty').disabled === true));
  check('facture émise : boutons Enregistrer masqués', await E(() => [...document.querySelectorAll('.lock-hide')].every(el => el.style.display === 'none')));
  check('facture émise : bandeau « non modifiable » + avoir proposé', await E(() => /non modifiable/.test(document.getElementById('editorLockBanner').textContent) && !!document.querySelector('#editorLockBanner button')));
  const saved = await E(async () => { const r = await persistEditor('draft'); return r; });
  check('facture émise : enregistrement refusé', saved === null);
  const unchanged = await E((id) => Storage.get('invoices', []).find(i => i.id === id), i1.id);
  check('facture émise : montants inchangés', unchanged.totalTTC === 216 && unchanged.number === `FAC-${yr}-001`);

  // --- 4. Avoir ---
  await E((id) => createCreditFromInvoice(id), i1.id); await p.waitForTimeout(500);
  const cr = await E(() => Storage.get('invoices', []).find(i => i.type === 'credit'));
  check('avoir créé : AVR-' + yr + '-001, montants négatifs', cr && cr.number === `AVR-${yr}-001` && cr.totalHT === -180 && cr.totalTVA === -36 && cr.totalTTC === -216, cr && JSON.stringify([cr.number, cr.totalHT, cr.totalTTC]));
  check('avoir : lignes négatives', cr.items[0].quantity === -2 && cr.items[0].totalHT === -180);
  await E((id) => createCreditFromInvoice(id), i1.id); await p.waitForTimeout(300);
  check('2e avoir sur la même facture refusé', (await E(() => Storage.get('invoices', []).filter(i => i.type === 'credit').length)) === 1);
  const crRelated = await E(() => Storage.get('invoices', []).find(i => i.type === 'credit').relatedInvoiceNumber);
  check('avoir : lié à la facture d\'origine', crRelated === `FAC-${yr}-001`);

  // --- 5. Paiements partiels ---
  const payFor = (id, amount) => E(([id, amount]) => {
    document.getElementById('paymentInvoice').innerHTML = `<option value="${id}">x</option>`; document.getElementById('paymentInvoice').value = id;
    document.getElementById('paymentDate').value = todayISO(); document.getElementById('paymentAmount').value = String(amount);
    document.getElementById('paymentReference').value = ''; document.getElementById('paymentNotes').value = ''; savePayment();
  }, [id, amount]);
  await payFor(i2.id, 100);
  let inv2 = await E((id) => Storage.get('invoices', []).find(i => i.id === id), i2.id);
  check('paiement partiel : facture non soldée, reste 116', inv2.status === 'sent' && inv2.paidAmount === 100 && inv2.totalTTC - inv2.paidAmount === 116, JSON.stringify([inv2.status, inv2.paidAmount]));
  await payFor(i2.id, 116);
  inv2 = await E((id) => Storage.get('invoices', []).find(i => i.id === id), i2.id);
  check('solde payé : facture « payée »', inv2.status === 'paid' && inv2.paidAmount === 216);
  check('journal : émission, avoir et paiements tracés', await E(() => { const a = Storage.get('docLog', []).map(l => l.action); return ['emission', 'avoir', 'paiement', 'suppression_brouillon'].every(x => a.includes(x)); }));

  // --- 6. Devis -> facture ---
  await E(() => {
    Storage.set('quotes', [{ id: 'q1', number: `DEV-${new Date().getFullYear()}-001`, type: 'quote', clientId: 'c1', clientName: 'Client Test', date: todayISO(), status: 'sent',
      items: [{ description: 'Service', quantity: 1, price: 500, discount: 0, tva: 20, totalHT: 500, totalTVA: 100, totalTTC: 600 }], totalHT: 500, totalTVA: 100, totalTTC: 600, paymentTerms: '30' }]);
  });
  await E(() => convertQuoteToInvoice('q1', true)); await p.waitForTimeout(500);
  const conv = await E(() => Storage.get('invoices', []).find(i => i.sourceQuote === 'q1'));
  check('devis -> facture : brouillon créé avec les mêmes lignes', conv && conv.status === 'draft' && conv.totalTTC === 600 && conv.items.length === 1 && conv.number.startsWith('BRO-'));
  await E((id) => { editInvoice(id); }, conv.id);
  await E(() => saveInvoice('sent')); await p.waitForTimeout(700);
  const issued = await E(() => Storage.get('invoices', []).find(i => i.sourceQuote === 'q1'));
  const q1 = await E(() => Storage.get('quotes', []).find(q => q.id === 'q1'));
  check('devis -> facture : numéro officiel attribué à l\'émission', issued.number === `FAC-${yr}-003` && q1.convertedInvoiceNumber === issued.number && q1.status === 'accepted', JSON.stringify([issued.number, q1.convertedInvoiceNumber]));

  // --- 7. PDF ---
  const dl = p.waitForEvent('download', { timeout: 8000 }).catch(() => null);
  await E((id) => generatePDF(id, 'invoice'), i1.id);
  const f = await dl;
  check('PDF facture téléchargé (FAC-' + yr + '-001.pdf)', f && f.suggestedFilename() === `FAC-${yr}-001.pdf`, f && f.suggestedFilename());
  if (f) { const pth = await f.path(); const txt = fs.readFileSync(pth).toString('latin1'); check('PDF valide (en-tête %PDF)', txt.startsWith('%PDF')); }

  // --- 8. Persistance après rechargement ---
  const before = await E(() => Storage.get('invoices', []).map(i => i.number).sort().join(','));
  await p.reload(); await p.waitForTimeout(1500);
  const afterOk = await E(() => { try { return Storage.get('invoices', []).map(i => i.number).sort().join(','); } catch (e) { return 'ERR'; } });
  check('factures conservées après rechargement', afterOk === before, afterOk);

  // --- 9. Mobile : pas de débordement horizontal, actions visibles ---
  await p.setViewportSize({ width: 390, height: 800 });
  for (const pg of ['dashboard', 'invoices', 'quotes', 'clients', 'products', 'payments', 'reminders']) {
    await E((x) => navTo(x), pg); await p.waitForTimeout(250);
    const ov = await E(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`mobile 390 px : page ${pg} sans débordement de la page`, ov <= 1, 'débordement ' + ov + ' px');
  }
  await E(() => navTo('invoices')); await p.waitForTimeout(250);
  const vis = await E(() => { const b = document.querySelector('table.tbl-act td:last-child button'); if (!b) return false; const r = b.getBoundingClientRect(); return r.right <= window.innerWidth + 1 && r.width >= 36; });
  check('mobile : boutons d\'action des factures visibles et assez grands', vis);

  check('aucune erreur JavaScript pendant les tests', errors.length === 0, errors.join(' | '));

  let fail = 0;
  for (const [ok, name, extra] of results) { if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || !extra ? '' : '  -> ' + extra)); }
  console.log(`\n${results.length - fail}/${results.length} tests réussis`);
  await b.close(); srv.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERREUR HARNAIS', e); process.exit(2); });
