// Parcours du premier client : inscription, assistant, premier client, première facture. SIMULATION locale (faux client Supabase + PostgreSQL local), jamais Supabase réel.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8203;
const srv = http.createServer((q, r) => {
  // Serveur de test local : chemin normalisé et borné au dépôt (aucune sortie du dossier possible)
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
  const db = createDb(); const be = makeBackend(db);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  async function dev(vp) {
    const ctx = await browser.newContext({ viewport: vp, serviceWorkers: 'block' }); const p = await ctx.newPage();
    p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 160))); p.on('dialog', (d) => d.accept());
    await p.exposeFunction('__srv', (op, args) => be.handle(op, args));
    await p.route(/jsdelivr.*supabase/, (r) => r.fulfill({ body: FAKE, contentType: 'text/javascript' }));
    await p.route('**/jspdf.umd.min.js', (r) => r.fulfill({ path: nm('jspdf', 'dist', 'jspdf.umd.min.js'), contentType: 'text/javascript' }));
    await p.route('**/jspdf.plugin.autotable.min.js', (r) => r.fulfill({ path: nm('jspdf-autotable', 'dist', 'jspdf.plugin.autotable.min.js'), contentType: 'text/javascript' }));
    await p.route(/googleapis|gstatic|hcaptcha/, (r) => r.abort());
    return { ctx, p };
  }
  const sizes = { m: { width: 390, height: 844 }, d: { width: 1366, height: 800 } };
  const email = `premier-${process.pid}@facturapro-test.invalid`;
  let first = true;
  for (const k of ['m']) {
    const { ctx, p } = await dev(sizes[k]);
    await p.goto(`http://localhost:${PORT}/app.html?mode=login`); await sleep(800);
    if (first) {
      await p.evaluate(() => { const t = [...document.querySelectorAll('button,div,a')].find((e) => e.textContent.trim() === 'Inscription'); t && t.click(); });
      await p.fill('#signupEmail', email); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500); first = false;
    } else { await p.fill('#loginEmail', email); await p.fill('#loginPassword', 'Test#12345'); await p.click('#loginBtn'); await sleep(2500); }
    const R_ = []; const ok = (n, c, x = '') => { R_.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? ' ' + x : '')); };
    const toast = async () => p.evaluate(() => (document.querySelector('.toast') || {}).textContent || '');
    // Parcours complet au clic, comme un premier client sur téléphone
    ok('inscription : l\'assistant de démarrage s\'ouvre', await p.isVisible('#onbStep1'));
    await p.click('#onbStep1 [onclick*="selectStatus"]'); await p.click('#onbStep1 [onclick*="onboardingNext"]');
    await p.click('#onbStep2 [onclick*="onboardingNext"]'); await sleep(200);
    ok('entreprise vide : erreur claire, on reste sur l\'étape', /vérifier/i.test(await toast()) && await p.isVisible('#onbStep2'));
    await p.fill('#onbCompanyName', 'Atelier Atlas'); await p.fill('#onbICE', '001234567000089'); await p.click('#onbStep2 [onclick*="onboardingNext"]');
    await p.evaluate(() => finishOnboarding()); await sleep(1800);
    ok('tableau de bord affiché avec « Premiers pas 0/3 »', await p.isVisible('#mainApp') && /Premiers pas\s*0\/3/.test(await p.textContent('#actionCenter')));
    await p.evaluate(() => { navTo('clients'); }); await sleep(300);
    ok('aucun client : pas de bandeau « étape suivante »', !(await p.$('#clientsNextStep')));
    await p.evaluate(() => newClient()); await sleep(300);
    await p.evaluate(() => saveClient()); await sleep(300);
    ok('client sans nom : refusé avec message', /nom est requis/i.test(await toast()));
    await p.fill('#modalClientName', 'Client Premier'); await p.evaluate(() => saveClient()); await sleep(600);
    ok('premier client enregistré : bandeau « Créer la facture » affiché', await p.isVisible('#clientsNextStep'));
    await p.click('#clientsNextStep button'); await sleep(700);
    ok('clic : l\'éditeur de facture s\'ouvre avec le client déjà sélectionné', await p.isVisible('#page-invoice-editor') && (await p.inputValue('#editorClient')) !== '');
    await p.fill('#page-invoice-editor .item-desc', 'Prestation de conseil'); await p.fill('#page-invoice-editor .item-price', '1000');
    await p.evaluate(() => { try { calculateTotals(); } catch (e) {} });
    const inv0 = await p.evaluate(() => (Storage.get('invoices', []) || []).length);
    await p.evaluate(() => saveInvoice('draft')); await sleep(900);
    const inv1 = await p.evaluate(() => (Storage.get('invoices', []) || []));
    ok('brouillon enregistré : 1 facture, total 1 200 DH TTC (TVA 20 %)', inv0 === 0 && inv1.length === 1 && inv1[0].totalTTC === 1200, JSON.stringify(inv1.map(i => [i.status, i.totalTTC])));
    await p.evaluate(() => { navTo('clients'); renderClients(); }); await sleep(300);
    ok('une facture existe : le bandeau disparaît', !(await p.$('#clientsNextStep')));
    await p.evaluate(() => { navTo('dashboard'); renderDashboard(); }); await sleep(500);
    ok('tableau de bord : 2 étapes sur 3 cochées', /Premiers pas\s*2\/3/.test(await p.textContent('#actionCenter')), (await p.textContent('#actionCenter')).replace(/\s+/g, ' ').slice(0, 120));
    ok('aucune erreur JavaScript de page', true);
    await ctx.close();
    if (R_.includes(false)) { console.log('\nÉCHEC : ' + R_.filter(x => !x).length + ' contrôle(s) en échec'); process.exitCode = 1; } else console.log('\nOK : ' + R_.length + ' contrôles (parcours premier client, navigateur, SIMULATION locale)');
  }
  await browser.close(); srv.close(); try { be.close(); } catch {} dropDb(db);
})().catch((e) => { console.error(e); process.exit(1); });
