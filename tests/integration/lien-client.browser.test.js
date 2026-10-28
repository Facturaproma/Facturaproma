// Lien client public (sql/30 + facture.html) : création du lien, page publique sans connexion, consultation comptée, actualisation après paiement,
// révocation, injection HTML neutralisée, jeton invalide. SIMULATION locale (faux Supabase + PostgreSQL local), jamais Supabase réel.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const { Pool } = require('pg');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8209;
const srv = http.createServer((q, r) => {
  let u = '/'; try { u = decodeURIComponent(q.url.split('?')[0]); } catch (e) { r.writeHead(400); return r.end(); }
  const f = path.resolve(R, '.' + path.posix.normalize('/' + (u === '/' ? 'index.html' : u)));
  if (f !== R && !f.startsWith(R + path.sep)) { r.writeHead(403); return r.end(); }
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } let body = d;
    if (/app\.html$/.test(f)) body = d.toString('utf8').replace(/^const SUPABASE_URL = .*$/m, "const SUPABASE_URL = 'https://fake.supabase.test';").replace(/^const SUPABASE_ANON_KEY = .*$/m, "const SUPABASE_ANON_KEY = 'fake-anon-key';").replace(/ integrity="[^"]*" crossorigin="anonymous"/g, '');
    const t = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.ttf': 'font/ttf', '.png': 'image/png' }[path.extname(f)] || 'application/octet-stream';
    r.writeHead(200, { 'content-type': t }); r.end(body); });
}).listen(PORT);
const nm = (...s) => path.join(R, 'node_modules', ...s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const db = createDb({ partage: true }); const be = makeBackend(db);
  const anon = new Pool({ database: db, max: 2 });
  // Le « Supabase public » : appel REST anonyme -> fonction SQL exécutée sous le rôle anon (comme PostgREST)
  const publicRpc = async (token) => { const c = await anon.connect(); try { await c.query('BEGIN'); await c.query('SET LOCAL ROLE anon'); const r = await c.query('SELECT public.get_shared_invoice($1) AS r', [token]); await c.query('COMMIT'); return r.rows[0].r; } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); } };
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const R_ = []; const ok = (n, c, x = '') => { R_.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? ' ' + x : '')); };
  const email = `lien-${process.pid}@facturapro-test.invalid`;

  // ---------- Propriétaire (application) ----------
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' }); const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message.slice(0, 160))); p.on('dialog', (d) => d.accept());
  await p.exposeFunction('__srv', (op, args) => be.handle(op, args));
  await p.route(/jsdelivr.*supabase/, (r) => r.fulfill({ body: FAKE, contentType: 'text/javascript' }));
  await p.route('**/jspdf.umd.min.js', (r) => r.fulfill({ path: nm('jspdf', 'dist', 'jspdf.umd.min.js'), contentType: 'text/javascript' }));
  await p.route('**/jspdf.plugin.autotable.min.js', (r) => r.fulfill({ path: nm('jspdf-autotable', 'dist', 'jspdf.plugin.autotable.min.js'), contentType: 'text/javascript' }));
  await p.route(/googleapis|gstatic|hcaptcha/, (r) => r.abort());
  await p.goto(`http://localhost:${PORT}/app.html?mode=login`); await sleep(800);
  await p.evaluate(() => { const t = [...document.querySelectorAll('button,div,a')].find((e) => e.textContent.trim() === 'Inscription'); t && t.click(); });
  await p.fill('#signupEmail', email); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500);
  if (!(await p.isVisible('#mainApp'))) {
    await p.evaluate(() => selectStatus(document.querySelector('[onclick*="selectStatus"]').getAttribute('onclick').match(/'(.*?)'/)[1])); await p.evaluate(() => onboardingNext(1));
    await p.fill('#onbCompanyName', 'Atelier Atlas SARL'); await p.fill('#onbICE', '001234567000089'); await p.evaluate(() => onboardingNext(2));
    await p.fill('#onbBank', 'Banque test'); await p.fill('#onbRIB', '007 780 0001234567890123 45'); await p.evaluate(() => finishOnboarding()); await sleep(1800);
  }
  await p.evaluate(() => {
    window.isUserLicensed = () => true;
    const iso = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    const mk = (id, num, status, name) => ({ id, number: num, clientId: 'c1', clientName: name, clientICE: '001234567000089', clientAddress: '12 rue Test, Casablanca', date: iso(10), dueDate: iso(-20), status, type: 'invoice', paymentTerms: '30',
      items: [{ description: 'Prestation <b>gras</b>', quantity: 2, unitPrice: 500, tva: 20, discount: 0, totalHT: 1000, totalTVA: 200, totalTTC: 1200 }], totalHT: 1000, totalTVA: 200, totalTTC: 1200, notes: 'Merci de votre confiance' });
    Storage.set('clients', [{ id: 'c1', name: 'Karim', phone: '0661234567', createdAt: new Date().toISOString() }]);
    Storage.set('invoices', [mk('f1', 'F-2026-001', 'sent', 'Karim'), mk('f2', 'BRO-AAAA11', 'draft', 'Brouillon SA'), mk('f3', 'F-2026-003', 'sent', '<img src=x onerror="window.__xss=1">')]);
    Storage.set('payments', [{ id: 'p1', invoiceId: 'f1', date: iso(2), amount: 500, method: 'virement', reference: 'VIR-1', createdAt: new Date().toISOString() }]);
  });
  const sql = (q) => require('child_process').execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A', '-d', db, '-c', q]).toString().trim();
  const toast = () => p.evaluate(() => (document.getElementById('toast') || {}).textContent || '');

  // 1. Un brouillon ne se partage pas
  await sleep(1500);
  const have = await p.evaluate(() => (Storage.get('invoices') || []).map((i) => i.id + ':' + i.number).join(','));
  await p.evaluate(() => { document.getElementById('toast').textContent = ''; openClientLink('f2'); }); await sleep(300);
  const tt = await toast() + ' | invoices=' + have; ok('brouillon : partage refusé avec un message clair, aucun lien créé', /Seule une facture enregistrée/.test(tt) && sql('SELECT count(*) FROM public.invoice_shares') === '0', JSON.stringify(tt));
  // 2. Facture enregistrée : lien créé
  await p.evaluate(() => navTo('invoices')); await sleep(400);
  ok('liste des factures : « 🔗 Lien client » proposé pour une facture enregistrée', await p.evaluate(() => /openClientLink\('f1'\)/.test(document.getElementById('page-invoices').innerHTML)));
  await p.evaluate(() => openClientLink('f1')); await sleep(900);
  const m1 = await p.evaluate(() => ({ open: !!document.querySelector('.share-link'), url: (document.getElementById('shareUrl') || {}).value || '', txt: (document.querySelector('.share-link') || {}).textContent || '' }));
  const tok = (/[?&]t=([0-9a-f]{64})$/.exec(m1.url) || [])[1];
  ok('fenêtre « Lien client » avec une adresse facture.html?t=<64 hex>', m1.open && /\/facture\.html\?t=[0-9a-f]{64}$/.test(m1.url), m1.url);
  ok('« Pas encore consulté » et validité affichées', /Pas encore consulté/.test(m1.txt) && /valable jusqu'au \d{2} \S+ \d{4}/.test(m1.txt), m1.txt.replace(/\s+/g, ' ').slice(0, 260));
  ok('un seul lien en base, au bon compte', sql('SELECT count(*) FROM public.invoice_shares') === '1');
  const stored = JSON.parse(sql("SELECT snapshot FROM public.invoice_shares LIMIT 1"));
  ok('instantané : reste dû 700 (1 200 − 500 payés), état partiel, RIB présent, aucun champ hors liste', stored.payment.remaining === 700 && stored.payment.state === 'partial' && /007 780/.test(stored.company.rib) && Object.keys(stored).every((k) => ['v', 'asOf', 'company', 'doc', 'client', 'items', 'totals', 'payment'].includes(k)));

  // 3. Page publique, visiteur sans connexion, mobile 390 px
  const pub = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' }); const v = await pub.newPage();
  const verrs = []; v.on('pageerror', (e) => verrs.push(e.message)); v.on('console', (m) => { if (m.type() === 'error') verrs.push('console: ' + m.text()); });
  const outside = []; v.on('request', (r) => { const u = r.url(); if (!u.startsWith(`http://localhost:${PORT}`) && !/supabase\.co/.test(u)) outside.push(u); });
  await v.route(/supabase\.co\/rest\/v1\/rpc\/get_shared_invoice/, async (r) => {
    const body = JSON.parse(r.request().postData() || '{}');
    const data = await publicRpc(body.p_token);
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  await v.goto(m1.url); await sleep(900);
  const pg = await v.evaluate(() => ({ t: document.body.innerText, h: document.documentElement.scrollWidth, w: window.innerWidth, title: document.title }));
  ok('page publique : société, numéro, client, lignes', /Atelier Atlas SARL/.test(pg.t) && /Facture F-2026-001/.test(pg.t) && /Karim/.test(pg.t) && /Prestation/.test(pg.t));
  ok('page publique : statut, reste à payer et montants (1 200,00 TTC ; 700,00 restant)', /Partiellement payée/.test(pg.t) && /1\s200,00 DH/.test(pg.t) && /700,00 DH/.test(pg.t) && /Reste à payer/.test(pg.t));
  ok('page publique : RIB et référence du virement', /007 780 0001234567890123 45/.test(pg.t) && /F-2026-001/.test(pg.t.split(/R.GLEMENT/i)[1] || ''));
  ok('page publique : bouton Imprimer / PDF', /Imprimer/.test(pg.t));
  ok('page publique mobile : pas de défilement horizontal', pg.h <= pg.w + 1, `${pg.h}/${pg.w}`);
  ok('page publique : aucun appel vers un autre site que le serveur de données', outside.length === 0, outside.join(','));
  ok('page publique : le HTML des données reste du texte (« <b>gras</b> » visible, aucune balise exécutée)', /<b>gras<\/b>/.test(pg.t) && await v.evaluate(() => document.querySelectorAll('main b').length === 0));
  ok('page publique : aucune erreur JavaScript ni console', verrs.length === 0, verrs.join(' | '));
  ok('consultation comptée (1)', sql('SELECT views FROM public.invoice_shares LIMIT 1') === '1');

  // 4. Le propriétaire voit « Consulté 1 fois » ; après un paiement complet, le même lien est actualisé
  await p.evaluate(() => { const ps = Storage.get('payments'); ps.push({ id: 'p2', invoiceId: 'f1', date: new Date().toISOString().slice(0, 10), amount: 700, method: 'virement', reference: 'VIR-2', createdAt: new Date().toISOString() }); Storage.set('payments', ps); });
  await p.evaluate(() => openClientLink('f1')); await sleep(900);
  const m2 = await p.evaluate(() => ({ url: document.getElementById('shareUrl').value, txt: document.querySelector('.share-link').textContent }));
  ok('réouverture : même lien conservé, « Consulté 1 fois »', m2.url === m1.url && /Consulté 1 fois/.test(m2.txt), m2.txt.slice(0, 160));
  await v.reload(); await sleep(900);
  const pg2 = await v.evaluate(() => document.body.innerText);
  ok('après paiement : la page publique affiche « Soldée », sans bloc de virement', /Soldée/.test(pg2) && !/Règlement par virement/.test(pg2));

  // 5. Injection HTML dans le nom du client (facture f3)
  await p.evaluate(() => openClientLink('f3')); await sleep(900);
  const url3 = await p.evaluate(() => document.getElementById('shareUrl').value);
  await v.goto(url3); await sleep(900);
  const inj = await v.evaluate(() => ({ img: document.querySelectorAll('main img').length, xss: !!window.__xss, t: document.body.innerText }));
  ok('nom de client piégé : affiché comme texte, aucune image, aucun script exécuté', inj.img === 0 && !inj.xss && /<img src=x/.test(inj.t));

  // 6. Jetons invalides
  for (const [label, u] of [['sans jeton', `http://localhost:${PORT}/facture.html`], ['jeton mal formé', `http://localhost:${PORT}/facture.html?t=abc`], ['jeton inconnu', `http://localhost:${PORT}/facture.html?t=${'0'.repeat(64)}`]]) {
    await v.goto(u); await sleep(500);
    ok(`${label} : « Lien indisponible », aucune information`, await v.evaluate(() => /Lien indisponible/.test(document.body.innerText) && !/Atelier|Facture F/.test(document.body.innerText)));
  }

  // 7. Révocation
  await p.evaluate(() => openClientLink('f1')); await sleep(800);
  await p.evaluate(() => document.querySelector('.share-link [data-act="revoke"]').click()); await sleep(800);
  ok('révocation : fenêtre fermée, lien marqué révoqué en base', await p.evaluate(() => !document.querySelector('.share-link')) && sql("SELECT (revoked_at IS NOT NULL) FROM public.invoice_shares WHERE invoice_id='f1'") === 't');
  await v.goto(m1.url); await sleep(600);
  ok('lien révoqué : la page publique répond « plus valide »', await v.evaluate(() => /plus valide/.test(document.body.innerText) && !/Atelier/.test(document.body.innerText)));
  await p.evaluate(() => openClientLink('f1')); await sleep(800);
  const m3 = await p.evaluate(() => document.getElementById('shareUrl').value);
  ok('repartage après révocation : NOUVEAU lien (l\'ancien reste mort)', m3 !== m1.url && /facture\.html\?t=[0-9a-f]{64}$/.test(m3));

  // 8. Propriétaire : aucune erreur JS
  ok('application : aucune erreur JavaScript', errs.length === 0, errs.join(' | '));
  const fails = R_.filter((x) => !x).length;
  console.log(fails ? fails + ' ÉCHEC(S)' : `OK : ${R_.length} contrôles (lien client, simulation locale)`);
  await browser.close(); await anon.end(); srv.close(); dropDb(db);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
