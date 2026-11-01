// Recette §6 de docs/FACTURAPRO-2.0.md exécutée de bout en bout dans l'application (11 étapes), avec contrôle croisé des chiffres : Stock, Trésorerie, Pilotage et Journaux doivent raconter la même histoire. Compte de test jetable, PostgreSQL local, jamais de données réelles.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8260;
const srv = http.createServer((q, r) => {
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
  const db = createDb({ stock: true }); const be = makeBackend(db);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' }); const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 160))); p.on('dialog', (d) => d.accept());
  await p.exposeFunction('__srv', (op, args) => be.handle(op, args));
  await p.route(/jsdelivr.*supabase/, (r) => r.fulfill({ body: FAKE, contentType: 'text/javascript' }));
  await p.route('**/jspdf.umd.min.js', (r) => r.fulfill({ path: nm('jspdf', 'dist', 'jspdf.umd.min.js'), contentType: 'text/javascript' }));
  await p.route('**/jspdf.plugin.autotable.min.js', (r) => r.fulfill({ path: nm('jspdf-autotable', 'dist', 'jspdf.plugin.autotable.min.js'), contentType: 'text/javascript' }));
  await p.route(/googleapis|gstatic|hcaptcha/, (r) => r.abort());
  const R_ = []; const ok = (n, c, x = '') => { R_.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? ' ' + x : '')); };
  await p.goto(`http://localhost:${PORT}/app.html?mode=login`); await sleep(800);
  await p.click('[data-tab=signup]');
  await p.fill('#signupEmail', `rec-${process.pid}@facturapro-test.invalid`); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500);
  if (!(await p.isVisible('#mainApp'))) {
    await p.evaluate(() => selectStatus(document.querySelector('[onclick*="selectStatus"]').getAttribute('onclick').match(/'(.*?)'/)[1])); await p.evaluate(() => onboardingNext(1));
    await p.fill('#onbCompanyName', 'Atelier Atlas SARL'); await p.fill('#onbICE', '001234567000089'); await p.evaluate(() => onboardingNext(2));
    await p.fill('#onbBank', 'Banque test'); await p.fill('#onbRIB', '007 780 0001234567890123 45'); await p.evaluate(() => finishOnboarding()); await sleep(1800);
  }
  await p.evaluate(() => stockRefreshLevels());
  await p.evaluate(() => { Storage.set('clients', [{ id: 'c1', name: 'Client Test', createdAt: new Date().toISOString() }]); });
  const level = (id) => p.evaluate((i) => stockLevel(i), id);
  const pid = async (n) => p.evaluate((nm) => (Storage.get('products', []).find(x => x.name === nm) || {}).id, n);

  await p.evaluate(() => {
    Storage.set('products', [{ id: 'pa', name: 'Farine 25kg', price: 200, tva: 20, unit: 'sac', trackStock: true }]);
    Storage.set('suppliers', [{ id: 's1', name: 'Minoterie' }, { id: 's2', name: 'Bailleur' }]);
    Storage.set('clients', [{ id: 'c1', name: 'Épicerie Nour', ice: '001234567000089' }]);
    window.__t = []; const o = showToast; showToast = (m, t) => { window.__t.push(String(m)); return o(m, t); }; window.confirm = () => true; window.prompt = (q, d) => (d !== undefined ? d : 'Recette');
  });
  await sleep(800);
  const T = () => p.evaluate(() => window.__t[window.__t.length - 1] || '');
  const today = await p.evaluate(() => todayISO()), first = today.slice(0, 8) + '01';
  const prevDay = await p.evaluate((f) => { const d = new Date(f + 'T12:00:00'); d.setDate(0); return d.toISOString().slice(0, 10); }, first);
  // 1) Comptes
  const mkAcc = (n, k, b) => p.evaluate(async ([n, k, b, d]) => { navTo('treasury'); openCashAccount(); document.getElementById('caName').value = n; document.getElementById('caKind').value = k; document.getElementById('caOpening').value = String(b); document.getElementById('caDate').value = d; await saveCashAccount(); }, [n, k, b, first]);
  await mkAcc('Banque', 'bank', 10000); await mkAcc('Caisse', 'cash', 500); await sleep(400);
  const bal = () => p.evaluate(async () => { const r = await supaClient.rpc('cash_balances', { p_date: null }); return Object.fromEntries((r.data || []).filter(x => x.account_id).map(x => [x.name, Number(x.balance)])); });
  ok('1. comptes Banque 10 000 et Caisse 500 au 1er du mois', JSON.stringify(await bal()) === JSON.stringify({ Banque: 10000, Caisse: 500 }), JSON.stringify(await bal()));
  // 3) Deux achats du produit suivi, avec échéance
  const buy = (pu, due) => p.evaluate(async ([pu, due]) => { navTo('purchases'); openPurchase(); document.getElementById('purSupplier').value = 's1'; const r = document.querySelector('#purLines .pur-line'); r.querySelector('.pl-prod').value = 'pa'; onPurchaseProduct(r.querySelector('.pl-prod')); r.querySelector('.pl-qty').value = '10'; r.querySelector('.pl-price').value = String(pu); document.getElementById('purDue').value = due; await savePurchase(); }, [pu, due]);
  await buy(50, today); await buy(62, today); await sleep(500);
  await p.evaluate(async () => { navTo('stock'); await stockRefreshLevels(); await renderStock(); });
  ok('3. deux achats (10 × 50, 10 × 62) : stock 20, coût moyen 56 affiché dans Stock', (await p.evaluate(() => stockLevel('pa'))) === 20 && (await p.evaluate(() => (stockValOf('pa') || {}).cmup)) === 56 && /56[.,]00/.test(await p.innerText('#page-stock')), await p.innerText('#page-stock').then(t => t.slice(0, 200)));
  // 4) Loyer payé maintenant depuis la Banque
  await p.evaluate(async () => { navTo('purchases'); openPurchase('expense'); document.getElementById('purSupplier').value = 's2'; const r = document.querySelector('#purLines .pur-line'); r.querySelector('.pl-desc').value = 'Loyer'; const c = r.querySelector('.pl-cat'); c.value = [...c.options].find(o => /Loyer/.test(o.value)).value; r.querySelector('.pl-qty').value = '1'; r.querySelector('.pl-price').value = '2000'; setTvaSelect(r.querySelector('.pl-tva'), 0); document.getElementById('purPaid').checked = true; document.getElementById('purPayAccount').value = cashActive().find(a => a.kind === 'bank').id; await savePurchase(); });
  await sleep(500);
  ok('4. loyer 2 000 payé maintenant : achat soldé, Banque 8 000', (await p.evaluate(() => { const x = purList().find(y => y.totalTTC === 2000); return x && x.paid === 2000; })) && (await bal()).Banque === 8000, JSON.stringify(await bal()));
  // 5) Facture F1 (5 sacs × 200 HT) puis paiement partiel en espèces sur la Caisse
  const issue = (qty) => p.evaluate(async (q) => { navTo('invoices'); newInvoice(); document.getElementById('editorClient').value = 'c1'; document.getElementById('itemsBody').innerHTML = '';
    addItem({ description: 'Farine', quantity: q, price: 200, tva: 20 }); const row = document.getElementById('itemsBody').lastElementChild; currentPickerRowId = row.id; selectProductForItem('pa'); row.querySelector('.item-qty').value = q; row.querySelector('.item-price').value = 200;
    await saveInvoice('sent'); return editingInvoice.id; }, qty);
  const f1 = await issue(5); await sleep(1500);
  await p.evaluate(async ([id]) => { navTo('payments'); recordPayment(); await new Promise(r => setTimeout(r, 400)); document.getElementById('paymentInvoice').value = id; document.getElementById('paymentAmount').value = '600'; document.getElementById('paymentMethod').value = 'especes'; document.getElementById('paymentMethod').onchange(); savePayment(); }, [f1]);
  await sleep(1500);
  ok('5. F1 émise (1 000 HT, 1 200 TTC), stock 15 ; paiement partiel 600 en espèces : Caisse 1 100', (await p.evaluate(() => stockLevel('pa'))) === 15 && (await bal()).Caisse === 1100, JSON.stringify([await p.evaluate(() => stockLevel('pa')), await bal()]));
  ok('5. statut de F1 : payée en partie, reste 600', await p.evaluate((id) => { const i = getInvoiceWithStatus(Storage.get('invoices', []).find(x => x.id === id)); return invoiceRemaining(i, Storage.get('payments', [])) === 600; }, f1));
  // 6) Avoir avec retour d'une unité (F2), avoir sans retour (F3)
  const f2 = await issue(3); await sleep(1200); const f3 = await issue(2); await sleep(1200);
  await p.evaluate((i) => { createCreditFromInvoice(i); }, f2); await sleep(500);
  await p.evaluate(() => { const m = document.querySelector('.cr-return'); m.querySelector('.cr-ret-on').click(); m.querySelector('.cr-ret-qty').value = '1'; m.querySelector('.cr-ret-ok').click(); }); await sleep(1500);
  const sAfterRet = await p.evaluate(() => stockLevel('pa'));
  await p.evaluate((i) => { createCreditFromInvoice(i); }, f3); await sleep(500);
  await p.evaluate(() => document.querySelector('.cr-return .cr-ret-ok').click()); await sleep(1500);
  ok('6. avoir avec retour d\'1 sac : stock 10 → 11 ; avoir sans retour : stock inchangé (11)', sAfterRet === 11 && (await p.evaluate(() => stockLevel('pa'))) === 11, `${sAfterRet} / ${await p.evaluate(() => stockLevel('pa'))}`);
  // 7) BL de 2 sacs, facturé et émis, puis tentative d'annulation
  await p.evaluate(async () => { navTo('deliveries'); openDelivery(); document.getElementById('blClient').value = 'c1'; document.getElementById('blLines').innerHTML = ''; addDeliveryLine(); const r = [...document.querySelectorAll('#blLines .pur-line')].pop(); r.querySelector('.pl-prod').value = 'pa'; onDeliveryProduct(r.querySelector('.pl-prod')); r.querySelector('.pl-qty').value = '2'; r.querySelector('.pl-price').value = '200'; await saveDelivery(); });
  await sleep(800);
  const bl = await p.evaluate(() => blList()[0]);
  await p.evaluate(async (id) => { await createInvoiceFromDeliveries([id]); }, bl.id); await sleep(800);
  const f4 = await p.evaluate(async () => { const d = Storage.get('invoices', []).find(i => i.status === 'draft' && i.deliveryIds); editInvoice(d.id); await saveInvoice('sent'); return d.id; }); await sleep(1500);
  ok('7. BL de 2 sacs facturé et émis : stock 9 (pas de double sortie)', (await p.evaluate(() => stockLevel('pa'))) === 9, String(await p.evaluate(() => stockLevel('pa'))));
  await p.evaluate(async (id) => { navTo('deliveries'); await blLoad(true); await cancelDelivery(id); }, bl.id); await sleep(600);
  ok('7. annulation du BL facturé : refusée, BL toujours actif', (await p.evaluate((id) => blList().find(d => d.id === id).status, bl.id)) === 'active', await T());
  // 8) Règlement en deux fois, virement puis annulation
  const p1 = await p.evaluate(() => purList().find(x => x.totalTTC === 600).id);
  const settle = (amt) => p.evaluate(async ([i, a]) => { await openSettle(i); document.getElementById('stAmount').value = String(a); document.getElementById('stAccount').value = cashActive().find(x => x.kind === 'bank').id; await saveSettle(); }, [p1, amt]);
  await settle(400); await sleep(400); await settle(300); await sleep(400);
  ok('8. règlement 400 accepté, puis 300 refusé (reste 200)', (await p.evaluate((i) => purList().find(x => x.id === i).paid, p1)) === 400 && /supérieur au reste/.test(await T()), await T());
  await p.evaluate(() => closeModal('settleModal'));
  await p.evaluate(async () => { navTo('treasury'); await openCashMove(); document.getElementById('cmKind').value = 'transfer'; onCashMoveKind(); document.getElementById('cmAccount').value = cashActive().find(x => x.kind === 'bank').id; document.getElementById('cmTo').value = cashActive().find(x => x.kind === 'cash').id; document.getElementById('cmAmount').value = '1000'; await saveCashMove(); });
  await sleep(400); const afterTr = await bal();
  await p.evaluate(async () => { await renderTreasury(); const id = [...document.querySelectorAll('#treJournal .stk-row')].find(r => /Virement émis/.test(r.innerText)).querySelector('button').getAttribute('onclick').match(/reverseCashMove\(['"]?([^'")]+)/)[1]; await reverseCashMove(id); });
  await sleep(400);
  ok('8. virement 1 000 Banque → Caisse puis annulé : soldes revenus (Banque 7 600, Caisse 1 100)', afterTr.Banque === 6600 && afterTr.Caisse === 2100 && JSON.stringify(await bal()) === JSON.stringify({ Banque: 7600, Caisse: 1100 }), JSON.stringify([afterTr, await bal()]));
  // 9) Pilotage comparé au calcul à la main
  await p.evaluate(async () => { navTo('pilotage'); await new Promise(r => setTimeout(r, 200)); await renderPilotage(); });
  const s = await p.evaluate(() => _pilData); const N = (k) => Number(s[k]);
  // CA = 1000 + 600 + 400 + 400 − 600 − 400 = 1400 ; CMV = (5+3+2+2) × 56 − 56 = 616 ; marge 784 ; charges 2000 ; résultat −1216
  ok('9. CA HT 1 400 (4 factures − 2 avoirs), coût des ventes 616, marge 784', N('sales_ht') === 1400 && N('cogs') === 616 && N('gross_margin') === 784, JSON.stringify([s.sales_ht, s.cogs, s.gross_margin]));
  ok('9. charges 2 000 (loyer), résultat −1 216 ; encaissé 600', N('charges') === 2000 && N('result') === -1216 && N('collections') === 600);
  // créances : F1 600 + F4 480 (F2, F3 soldées par avoir) ; dettes : 200 + 744 ; stock 9 × 56 ; trésorerie 7 600 + 1 100
  ok('9. créances 1 080, dettes 944, stock 504, trésorerie 8 700', N('receivables') === 1080 && N('payables') === 944 && N('stock_value') === 504 && N('treasury') === 8700, JSON.stringify([s.receivables, s.payables, s.stock_value, s.treasury]));
  ok('9. écran Pilotage : mêmes montants affichés', /1\s?400[.,]00/.test(await p.innerText('#pilResult')) && /616[.,]00/.test(await p.innerText('#pilResult')) && /8\s?700[.,]00/.test(await p.innerText('#pilPosition')));
  const trTot = await p.evaluate(async () => { navTo('treasury'); await renderTreasury(); return document.getElementById('treTotal').innerText; });
  ok('9. Trésorerie et Pilotage donnent la même trésorerie (8 700)', /8\s?700[.,]00/.test(trTot), trTot);
  // 11) Journaux de gestion : cohérents avec le Pilotage
  const csv = await p.evaluate(async ([f, t]) => { let out = ''; const o = URL.createObjectURL; URL.createObjectURL = (b) => { b.text().then(x => { out = x; }); return 'blob:x'; }; HTMLAnchorElement.prototype.click = function () {};
    document.getElementById('axFrom').value = f; document.getElementById('axTo').value = t; await exportJournals(); await new Promise(r => setTimeout(r, 300)); URL.createObjectURL = o; return out; }, [first, today]);
  const rows = csv.replace(/^﻿/, '').split('\n').slice(2).map(l => l.split(';')), num = (x) => Number(String(x || '0').replace(',', '.'));
  const sum = (j, col, f = () => true) => Math.round(rows.filter(r => r[0] === j && f(r)).reduce((t, r) => t + num(r[col]), 0) * 100) / 100;
  ok('11. journal des ventes : somme HT = CA du Pilotage (1 400)', sum('VENTES', 8) === 1400, String(sum('VENTES', 8)));
  ok('11. journal des achats : charges = 2 000, marchandises HT = 1 120', sum('ACHATS', 8, r => r[5] === 'Charge' && /actif/.test(r[14])) === 2000 && sum('ACHATS', 8, r => r[5] === 'Marchandise') === 1120);
  ok('11. journal des encaissements = encaissé du Pilotage (600)', sum('ENCAISSEMENTS', 10) === 600);
  ok('11. journal de trésorerie : net = variation des comptes (−2 400 : loyer 2 000 + règlement 400, virement annulé neutre)', sum('TRESORERIE', 10) === -2400, String(sum('TRESORERIE', 10)));
  // 10) Clôture du mois précédent
  await p.evaluate(async (pm) => { navTo('treasury'); await openCloseMonth(); document.getElementById('clMonth').value = pm; await checkCloseMonth(); await confirmCloseMonth(); }, prevDay.slice(0, 7)); await sleep(400);
  ok('10. mois précédent clôturé', (await p.evaluate(() => _finLock)) === prevDay, String(await p.evaluate(() => _finLock)));
  await p.evaluate(async (d) => { navTo('purchases'); openPurchase('expense'); document.getElementById('purSupplier').value = 's2'; document.getElementById('purDate').value = d; const r = document.querySelector('#purLines .pur-line'); r.querySelector('.pl-desc').value = 'Oubli'; const c = r.querySelector('.pl-cat'); c.value = c.options[1].value; r.querySelector('.pl-qty').value = '1'; r.querySelector('.pl-price').value = '10'; await savePurchase(); }, prevDay);
  await sleep(400);
  ok('10. achat daté du mois clôturé : refusé', /Période clôturée/.test(await T()) && !(await p.evaluate(() => purList().some(x => x.totalTTC === 12 || x.totalHT === 10))), await T());
  await p.evaluate(() => closeModal('purchaseModal'));
  await p.evaluate(async ([id, d]) => { navTo('payments'); recordPayment(); await new Promise(r => setTimeout(r, 400)); document.getElementById('paymentInvoice').value = id; document.getElementById('paymentDate').value = d; document.getElementById('paymentAmount').value = '10'; savePayment(); }, [f4, prevDay]);
  await sleep(400);
  ok('10. paiement daté du mois clôturé : refusé', /clôturée/.test(await T()) && (await p.evaluate(() => Storage.get('payments', []).length)) === 1);
  await p.evaluate(async (pm) => { window.prompt = () => 'Correction recette'; navTo('treasury'); await reopenMonth(pm); }, prevDay.slice(0, 7)); await sleep(400);
  ok('10. réouverture avec motif : verrou levé', (await p.evaluate(() => _finLock)) === null);
  // Caisse négative : alerte visible
  await p.evaluate(async () => { navTo('treasury'); await openCashMove(); document.getElementById('cmKind').value = 'owner_out'; onCashMoveKind(); document.getElementById('cmAccount').value = cashActive().find(x => x.kind === 'cash').id; document.getElementById('cmAmount').value = '2000'; await saveCashMove(); await renderTreasury(); });
  ok('caisse rendue négative (retrait 2 000 > 1 100) : alerte affichée', /ne peut pas être négative/.test(await p.innerText('#treAccounts')));
  if (process.env.SHOT_DIR) { await p.evaluate(async () => { navTo('pilotage'); await renderPilotage(); }); await p.screenshot({ path: process.env.SHOT_DIR + '/recette-pilotage.png', fullPage: true, animations: 'disabled' }); }
  await browser.close(); srv.close(); try { dropDb(db); } catch (e) {}
  const n = R_.filter(Boolean).length; console.log(`\n${n === R_.length ? 'OK' : 'ÉCHEC'} : ${n}/${R_.length} contrôles (recette §6 complète)`); process.exit(n === R_.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
