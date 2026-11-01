// Avoir fournisseur : retour de marchandise au prix d'achat, remise sur une charge, dette, règlement, Pilotage, TVA, journaux. SIMULATION locale, aucune donnée réelle.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8264;
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
  await p.fill('#signupEmail', `avf-${process.pid}@facturapro-test.invalid`); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500);
  if (!(await p.isVisible('#mainApp'))) {
    await p.evaluate(() => selectStatus(document.querySelector('[onclick*="selectStatus"]').getAttribute('onclick').match(/'(.*?)'/)[1])); await p.evaluate(() => onboardingNext(1));
    await p.fill('#onbCompanyName', 'Atelier Atlas SARL'); await p.fill('#onbICE', '001234567000089'); await p.evaluate(() => onboardingNext(2));
    await p.fill('#onbBank', 'Banque test'); await p.fill('#onbRIB', '007 780 0001234567890123 45'); await p.evaluate(() => finishOnboarding()); await sleep(1800);
  }
  await p.evaluate(() => {
    Storage.set('products', [{ id: 'pf', name: 'Farine', price: 100, tva: 20, unit: 'sac', trackStock: true }]);
    Storage.set('suppliers', [{ id: 's1', name: 'Grossiste' }]);
  });
  const lv = () => p.evaluate(() => stockLevel('pf'));
  // Achat : 10 sacs suivis à 50 HT + loyer 2000 HT (charge), TVA 20 % → 3000 TTC
  await p.evaluate(async () => { const r = await supaClient.rpc('purchase_record', { p: { key: 'avf-p1', supplier_id: 's1', supplier_name: 'Grossiste', date: todayISO(), lines: [
    { nature: 'goods', product_id: 'pf', product_name: 'Farine', unit: 'sac', track_stock: true, description: 'Farine', qty: 10, unit_price: 50, tva_rate: 20 },
    { nature: 'expense', category: 'Loyer', description: 'Loyer', qty: 1, unit_price: 2000, tva_rate: 20 }] } }); if (r.error) throw new Error(r.error.message);
    await purLoad(true); await stockRefreshLevels(); navTo('purchases'); await renderPurchases(); });
  const pur = () => p.evaluate(() => purList()[0]);
  ok('achat : 3000 TTC, reste à payer 3000, stock 10', (await pur()).totalTTC === 3000 && (await p.evaluate(() => purDue(purList()[0]))) === 3000 && (await lv()) === 10);
  ok('bouton « Avoir fournisseur » proposé', await p.evaluate(() => /openSupplierCredit\(/.test(document.getElementById('purchasesList').innerHTML)));
  const open = () => p.evaluate(() => openSupplierCredit(purList()[0].id));
  const fill = (vals, reason, ref) => p.evaluate(([v, r, f]) => { const m = document.querySelector('.pcr-modal'); const rows = [...m.querySelectorAll('.pcr-line')];
    v.forEach((x, k) => { if (x.q !== undefined) rows[k].querySelector('.pcr-qty').value = x.q; if (x.p !== undefined) rows[k].querySelector('.pcr-price').value = x.p; });
    m.querySelector('.pcr-reason').value = r; m.querySelector('.pcr-ref').value = f || ''; m.dispatchEvent(new Event('input', { bubbles: true })); return m.querySelector('.pcr-total').textContent; }, [vals, reason, ref]);
  const submit = async () => { await p.evaluate(() => document.querySelector('.pcr-modal .pcr-ok').click()); await sleep(1500); };
  await open(); await sleep(300);
  ok('fenêtre : 2 lignes ; prix verrouillé pour la marchandise suivie', await p.evaluate(() => { const r = document.querySelectorAll('.pcr-modal .pcr-line'); return r.length === 2 && r[0].querySelector('.pcr-price').disabled && !r[1].querySelector('.pcr-price').disabled; }));
  ok('aperçu : 3 sacs + remise de 500 → 780 TTC', /780/.test(await fill([{ q: 3 }, { q: 1, p: 500 }], 'Sacs abîmés, remise loyer', 'AV-778')));
  await fill([{ q: 11 }, { q: 0 }], 'Trop'); await submit();
  ok('quantité > achetée : refusée, rien enregistré', await p.evaluate(() => !!document.querySelector('.pcr-modal') && (purList()[0].credits || []).length === 0));
  await fill([{ q: 3 }, { q: 1, p: 500 }], ''); await submit();
  ok('motif obligatoire', await p.evaluate(() => (purList()[0].credits || []).length === 0));
  await fill([{ q: 3 }, { q: 1, p: 500 }], 'Sacs abîmés, remise loyer', 'AV-778'); await submit();
  ok('avoir enregistré : AVF-ACH-…-1, 780 TTC, fenêtre fermée', await p.evaluate(() => { const c = (purList()[0].credits || [])[0]; return !document.querySelector('.pcr-modal') && !!c && /^AVF-ACH-/.test(c.number) && c.totalTTC === 780 && c.supplierRef === 'AV-778'; }), JSON.stringify(await p.evaluate(() => purList()[0].credits)));
  ok('stock : 10 → 7 (retour au fournisseur)', (await lv()) === 7, String(await lv()));
  ok('reste à payer : 3000 − 780 = 2220 ; avoir affiché, « Annuler l\'achat » retiré', await p.evaluate(() => purDue(purList()[0]) === 2220 && /AVF-ACH-/.test(document.getElementById('purchasesList').innerHTML) && !/cancelPurchase\(/.test(document.getElementById('purchasesList').innerHTML)));
  // Règlement plafonné à la dette diminuée
  await p.evaluate(async () => { const r = await supaClient.rpc('cash_account_create', { p: { key: 'avf-acc', name: 'Banque', kind: 'bank', opening_balance: 10000, opening_date: '2026-01-01' } }); await cashLoadAccounts(true).catch(() => {}); });
  const settle = (amt) => p.evaluate(async (a) => { const r = await supaClient.rpc('supplier_settle', { p: { purchase_id: purList()[0].id, account_id: cashActive()[0].id, date: todayISO(), amount: a } }); return r.error ? r.error.message : 'ok'; }, amt);
  ok('règlement de 2300 (> 2220) refusé par le serveur', /REGLEMENT_SUPERIEUR_A_LA_DETTE/.test(await settle(2300)));
  ok('règlement de 2220 accepté → soldé', (await settle(2220)) === 'ok' && await p.evaluate(async () => { await purLoad(true); return purDue(purList()[0]) === 0; }));
  // Pilotage et TVA
  const figs = await p.evaluate(async () => { const d = todayISO(); const { data } = await supaClient.rpc('fin_summary', { p_from: d.slice(0, 8) + '01', p_to: d }); return data; });
  ok('Pilotage : charges 1500 (2000 − 500), dettes 0', figs && Number(figs.charges) === 1500 && Number(figs.payables) === 0, JSON.stringify(figs && [figs.charges, figs.payables]));
  ok('TVA déductible : 500 − 130 = 370', await p.evaluate(() => { const v = allVatPurchases().filter(x => x.fromPurchase); return Math.abs(v.reduce((t, x) => t + x.tva, 0) - 370) < 0.001; }), JSON.stringify(await p.evaluate(() => allVatPurchases())));
  // Deuxième avoir : le reste du loyer, après règlement complet → trop-payé signalé
  await p.evaluate(async () => { await renderPurchases(); openSupplierCredit(purList()[0].id); }); await sleep(300);
  ok('2e avoir : seules les quantités restantes sont proposées (7 sacs, 1500 HT de loyer)', await p.evaluate(() => { const r = [...document.querySelectorAll('.pcr-modal .pcr-line')]; return r.length === 2 && Number(r[0].querySelector('.pcr-qty').max) === 7 && /1\s?500/.test(r[1].innerText); }));
  await fill([{ q: 0 }, { q: 1, p: 1600 }], 'Trop'); await submit();
  ok('remise au-delà du reste de la ligne (1600 > 1500) refusée', await p.evaluate(() => !!document.querySelector('.pcr-modal') && purList()[0].credits.length === 1));
  await fill([{ q: 0 }, { q: 1, p: 1000 }], 'Remise complémentaire'); await submit();
  ok('2e avoir enregistré : trop-payé 1200 affiché (remboursement à obtenir)', await p.evaluate(() => purList()[0].credits.length === 2 && /trop-payé/.test(document.getElementById('purchasesList').innerHTML)));
  // Journaux comptables : lignes d'avoir en négatif dans ACHATS
  const csv = await p.evaluate(async () => { let out = ''; const orig = window.downloadFile, origB = URL.createObjectURL;
    const d = todayISO(); document.getElementById('axFrom') && (document.getElementById('axFrom').value = d.slice(0, 8) + '01'); document.getElementById('axTo') && (document.getElementById('axTo').value = d);
    URL.createObjectURL = (b) => { b.text().then(t => { out = t; }); return 'blob:x'; };
    try { await exportJournals(); } catch (e) { out = 'ERR ' + e.message; }
    await new Promise(r => setTimeout(r, 300)); URL.createObjectURL = origB; return out; });
  ok('journal ACHATS : lignes « Avoir fournisseur » en négatif', /Avoir fournisseur/.test(csv) && /-500,00/.test(csv) && /-150,00/.test(csv), csv.slice(0, 300));

  const nOk = R_.filter(Boolean).length;
  console.log(`${nOk === R_.length ? 'OK' : 'ECHEC'} : ${nOk}/${R_.length} contrôles (avoir fournisseur, SIMULATION locale)`);
  await browser.close(); srv.close(); dropDb(db); process.exit(nOk === R_.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
