// Sécurité de la console d'administration : des champs que N'IMPORTE QUEL client peut écrire (demande d'abonnement : société, statut, code promo,
// e-mail) ne doivent jamais s'exécuter dans admin.html (même origine que l'application, droits administrateur). OWASP A03 / A01.
// SIMULATION locale : faux Supabase, aucune donnée réelle.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8232;
const srv = http.createServer((q, r) => {
  let u = '/'; try { u = decodeURIComponent(q.url.split('?')[0]); } catch (e) { r.writeHead(400); return r.end(); }
  const f = path.resolve(R, '.' + path.posix.normalize('/' + (u === '/' ? 'index.html' : u)));
  if (f !== R && !f.startsWith(R + path.sep)) { r.writeHead(403); return r.end(); }
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } let body = d;
    if (/admin\.html$/.test(f)) body = d.toString('utf8').replace(/^const SUPABASE_URL = .*$/m, "const SUPABASE_URL = 'https://fake.supabase.test';").replace(/^const SUPABASE_ANON_KEY = .*$/m, "const SUPABASE_ANON_KEY = 'fake-anon-key';").replace(/ integrity="[^"]*" crossorigin="anonymous"/g, '');
    const t = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json' }[path.extname(f)] || 'application/octet-stream';
    r.writeHead(200, { 'content-type': t }); r.end(body); });
}).listen(PORT);
const nm = (...s) => path.join(R, 'node_modules', ...s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const R_ = []; const ok = (n, c, x = '') => { R_.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? ' ' + x : '')); };
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, serviceWorkers: 'block' }); const p = await ctx.newPage();
  p.on('dialog', (d) => d.dismiss());
  await p.route(/jsdelivr.*supabase/, (r) => r.fulfill({ body: FAKE, contentType: 'text/javascript' }));
  await p.route('**/jspdf.umd.min.js', (r) => r.fulfill({ path: nm('jspdf', 'dist', 'jspdf.umd.min.js'), contentType: 'text/javascript' }));
  await p.route('**/jspdf.plugin.autotable.min.js', (r) => r.fulfill({ path: nm('jspdf-autotable', 'dist', 'jspdf.plugin.autotable.min.js'), contentType: 'text/javascript' }));
  await p.route(/googleapis|gstatic|hcaptcha/, (r) => r.abort());
  await p.goto(`http://localhost:${PORT}/admin.html`); await sleep(800);

  // Données hostiles telles qu'un client malveillant peut les écrire dans subscription_requests (RLS : seuls e-mail/statut/code sont contrôlés)
  const IMG = '<img src=x onerror="window.__pwn=(window.__pwn||0)+1">';
  const APOS = "o'brien-x'-(window.__pwn=(window.__pwn||0)+1)-'@test.invalid"; // apostrophes : autorisées dans la partie locale d'une adresse e-mail
  const res = await p.evaluate(({ IMG, APOS }) => {
    window.__pwn = 0;
    allRequests = [
      { id: '11111111-1111-1111-1111-111111111111', client_email: 'a@test.invalid', company_name: IMG, company_status: IMG, tier: 'monthly', base_price: 100, final_price: 100, promo_code: IMG, status: 'pending', created_at: new Date().toISOString() },
      { id: '22222222-2222-2222-2222-222222222222', client_email: APOS, company_name: 'Société', company_status: 'srl', tier: 'monthly', base_price: 100, final_price: 100, promo_code: null, status: 'pending', created_at: new Date().toISOString() },
    ];
    try { document.getElementById('requestStatusFilter') && (document.getElementById('requestStatusFilter').value = 'open'); renderRequests(); } catch (e) { return { err: String(e) }; }
    return { html: (document.getElementById('requestsTable') || {}).innerHTML || '' };
  }, { IMG, APOS });
  await sleep(500);
  ok('demandes : rendu effectué', res.html && res.html.length > 200, res.err || '');
  ok('société / statut / code promo piégés : aucune balise injectée, aucun code exécuté', (await p.evaluate(() => window.__pwn)) === 0 && !(await p.evaluate(() => document.querySelector('#requestsTable img'))));

  // Clic sur chaque bouton d'action de la ligne dont l'e-mail contient des apostrophes
  const nb = await p.evaluate(() => [...document.querySelectorAll('#requestsTable button[onclick]')].length);
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  for (let i = 0; i < nb; i++) await p.evaluate((i) => { try { document.querySelectorAll('#requestsTable button[onclick]')[i].click(); } catch (e) {} }, i);
  await sleep(300);
  ok("e-mail avec apostrophes : cliquer les boutons n'exécute aucun code", (await p.evaluate(() => window.__pwn)) === 0, 'boutons=' + nb);

  // Paiements/codes : champs issus de la demande
  const r2 = await p.evaluate(({ IMG, APOS }) => {
    const out = {};
    try {
      allCodes = [{ id: 'c1', code: 'ABCD-1234', type: 'monthly', status: 'active', client_email: IMG, note: IMG, created_at: new Date().toISOString(), days: 30 },
                  { id: 'c2', code: 'EFGH-5678', type: 'monthly', status: 'active', client_email: APOS, note: 'n', created_at: new Date().toISOString(), days: 30 }];
      renderCodes();
      document.querySelectorAll('#codesTable button[onclick], #codesTable a[onclick]').forEach((b) => { try { b.click(); } catch (e) {} });
    } catch (e) { out.codesErr = String(e).slice(0, 120); }
    return out;
  }, { IMG, APOS });
  await sleep(300);
  ok('codes : e-mail et note piégés neutralisés', (await p.evaluate(() => window.__pwn)) === 0 && !(await p.evaluate(() => document.querySelector('img[src="x"]'))), r2.codesErr || '');

  await browser.close(); srv.close();
  const n = R_.filter(Boolean).length; console.log(`\n${n === R_.length ? 'OK' : 'ÉCHEC'} : ${n}/${R_.length} contrôles (console admin)`); process.exit(n === R_.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
