// Trésorerie (sql/39) : comptes et soldes d'ouverture, achat payé comptant, règlements fournisseurs plafonnés, encaissement client sur un compte (lu, jamais recopié), apports, virements, annulations, dettes. SIMULATION locale, aucune donnée réelle.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8256;
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
  await p.fill('#signupEmail', `tre-${process.pid}@facturapro-test.invalid`); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500);
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
    Storage.set('products', [{ id: 'pf', name: 'Farine', price: 100, tva: 20, unit: 'sac', trackStock: true }]);
    Storage.set('suppliers', [{ id: 's1', name: 'Minoterie' }]); Storage.set('clients', [{ id: 'c1', name: 'Épicerie Nour' }]);
  });
  await p.evaluate(async () => { navTo('treasury'); await renderTreasury(); });
  ok('sans compte : invitation à créer un compte', /Aucun compte/.test(await p.innerText('#treAccounts')));
  const mkAcc = (name, kind, bal) => p.evaluate(async ([n, k, b]) => { openCashAccount(); document.getElementById('caName').value = n; document.getElementById('caKind').value = k; document.getElementById('caOpening').value = String(b); document.getElementById('caDate').value = '2026-10-01'; await saveCashAccount(); }, [name, kind, bal]);
  await mkAcc('Banque', 'bank', 10000); await mkAcc('Caisse', 'cash', 500); await sleep(400);
  const bal = async () => p.evaluate(async () => { const r = await supaClient.rpc('cash_balances', { p_date: null }); return Object.fromEntries(r.data.map(x => [x.name, Number(x.balance)])); });
  ok('deux comptes créés avec leur solde d\'ouverture (10 000 et 500)', JSON.stringify(await bal()) === JSON.stringify({ Banque: 10000, Caisse: 500 }), JSON.stringify(await bal()));
  ok('nom de compte en double : refusé', await p.evaluate(async () => { openCashAccount(); document.getElementById('caName').value = 'Banque'; document.getElementById('caOpening').value = '1'; await saveCashAccount(); const ok_ = document.getElementById('cashAccountModal').classList.contains('active'); closeModal('cashAccountModal'); return ok_; }));
  // Achat payé comptant depuis la banque
  await p.evaluate(async () => { navTo('purchases'); openPurchase(); document.getElementById('purSupplier').value = 's1'; const r = document.querySelector('#purLines .pur-line'); r.querySelector('.pl-prod').value = 'pf'; onPurchaseProduct(r.querySelector('.pl-prod')); r.querySelector('.pl-qty').value = '10'; r.querySelector('.pl-price').value = '50'; await new Promise(res => setTimeout(res, 300)); document.getElementById('purPaid').checked = true; document.getElementById('purPayAccount').value = cashActive().find(a => a.kind === 'bank').id; await savePurchase(); });
  ok('« Payé maintenant » visible dès qu\'un compte existe', await p.evaluate(() => document.getElementById('purPayRow').style.display !== 'none'));
  const p1 = await p.evaluate(() => purList().find(x => x.totalTTC === 600));
  ok('achat payé comptant : soldé (réglé 600), Banque 9 400', p1 && p1.paid === 600 && (await bal()).Banque === 9400, JSON.stringify([p1 && p1.paid, await bal()]));
  // Achat à crédit en retard
  await p.evaluate(async () => { openPurchase(); document.getElementById('purSupplier').value = 's1'; const r = document.querySelector('#purLines .pur-line'); r.querySelector('.pl-prod').value = 'pf'; onPurchaseProduct(r.querySelector('.pl-prod')); r.querySelector('.pl-qty').value = '10'; r.querySelector('.pl-price').value = '62'; document.getElementById('purDate').value = '2026-10-10'; document.getElementById('purDue').value = '2026-10-20'; await savePurchase(); });
  const p2 = await p.evaluate(() => purList().find(x => x.totalTTC === 744));
  ok('achat à crédit : dette 744, trésorerie inchangée', p2 && p2.paid === 0 && (await bal()).Banque === 9400);
  await p.evaluate(async () => { navTo('treasury'); await renderTreasury(); });
  ok('Trésorerie : dette fournisseur 744 affichée « en retard »', /744[.,]00/.test(await p.innerText('#treDebts')) && /en retard/.test(await p.innerText('#treDebts')));
  // Règlements partiels et plafond
  const settle = (id, amount) => p.evaluate(async ([i, a]) => { await openSettle(i); document.getElementById('stAmount').value = String(a); await saveSettle(); }, [id, amount]);
  await settle(p2.id, 700); await sleep(300);
  ok('règlement partiel 700 : reste 44', (await p.evaluate((i) => { const x = purList().find(y => y.id === i); return Math.round((x.totalTTC - x.paid) * 100) / 100; }, p2.id)) === 44);
  await settle(p2.id, 100); await sleep(300);
  ok('règlement supérieur au reste (100 > 44) : refusé, fenêtre ouverte', await p.evaluate(() => document.getElementById('settleModal').classList.contains('active')) && (await p.evaluate((i) => purList().find(y => y.id === i).paid, p2.id)) === 700);
  await p.evaluate(() => closeModal('settleModal'));
  await settle(p2.id, 44); await sleep(300);
  ok('règlement du solde : achat soldé, Banque 9 400 − 744 = 8 656', (await p.evaluate((i) => purList().find(y => y.id === i).paid, p2.id)) === 744 && (await bal()).Banque === 8656);
  ok('règlements : stock et coûts inchangés (CMUP 56)', (await be.sql("SELECT cmup::float c FROM stock_cost_state"))[0].c === 56);
  // Encaissement client sur la caisse (espèces)
  await p.evaluate(async () => { Storage.set('invoices', [{ id: 'f1', number: 'FAC-T-1', clientId: 'c1', clientName: 'Épicerie Nour', date: todayISO(), dueDate: todayISO(), totalHT: 500, totalTVA: 100, totalTTC: 600, status: 'sent', items: [] }]); recordPayment(); await new Promise(r => setTimeout(r, 400)); document.getElementById('paymentInvoice').value = 'f1'; document.getElementById('paymentAmount').value = '600'; document.getElementById('paymentMethod').value = 'especes'; document.getElementById('paymentMethod').onchange(); savePayment(); });
  await sleep(1500);
  ok('paiement client en espèces : compte Caisse proposé et enregistré sur le paiement', await p.evaluate(() => { const py = Storage.get('payments', [])[0]; return py && py.accountId === cashActive().find(a => a.kind === 'cash').id; }));
  ok('Caisse = 500 + 600 = 1 100 (encaissement lu, aucune ligne recopiée)', (await bal()).Caisse === 1100 && (await be.sql("SELECT count(*)::int n FROM cash_movements WHERE direction = 'in'"))[0].n === 0, JSON.stringify(await bal()));
  // Apport, virement, annulation du virement
  const move = (kind, amount, toCash) => p.evaluate(async ([k, a, t]) => { await openCashMove(); document.getElementById('cmKind').value = k; onCashMoveKind(); document.getElementById('cmAccount').value = cashActive().find(x => x.kind === 'bank').id; if (t) document.getElementById('cmTo').value = cashActive().find(x => x.kind === 'cash').id; document.getElementById('cmAmount').value = String(a); await saveCashMove(); }, [kind, amount, toCash]);
  await move('owner_in', 5000); await move('transfer', 1000, true); await sleep(400);
  ok('apport 5 000 puis virement 1 000 vers la caisse : Banque 12 656, Caisse 2 100', JSON.stringify(await bal()) === JSON.stringify({ Banque: 12656, Caisse: 2100 }), JSON.stringify(await bal()));
  await p.evaluate(async () => { await renderTreasury(); const id = [...document.querySelectorAll('#treJournal .stk-row')].find(r => /Virement reçu/.test(r.innerText)).querySelector('button').getAttribute('onclick').match(/reverseCashMove\(['"]?([^'")]+)/)[1]; await reverseCashMove(id); });
  await sleep(400);
  ok('annulation du virement : les deux jambes annulées (Banque 13 656, Caisse 1 100)', JSON.stringify(await bal()) === JSON.stringify({ Banque: 13656, Caisse: 1100 }), JSON.stringify(await bal()));
  ok('journal : mouvements annulés marqués (libellé lisible), encaissement client affiché avec sa facture', /annulé/.test(await p.innerText('#treJournal')) && /Annulation : Virement reçu/.test(await p.innerText('#treJournal')) && /FAC-T-1/.test(await p.innerText('#treJournal')));
  // Achat réglé : annulation refusée tant que le règlement existe
  await p.evaluate(async (i) => { navTo('purchases'); await purLoad(true); await cancelPurchase(i); }, p1.id); await sleep(300);
  ok('achat réglé : annulation refusée', (await p.evaluate((i) => purList().find(x => x.id === i).status, p1.id)) === 'active');
  await p.evaluate(async () => { navTo('treasury'); await renderTreasury(); const row = [...document.querySelectorAll('#treJournal .stk-row')].find(r => /Règlement fournisseur/.test(r.innerText) && /600[.,]00/.test(r.innerText)); const id = row.querySelector('button').getAttribute('onclick').match(/reverseCashMove\(['"]?([^'")]+)/)[1]; await reverseCashMove(id); });
  await p.evaluate(async (i) => { navTo('purchases'); await purLoad(true); await cancelPurchase(i); }, p1.id); await sleep(400);
  ok('règlement annulé → achat annulé ; Banque 13 656 + 600 = 14 256', (await p.evaluate((i) => purList().find(x => x.id === i).status, p1.id)) === 'cancelled' && (await bal()).Banque === 14256, JSON.stringify(await bal()));
  // Paiement ancien sans compte
  await p.evaluate(async () => { const ps = Storage.get('payments', []); ps.push({ id: 'old', invoiceId: 'f1', date: todayISO(), amount: 50, method: 'virement' }); Storage.set('payments', ps); await new Promise(r => setTimeout(r, 1200)); navTo('treasury'); await renderTreasury(); });
  ok('encaissement sans compte : signalé à part, hors soldes', /sans compte/.test(await p.innerText('#treAccounts')) && (await bal()).Caisse === 1100);
  ok('trésorerie disponible affichée (14 256 + 1 100 = 15 356)', /15\s?356[.,]00/.test(await p.innerText('#treTotal')), await p.innerText('#treTotal'));
  if (process.env.SHOT_DIR) await p.screenshot({ path: process.env.SHOT_DIR + '/tresorerie.png', fullPage: true, animations: 'disabled' });
  ok('injection : libellé échappé', await p.evaluate(async () => { await openCashMove(); document.getElementById('cmKind').value = 'other_out'; onCashMoveKind(); document.getElementById('cmAmount').value = '1'; document.getElementById('cmLabel').value = '<img src=x onerror=window.__x=1>'; await saveCashMove(); await renderTreasury(); return !document.querySelector('#treJournal img') && !window.__x; }));
  await browser.close(); srv.close(); try { dropDb(db); } catch (e) {}
  const n = R_.filter(Boolean).length; console.log(`\n${n === R_.length ? 'OK' : 'ÉCHEC'} : ${n}/${R_.length} contrôles (trésorerie)`); process.exit(n === R_.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
