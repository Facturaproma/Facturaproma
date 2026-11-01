// Clôture de période (sql/40) : contrôles avant clôture, clôture d'octobre, refus des factures, paiements, achats, stock et trésorerie datés dans le mois clôturé, réouverture motivée. SIMULATION locale, aucune donnée réelle.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8257;
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
  await p.fill('#signupEmail', `clo-${process.pid}@facturapro-test.invalid`); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500);
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
    Storage.set('invoices', [{ id: 'd1', number: 'BRO-1', clientId: 'c1', clientName: 'Épicerie Nour', date: '2026-10-20', dueDate: '2026-10-30', totalHT: 100, totalTVA: 20, totalTTC: 120, status: 'draft', items: [{ description: 'Farine', quantity: 1, price: 100, tva: 20, discount: 0, totalHT: 100, totalTVA: 20, totalTTC: 120 }] }]);
    window.__t = []; const o = showToast; showToast = (m, t) => { window.__t.push(String(m)); return o(m, t); }; window.confirm = () => true;
  });
  await sleep(1200);
  const lastToast = () => p.evaluate(() => window.__t[window.__t.length - 1] || '');
  await p.evaluate(async () => { await supaClient.rpc('cash_account_create', { p: { name: 'Banque', kind: 'bank', opening_balance: 1000, opening_date: '2026-09-01' } });
    await supaClient.rpc('purchase_record', { p: { key: 'k1', supplier_id: 's1', supplier_name: 'Minoterie', date: '2026-10-05', lines: [{ nature: 'goods', product_id: 'pf', track_stock: true, description: 'Farine', qty: 10, unit_price: 50, tva_rate: 20 }] } }); });
  await p.evaluate(async () => { navTo('treasury'); await renderTreasury(); await finLoadLock(true); renderClosure(); });
  ok('Trésorerie : carte « Clôture des mois », aucun mois clôturé', /Aucun mois clôturé/.test(await p.innerText('#treClosure')));
  await p.evaluate(() => openCloseMonth()); await sleep(800);
  ok('fenêtre : octobre proposé par défaut (mois précédent)', (await p.inputValue('#clMonth')) === '2026-10');
  const chk = await p.innerText('#clCheck');
  ok('contrôles : 1 achat, brouillon daté signalé, bouton actif', /1 achat/.test(chk) && /brouillon/.test(chk) && !(await p.evaluate(() => document.getElementById('clConfirm').disabled)), chk);
  await p.evaluate(async () => { document.getElementById('clMonth').value = '2026-11'; await checkCloseMonth(); });
  ok('mois en cours : clôture impossible (bouton désactivé)', /pas terminé/.test(await p.innerText('#clCheck')) && await p.evaluate(() => document.getElementById('clConfirm').disabled));
  await p.evaluate(async () => { document.getElementById('clMonth').value = '2026-10'; await checkCloseMonth(); document.getElementById('clNote').value = 'Banque pointée'; await confirmCloseMonth(); });
  await sleep(300);
  ok('octobre clôturé : verrou au 31/10/2026 affiché, historique avec la note', /31\/10\/2026|31 oct/.test(await p.innerText('#treClosure')) && /Banque pointée/.test(await p.innerText('#treClosure')), await p.innerText('#treClosure'));
  // Factures
  await p.evaluate(async () => { navTo('invoices'); editInvoice('d1'); document.getElementById('editorDate').value = '2026-10-20'; await saveInvoice('sent'); });
  await sleep(600);
  ok('émission d\'un brouillon daté du 20/10 : refusée, reste brouillon, aucun numéro consommé', (await p.evaluate(() => Storage.get('invoices', []).find(i => i.id === 'd1').status)) === 'draft' && /clôturée/.test(await lastToast())
    && (await be.sql("SELECT count(*)::int n FROM public.doc_counters")).every(r => r.n === 0), await lastToast());
  await p.evaluate(async () => { editInvoice('d1'); document.getElementById('editorDate').value = todayISO(); document.getElementById('editorDueDate').value = todayISO(); await saveInvoice('sent'); });
  await sleep(1500);
  const inv = await p.evaluate(() => Storage.get('invoices', []).find(i => i.id === 'd1'));
  ok('même facture datée d\'aujourd\'hui : émise avec un numéro serveur', inv.status !== 'draft' && /^FAC-/.test(inv.number), JSON.stringify([inv.status, inv.number]));
  ok('facture émise enregistrée côté serveur (synchronisation acceptée)', (await be.sql("SELECT value FROM public.user_data WHERE key = 'invoices'"))[0].value.some(i => i.id === 'd1' && i.status !== 'draft'));
  // Paiements
  await p.evaluate(async () => { navTo('payments'); recordPayment(); await new Promise(r => setTimeout(r, 300)); document.getElementById('paymentInvoice').value = 'd1'; document.getElementById('paymentDate').value = '2026-10-15'; document.getElementById('paymentAmount').value = '50'; savePayment(); });
  await sleep(500);
  ok('paiement daté du 15/10 : refusé avant envoi', (await p.evaluate(() => (Storage.get('payments', []) || []).length)) === 0 && /clôturée/.test(await lastToast()));
  // Contournement simulé (ancienne version de l'application) : le serveur refuse et l'application revient à l'état serveur
  await p.evaluate(async () => { Storage.set('payments', [{ id: 'x1', invoiceId: 'd1', date: '2026-10-16', amount: 10, method: 'especes' }]); });
  await sleep(2000);
  ok('paiement daté du 16/10 écrit sans contrôle : refusé par le serveur, données rechargées', (await p.evaluate(() => (Storage.get('payments', []) || []).length)) === 0
    && (await be.sql("SELECT count(*)::int n FROM public.user_data WHERE key = 'payments' AND value @> '[{\"id\":\"x1\"}]'"))[0].n === 0 && /période clôturée/.test(await lastToast()), await lastToast());
  // Achats, stock, trésorerie
  await p.evaluate(async () => { navTo('purchases'); openPurchase('expense'); document.getElementById('purSupplier').value = 's1'; document.getElementById('purDate').value = '2026-10-20'; const r = document.querySelector('#purLines .pur-line'); r.querySelector('.pl-desc').value = 'Loyer'; const c = r.querySelector('.pl-cat'); if (c) c.value = c.options[1] ? c.options[1].value : ''; r.querySelector('.pl-qty').value = '1'; r.querySelector('.pl-price').value = '100'; await savePurchase(); });
  await sleep(500);
  ok('achat daté du 20/10 : refusé, fenêtre ouverte, message clair', await p.evaluate(() => document.getElementById('purchaseModal').classList.contains('active')) && /Période clôturée/.test(await lastToast()), await lastToast());
  await p.evaluate(() => closeModal('purchaseModal'));
  const nStock = (await be.sql("SELECT count(*)::int n FROM public.stock_movements"))[0].n;
  await p.evaluate(async () => { navTo('stock'); await openStockMove('in'); document.getElementById('stockMoveProduct').value = 'pf'; document.getElementById('stockMoveType').value = 'in'; document.getElementById('stockMoveQty').value = '2'; document.getElementById('stockMoveDate').value = '2026-10-15'; await saveStockMove(); });
  await sleep(400);
  ok('mouvement de stock daté du 15/10 : refusé', (await be.sql("SELECT count(*)::int n FROM public.stock_movements"))[0].n === nStock && /clôturée/.test(await lastToast()));
  await p.evaluate(async () => { navTo('treasury'); await openCashMove(); document.getElementById('cmKind').value = 'owner_in'; onCashMoveKind(); document.getElementById('cmAmount').value = '100'; document.getElementById('cmDate').value = '2026-10-31'; await saveCashMove(); });
  await sleep(400);
  ok('apport daté du 31/10 : refusé', (await be.sql("SELECT count(*)::int n FROM public.cash_movements"))[0].n === 0 && /Période clôturée/.test(await lastToast()), await lastToast());
  await p.evaluate(() => closeModal('cashMoveModal'));
  // Réouverture
  await p.evaluate(async () => { window.prompt = () => ''; await renderTreasury(); await finLoadLock(true); renderClosure(); const b = [...document.querySelectorAll('#treClosure button')].find(x => /Rouvrir/.test(x.textContent)); await reopenMonth(b.getAttribute('onclick').match(/reopenMonth\(['"]?([0-9-]+)/)[1]); });
  ok('réouverture sans motif : refusée', /Motif obligatoire/.test(await lastToast()) && (await p.evaluate(() => _finLock)) === '2026-10-31');
  await p.evaluate(async () => { window.prompt = () => 'Facture fournisseur oubliée'; await reopenMonth('2026-10'); });
  await sleep(300);
  ok('réouverture motivée : plus de verrou, motif dans l\'historique', (await p.evaluate(() => _finLock)) === null && /Facture fournisseur oubliée/.test(await p.innerText('#treClosure')));
  await p.evaluate(async () => { await openCashMove(); document.getElementById('cmKind').value = 'owner_in'; onCashMoveKind(); document.getElementById('cmAmount').value = '100'; document.getElementById('cmDate').value = '2026-10-31'; await saveCashMove(); });
  await sleep(400);
  ok('après réouverture : l\'apport du 31/10 est accepté', (await be.sql("SELECT count(*)::int n FROM public.cash_movements"))[0].n === 1);
  if (process.env.SHOT_DIR) await p.screenshot({ path: process.env.SHOT_DIR + '/cloture.png', fullPage: true, animations: 'disabled' });
  ok('injection : note de clôture échappée', await p.evaluate(async () => { await supaClient.rpc('period_close', { p_month: '2026-09', p_note: '<img src=x onerror=window.__x=1>' }); await finLoadLock(true); renderClosure(); return !document.querySelector('#treClosure img') && !window.__x; }));
  await browser.close(); srv.close(); try { dropDb(db); } catch (e) {}
  const n = R_.filter(Boolean).length; console.log(`\n${n === R_.length ? 'OK' : 'ÉCHEC'} : ${n}/${R_.length} contrôles (clôture)`); process.exit(n === R_.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
