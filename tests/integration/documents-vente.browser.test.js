// Paiement lié au code (sql/32 + console admin) : générer un code crée un paiement en attente (non compté), l'encaisser le passe à payé
// sans doublon, la révocation l'annule. SIMULATION locale (faux Supabase + PostgreSQL local).
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8237;
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
  const db = createDb({ paiementCode: true, documentsVente: true }); const be = makeBackend(db);
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

  sql("INSERT INTO public.admin_settings(key,value) VALUES ('fp_company_config', '{\"name\":\"FacturaPro Test SARL\",\"ice\":\"001234567000089\",\"if\":\"12345678\",\"rc\":\"999\",\"tvaRate\":20,\"address\":\"1 rue Test\",\"city\":\"Casablanca\"}')");
  const cfgName = await p.evaluate(async () => (await fpReadCfg()).name);
  ok('réglages société stockés en texte JSON : relus correctement', cfgName === 'FacturaPro Test SARL', cfgName);
  await p.evaluate(async () => { document.getElementById('codeType').value = 'monthly'; document.getElementById('codeClient').value = 'doc@client.test'; document.getElementById('codeNote').value = ''; await generateCode(); });
  await sleep(1000);
  ok('code généré → facture LIC émise et liée (49 DH, TVA 20 % figée)', sql("SELECT count(*) FROM public.admin_documents WHERE doc_type='invoice' AND client_email='doc@client.test' AND total_ttc=49 AND tva_rate=20 AND number ~ '^LIC-[0-9]{4}-0001$' AND payment_id IS NOT NULL") === '1');
  const a = await p.evaluate(() => ({ docs: fpDocuments.length, row: document.getElementById('pendingPaymentsTable').textContent }));
  ok('console : la facture apparaît sur la ligne du paiement en attente', a.docs === 1 && /LIC-\d{4}-0001/.test(a.row), JSON.stringify(a).slice(0, 140));
  await p.evaluate(async () => { const c = allCodes.find(x => x.client_email === 'doc@client.test'); await markAsPaid(c.id, c.client_email, c.type, 49); });
  await sleep(1400);
  ok('encaissement → reçu REC lié à la facture', sql("SELECT count(*) FROM public.admin_documents r JOIN public.admin_documents i ON i.id=r.ref_id WHERE r.doc_type='receipt' AND r.number ~ '^REC-[0-9]{4}-0001$' AND r.total_ttc=49 AND i.number ~ '^LIC-'") === '1');
  const b = await p.evaluate(() => ({ n: fpDocuments.length, row: document.getElementById('paymentsTable').textContent, st: fpDocuments.map(d => d.docType + ':' + d.status).sort().join() }));
  ok('console : paiement encaissé avec boutons facture ET reçu ; facture marquée soldée', /LIC-\d{4}-0001/.test(b.row) && /REC-\d{4}-0001/.test(b.row) && b.st === 'invoice:reconciled,receipt:reconciled', JSON.stringify(b).slice(0, 200));
  const pdfs = await p.evaluate(async () => { const out = []; for (const d of fpDocuments) { const pdf = await generateFpDocPDF(d, false); out.push(d.docType + ':' + (pdf ? pdf.getNumberOfPages() : 'ERR') + ':' + (pdf ? pdf.output('arraybuffer').byteLength > 2000 : false)); } return out.sort().join(); });
  ok('PDF facture et reçu générés (1 page chacun)', pdfs === 'invoice:1:true,receipt:1:true', pdfs);
  if (process.env.DUMP_PDF) { for (const t of ['invoice', 'receipt']) { const b64 = await p.evaluate(async (ty) => { const d = fpDocuments.find(x => x.docType === ty); const pdf = await generateFpDocPDF(d, false); return pdf.output('datauristring').split(',')[1]; }, t); require('fs').writeFileSync(process.env.DUMP_PDF + '_' + t + '.pdf', Buffer.from(b64, 'base64')); } }
  await p.evaluate(() => deleteFpDoc()); await sleep(200);
  ok('suppression d\'un document refusée (message), documents toujours en base', sql("SELECT count(*) FROM public.admin_documents") === '2' && /ne se supprime pas/.test(await p.evaluate(() => (document.querySelector('.toast') || {}).textContent || '')));
  await p.evaluate(async () => { document.getElementById('codeType').value = 'annual'; document.getElementById('codeClient').value = 'annule@client.test'; await generateCode(); });
  await sleep(900);
  await p.evaluate(async () => { const c = allCodes.find(x => x.client_email === 'annule@client.test'); await cancelCode(c.id); });
  await sleep(1000);
  ok('commande annulée → facture « annulée » (numéro conservé), aucun reçu', sql("SELECT count(*) FROM public.admin_documents WHERE client_email='annule@client.test' AND doc_type='invoice' AND status='void' AND number ~ '^LIC-[0-9]{4}-0002$'") === '1' && sql("SELECT count(*) FROM public.admin_documents WHERE client_email='annule@client.test' AND doc_type='receipt'") === '0');
  await p.evaluate(async () => { await loadFpDocuments(); renderFpDocuments(); });
  const tbl = await p.evaluate(() => document.getElementById('fpDocsTable').textContent);
  ok('onglet « Mes factures » : documents listés, sans bouton de suppression', /LIC-\d{4}-0001/.test(tbl) && /REC-\d{4}-0001/.test(tbl) && !/deleteFpDoc/.test(await p.evaluate(() => document.getElementById('fpDocsTable').innerHTML)));
  await p.evaluate(async () => { document.getElementById('paymentEmail').value = 'direct@client.test'; document.getElementById('paymentDate').value = new Date().toISOString().slice(0, 10); document.getElementById('paymentAmount').value = '449'; document.getElementById('paymentType').value = 'annual'; document.getElementById('paymentMode').value = 'virement'; await savePayment(); });
  await sleep(1000);
  ok('paiement saisi à la main → facture + reçu émis', sql("SELECT count(*) FROM public.admin_documents WHERE client_email='direct@client.test'") === '2');

  await browser.close(); srv.close(); try { dropDb(db); } catch (e) {}
  const n = R_.filter(Boolean).length; console.log(`\n${n === R_.length ? 'OK' : 'ÉCHEC'} : ${n}/${R_.length} contrôles (documents de vente)`); process.exit(n === R_.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
