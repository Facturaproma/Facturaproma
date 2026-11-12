// Équipe, comptes partagés (sql/48, étape T1) en APERÇU (?equipe=apercu) : page masquée sans le paramètre, limite de la formule,
// invitation par lien, inscription et acceptation par l'invité, profil, désactivation, adresse piégée neutralisée.
// SIMULATION locale (faux Supabase + PostgreSQL local), jamais Supabase réel.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8294;
const srv = http.createServer((q, r) => {
  let u = '/'; try { u = decodeURIComponent(q.url.split('?')[0]); } catch (e) { r.writeHead(400); return r.end(); }
  const f = path.resolve(R, '.' + path.posix.normalize('/' + (u === '/' ? 'index.html' : u)));
  if (f !== R && !f.startsWith(R + path.sep)) { r.writeHead(403); return r.end(); }
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } let body = d;
    if (/app\.html$/.test(f)) body = d.toString('utf8').replace(/^const SUPABASE_URL = .*$/m, "const SUPABASE_URL = 'https://fake.supabase.test';").replace(/^const SUPABASE_ANON_KEY = .*$/m, "const SUPABASE_ANON_KEY = 'fake-anon-key';").replace(/ integrity="[^"]*" crossorigin="anonymous"/g, '');
    const t = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.ttf': 'font/ttf', '.css': 'text/css', '.png': 'image/png' }[path.extname(f)] || 'application/octet-stream';
    r.writeHead(200, { 'content-type': t }); r.end(body); });
}).listen(PORT);
const nm = (...s) => path.join(R, 'node_modules', ...s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const db = createDb({ comptes: true }); const be = makeBackend(db);
  const sql = (q) => require('child_process').execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A', '-d', db, '-c', q]).toString().trim();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const R_ = []; const ok = (n, c, x = '') => { R_.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? ' ' + x : '')); };
  const errs = [];
  const open = async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' }); const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(e.message.slice(0, 160))); p.on('dialog', (d) => d.accept());
    await p.exposeFunction('__srv', (op, args) => be.handle(op, args));
    await p.route(/jsdelivr.*supabase/, (r) => r.fulfill({ body: FAKE, contentType: 'text/javascript' }));
    await p.route('**/jspdf.umd.min.js', (r) => r.fulfill({ path: nm('jspdf', 'dist', 'jspdf.umd.min.js'), contentType: 'text/javascript' }));
    await p.route('**/jspdf.plugin.autotable.min.js', (r) => r.fulfill({ path: nm('jspdf-autotable', 'dist', 'jspdf.plugin.autotable.min.js'), contentType: 'text/javascript' }));
    await p.route(/googleapis|gstatic|hcaptcha/, (r) => r.abort());
    return p;
  };
  const signup = async (p, email) => {
    await p.evaluate(() => { const t = [...document.querySelectorAll('button,div,a')].find((e) => e.textContent.trim() === 'Inscription'); t && t.click(); });
    await p.fill('#signupEmail', email); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500);
    if (!(await p.isVisible('#mainApp'))) {
      await p.evaluate(() => selectStatus(document.querySelector('[onclick*="selectStatus"]').getAttribute('onclick').match(/'(.*?)'/)[1])); await p.evaluate(() => onboardingNext(1));
      await p.fill('#onbCompanyName', 'Atelier Atlas SARL'); await p.fill('#onbICE', '001234567000089'); await p.evaluate(() => onboardingNext(2));
      await p.fill('#onbBank', 'Banque test'); await p.fill('#onbRIB', '007 780 0001234567890123 45'); await p.evaluate(() => finishOnboarding()); await sleep(1800);
    }
  };
  const team = async (p) => { await p.evaluate(() => navTo('team')); await sleep(1200); return p.evaluate(() => (document.getElementById('teamBody') || {}).innerText || ''); };
  const toast = (p) => p.evaluate(() => (document.getElementById('toast') || {}).textContent || '');
  const ownerEmail = `eq-owner-${process.pid}@facturapro-test.invalid`, memberEmail = `eq-member-${process.pid}@facturapro-test.invalid`;

  // ---------- Sans le paramètre d'aperçu : rien ne change pour les clients ----------
  const p = await open();
  await p.goto(`http://localhost:${PORT}/app.html?mode=login`); await sleep(800);
  await signup(p, ownerEmail);
  ok('sans ?equipe=apercu : entrée de menu masquée, page Équipe inaccessible (retour à l\'accueil)',
    await p.evaluate(() => { navTo('team'); return getComputedStyle(document.getElementById('navTeam')).display === 'none' && document.getElementById('page-dashboard').classList.contains('active'); }));
  ok('sans ?equipe=apercu : aucun compte créé sur le serveur', sql(`SELECT count(*) FROM public.account_members m JOIN auth.users u ON u.id = m.user_id WHERE u.email = '${ownerEmail}'`) === '0');

  // ---------- Aperçu : nouveau client en Essentielle, 1 utilisateur ----------
  await p.goto(`http://localhost:${PORT}/app.html?equipe=apercu`); await sleep(2500);
  ok('aperçu : entrée de menu visible', await p.evaluate(() => getComputedStyle(document.getElementById('navTeam')).display !== 'none'));
  let txt = await team(p);
  ok('aperçu : nouveau compte créé en Essentielle (jamais en conditions historiques), propriétaire, 1 / 1', /1 \/ 1/.test(txt) && /Essentielle/.test(txt) && !/Conditions historiques/.test(txt) && /Propriétaire/.test(txt)
    && sql(`SELECT m.role || ':' || a.plan_key FROM public.account_members m JOIN public.accounts a ON a.id = m.account_id JOIN auth.users u ON u.id = m.user_id WHERE u.email = '${ownerEmail}'`) === 'owner:essentielle', txt.slice(0, 200));
  ok('Essentielle : pas de formulaire d\'invitation, message de limite', await p.isVisible('#teamFull') && !(await p.isVisible('#teamInviteForm')));

  // ---------- Pro (2 utilisateurs) : invitation ----------
  sql(`UPDATE public.accounts SET plan_key = 'pro' WHERE owner_id = (SELECT id FROM auth.users WHERE email = '${ownerEmail}')`);
  txt = await team(p);
  ok('Pro : 1 / 2, formulaire d\'invitation', /1 \/ 2/.test(txt) && /Pro/.test(txt) && await p.isVisible('#teamInviteForm'));
  ok('le propriétaire peut proposer le rôle Administrateur', await p.evaluate(() => [...document.querySelectorAll('#teamInviteRole option')].some((o) => o.value === 'admin')));
  await p.fill('#teamInviteEmail', memberEmail.toUpperCase()); await p.selectOption('#teamInviteProfile', 'complet');
  await p.evaluate(() => teamInvite()); await sleep(1200);
  const link = await p.evaluate(() => (document.getElementById('teamLinkInput') || {}).value || '');
  ok('invitation : lien personnel affiché (aperçu + jeton de 64 caractères)', /\?equipe=apercu&invite=[a-f0-9]{64}$/.test(link), link);
  txt = await p.evaluate(() => document.getElementById('teamBody').innerText);
  ok('2 / 2 avec l\'invitation en attente ; formulaire remplacé par le message de limite', /2 \/ 2/.test(txt) && txt.includes(memberEmail) && await p.isVisible('#teamFull'));
  ok('jeton jamais stocké en clair', sql(`SELECT count(*) FROM public.account_invitations WHERE token_hash = '${link.slice(-64)}'`) === '0');

  // ---------- L'invité ouvre le lien, s'inscrit avec l'adresse invitée ----------
  const q = await open();
  await q.goto(link); await sleep(1200);
  await signup(q, memberEmail);
  await sleep(800);
  ok('invité : membre du compte du propriétaire après inscription',
    sql(`SELECT m.role || ':' || m.profile || ':' || (m.account_id = (SELECT account_id FROM public.account_members WHERE user_id = (SELECT id FROM auth.users WHERE email = '${ownerEmail}'))) FROM public.account_members m JOIN auth.users u ON u.id = m.user_id WHERE u.email = '${memberEmail}'`) === 'member:complet:true');
  ok('invité : jeton retiré de l\'adresse', !(await q.evaluate(() => location.search.includes('invite='))));
  txt = await team(q);
  ok('invité : voit l\'équipe (2 / 2), son rôle Collaborateur, pas de formulaire d\'invitation', /2 \/ 2/.test(txt) && /Collaborateur/.test(txt) && !(await q.isVisible('#teamInviteForm')) && !(await q.isVisible('#teamFull')));

  // ---------- Le propriétaire gère le membre ----------
  txt = await team(p);
  ok('propriétaire : le membre apparaît actif', txt.includes(memberEmail) && /Actif/.test(txt));
  await p.evaluate(() => { const s = [...document.querySelectorAll('#teamMembersRows select[aria-label="Accès"]')][0]; s.value = 'ventes'; s.dispatchEvent(new Event('change')); }); await sleep(1200);
  ok('profil passé à « Ventes »', sql(`SELECT profile FROM public.account_members m JOIN auth.users u ON u.id = m.user_id WHERE u.email = '${memberEmail}'`) === 'ventes');
  await p.evaluate(() => { const b = [...document.querySelectorAll('#teamMembersRows button')].find((x) => x.textContent.trim() === 'Désactiver'); b.click(); }); await sleep(1500);
  txt = await p.evaluate(() => document.getElementById('teamBody').innerText);
  ok('désactivation : statut Désactivé, place libérée (1 / 2)', sql(`SELECT status FROM public.account_members m JOIN auth.users u ON u.id = m.user_id WHERE u.email = '${memberEmail}'`) === 'disabled' && /1 \/ 2/.test(txt) && /Désactivé/.test(txt));
  txt = await team(q);
  ok('membre désactivé : accès refusé à la requête suivante', /désactivé/.test(txt));

  // ---------- Adresse piégée : affichée comme du texte ----------
  await team(p);
  await p.fill('#teamInviteEmail', 'x"><svg/onload=window.__x=1>@a.ma'); await p.evaluate(() => teamInvite()); await sleep(1200);
  ok('adresse piégée : affichée telle quelle, aucun code exécuté',
    !(await p.evaluate(() => window.__x)) && (await p.evaluate(() => document.getElementById('teamBody').innerText)).includes('x"><svg/onload=window.__x=1>@a.ma'));
  await p.evaluate(() => { const b = [...document.querySelectorAll('#teamInviteRows button')][0]; b.click(); }); await sleep(1200);
  ok('invitation annulée : place libérée', /1 \/ 2/.test(await p.evaluate(() => document.getElementById('teamBody').innerText)) && /annulée/i.test(await toast(p)));

  ok('aucune erreur JavaScript', errs.length === 0, errs.join(' | '));
  const nOk = R_.filter(Boolean).length;
  console.log(`${nOk === R_.length ? 'OK' : 'ECHEC'} : ${nOk}/${R_.length} contrôles (équipe, aperçu, SIMULATION locale)`);
  await browser.close(); srv.close(); dropDb(db); process.exit(nOk === R_.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
