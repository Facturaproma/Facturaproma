// Accueil : bloc « Ce mois-ci » (encaissé vs mois précédent, objectif, reste à encaisser). SIMULATION locale (faux client Supabase + PostgreSQL local), aucune donnée réelle.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8250;
const srv = http.createServer((q, r) => {
  let u = '/'; try { u = decodeURIComponent(q.url.split('?')[0]); } catch (e) { r.writeHead(400); return r.end(); }
  const f = path.resolve(R, '.' + path.posix.normalize('/' + (u === '/' ? 'index.html' : u)));
  if (f !== R && !f.startsWith(R + path.sep)) { r.writeHead(403); return r.end(); }
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } let body = d;
    if (/(app|admin)\.html$/.test(f)) body = d.toString('utf8').replace(/^const SUPABASE_URL = .*$/m, "const SUPABASE_URL = 'https://fake.supabase.test';").replace(/^const SUPABASE_ANON_KEY = .*$/m, "const SUPABASE_ANON_KEY = 'fake-anon-key';");
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
  await p.fill('#signupEmail', `rel-${process.pid}@facturapro-test.invalid`); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500);
  await p.evaluate(() => finishOnboarding()); await sleep(1800);
  await p.evaluate(() => {
    const iso_ = (dd) => { const d = new Date(); d.setDate(d.getDate() - dd); return d.toISOString().slice(0, 10); };
    Storage.set('clients', [{ id: 'c1', name: 'Client Un' }, { id: 'c2', name: 'Client Deux' }, { id: 'c3', name: 'Client Trois' }, { id: 'c4', name: 'Client Quatre' }]);
    Storage.set('invoices', [
      { id: 'i1', number: 'T-1', clientId: 'c1', clientName: 'Client Un', date: iso_(10), dueDate: iso_(5), totalHT: 1000, totalTTC: 1200, status: 'sent', items: [] },
      { id: 'a1', number: 'AV-1', type: 'credit', relatedInvoiceId: 'i1', clientId: 'c1', clientName: 'Client Un', date: iso_(9), dueDate: iso_(9), totalHT: -1000, totalTTC: -1200, status: 'sent', items: [] },
      { id: 'i2', number: 'T-2', clientId: 'c2', clientName: 'Client Deux', date: iso_(8), dueDate: iso_(30), totalHT: 500, totalTTC: 600, status: 'paid', items: [] },
      { id: 'd1', number: 'BROUILLON-1', clientId: 'c3', clientName: 'Client Trois', date: iso_(60), dueDate: iso_(40), totalHT: 9000, totalTTC: 10800, status: 'draft', items: [] }
    ]);
    Storage.set('payments', []);
    Storage.set('quotes', [{ id: 'q1', number: 'DEV-1', clientId: 'c4', clientName: 'Client Quatre', items: [], totalTTC: 100, status: 'sent', convertedTo: 'd1' }]);
    Storage.set('recurring', []);
  });
  // Rapport « Top clients » : ni brouillon ni facture annulée par avoir
  const tc = await p.evaluate(() => { navTo('reports'); try { setReportRange && 0; } catch (e) {} renderReportTopClients(); return document.getElementById('rpTcTable').innerText + '|' + document.getElementById('rpTcActiveCount').innerText; });
  ok('Top clients : le brouillon de « Client Trois » (10 800) est exclu', !/Client Trois/.test(tc), tc.replace(/\s+/g, ' '));
  ok('Top clients : la facture annulée par avoir de « Client Un » est exclue', !/Client Un/.test(tc));
  ok('Top clients : seule « Client Deux » (facture payée) est comptée', /Client Deux/.test(tc) && /\|1$/.test(tc.trim()));
  // Suppression de client : refusée s'il a un devis ou une récurrence
  await p.evaluate(() => deleteClient('c4'));
  ok('client avec un devis : suppression refusée', await p.evaluate(() => Storage.get('clients', []).some(c => c.id === 'c4')));
  await p.evaluate(() => { Storage.set('quotes', []); Storage.set('recurring', [{ id: 'r1', clientId: 'c4', clientName: 'Client Quatre', frequency: 'monthly', nextDate: todayISO(), items: [], totalTTC: 1 }]); deleteClient('c4'); });
  ok('client avec une récurrence : suppression refusée', await p.evaluate(() => Storage.get('clients', []).some(c => c.id === 'c4')));
  await p.evaluate(() => { Storage.set('recurring', []); deleteClient('c4'); });
  ok('client sans lien : supprimé', await p.evaluate(() => !Storage.get('clients', []).some(c => c.id === 'c4')));
  await p.evaluate(() => deleteClient('c2'));
  ok('client avec facture : suppression refusée', await p.evaluate(() => Storage.get('clients', []).some(c => c.id === 'c2')));
  // Brouillon supprimé : le devis d'origine perd son lien
  await p.evaluate(() => { Storage.set('quotes', [{ id: 'q1', number: 'DEV-1', clientId: 'c3', clientName: 'Client Trois', items: [], totalTTC: 100, status: 'accepted', convertedTo: 'd1', convertedInvoiceNumber: 'brouillon' }]); deleteInvoice('d1'); });
  ok('brouillon supprimé : le devis n\'a plus de lien vers une facture inexistante', await p.evaluate(() => { const q = Storage.get('quotes', [])[0]; return !q.convertedTo && !q.convertedInvoiceNumber; }));
  // Produit suivi avec du stock : suppression refusée
  await p.evaluate(() => { Storage.set('products', [{ id: 'pp', name: 'Sac', price: 10, tva: 20, unit: 'kg', trackStock: true }, { id: 'pq', name: 'Service', price: 10, tva: 20 }]); });
  await p.evaluate(async () => { await stockRecord([{ key: 'k1', productId: 'pp', productName: 'Sac', unit: 'kg', type: 'in', qty: 5, date: todayISO(), source: 'manual' }]); await stockRefreshLevels(); deleteProduct('pp'); });
  ok('produit suivi avec stock ≠ 0 : suppression refusée', await p.evaluate(() => Storage.get('products', []).some(x => x.id === 'pp')));
  await p.evaluate(() => { deleteProduct('pq'); });
  ok('produit non suivi : supprimé', await p.evaluate(() => !Storage.get('products', []).some(x => x.id === 'pq')));
  await browser.close(); srv.close(); try { dropDb(db); } catch (e) {}
  const n = R_.filter(Boolean).length; console.log(`\n${n === R_.length ? 'OK' : 'ÉCHEC'} : ${n}/${R_.length} contrôles (cohérence des liaisons)`); process.exit(n === R_.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
