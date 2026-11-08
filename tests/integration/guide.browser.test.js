// Guide animé « Comment ça marche » : invitation sur le tableau de bord, 6 étapes, navigation, « Essayer », arabe, mouvement réduit. SIMULATION locale.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8268;
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
  const errs = []; p.on('pageerror', (e) => { errs.push(e.message.slice(0, 160)); console.log('PAGEERROR', e.message.slice(0, 160)); }); p.on('dialog', (d) => d.accept());
  await p.exposeFunction('__srv', (op, args) => be.handle(op, args));
  await p.route(/jsdelivr.*supabase/, (r) => r.fulfill({ body: FAKE, contentType: 'text/javascript' }));
  await p.route('**/jspdf.umd.min.js', (r) => r.fulfill({ path: nm('jspdf', 'dist', 'jspdf.umd.min.js'), contentType: 'text/javascript' }));
  await p.route('**/jspdf.plugin.autotable.min.js', (r) => r.fulfill({ path: nm('jspdf-autotable', 'dist', 'jspdf.plugin.autotable.min.js'), contentType: 'text/javascript' }));
  await p.route(/googleapis|gstatic|hcaptcha/, (r) => r.abort());
  const R_ = []; const ok = (n, c, x = '') => { R_.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? ' ' + x : '')); };
  await p.goto(`http://localhost:${PORT}/app.html?mode=login`); await sleep(800);
  await p.click('[data-tab=signup]');
  await p.fill('#signupEmail', `gui-${process.pid}@facturapro-test.invalid`); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500);
  if (!(await p.isVisible('#mainApp'))) {
    await p.evaluate(() => selectStatus(document.querySelector('[onclick*="selectStatus"]').getAttribute('onclick').match(/'(.*?)'/)[1])); await p.evaluate(() => onboardingNext(1));
    await p.fill('#onbCompanyName', 'Atelier Atlas SARL'); await p.fill('#onbICE', '001234567000089'); await p.evaluate(() => onboardingNext(2));
    await p.fill('#onbBank', 'Banque test'); await p.fill('#onbRIB', '007 780 0001234567890123 45'); await p.evaluate(() => finishOnboarding()); await sleep(1800);
  }
  await p.evaluate(() => navTo('dashboard')); await sleep(600);
  ok('tableau de bord : invitation « Découvrez FacturaPro en 1 minute »', await p.evaluate(() => !!document.querySelector('.fpg-invite')));
  ok('bouton « ❓ Comment ça marche » dans le menu', await p.evaluate(() => /openGuide\(0\)/.test(document.getElementById('sidebar').innerHTML)));
  await p.evaluate(() => document.querySelector('.fpg-invite .btn-primary').click()); await sleep(500);
  const st = () => p.evaluate(() => { const m = document.querySelector('.fp-guide'); if (!m) return null; return { h: m.querySelector('.fpg-text h3').textContent, nodes: m.querySelectorAll('.fpg-node').length, on: [...m.querySelectorAll('.fpg-dots span')].findIndex(x => x.classList.contains('on')), next: m.querySelector('.fpg-next').textContent, prevVis: m.querySelector('.fpg-prev').style.display, anim: getComputedStyle(m.querySelector('.fpg-dot')).animationName }; });
  let s0 = await st();
  ok('guide ouvert : étape 1 « Le parcours d\'une vente », 4 étapes du schéma, animation active', s0 && /parcours d'une vente/.test(s0.h) && s0.nodes === 4 && s0.on === 0 && s0.prevVis === 'none' && s0.anim === 'fpgDot', JSON.stringify(s0));
  ok('boutons visibles sans débordement (téléphone)', await p.evaluate(() => { const m = document.querySelector('.fp-guide .modal-content').getBoundingClientRect(); return [...document.querySelectorAll('.fp-guide .fpg-actions .btn')].filter(b => b.offsetParent).every(b => { const r = b.getBoundingClientRect(); return r.right <= m.right + 1 && r.left >= m.left - 1; }); }));
  await p.screenshot({ path: process.env.GUIDE_SHOT || '/tmp/guide-step1.png' });
  for (let i = 0; i < 5; i++) { await p.evaluate(() => document.querySelector('.fp-guide .fpg-next').click()); await sleep(150); }
  const s5 = await st();
  ok('6 étapes : la dernière « Fin de mois et comptable », bouton « Terminer »', /Fin de mois/.test(s5.h) && s5.on === 5 && /Terminer/.test(s5.next), JSON.stringify(s5));
  await p.evaluate(() => document.querySelector('.fp-guide .fpg-dots span[data-i="3"]').click()); await sleep(150);
  ok('points de navigation : saut direct à l\'étape 4 (achats)', /Achats, stock/.test((await st()).h));
  await p.evaluate(() => document.querySelector('.fp-guide .fpg-try').click()); await sleep(600);
  ok('« Essayer » : guide fermé, page Achats ouverte, invitation masquée ensuite', await p.evaluate(() => !document.querySelector('.fp-guide') && document.getElementById('page-purchases').classList.contains('active') && Storage.get('guideSeen', false) === true));
  await p.evaluate(() => navTo('dashboard')); await sleep(400);
  ok('invitation disparue après consultation', await p.evaluate(() => !document.querySelector('.fpg-invite')));
  // Mouvement réduit
  await p.emulateMedia({ reducedMotion: 'reduce' });
  await p.evaluate(() => openGuide(1)); await sleep(300);
  ok('mouvement réduit : pas d\'animation, schéma visible', await p.evaluate(() => getComputedStyle(document.querySelector('.fp-guide .fpg-node')).animationName === 'none' && getComputedStyle(document.querySelector('.fp-guide .fpg-node')).opacity === '1'));
  await p.evaluate(() => document.querySelector('.fp-guide .fpg-x').click());
  // Arabe : toutes les chaînes du guide ont une traduction
  const missing = await p.evaluate(() => { const out = []; const add = (x) => { if (x && !AR_TEXT[x]) out.push(x); };
    FP_GUIDE.forEach(g => { add(g.t); add(g.p); add(g.tag); add('▶ ' + g.btn); g.li.forEach(add); g.nodes.forEach(n => add(n[1])); });
    ['❓ Comment ça marche', '← Précédent', 'Suivant →', 'Terminer ✓', 'Découvrez FacturaPro en 1 minute', '▶ Voir le guide'].forEach(add); return out; });
  ok('arabe : toutes les phrases du guide sont traduites', missing.length === 0, JSON.stringify(missing));
  ok('aucune erreur JavaScript', errs.length === 0, JSON.stringify(errs));

  const nOk = R_.filter(Boolean).length;
  console.log(`${nOk === R_.length ? 'OK' : 'ECHEC'} : ${nOk}/${R_.length} contrôles (guide animé, SIMULATION locale)`);
  await browser.close(); srv.close(); dropDb(db); process.exit(nOk === R_.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
