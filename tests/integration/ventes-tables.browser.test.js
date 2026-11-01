// Ventes et paiements dans de vraies tables (mode documents, sql/45) : bascule d'un compte, paiement, annulation, avoir partiel, Pilotage, trésorerie. SIMULATION locale, aucune donnée réelle.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8265;
const srv = http.createServer((q, r) => {
  let u = '/'; try { u = decodeURIComponent(q.url.split('?')[0]); } catch (e) { r.writeHead(400); return r.end(); }
  const f = path.resolve(R, '.' + path.posix.normalize('/' + (u === '/' ? 'index.html' : u)));
  if (f !== R && !f.startsWith(R + path.sep)) { r.writeHead(403); return r.end(); }
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } let body = d;
    if (/(app|admin)\.html$/.test(f)) body = d.toString('utf8').replace(/^const SUPABASE_URL = .*$/m, "const SUPABASE_URL = 'https://mdozjptoecygmpkjlohr.supabase.co';").replace(/^const SUPABASE_ANON_KEY = .*$/m, "const SUPABASE_ANON_KEY = 'fake-anon-key';").replace(/ integrity="[^"]*" crossorigin="anonymous"/g, '');
    const t = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.ttf': 'font/ttf', '.png': 'image/png', '.css': 'text/css' }[path.extname(f)] || 'application/octet-stream';
    r.writeHead(200, { 'content-type': t }); r.end(body); });
}).listen(PORT);
const nm = (...s) => path.join(R, 'node_modules', ...s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const db = createDb({ stock: true, docs: true, ventes: true }); const be = makeBackend(db);
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
  await p.fill('#signupEmail', `vtb-${process.pid}@facturapro-test.invalid`); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500);
  if (!(await p.isVisible('#mainApp'))) {
    await p.evaluate(() => selectStatus(document.querySelector('[onclick*="selectStatus"]').getAttribute('onclick').match(/'(.*?)'/)[1])); await p.evaluate(() => onboardingNext(1));
    await p.fill('#onbCompanyName', 'Atelier Atlas SARL'); await p.fill('#onbICE', '001234567000089'); await p.evaluate(() => onboardingNext(2));
    await p.fill('#onbBank', 'Banque test'); await p.fill('#onbRIB', '007 780 0001234567890123 45'); await p.evaluate(() => finishOnboarding()); await sleep(1800);
  }
  await p.evaluate(() => stockRefreshLevels());
  await p.evaluate(() => { Storage.set('clients', [{ id: 'c1', name: 'Client Test', createdAt: new Date().toISOString() }]); });
  await p.evaluate(() => {
    Storage.set('products', [{ id: 'ps', name: 'Prestation', price: 1000, tva: 20 }]);
    Storage.set('clients', [{ id: 'c1', name: 'Épicerie Nour' }]);
    window.__t = []; const o = showToast; showToast = (m, t) => { window.__t.push(String(m)); return o(m, t); }; window.confirm = () => true;
  });
  await sleep(600);
  const today = await p.evaluate(() => todayISO());
  const email = await p.evaluate(() => (supaClient.auth && supaClient.__user && supaClient.__user.email) || document.getElementById('signupEmail')?.value || '');
  await p.evaluate(async (d) => { await supaClient.rpc('cash_account_create', { p: { name: 'Caisse', kind: 'cash', opening_balance: 0, opening_date: d } }); }, today.slice(0, 8) + '01');
  // ----- en mode legacy : une facture de 1 200 et un paiement de 200 -----
  const fid = await p.evaluate(async () => { navTo('invoices'); newInvoice(); document.getElementById('editorClient').value = 'c1'; document.getElementById('itemsBody').innerHTML = '';
    addItem({ description: 'Prestation', quantity: 1, price: 1000, tva: 20 }); await saveInvoice('sent'); return editingInvoice.id; });
  await sleep(1500);
  const pay = (amt) => p.evaluate(async ([id, a]) => { navTo('payments'); recordPayment(); await new Promise(r => setTimeout(r, 500)); document.getElementById('paymentInvoice').value = id; document.getElementById('paymentAmount').value = String(a); document.getElementById('paymentMethod').value = 'especes'; document.getElementById('paymentMethod').onchange(); savePayment(); }, [fid, amt]);
  await pay(200); await sleep(1800);
  const uid = await p.evaluate(() => Storage._currentUserId);
  const udPay = async () => ((await be.sql("SELECT value FROM user_data WHERE user_id = $1 AND key = 'payments'", [uid]))[0] || {}).value || [];
  ok('legacy : facture et paiement de 200 dans user_data', (await udPay()).length === 1);
  // ----- bascule du compte par l'opérateur (copie, vérification, mode documents) -----
  await be.sql('UPDATE user_data SET updated_at = now() - interval \'1 hour\' WHERE user_id = $1', [uid]);
  await be.sql('INSERT INTO public.doc_store_testers(user_id) VALUES ($1) ON CONFLICT DO NOTHING', [uid]);
  const sw = (await be.sql('SELECT public.fp_doc_mode_set($1::uuid, \'documents\', NULL, 0) r', [uid]))[0].r;
  ok('bascule : copie vérifiée, mode documents', sw && sw.ok === true && sw.mode === 'documents', JSON.stringify(sw));
  await p.reload(); await sleep(3000);
  ok('application rechargée : mode documents, facture et paiement relus dans les nouvelles tables', await p.evaluate((id) => DocStoreGlue.mode === 'documents' && Storage.get('invoices', []).some(i => i.id === id) && Storage.get('payments', []).length === 1, fid),
    JSON.stringify(await p.evaluate(() => ({ m: DocStoreGlue.mode, st: DocStoreGlue.store && DocStoreGlue.store.status(), n: Storage.get('invoices', []).length }))));
  const udBefore = JSON.stringify(await udPay());
  // ----- paiement de 1 000 : enregistré par record_payment -----
  await p.evaluate(() => { window.__t = []; });
  await pay(1000); await sleep(2500);
  const dp = async () => be.sql('SELECT id, amount, body FROM doc_payments WHERE user_id = $1 ORDER BY created_at', [uid]);
  const dstatus = async () => (await be.sql("SELECT status, paid_amount FROM documents WHERE user_id = $1 AND doc_type = 'invoice' AND id = $2", [uid, fid]))[0];
  const bal = () => p.evaluate(async () => { const r = await supaClient.rpc('cash_balances', { p_date: null }); return Number((r.data || []).find(x => x.name === 'Caisse').balance); });
  ok('paiement de 1 000 : 2 lignes dans doc_payments, compte de trésorerie conservé', (await dp()).length === 2 && !!(await dp())[1].body.accountId, JSON.stringify(await dp()));
  ok('facture payée côté serveur (documents)', (await dstatus()).status === 'paid' && Number((await dstatus()).paid_amount) === 1200, JSON.stringify(await dstatus()));
  ok('trésorerie : Caisse 1 200 (encaissements lus dans doc_payments)', (await bal()) === 1200, String(await bal()));
  ok('aucune écriture dans l\'ancien stockage après la bascule', JSON.stringify(await udPay()) === udBefore);
  // ----- annulation du paiement de 1 000 -----
  const pid = await p.evaluate(() => Storage.get('payments', [])[1].id);
  await p.evaluate((id) => { window.prompt = () => 'Erreur de montant'; reversePayment(id); }, pid); await sleep(2500);
  ok('annulation : ligne −1 000 dans doc_payments, facture redevenue à payer côté serveur', (await dp()).length === 3 && Number((await dp())[2].amount) === -1000 && (await dstatus()).status === 'sent', JSON.stringify([await dp(), await dstatus()]));
  ok('trésorerie : Caisse revenue à 200', (await bal()) === 200);
  // ----- avoir partiel de 120 TTC -----
  await p.evaluate((id) => createPartialCredit(id), fid); await sleep(600);
  await p.evaluate(() => { const m = document.querySelector('.cr-partial'); const r = m.querySelector('.cr-p-line'); r.querySelector('.cr-p-qty').value = '1'; r.querySelector('.cr-p-price').value = '100'; m.querySelector('.cr-p-reason').value = 'Geste commercial'; m.querySelector('.cr-p-ok').click(); });
  await sleep(2500);
  const cr = await be.sql("SELECT number, total_ttc, related_id, status FROM documents WHERE user_id = $1 AND doc_type = 'credit'", [uid]);
  ok('avoir partiel : enregistré dans documents (−120, lié à la facture, émis)', cr.length === 1 && Number(cr[0].total_ttc) === -120 && cr[0].related_id === fid && cr[0].status !== 'draft', JSON.stringify(cr));
  // ----- Pilotage lu dans les nouvelles tables -----
  const s = await p.evaluate(async (d) => (await supaClient.rpc('fin_summary', { p_from: d.slice(0, 8) + '01', p_to: d })).data, today);
  ok('Pilotage : ventes HT 900 (1000 − 100), encaissé net 200, créances 880', Number(s.sales_ht) === 900 && Number(s.collections) === 200 && Number(s.receivables) === 880, JSON.stringify([s.sales_ht, s.collections, s.receivables]));
  // ----- serveur : plafond avoirs compris -----
  const over = await p.evaluate(async (id) => { const r = await supaClient.rpc('record_payment', { p_invoice_id: id, p_payment: { id: uuid(), date: todayISO(), amount: 881, method: 'especes' }, p_op_id: uuid() }); return r.error ? r.error.message : 'ok'; }, fid);
  ok('serveur : paiement au-delà du reste (881 > 880) refusé', /PAIEMENT_SUPERIEUR_AU_RESTE/.test(over), over);
  // ----- retour arrière par l'opérateur : tout revient dans user_data -----
  const rb = (await be.sql('SELECT public.fp_doc_mode_set($1::uuid, \'legacy\') r', [uid]))[0].r;
  ok('retour arrière : accepté, user_data contient 3 paiements et l\'avoir', rb && rb.ok === true && (await udPay()).length === 3
    && (await be.sql("SELECT count(*)::int n FROM user_data, jsonb_array_elements(value) e WHERE user_id = $1 AND key = 'invoices' AND e->>'type' = 'credit'", [uid]))[0].n === 1, JSON.stringify(rb));
  await p.reload(); await sleep(3000);
  const s2 = await p.evaluate(async (d) => (await supaClient.rpc('fin_summary', { p_from: d.slice(0, 8) + '01', p_to: d })).data, today);
  ok('après retour : mode legacy, mêmes chiffres de Pilotage', await p.evaluate(() => DocStoreGlue.mode === 'legacy') && Number(s2.sales_ht) === 900 && Number(s2.receivables) === 880 && Number(s2.collections) === 200, JSON.stringify([s2.sales_ht, s2.collections, s2.receivables]));

  const nOk = R_.filter(Boolean).length;
  console.log(`${nOk === R_.length ? 'OK' : 'ECHEC'} : ${nOk}/${R_.length} contrôles (ventes dans de vraies tables, SIMULATION locale)`);
  await browser.close(); srv.close(); dropDb(db); process.exit(nOk === R_.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
