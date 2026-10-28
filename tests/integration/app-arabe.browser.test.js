// Application en arabe (aperçu ?lang=ar) : connexion, tableau de bord, factures, clients ; le français reste intact sans le paramètre. SIMULATION locale (faux client Supabase + PostgreSQL local), jamais Supabase réel.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8236;
const srv = http.createServer((q, r) => {
  // Serveur de test local : chemin normalisé et borné au dépôt (aucune sortie du dossier possible)
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
  const R_ = []; const ok = (n, c, x = '') => { R_.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? ' ' + x : '')); };
  const txt = (p, sel) => p.innerText(sel);
  const FR = /Tableau de bord|Se connecter|Mot de passe|Créer|Brouillon|Aucun client|Premiers pas|Connexion|Inscription|Relances|Accueil/;
  // 1) Sans paramètre : français, gauche→droite, aucun texte arabe
  let { ctx, p } = await dev({ width: 390, height: 844 });
  await p.goto(`http://localhost:${PORT}/app.html?mode=login`); await sleep(800);
  ok('sans ?lang=ar : français, sens gauche→droite', await p.evaluate(() => document.documentElement.dir) === 'ltr' && /Se connecter/.test(await txt(p, '#authScreen')) && !/[؀-ۿ]/.test(await txt(p, '#authScreen')));
  ok('mot de passe : aide « Minimum 8 caractères » (cohérente avec le champ)', /Minimum 8 caractères/.test(await p.innerHTML('#signupForm')));
  await ctx.close();
  // 2) Arabe
  ({ ctx, p } = await dev({ width: 390, height: 844 }));
  await p.goto(`http://localhost:${PORT}/app.html?mode=login&lang=ar`); await sleep(900);
  let t = await txt(p, '#authScreen');
  ok('?lang=ar : écran de connexion en arabe, sens droite→gauche, sans français', await p.evaluate(() => document.documentElement.dir) === 'rtl' && /تسجيل الدخول/.test(t) && /نسيت كلمة المرور/.test(t) && !FR.test(t));
  await p.click('[data-tab=signup]');
  t = await txt(p, '#authScreen');
  ok('inscription en arabe : champs, CGU et confidentialité', /إنشاء حسابي/.test(t) && /شروط الاستعمال/.test(t) && /سياسة الخصوصية/.test(t) && !FR.test(t));
  ok('liens légaux conservés (CGU / confidentialité)', await p.evaluate(() => [...document.querySelectorAll('#signupForm a')].map((a) => a.getAttribute('href')).join()) === 'legal.html#cgu,legal.html#confidentialite');
  await p.fill('#signupEmail', 'x@facturapro-test.invalid'); await p.fill('#signupPassword', 'abc'); await p.fill('#signupConfirm', 'abd');
  await p.evaluate(() => handleSignup({ preventDefault() {} })); await sleep(300);
  const err = await p.evaluate(() => document.getElementById('authError').textContent);
  ok('message d\'erreur en arabe', /[؀-ۿ]/.test(err) && !/mot de passe/i.test(err), err);
  const email = `ar-${process.pid}@facturapro-test.invalid`;
  await p.fill('#signupEmail', email); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500);
  await p.evaluate(() => finishOnboarding()); await sleep(1800);
  t = await txt(p, '#mainApp');
  ok('tableau de bord en arabe (menu, statistiques, premiers pas), sans français', /لوحة التحكم/.test(t) && /الخطوات الأولى/.test(t) && /رقم المعاملات المحصَّل/.test(t) && /الفواتير/.test(t) && !FR.test(t), (t.match(FR) || [''])[0]);
  ok('montants et nombres restent lisibles', /0,00\s*DH/.test(t));
  await p.evaluate(() => navTo('clients')); await sleep(400); t = await txt(p, '#mainApp');
  ok('clients en arabe, sans français', /العملاء/.test(t) && /عميل جديد/.test(t) && !FR.test(t), (t.match(FR) || [''])[0]);
  await p.evaluate(() => navTo('invoices')); await sleep(400); t = await txt(p, '#mainApp');
  ok('factures en arabe (filtres), sans français', /مسودات/.test(t) && /متأخرة/.test(t) && !FR.test(t), (t.match(FR) || [''])[0]);
  // Écrans secondaires : aucun texte français résiduel (hors noms propres, formats et modèles de messages destinés aux clients)
  const OK_FR = /^(@placeholder:(Bonjour, je me|Suite à mon|Sans paiement de|FP-|Casablanca|https|FAC|DEV|AVR)|FAC-2026|.*@facturapro-test|Business|ICE \*|SWIFT \/ BIC|CSV Excel|FEC)/;
  for (const pg of ['invoice-editor', 'quotes', 'products', 'reports', 'payments', 'reminders', 'messages', 'license', 'company', 'team']) {
    await p.evaluate((x) => { try { navTo(x); } catch (e) {} }, pg); await sleep(500);
    const left = await p.evaluate((x) => { const root = document.getElementById('page-' + x); const out = []; const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n;
      while ((n = w.nextNode())) { const v = n.nodeValue.trim(); if (v && !/[؀-ۿ]/.test(v) && /[A-Za-zÀ-ÿ]{3,}/.test(v)) out.push(v); }
      root.querySelectorAll('[placeholder],[title]').forEach((e) => ['placeholder', 'title'].forEach((a) => { const v = e.getAttribute(a); if (v && /[A-Za-zÀ-ÿ]{3,}/.test(v) && !/[؀-ۿ]/.test(v)) out.push('@' + a + ':' + v); }));
      return out; }, pg).then((l) => l.filter((v) => !OK_FR.test(v)));
    ok('écran « ' + pg + ' » traduit en arabe', left.length === 0, left.slice(0, 3).join(' / '));
  }
  // Fenêtres, assistant de démarrage, écran de licence : tout le texte statique est traduit (hors CNSS / impôts, lot suivant)
  const leftAll = await p.evaluate(() => { const out = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
    while ((n = w.nextNode())) { const v = n.nodeValue.trim(); if (!v || /[؀-ۿ]/.test(v) || !/[A-Za-zÀ-ÿ]{3,}/.test(v)) continue; if (n.parentNode.closest('script,style,#page-cnss,#page-taxes')) continue; out.push(v); }
    document.querySelectorAll('[placeholder],[title]').forEach((e) => ['placeholder', 'title'].forEach((a) => { const v = e.getAttribute(a); if (v && /[A-Za-zÀ-ÿ]{3,}/.test(v) && !/[؀-ۿ]/.test(v) && !e.closest('#page-cnss,#page-taxes')) out.push('@' + a + ':' + v); }));
    return out; }).then((l) => l.filter((v) => !OK_FR.test(v) && !/^@placeholder:(votre@email|employe@|Mohamed|contact@|123 Boulevard|BCMAMAMC|FP-XXXX)/.test(v) && !/^(FacturaPro|facturaproma\.github\.io\/Facturaproma\/app\.html|Sage|EBP|Cegid|Ciel|Quadratus|RIB|ICE|RC|Email)$/.test(v)));
  ok('fenêtres, assistant et licence : aucun texte français résiduel', leftAll.length === 0, leftAll.slice(0, 4).join(' / '));
  ok('le bouton de langue reste masqué (aperçu seulement)', await p.evaluate(() => { const e = document.getElementById('langCheckAr'); return !e || !e.offsetParent; }));
  ok('aucun défilement horizontal en arabe sur mobile', await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await ctx.close();
  await browser.close(); srv.close(); try { await dropDb(db); } catch (e) {}
  const f = R_.filter((x) => !x).length; console.log(f ? `${f} ÉCHEC(S)` : 'OK'); process.exit(f ? 1 : 0);
})();
