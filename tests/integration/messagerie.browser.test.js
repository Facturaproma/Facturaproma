// Messagerie société ↔ admin (sql/29) : envoi, isolation, non-lus, réponse, rendu sans HTML, fonction absente. SIMULATION locale (faux Supabase + PostgreSQL local).
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8212;
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
  const db = createDb({ messagerie: true }); const be = makeBackend(db);
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
  const email = `msg-${process.pid}@facturapro-test.invalid`;
  let first = true;
  for (const k of ['m']) {
    const { ctx, p } = await dev(sizes[k]);
    await p.goto(`http://localhost:${PORT}/app.html?mode=login`); await sleep(800);
    if (first) {
      await p.evaluate(() => { const t = [...document.querySelectorAll('button,div,a')].find((e) => e.textContent.trim() === 'Inscription'); t && t.click(); });
      await p.fill('#signupEmail', email); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500); first = false;
    } else { await p.fill('#loginEmail', email); await p.fill('#loginPassword', 'Test#12345'); await p.click('#loginBtn'); await sleep(2500); }
    if (!(await p.isVisible('#mainApp'))) {
      await p.evaluate(() => selectStatus(document.querySelector('[onclick*="selectStatus"]').getAttribute('onclick').match(/'(.*?)'/)[1])); await p.evaluate(() => onboardingNext(1));
      await p.fill('#onbCompanyName', 'Atelier Atlas SARL'); await p.fill('#onbICE', '001234567000089'); await p.evaluate(() => onboardingNext(2));
      await p.fill('#onbBank', 'Banque test'); await p.fill('#onbRIB', '007 780 0001234567890123 45'); await p.evaluate(() => finishOnboarding()); await sleep(1800);
    }
    const R_ = []; const ok = (n, c, x = '') => { R_.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? ' ' + x : '')); };
    const { execFileSync } = require('child_process');
    const sql = (q) => execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A', '-d', db, '-c', q]).toString().trim();
    const toast = () => p.evaluate(() => [...document.querySelectorAll('.toast, #toast, [class*="toast"]')].map((e) => e.textContent).join(' | '));
    // ---------- Société A ----------
    await p.evaluate(() => navTo('messages')); await sleep(500);
    ok('société : page Messages, aucun message au départ', await p.evaluate(() => /Aucun message/.test(document.getElementById('msgThread').textContent)));
    ok('société : zone de saisie limitée à 2000 caractères', await p.evaluate(() => document.getElementById('msgInput').maxLength === 2000));
    await p.fill('#msgInput', '<img src=x onerror="window.__xss=1"> Bonjour,\nje voudrais changer mon RIB.');
    await p.click('#msgSendBtn'); await sleep(900);
    const bub = await p.evaluate(() => ({ n: document.querySelectorAll('#msgThread .msg-me').length, txt: document.querySelector('#msgThread .msg-me')?.textContent || '', img: document.querySelectorAll('#msgThread img').length, xss: !!window.__xss }));
    ok('société : message envoyé et affiché à droite', bub.n === 1 && /changer mon RIB/.test(bub.txt));
    ok('société : le HTML saisi est affiché comme du texte (aucune balise exécutée)', bub.img === 0 && !bub.xss && /<img src=x/.test(bub.txt));
    ok('société : date et heure lisibles (jj mois aaaa hh:mm)', /\d{1,2} \S+ 20\d\d \d\d:\d\d/.test(await p.evaluate(() => document.querySelector('#msgThread .msg-me small').textContent)));
    ok('société : zone vidée après envoi', (await p.evaluate(() => document.getElementById('msgInput').value)) === '');
    await p.fill('#msgInput', '   '); await p.click('#msgSendBtn'); await sleep(300);
    ok('société : message vide refusé, rien d\'ajouté', (await p.evaluate(() => document.querySelectorAll('#msgThread .msg-b').length)) === 1);
    const dbRows = sql("SELECT count(*) FROM public.support_messages WHERE sender='client'");
    ok('base : 1 message client enregistré', dbRows === '1', dbRows);
    // ---------- Administration ----------
    sql("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES ('c1c1c1c1-0000-0000-0000-000000000001','boss@test.invalid',now()); INSERT INTO public.admins(email,password_hash,is_master) VALUES ('boss@test.invalid','x',false)");
    const adm = await dev({ width: 1366, height: 800 }); const a = adm.p;
    await a.goto(`http://localhost:${PORT}/admin.html`); await sleep(800);
    const signed = await a.evaluate(async () => { const r = await supaClient.auth.signInWithPassword({ email: 'boss@test.invalid', password: 'x' }); currentAdmin = { email: 'boss@test.invalid', isMaster: false, isStaff: false }; return !r.error; });
    ok('admin : connexion de test', signed);
    await a.evaluate(() => { document.getElementById('loginScreen').classList.add('hidden'); document.getElementById('app').style.display = 'flex'; document.querySelectorAll('.page').forEach((x) => x.classList.remove('active')); document.getElementById('page-messages').classList.add('active'); return renderAdminMessages(); }); await sleep(700);
    const L = await a.evaluate(() => ({ items: document.querySelectorAll('#amList .am-item').length, unread: document.querySelector('#amList .am-unread')?.textContent, name: document.querySelector('#amList .am-top span')?.textContent, badge: document.getElementById('badgeMessages').textContent }));
    ok('admin : 1 conversation, 1 non-lu, badge 1, nom = société (Atelier Atlas SARL)', L.items === 1 && L.unread === '1' && L.badge === '1' && L.name === 'Atelier Atlas SARL', JSON.stringify(L));
    await a.click('#amList .am-item'); await sleep(700);
    const C = await a.evaluate(() => ({ n: document.querySelectorAll('#amMsgs .am-client').length, img: document.querySelectorAll('#amMsgs img').length, xss: !!window.__xss, txt: document.querySelector('#amMsgs .am-client')?.textContent || '', form: document.getElementById('amForm').style.display, unread: document.querySelectorAll('#amList .am-unread').length, badge: document.getElementById('badgeMessages').style.display }));
    ok('admin : message de la société lu, HTML non exécuté', C.n === 1 && C.img === 0 && !C.xss && /<img src=x/.test(C.txt) && C.form !== 'none');
    ok('admin : l\'ouverture marque lu (plus de pastille, badge masqué)', C.unread === 0 && C.badge === 'none');
    await a.fill('#amInput', 'Bonjour, voici la marche à suivre : Mon Entreprise > Informations bancaires.'); await a.click('#amSend'); await sleep(900);
    const R = await a.evaluate(() => ({ adm: document.querySelectorAll('#amMsgs .am-admin').length, empty: document.getElementById('amInput').value === '' }));
    ok('admin : réponse envoyée et affichée', R.adm === 1 && R.empty);
    await a.fill('#amInput', ''); await a.click('#amSend'); await sleep(300);
    ok('admin : réponse vide refusée', (await a.evaluate(() => document.querySelectorAll('#amMsgs .am-admin').length)) === 1);
    const ov = await a.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    ok('admin : pas de défilement horizontal (bureau)', ov <= 1, String(ov));
    // ---------- Retour société A ----------
    await p.evaluate(() => { document.querySelectorAll('.page').forEach((x) => x.classList.remove('active')); document.getElementById('page-dashboard').classList.add('active'); });
    await p.evaluate(() => refreshSupportBadge()); await sleep(500);
    const bd = await p.evaluate(() => ({ t: document.getElementById('badgeMessages').textContent, d: document.getElementById('badgeMessages').style.display }));
    ok('société : badge « 1 » sur Messages (réponse non lue)', bd.t === '1' && bd.d !== 'none', JSON.stringify(bd));
    await p.evaluate(() => navTo('messages')); await sleep(800);
    const back = await p.evaluate(() => ({ them: document.querySelectorAll('#msgThread .msg-them').length, badge: document.getElementById('badgeMessages').style.display, txt: document.querySelector('#msgThread .msg-them')?.textContent || '' }));
    ok('société : réponse de l\'équipe affichée à gauche, badge effacé', back.them === 1 && /marche à suivre/.test(back.txt) && back.badge === 'none');
    const ov2 = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    ok('société : téléphone 390 px, pas de défilement horizontal', ov2 <= 1, String(ov2));
    if (process.env.SHOT_DIR) { require('fs').mkdirSync(process.env.SHOT_DIR, { recursive: true }); await p.screenshot({ path: process.env.SHOT_DIR + '/societe-messages.png' }); await a.screenshot({ path: process.env.SHOT_DIR + '/admin-messages.png' }); }
    // ---------- Isolation : société B ----------
    const bctx = await dev({ width: 390, height: 800 }); const b = bctx.p;
    await b.goto(`http://localhost:${PORT}/app.html?mode=login`); await sleep(600);
    const bRows = await b.evaluate(async () => { const r = await supaClient.auth.signUp({ email: 'b-' + Date.now() + '@facturapro-test.invalid', password: 'Test#12345' }); const m = await supaClient.rpc('support_my_messages'); const t = await supaClient.rpc('admin_support_threads'); return { mine: (m.data || []).length, adminErr: !!t.error, adminMsg: String((t.error && t.error.message) || '') }; });
    ok('société B : ne voit aucun message de A', bRows.mine === 0);
    ok('société B : la liste des conversations de l\'admin lui est refusée', bRows.adminErr && /forbidden/.test(bRows.adminMsg), bRows.adminMsg);
    // ---------- Fonction absente (sql/29 non installé) ----------
    await p.evaluate(() => { window.__net.missingRpc.push('support_my_messages'); }); await p.evaluate(() => loadSupportThread(true)); await sleep(500);
    ok('fonction absente : message clair, pas d\'erreur', await p.evaluate(() => /pas encore activée/.test(document.getElementById('msgThread').textContent)));
    await ctx.close(); await adm.ctx.close(); await bctx.ctx.close();
    if (R_.includes(false)) { console.log('\nÉCHEC : ' + R_.filter(x => !x).length + ' contrôle(s) en échec'); process.exitCode = 1; } else console.log('\nOK : ' + R_.length + ' contrôles (messagerie, SIMULATION locale)');
  }
  await browser.close(); srv.close(); try { be.close(); } catch {} dropDb(db);
})().catch((e) => { console.error(e); process.exit(1); });
