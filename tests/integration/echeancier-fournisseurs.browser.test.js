// Échéancier fournisseurs : groupes par échéance, reste à payer (règlements et avoirs déduits), par fournisseur, CSV, alerte du tableau de bord. SIMULATION locale.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8266;
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
  await p.fill('#signupEmail', `ech-${process.pid}@facturapro-test.invalid`); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500);
  if (!(await p.isVisible('#mainApp'))) {
    await p.evaluate(() => selectStatus(document.querySelector('[onclick*="selectStatus"]').getAttribute('onclick').match(/'(.*?)'/)[1])); await p.evaluate(() => onboardingNext(1));
    await p.fill('#onbCompanyName', 'Atelier Atlas SARL'); await p.fill('#onbICE', '001234567000089'); await p.evaluate(() => onboardingNext(2));
    await p.fill('#onbBank', 'Banque test'); await p.fill('#onbRIB', '007 780 0001234567890123 45'); await p.evaluate(() => finishOnboarding()); await sleep(1800);
  }
  const T = await p.evaluate(() => todayISO());
  const rel = (n) => { const d = new Date(T + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  await p.evaluate(async ([d0, dl, dw, dlater]) => {
    Storage.set('suppliers', [{ id: 's1', name: 'Grossiste Atlas' }, { id: 's2', name: 'Imprimerie Nour' }]);
    const mk = async (k, sid, sname, due, amt) => { const r = await supaClient.rpc('purchase_record', { p: { key: k, supplier_id: sid, supplier_name: sname, date: d0, due_date: due, lines: [{ nature: 'expense', category: 'Sous-traitance', description: 'Prestation', qty: 1, unit_price: amt, tva_rate: 20 }] } }); if (r.error) throw new Error(r.error.message); };
    await mk('e1', 's1', 'Grossiste Atlas', dl, 1000);       // 1 200 TTC, en retard
    await mk('e2', 's1', 'Grossiste Atlas', dw, 500);        // 600 TTC, dans 3 jours
    await mk('e3', 's2', 'Imprimerie Nour', dlater, 2000);   // 2 400 TTC, dans 60 jours
    await mk('e4', 's2', 'Imprimerie Nour', null, 100);      // 120 TTC, sans échéance
    await mk('e5', 's2', 'Imprimerie Nour', dl, 50);         // 60 TTC, réglé ensuite → absent
    await supaClient.rpc('cash_account_create', { p: { key: 'e-acc', name: 'Banque', kind: 'bank', opening_balance: 10000, opening_date: d0 } });
    await purLoad(true); await cashLoadAccounts(true).catch(() => {});
  }, [rel(-40), rel(-5), rel(3), rel(60)]);
  // Règlement partiel (200) sur e1, règlement complet de e5, avoir de 100 HT sur e3
  await p.evaluate(async () => {
    const pl = purList(), acc = cashActive()[0].id, by = (k) => pl.find(x => x.totalTTC === k);
    await supaClient.rpc('supplier_settle', { p: { purchase_id: by(1200).id, account_id: acc, date: todayISO(), amount: 200 } });
    await supaClient.rpc('supplier_settle', { p: { purchase_id: by(60).id, account_id: acc, date: todayISO(), amount: 60 } });
    await supaClient.rpc('purchase_credit_record', { p: { purchase_id: by(2400).id, date: todayISO(), reason: 'Remise', lines: [{ line_no: 0, qty: 1, unit_price: 100 }] } });
    await purLoad(true);
  });
  const sc = await p.evaluate(() => { const s = supplierSchedule(); return { total: s.total, groups: s.groups.map(g => [g.k, g.rows.length, g.total]), sup: s.suppliers.map(x => [x.name, x.total, x.late]) }; });
  ok('reste à payer total : 1000 + 600 + 2280 + 120 = 4000 (règlements et avoir déduits, pièce soldée absente)', sc.total === 4000, JSON.stringify(sc));
  ok('groupes : en retard 1000, 7 jours 600, plus tard 2280, sans échéance 120', JSON.stringify(sc.groups) === JSON.stringify([['late', 1, 1000], ['week', 1, 600], ['later', 1, 2280], ['none', 1, 120]]), JSON.stringify(sc.groups));
  ok('par fournisseur : Imprimerie Nour 2400, Grossiste Atlas 1600 dont 1000 en retard', JSON.stringify(sc.sup) === JSON.stringify([['Imprimerie Nour', 2400, 0], ['Grossiste Atlas', 1600, 1000]]), JSON.stringify(sc.sup));
  ok('regroupement « reste du mois » : échéance au-delà de 7 jours dans le mois en cours', await p.evaluate(() => { const g = supplierSchedule('2026-11-10'); return true; }) && await p.evaluate(() => {
    const save = purList; const fake = [{ id: 'x', status: 'active', totalTTC: 100, paid: 0, credited: 0, dueDate: '2026-11-25', supplierName: 'X', number: 'N' }];
    purList = () => fake; try { return supplierSchedule('2026-11-10').groups[0].k === 'month'; } finally { purList = save; } }));
  // Fenêtre
  await p.evaluate(() => { navTo('purchases'); }); await sleep(600);
  ok('bouton « 📅 Échéancier » sur la page Achats', await p.evaluate(() => /openSupplierSchedule\(\)/.test(document.getElementById('page-purchases').innerHTML)));
  await p.evaluate(() => openSupplierSchedule()); await sleep(1200);
  const m = await p.evaluate(() => { const m = document.querySelector('.sup-sched'); return m && { groups: [...m.querySelectorAll('.sched-group')].map(g => g.dataset.g), text: m.innerText }; });
  ok('fenêtre : 4 groupes dans l\'ordre, retard en jours, total', m && JSON.stringify(m.groups) === '["late","week","later","none"]' && /5 j de retard/.test(m.text) && /dans 3 j/.test(m.text) && /4\s?000,00/.test(m.text), JSON.stringify(m));
  ok('fenêtre : avoirs et règlements affichés, total par fournisseur', /avoirs 120,00/.test(m.text) && /réglé 200,00/.test(m.text) && /Par fournisseur/.test(m.text));
  // CSV
  const csv = await p.evaluate(async () => { let out = ''; const o = URL.createObjectURL; URL.createObjectURL = (b) => { b.text().then(t => { out = t; }); return 'blob:x'; };
    exportSupplierSchedule(); await new Promise(r => setTimeout(r, 300)); URL.createObjectURL = o; return out; });
  ok('CSV : 4 lignes + total 4000,00, colonnes Situation et Reste', csv.split('\n').filter(l => l.trim()).length === 6 && /En retard/.test(csv) && /;Total;4000,00/.test(csv), csv);
  // Régler depuis l'échéancier
  await p.evaluate(() => { const b = [...document.querySelectorAll('.sup-sched button')].find(x => /Régler/.test(x.textContent)); b.click(); }); await sleep(800);
  ok('« Régler » ouvre la fenêtre de règlement sur la pièce en retard', await p.evaluate(() => !document.querySelector('.sup-sched') && /reste 1\s?000,00/.test(document.getElementById('stInfo').textContent)), await p.evaluate(() => document.getElementById('stInfo') && document.getElementById('stInfo').textContent));
  // Tableau de bord
  await p.evaluate(() => { document.querySelectorAll('.modal-overlay.active').forEach(x => x.classList.remove('active')); navTo('dashboard'); }); await sleep(1500);
  ok('tableau de bord : alerte « 2 échéances fournisseurs dont 1 en retard : 1 600 »', await p.evaluate(() => { const e = document.getElementById('supplierDueAlert'); return e && /2 échéances fournisseurs/.test(e.innerText) && /dont 1 en retard/.test(e.innerText) && /1\s?600,00/.test(e.innerText); }),
    await p.evaluate(() => document.getElementById('supplierDueAlert') && document.getElementById('supplierDueAlert').innerText));
  ok('libellé « Charges et services » et catégorie « Logiciels et abonnements »', await p.evaluate(() => /Charges et services/.test(document.getElementById('purFilter').innerHTML) && FIN_CATEGORIES.includes('Logiciels et abonnements')));

  const nOk = R_.filter(Boolean).length;
  console.log(`${nOk === R_.length ? 'OK' : 'ECHEC'} : ${nOk}/${R_.length} contrôles (échéancier fournisseurs, SIMULATION locale)`);
  await browser.close(); srv.close(); dropDb(db); process.exit(nOk === R_.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
