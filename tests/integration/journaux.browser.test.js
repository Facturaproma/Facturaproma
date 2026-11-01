// Journaux de gestion (PR9) : export CSV unique — ventes, achats par nature (annulés signalés), encaissements avec compte, trésorerie signée ; période, montants, injection de formules. SIMULATION locale, aucune donnée réelle.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8259;
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
  await p.fill('#signupEmail', `jrn-${process.pid}@facturapro-test.invalid`); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500);
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
    Storage.set('products', [{ id: 'pa', name: 'Farine', price: 200, tva: 20, unit: 'sac', trackStock: true }]);
    Storage.set('suppliers', [{ id: 's1', name: 'Minoterie' }]); Storage.set('clients', [{ id: 'c1', name: 'Épicerie Nour', ice: '001234567000089' }]);
    window.__t = []; const o = showToast; showToast = (m, t) => { window.__t.push(String(m)); return o(m, t); };
  });
  await sleep(800);
  const ids = await p.evaluate(async () => { const d = todayISO(), old = (() => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() - 60); return x.toISOString().slice(0, 10); })(), r = async (q) => (await supaClient.rpc('purchase_record', { p: q })).data.id;
    const bank = (await supaClient.rpc('cash_account_create', { p: { name: 'Banque Populaire', kind: 'bank', opening_balance: 5000, opening_date: old } })).data.id;
    const caisse = (await supaClient.rpc('cash_account_create', { p: { name: 'Caisse', kind: 'cash', opening_balance: 0, opening_date: old } })).data.id;
    const g = await r({ key: 'k1', supplier_id: 's1', supplier_name: 'Minoterie', supplier_ice: '002', date: d, lines: [{ nature: 'goods', product_id: 'pa', product_name: 'Farine', track_stock: true, description: 'Farine', qty: 10, unit_price: 50, tva_rate: 20 }, { nature: 'expense', category: 'Transport', description: 'Livraison', qty: 1, unit_price: 30, tva_rate: 20 }] });
    const e = await r({ key: 'k2', supplier_name: '=HYPERLINK("http://x")', date: d, vat_deductible: false, lines: [{ nature: 'expense', category: 'Loyer', description: 'Loyer', qty: 1, unit_price: 2000, tva_rate: 0 }] });
    const x = await r({ key: 'k3', supplier_name: 'Doublon', date: d, lines: [{ nature: 'expense', category: 'Loyer', description: 'Saisie en double', qty: 1, unit_price: 99, tva_rate: 0 }] });
    await supaClient.rpc('purchase_cancel', { p_id: x, p_reason: 'doublon' });
    await r({ key: 'k4', supplier_name: 'Ancien', date: old, lines: [{ nature: 'asset', description: 'Hors période', qty: 1, unit_price: 777, tva_rate: 20 }] });
    await supaClient.rpc('supplier_settle', { p: { key: 'st1', purchase_id: g, account_id: bank, amount: 636, date: d } });
    await supaClient.rpc('cash_movement_record', { p: { key: 'tr1', kind: 'transfer', account_id: bank, to_account_id: caisse, amount: 200, date: d } });
    return { bank, caisse, g }; });
  await p.evaluate(async () => { navTo('invoices'); newInvoice(); document.getElementById('editorClient').value = 'c1'; document.getElementById('itemsBody').innerHTML = '';
    addItem({ description: 'Farine', quantity: 5, price: 200, tva: 20 }); const row = document.getElementById('itemsBody').lastElementChild; currentPickerRowId = row.id; selectProductForItem('pa'); row.querySelector('.item-qty').value = 5; row.querySelector('.item-price').value = 200;
    await saveInvoice('sent'); });
  await sleep(1500);
  const inv = await p.evaluate(() => Storage.get('invoices', []).find(i => i.status !== 'draft'));
  await p.evaluate(async ([id, acc]) => { navTo('payments'); recordPayment(); await new Promise(r => setTimeout(r, 400)); document.getElementById('paymentInvoice').value = id; document.getElementById('paymentAmount').value = '600'; document.getElementById('paymentMethod').value = 'especes'; document.getElementById('paymentMethod').onchange(); document.getElementById('paymentAccount').value = acc; savePayment(); }, [inv.id, ids.caisse]);
  await sleep(1500);
  const exp = async (from, to) => p.evaluate(async ([f, t]) => { let out = ''; const o = URL.createObjectURL; URL.createObjectURL = (b) => { b.text().then(x => { out = x; }); return 'blob:x'; }; HTMLAnchorElement.prototype.click = function () {};
document.getElementById('axFrom').value = f; document.getElementById('axTo').value = t; await exportJournals(); await new Promise(r => setTimeout(r, 300)); URL.createObjectURL = o; return out; }, [from, to]);
  const today = await p.evaluate(() => todayISO());
  const csv = await exp(today.slice(0, 8) + '01', today);
  const rows = csv.replace(/^﻿/, '').split('\n'), J = (j) => rows.filter(r => r.startsWith(j + ';'));
  ok('en-tête : période et avertissement comptable, colonnes', /Journaux de gestion FacturaPro du/.test(rows[0]) && /pas une comptabilité générale/.test(rows[0]) && rows[1].startsWith('Journal;Date;Pièce;Tiers;ICE;Nature'), rows.slice(0, 2).join(' | '));
  ok('VENTES : la facture émise (1 000 HT, 200 TVA, 1 200 TTC, ICE client)', J('VENTES').length === 1 && /;1000,00;200,00;1200,00;;;;émise$/.test(J('VENTES')[0]) && /001234567000089/.test(J('VENTES')[0]), J('VENTES').join(' | '));
  ok('ACHATS : une ligne par ligne de pièce, nature et catégorie (marchandise, charge transport, loyer)', J('ACHATS').filter(r => /;actif$/.test(r)).length === 3 && J('ACHATS').some(r => /;Marchandise;;Farine;500,00;100,00;600,00;oui;/.test(r)) && J('ACHATS').some(r => /;Charge;Transport;Livraison;30,00;6,00;36,00;/.test(r)), J('ACHATS').join(' | '));
  ok('ACHATS : TVA non déductible signalée ; pièce annulée présente et marquée avec son motif', J('ACHATS').some(r => /;Loyer;Loyer;2000,00;0,00;2000,00;non;/.test(r)) && J('ACHATS').some(r => /annulé : doublon/.test(r)));
  ok('période : l\'achat d\'il y a 60 jours est exclu', !/Hors période/.test(csv));
  ok('ENCAISSEMENTS : paiement 600 avec son compte (Caisse) et son mode', J('ENCAISSEMENTS').length === 1 && /;600,00;;Caisse;especes;/.test(J('ENCAISSEMENTS')[0]), J('ENCAISSEMENTS').join(' | '));
  ok('TRESORERIE : règlement fournisseur −636 rattaché à son achat, virement sur deux comptes (−200 / +200)', J('TRESORERIE').some(r => /;ACH-\d{4}-\d{3};Minoterie;;Règlement fournisseur;.*;-636,00;;Banque Populaire;/.test(r)) && J('TRESORERIE').some(r => /;-200,00;;Banque Populaire;/.test(r)) && J('TRESORERIE').some(r => /;200,00;;Caisse;/.test(r)), J('TRESORERIE').join(' | '));
  ok('TRESORERIE : les encaissements clients ne sont pas dupliqués dans la trésorerie', !J('TRESORERIE').some(r => /Encaissement/.test(r)));
  ok('injection : un tiers commençant par « = » est neutralisé', /;"?'=HYPERLINK/.test(csv) && !/;=HYPERLINK/.test(csv));
  ok('montants négatifs restent numériques (pas d\'apostrophe)', !/;'-/.test(csv));
  const none = await exp('2020-01-01', '2020-01-31');
  ok('période sans pièce : message, aucun fichier', none === '' && /Aucune pièce/.test(await p.evaluate(() => window.__t[window.__t.length - 1])));
  await p.evaluate(async () => { document.getElementById('axFrom').value = '2026-12-01'; document.getElementById('axTo').value = '2026-01-01'; await exportJournals(); });
  ok('période inversée : refusée', /Période invalide/.test(await p.evaluate(() => window.__t[window.__t.length - 1])));
  await browser.close(); srv.close(); try { dropDb(db); } catch (e) {}
  const n = R_.filter(Boolean).length; console.log(`\n${n === R_.length ? 'OK' : 'ÉCHEC'} : ${n}/${R_.length} contrôles (journaux)`); process.exit(n === R_.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
