// Paiement lié au code (sql/32 + console admin) : générer un code crée un paiement en attente (non compté), l'encaisser le passe à payé
// sans doublon, la révocation l'annule. SIMULATION locale (faux Supabase + PostgreSQL local).
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8234;
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
  const db = createDb({ paiementCode: true }); const be = makeBackend(db);
  const sql = (q) => execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A', '-d', db, '-c', q]).toString().trim();
  sql("INSERT INTO auth.users(id,email,email_confirmed_at) VALUES ('f7f7f7f7-0000-0000-0000-000000000001','boss@test.invalid',now()); INSERT INTO public.admins(email,password_hash,is_master) VALUES ('boss@test.invalid','x',true)");
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const R_ = []; const ok = (n, c, x = '') => { R_.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? ' ' + x : '')); };
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 }, serviceWorkers: 'block' }); const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 160))); p.on('dialog', (d) => d.accept());
  await p.exposeFunction('__srv', (op, args) => be.handle(op, args));
  await p.route(/jsdelivr.*supabase/, (r) => r.fulfill({ body: FAKE, contentType: 'text/javascript' }));
  await p.route('**/jspdf.umd.min.js', (r) => r.fulfill({ path: nm('jspdf', 'dist', 'jspdf.umd.min.js'), contentType: 'text/javascript' }));
  await p.route('**/jspdf.plugin.autotable.min.js', (r) => r.fulfill({ path: nm('jspdf-autotable', 'dist', 'jspdf.plugin.autotable.min.js'), contentType: 'text/javascript' }));
  await p.route(/googleapis|gstatic|hcaptcha/, (r) => r.abort());
  await p.goto(`http://localhost:${PORT}/admin.html`); await sleep(800);
  await p.evaluate(async () => { await supaClient.auth.signInWithPassword({ email: 'boss@test.invalid', password: 'x' }); currentAdmin = { email: 'boss@test.invalid', isMaster: true, isStaff: false }; document.getElementById('loginScreen').classList.add('hidden'); document.getElementById('app').classList.add('active'); await loadAllData(); });

  await p.evaluate(async () => { document.getElementById('codeType').value = 'monthly'; document.getElementById('codeClient').value = 'Nouveau@Client.test'; document.getElementById('codeNote').value = ''; await generateCode(); });
  await sleep(800);
  ok('code généré → un paiement en attente de 49 DH lié', sql("SELECT count(*) FROM public.admin_payments p JOIN public.admin_codes c ON c.id=p.code_id WHERE p.status='pending' AND p.amount=49 AND p.client_email='nouveau@client.test'") === '1');
  const st = await p.evaluate(() => ({ pend: allPendingPayments.length, paid: allPayments.length, rev: document.getElementById('statTotalRevenue').textContent.replace(/\s| | /g, ''), row: document.getElementById('pendingPaymentsTable').textContent }));
  ok('console : 1 paiement en attente affiché, 0 DH de revenu, 0 paiement encaissé', st.pend === 1 && st.paid === 0 && /^0DH/.test(st.rev) && /nouveau@client\.test/.test(st.row), JSON.stringify(st).slice(0, 160));

  await p.evaluate(async () => { const c = allCodes[0]; await markAsPaid(c.id, c.client_email, c.type, 49); });
  await sleep(1200);
  ok('encaissement : le paiement lié passe à payé, SANS doublon', sql("SELECT count(*) FROM public.admin_payments WHERE client_email='nouveau@client.test'") === '1' && sql("SELECT status FROM public.admin_payments WHERE client_email='nouveau@client.test'") === 'paid');
  const st2 = await p.evaluate(() => ({ pend: allPendingPayments.length, paid: allPayments.length }));
  ok('console : plus d\'attente, 1 paiement encaissé compté', st2.pend === 0 && st2.paid === 1, JSON.stringify(st2));

  await p.evaluate(async () => { document.getElementById('codeType').value = 'annual'; document.getElementById('codeClient').value = 'autre@client.test'; await generateCode(); });
  await sleep(800);
  ok('2e code → 2e paiement en attente (449 DH)', sql("SELECT count(*) FROM public.admin_payments WHERE client_email='autre@client.test' AND status='pending' AND amount=449") === '1');
  await p.evaluate(async () => { const c = allCodes.find(x => x.client_email === 'autre@client.test'); await cancelCode(c.id); });
  await sleep(800);
  ok('code annulé → paiement annulé, non compté', sql("SELECT status FROM public.admin_payments WHERE client_email='autre@client.test'") === 'cancelled' && (await p.evaluate(() => allPendingPayments.length)) === 0);
  ok('aucun code ni paiement orphelin', sql("SELECT count(*) FROM public.admin_codes c WHERE NOT EXISTS (SELECT 1 FROM public.admin_payments p WHERE p.code_id=c.id)") === '0' && sql("SELECT count(*) FROM public.admin_payments WHERE code_id IS NULL") === '0');

  // Paiement saisi à la main sans code : signalé « à rattacher », jamais bloqué
  await p.evaluate(async () => { document.getElementById('paymentEmail').value = 'direct@client.test'; document.getElementById('paymentDate').value = new Date().toISOString().slice(0, 10); document.getElementById('paymentAmount').value = '49'; document.getElementById('paymentType').value = 'monthly'; document.getElementById('paymentMode').value = 'virement'; document.getElementById('paymentNote').value = ''; await savePayment(); });
  await sleep(900);
  const ul = await p.evaluate(() => ({ shown: getComputedStyle(document.getElementById('unlinkedPaymentsCard')).display !== 'none', txt: document.getElementById('unlinkedPaymentsTable').textContent }));
  ok('paiement manuel sans code : enregistré et listé « à rattacher » (avec « aucun code »)', sql("SELECT count(*) FROM public.admin_payments WHERE client_email='direct@client.test' AND status='paid' AND code_id IS NULL") === '1' && ul.shown && /direct@client\.test/.test(ul.txt) && /aucun code/.test(ul.txt));
  ok('les paiements liés à un code ne figurent pas dans la liste « à rattacher »', !/nouveau@client\.test/.test(ul.txt));

  await browser.close(); srv.close(); try { dropDb(db); } catch (e) {}
  const n = R_.filter(Boolean).length; console.log(`\n${n === R_.length ? 'OK' : 'ÉCHEC'} : ${n}/${R_.length} contrôles (paiement lié au code)`); process.exit(n === R_.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
