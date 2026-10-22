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
  // --- validation de l'étape « entreprise » : astérisque rouge + message AU-DESSUS du champ ---
  const step2Visible = () => p.evaluate(() => document.getElementById('onbStep2').classList.contains('active'));
  await p.evaluate(() => onboardingNext(2));
  check('étape entreprise vide : on reste sur l\'étape 2', await step2Visible());
  check('champs obligatoires signalés : nom et ICE', await p.evaluate(() => document.querySelectorAll('#onbStep2 .field-error').length === 2));
  check('message placé AU-DESSUS du champ (entre le libellé et la saisie)', await p.evaluate(() => { const i = document.getElementById('onbICE'); const e = i.previousElementSibling; return e && e.classList.contains('field-error') && e.previousElementSibling.tagName === 'LABEL'; }));
  check('astérisque rouge + texte « Vérifiez »', await p.evaluate(() => { const l = document.querySelector('#onbICE').parentElement; return !!l.querySelector('.req') && /^\* Vérifiez/.test(l.querySelector('.field-error').textContent) && getComputedStyle(l.querySelector('.req')).color === 'rgb(192, 57, 43)'; }));
  await p.fill('#onbCompanyName', 'SARL Test'); await p.fill('#onbICE', '1234');
  await p.evaluate(() => onboardingNext(2));
  check('ICE trop court : message avec le nombre de chiffres saisis', await p.evaluate(() => /15 chiffres \(4 saisis\)/.test(document.querySelector('#onbICE').parentElement.querySelector('.field-error').textContent)));
  check('compteur de chiffres en direct (4 / 15)', await p.evaluate(() => /^4 \/ 15/.test(document.getElementById('hintonbICE').textContent)));
  await p.fill('#onbICE', '111111111111111');
  await p.evaluate(() => onboardingNext(2));
  check('ICE de chiffres répétés refusé avec message visible', await p.evaluate(() => /vrai ICE/.test(document.querySelector('#onbICE').parentElement.querySelector('.field-error').textContent)) && await step2Visible());
  await p.fill('#onbICE', '001234567000089'); await p.fill('#onbPhone', '12'); await p.fill('#onbEmail', 'pas-un-email');
  await p.evaluate(() => onboardingNext(2));
  check('champs facultatifs mal remplis : téléphone et e-mail signalés', await p.evaluate(() => !!document.querySelector('#onbPhone').parentElement.querySelector('.field-error') && !!document.querySelector('#onbEmail').parentElement.querySelector('.field-error')) && await step2Visible());
  check('les messages disparaissent quand on corrige', await p.evaluate(() => { const i = document.getElementById('onbPhone'); i.value = ''; i.dispatchEvent(new Event('input')); return !i.parentElement.querySelector('.field-error'); }));
  await p.fill('#onbEmail', '');
  await p.fill('#onbCompanyName', 'SARL Test'); await p.fill('#onbICE', '001234567000089');
  await p.evaluate(() => onboardingNext(2));
  check('champs facultatifs vides acceptés : passage à l\'étape 3', !(await step2Visible()));
  await p.fill('#onbRIB', '12345');
  await p.evaluate(() => finishOnboarding());
  check('RIB incomplet : refusé avec message au-dessus du champ, application non ouverte', await p.evaluate(() => /24 chiffres \(5 saisis\)/.test(document.querySelector('#onbRIB').parentElement.querySelector('.field-error').textContent)) && !(await p.isVisible('#mainApp')));
  await p.fill('#onbRIB', '');
  await p.evaluate(() => onboardingBack(3));
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

  // --- 7 bis. WhatsApp : PDF en pièce jointe via le partage du téléphone, sinon repli ; brouillon non présenté comme facture définitive ---
  const shared = await E(async (id) => {
    window.__shared = null; window.__opened = null;
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(navigator, 'share', { value: async (d) => { window.__shared = { n: d.files.length, name: d.files[0].name, type: d.files[0].type, size: d.files[0].size, text: d.text }; }, configurable: true });
    window.open = (u) => { window.__opened = u; };
    await sendDocWhatsApp(id, 'invoice');
    return { shared: window.__shared, opened: window.__opened };
  }, i1.id);
  check('WhatsApp : le PDF est partagé en pièce jointe (type PDF, non vide, nom FAC-…)', shared.shared && shared.shared.n === 1 && shared.shared.type === 'application/pdf' && shared.shared.size > 1000 && /^FAC-.*\.pdf$/.test(shared.shared.name), JSON.stringify(shared.shared));
  check('WhatsApp : le message accompagne le PDF, sans ouvrir de lien wa.me', shared.shared && /Montant TTC/.test(shared.shared.text) && shared.opened === null);
  const fb = await E(async (id) => {
    window.__opened = null;
    Object.defineProperty(navigator, 'canShare', { value: () => false, configurable: true });
    await sendDocWhatsApp(id, 'invoice'); await new Promise(r => setTimeout(r, 900));
    return window.__opened;
  }, i1.id);
  check('WhatsApp sans partage de fichier : repli wa.me avec le message', typeof fb === 'string' && /^https:\/\/wa\.me\//.test(fb));
  const ab = await E(async (id) => {
    window.__opened = null;
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(navigator, 'share', { value: async () => { const e = new Error('x'); e.name = 'AbortError'; throw e; }, configurable: true });
    await sendDocWhatsApp(id, 'invoice'); await new Promise(r => setTimeout(r, 900));
    return window.__opened;
  }, i1.id);
  check('partage annulé par l\'utilisateur : aucun repli intempestif', ab === null);
  const msgs = await E(() => ({ draft: whatsappDocMessage({ number: 'BRO-R8KQJI', totalTTC: 120, date: '2026-10-22', dueDate: '2026-11-21' }, false, { name: 'Nawal SA', rib: '123' }),
    issued: whatsappDocMessage({ number: 'FAC-2026-0001', totalTTC: 120, date: '2026-10-22' }, false, { name: 'Nawal SA', rib: '123' }) }));
  check('brouillon : pas de numéro BRO-… ni de RIB, mention « numéro définitif attribué à l\'émission »', !/BRO-/.test(msgs.draft) && /brouillon de facture/.test(msgs.draft) && /attribué à l'émission/.test(msgs.draft) && !/RIB/.test(msgs.draft));
  check('facture émise : numéro réel et RIB conservés', /FAC-2026-0001/.test(msgs.issued) && /RIB : 123/.test(msgs.issued));

  // --- 8. Persistance après rechargement ---
  const before = await E(() => Storage.get('invoices', []).map(i => i.number).sort().join(','));
  await p.reload(); await p.waitForTimeout(1500);
  const afterOk = await E(() => { try { return Storage.get('invoices', []).map(i => i.number).sort().join(','); } catch (e) { return 'ERR'; } });
  check('factures conservées après rechargement', afterOk === before, afterOk);

  // --- 9. Mobile : pas de débordement horizontal, actions visibles ---
  await p.setViewportSize({ width: 390, height: 800 });
  for (const pg of ['dashboard', 'invoices', 'quotes', 'clients', 'products', 'payments', 'reminders', 'taxes', 'cnss']) {
    await E((x) => navTo(x), pg); await p.waitForTimeout(250);
    const ov = await E(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`mobile 390 px : page ${pg} sans débordement de la page`, ov <= 1, 'débordement ' + ov + ' px');
  }
  await E(() => newInvoice()); await p.waitForTimeout(400);
  const edOv = await E(() => document.documentElement.scrollWidth - window.innerWidth);
  check('mobile 390 px : éditeur de facture sans débordement de la page', edOv <= 1, 'débordement ' + edOv + ' px');
  check('mobile 390 px : boutons de l\'éditeur (PDF, WhatsApp, Brouillon, Enregistrer) tous visibles à l\'écran', await E(() => [...document.querySelectorAll('#page-invoice-editor .topbar-actions .btn')].filter(b => b.offsetParent).every(b => { const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth + 1; })));
  await E(() => navTo('dashboard')); await E(() => toggleSidebar()); await p.waitForTimeout(500);
  const menu = await E(() => { const sb = document.getElementById('sidebar'); sb.scrollTop = sb.scrollHeight; const r = sb.getBoundingClientRect();
    const inView = (sel) => { const e = [...document.querySelectorAll(sel)].pop(); const b = e.getBoundingClientRect(); return b.top >= 0 && b.bottom <= window.innerHeight + 1; };
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight, pw: inView('.sidebar-footer .logout-btn:nth-last-child(2)'), out: inView('.sidebar-footer .logout-btn:last-child') }; });
  check('mobile : le menu occupe tout l\'écran (collé en haut, ne dépasse pas en bas)', menu.top === 0 && menu.bottom <= menu.vh + 1, JSON.stringify(menu));
  check('mobile : « Changer mot de passe » et « Se déconnecter » visibles en bas du menu', menu.pw && menu.out, JSON.stringify(menu));
  await E(() => toggleSidebar());
  await E(() => navTo('invoices')); await p.waitForTimeout(250);
  const vis = await E(() => { const b = document.querySelector('table.tbl-act td:last-child button'); if (!b) return false; const r = b.getBoundingClientRect(); return r.right <= window.innerWidth + 1 && r.width >= 36; });
  check('mobile : boutons d\'action des factures visibles et assez grands', vis);

  // --- 10. Impôts & TVA, CNSS (rapport par période, achats, export CSV, échéances) ---
  await p.setViewportSize({ width: 1280, height: 900 });
  await E(() => navTo('taxes')); await p.waitForTimeout(400);
  const tx = await E(() => ({ deadline: document.getElementById('tvaNextDeadline').textContent, regime: document.getElementById('tvaRegime').value,
    periods: document.getElementById('tvaPeriod').options.length, stale: /31 mars 2026/.test(document.getElementById('page-taxes').textContent),
    dup: (document.getElementById('page-taxes').textContent.match(/déclaration T1/g) || []).length }));
  check('Impôts & TVA : régime trimestriel par défaut, 4 périodes', tx.regime === 'quarterly' && tx.periods === 4, JSON.stringify(tx));
  check('Impôts & TVA : plus de texte « 31 mars 2026 » ni de doublon T1', !tx.stale && tx.dup === 0, JSON.stringify(tx));
  check('Impôts & TVA : échéance affichée = fin du mois suivant un trimestre', await E(() => { const t = document.getElementById('tvaNextDeadline').textContent; return /^(30 avril|31 juillet|31 octobre|31 janvier) \d{4} — déclaration T[1-4] \d{4}$/.test(t); }), tx.deadline);
  await E(() => { document.getElementById('vpDate').value = todayISO(); document.getElementById('vpSupplier').value = 'Fournisseur test'; document.getElementById('vpRef').value = 'FA-1'; document.getElementById('vpHT').value = '100'; vpSuggestTva(); });
  check('achat : TVA proposée à 20 % (modifiable)', await E(() => document.getElementById('vpTVA').value === '20.00'));
  await E(() => addVatPurchase()); await p.waitForTimeout(200);
  check('achat enregistré et listé', await E(() => Storage.get('vatPurchases', []).length === 1 && /Fournisseur test/.test(document.getElementById('vatPurchasesBody').textContent)));
  const bal = await E(() => { const per = document.getElementById('tvaPeriod'); const y = document.getElementById('tvaYear'); y.value = String(new Date().getFullYear()); onVatControlChange(false);
    for (const o of per.options) { per.value = o.value; onVatControlChange(false); if (/20,00/.test(document.getElementById('tvaDeductible').textContent)) return document.getElementById('tvaBalanceLabel').textContent; } return null; });
  check('rapport TVA : la TVA déductible apparaît dans la période de l\'achat', bal !== null, String(bal));
  const dlv = p.waitForEvent('download', { timeout: 8000 }).catch(() => null);
  await E(() => exportVatReportCSV());
  const fv = await dlv;
  check('export CSV du rapport TVA', fv && /^rapport-tva-.*\.csv$/.test(fv.suggestedFilename()), fv && fv.suggestedFilename());
  if (fv) { const txt = fs.readFileSync(await fv.path(), 'utf8'); check('CSV : sections collectée / déductible / mention non officielle', /TVA COLLECTEE/.test(txt) && /TVA DEDUCTIBLE/.test(txt) && /non officielle/.test(txt)); }
  await E(() => { document.getElementById('tvaRegime').value = 'exempt'; onVatControlChange(true); });
  check('régime exonéré : rapport masqué, message affiché', await E(() => document.getElementById('tvaReportBody').style.display === 'none' && document.getElementById('tvaExemptNotice').style.display !== 'none'));
  await E(() => { document.getElementById('tvaRegime').value = 'quarterly'; onVatControlChange(true); });
  await E(() => navTo('cnss')); await p.waitForTimeout(300);
  await E(() => { document.getElementById('ceLabel').value = 'Salarié test'; document.getElementById('ceGross').value = '5000'; addCnssEmployee(); });
  check('CNSS employeur : 5 000 DH -> 337,00 salarié / 1 054,50 patronal', await E(() => { const t = document.getElementById('cnssEmployeesBody').textContent.replace(/\s|\u00a0|\u202f/g, ''); return t.includes('337,00DH') && t.includes('1054,50DH'); }));
  check('CNSS : liens officiels Damancom et cnss.ma, échéance affichée', await E(() => { const h = [...document.querySelectorAll('#page-cnss a')].map(a => a.href); return h.some(x => /^https:\/\/www\.damancom\.ma/.test(x)) && h.some(x => /^https:\/\/www\.cnss\.ma/.test(x)) && /^\d+(er)? \S+ \d{4} — déclaration des salaires de /.test(document.getElementById('cnssNextDue').textContent); }));

  check('aucune erreur JavaScript pendant les tests', errors.length === 0, errors.join(' | '));

  let fail = 0;
  for (const [ok, name, extra] of results) { if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || !extra ? '' : '  -> ' + extra)); }
  console.log(`\n${results.length - fail}/${results.length} tests réussis`);
  await b.close(); srv.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERREUR HARNAIS', e); process.exit(2); });
