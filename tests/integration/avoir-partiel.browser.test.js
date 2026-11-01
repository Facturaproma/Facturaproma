// Avoirs partiels : quantités ou prix par ligne, plusieurs avoirs par facture, cumul plafonné, retour en stock, reste à payer. SIMULATION locale, aucune donnée réelle.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8263;
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
  await p.fill('#signupEmail', `avpart-${process.pid}@facturapro-test.invalid`); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500);
  if (!(await p.isVisible('#mainApp'))) {
    await p.evaluate(() => selectStatus(document.querySelector('[onclick*="selectStatus"]').getAttribute('onclick').match(/'(.*?)'/)[1])); await p.evaluate(() => onboardingNext(1));
    await p.fill('#onbCompanyName', 'Atelier Atlas SARL'); await p.fill('#onbICE', '001234567000089'); await p.evaluate(() => onboardingNext(2));
    await p.fill('#onbBank', 'Banque test'); await p.fill('#onbRIB', '007 780 0001234567890123 45'); await p.evaluate(() => finishOnboarding()); await sleep(1800);
  }
  await p.evaluate(() => stockRefreshLevels());
  await p.evaluate(() => { Storage.set('clients', [{ id: 'c1', name: 'Client Test', createdAt: new Date().toISOString() }]); });
  const level = (id) => p.evaluate((i) => stockLevel(i), id);
  const pid = async (n) => p.evaluate((nm) => (Storage.get('products', []).find(x => x.name === nm) || {}).id, n);

  await p.evaluate(async () => {
    Storage.set('products', [{ id: 'pf', name: 'Farine 25kg', price: 100, tva: 20, unit: 'sac', trackStock: true }, { id: 'ps', name: 'Conseil', price: 500, tva: 20 }]);
    Storage.set('clients', [{ id: 'c1', name: 'Épicerie Nour' }]);
    await stockRecord([{ key: 'init', productId: 'pf', productName: 'Farine 25kg', unit: 'sac', type: 'in', qty: 20, date: todayISO(), source: 'manual' }]);
  });
  const f1 = await p.evaluate(async () => {
    newInvoice(); document.getElementById('editorClient').value = 'c1'; document.getElementById('itemsBody').innerHTML = '';
    addItem({ description: 'Farine', quantity: 4, price: 100, tva: 20 }); let row = document.getElementById('itemsBody').lastElementChild; currentPickerRowId = row.id; selectProductForItem('pf'); row.querySelector('.item-qty').value = 4;
    addItem({ description: 'Conseil', quantity: 1, price: 500, tva: 20 }); row = document.getElementById('itemsBody').lastElementChild; currentPickerRowId = row.id; selectProductForItem('ps'); row.querySelector('.item-qty').value = 1;
    await saveInvoice('sent'); return editingInvoice.id;
  }); await sleep(900);
  const lv = () => p.evaluate(() => stockLevel('pf'));
  const inv = () => p.evaluate((i) => Storage.get('invoices', []).find(x => x.id === i), f1);
  ok('facture : 4 sacs + conseil = 1080 TTC, stock 20 → 16', (await inv()).totalTTC === 1080 && (await lv()) === 16, JSON.stringify([(await inv()).totalTTC, await lv()]));
  await p.evaluate(() => navTo('invoices')); await sleep(400);
  ok('liste : boutons « Créer un avoir » et « Avoir partiel »', await p.evaluate(() => /createCreditFromInvoice\(/.test(document.body.innerHTML) && /✂️ Avoir partiel/.test(document.body.innerHTML)));
  const open = async () => { await p.evaluate((i) => createPartialCredit(i), f1); await sleep(500); };
  const fill = (vals, reason) => p.evaluate(([v, r]) => {
    const m = document.querySelector('.cr-partial'); const rows = [...m.querySelectorAll('.cr-p-line')];
    v.forEach((x, k) => { const row = rows[k]; if (!row) return; if (x.q !== undefined) row.querySelector('.cr-p-qty').value = x.q; if (x.p !== undefined) row.querySelector('.cr-p-price').value = x.p; if (x.r !== undefined && row.querySelector('.cr-p-ret')) row.querySelector('.cr-p-ret').value = x.r; });
    m.querySelector('.cr-p-reason').value = r; m.dispatchEvent(new Event('input', { bubbles: true }));
    return m.querySelector('.cr-p-total').textContent;
  }, [vals, reason]);
  const submit = async () => { await p.evaluate(() => document.querySelector('.cr-partial .cr-p-ok').click()); await sleep(1200); };
  const credits = () => p.evaluate((i) => Storage.get('invoices', []).filter(x => x.type === 'credit' && x.relatedInvoiceId === i), f1);

  // 1) retour d'un sac
  await open();
  ok('fenêtre : 2 lignes, retour proposé seulement pour la ligne suivie en stock', await p.evaluate(() => document.querySelectorAll('.cr-partial .cr-p-line').length === 2 && document.querySelectorAll('.cr-partial .cr-p-ret').length === 1));
  ok('aperçu du total : 120 TTC', /120/.test(await fill([{ q: 1, r: 1 }, { q: 0 }], 'Retour d\'un sac abîmé')));
  await fill([{ q: 5 }, { q: 0 }], 'Retour'); await submit();
  ok('quantité > facturée : refusée, fenêtre ouverte', await p.evaluate(() => !!document.querySelector('.cr-partial')) && (await credits()).length === 0);
  await fill([{ q: 1, p: 150 }, { q: 0 }], 'Retour'); await submit();
  ok('prix > prix facturé : refusé', (await credits()).length === 0);
  await fill([{ q: 1, p: 100, r: 2 }, { q: 0 }], 'Retour'); await submit();
  ok('quantité revenue > quantité créditée : refusée', (await credits()).length === 0);
  await fill([{ q: 1, r: 1 }, { q: 0 }], ''); await submit();
  ok('motif obligatoire', (await credits()).length === 0);
  await fill([{ q: 1, r: 1 }, { q: 0 }], 'Retour d\'un sac abîmé'); await submit();
  let cr = await credits();
  ok('avoir partiel n°1 créé : −120 TTC, numéro AVR, 1 ligne liée à la ligne 0', cr.length === 1 && cr[0].totalTTC === -120 && /^AVR/.test(cr[0].number) && cr[0].items.length === 1 && cr[0].items[0].srcIdx === 0 && cr[0].partial === true, JSON.stringify(cr[0] && [cr[0].totalTTC, cr[0].number, cr[0].items]));
  ok('stock remis : 16 → 17', (await lv()) === 17);
  ok('reste à payer : 960', await p.evaluate((i) => { const all = Storage.get('invoices', []); return invoiceRemaining(all.find(x => x.id === i), Storage.get('payments', []), all) === 960; }, f1));

  // 2) geste commercial : moitié du prix du conseil
  await p.evaluate(() => renderInvoices()); await sleep(300);
  ok('liste : « Avoir sur le reste » proposé, avoir total masqué', await p.evaluate(() => /✂️ Avoir sur le reste/.test(document.body.innerHTML) && !/onclick="createCreditFromInvoice\(/.test(document.querySelector('#page-invoices, #invoicesPage, main').innerHTML)));
  ok('avoir total refusé après un avoir partiel', await p.evaluate(async (i) => { await createCreditFromInvoice(i); return Storage.get('invoices', []).filter(x => x.type === 'credit' && x.relatedInvoiceId === i).length === 1; }, f1));
  await open(); await fill([{ q: 0 }, { q: 1, p: 250 }], 'Geste commercial sur le conseil'); await submit();
  cr = await credits();
  ok('avoir partiel n°2 (prix) : −300 TTC, sans mouvement de stock', cr.length === 2 && cr[1].totalTTC === -300 && (await lv()) === 17, JSON.stringify(cr.map(c => c.totalTTC)));
  ok('paiement supérieur au reste (700 > 660) refusé', await p.evaluate((i) => { const all = Storage.get('invoices', []); return !checkPaymentAmount(all.find(x => x.id === i), 700, Storage.get('payments', []), all).ok; }, f1));

  // 3) tout le reste
  await open();
  await p.evaluate(() => { const m = document.querySelector('.cr-partial'); m.querySelector('.cr-p-all').click(); m.querySelector('.cr-p-reason').value = 'Annulation du solde'; });
  ok('« Tout le reste » : total 660 TTC', /660/.test(await p.evaluate(() => document.querySelector('.cr-partial .cr-p-total').textContent)));
  await submit(); cr = await credits();
  ok('avoir n°3 : cumul des avoirs = 1080 = TTC de la facture', cr.length === 3 && Math.abs(cr.reduce((t, c) => t + c.totalTTC, 0) + 1080) < 0.001, JSON.stringify(cr.map(c => c.totalTTC)));
  ok('facture entièrement créditée : plus de bouton d\'avoir, reste à payer 0', await p.evaluate((i) => { renderInvoices(); const all = Storage.get('invoices', []); const f = all.find(x => x.id === i); return invoiceCreditableTTC(f, all) === 0 && invoiceRemaining(f, Storage.get('payments', []), all) === 0 && !/✂️ Avoir/.test(document.getElementById('page-invoices').innerHTML); }, f1));
  ok('stock : retour de 1 sac seulement (aucune case « revenu » pour le solde)', (await lv()) === 17);
  await p.evaluate((i) => createPartialCredit(i), f1); await sleep(300);
  ok('nouvel avoir impossible (déjà entièrement créditée)', await p.evaluate(() => !document.querySelector('.cr-partial')));

  // 4) serveur : cumul plafonné même si l'application est contournée
  const srvErr = await p.evaluate(async (i) => {
    const all = Storage.get('invoices', []); const c = all.find(x => x.type === 'credit' && x.relatedInvoiceId === i);
    const n = await getNextNumber('credit');
    const extra = { ...c, id: uuid(), number: n, totalTTC: -10, totalHT: -8.33, totalTVA: -1.67 };
    const { error } = await supaClient.from('user_data').upsert({ user_id: Storage._currentUserId, key: 'invoices', value: all.concat([extra]) }, { onConflict: 'user_id,key' });
    return error ? error.message : '';
  }, f1);
  ok('serveur : avoir supplémentaire au-delà du TTC refusé', /AVOIR_SUPERIEUR_FACTURE/.test(srvErr), srvErr);
  // 5) indicateurs serveur : ventes nettes et créances
  const figs = await p.evaluate(async () => { const d = todayISO(); const { data } = await supaClient.rpc('fin_summary', { p_from: d.slice(0, 8) + '01', p_to: d }); return data; });
  ok('Pilotage : ventes HT nettes 0 (900 facturés − 900 d\'avoirs), créances 0', figs && Number(figs.sales_ht) === 0 && Number(figs.credits_ht) === 900 && Number(figs.receivables) === 0, JSON.stringify(figs && [figs.sales_ht, figs.credits_ht, figs.receivables]));
  // PDF de l'avoir partiel
  ok('PDF de l\'avoir partiel généré sans erreur', await p.evaluate(async (i) => { const c = Storage.get('invoices', []).find(x => x.type === 'credit' && x.relatedInvoiceId === i); try { const r = await generatePDF(c.id, 'invoice', { asBlob: true }); const t = new TextDecoder('latin1').decode(await r.blob.arrayBuffer()); return /AVOIR/.test(t) && t.length > 2000; } catch (e) { return String(e); } }, f1));

  const nOk = R_.filter(Boolean).length;
  console.log(`${nOk === R_.length ? 'OK' : 'ECHEC'} : ${nOk}/${R_.length} contrôles (avoir partiel, SIMULATION locale)`);
  await browser.close(); srv.close(); dropDb(db); process.exit(nOk === R_.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
