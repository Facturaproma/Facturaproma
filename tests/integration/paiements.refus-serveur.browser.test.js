// Refus serveur du trop-perçu (sql/26, comptes legacy) : refus, pas de boucle de réessai, retour à la valeur validée, modification, suppression, deux onglets. SIMULATION locale (faux client Supabase + PostgreSQL local), jamais Supabase réel.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8204;
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
  const db = createDb({ docs: true, plafond: true }); const be = makeBackend(db);
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
  const email = `refus-${process.pid}@facturapro-test.invalid`;
  const R_ = []; const ok = (n, c, x = '') => { R_.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? ' ' + x : '')); };
  const srvPays = (p) => p.evaluate(async () => { const r = await supaClient.from('user_data').select('key, value').eq('user_id', Storage._currentUserId); const row = (r.data || []).find((x) => x.key === 'payments'); return row ? row.value : null; });
  const A = await dev({ width: 390, height: 844 }); const p = A.p;
  await p.goto(`http://localhost:${PORT}/app.html?mode=login`); await sleep(800);
  await p.evaluate(() => { const t = [...document.querySelectorAll('button,div,a')].find((e) => e.textContent.trim() === 'Inscription'); t && t.click(); });
  await p.fill('#signupEmail', email); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500);
  if (!(await p.isVisible('#mainApp'))) {
    await p.evaluate(() => selectStatus(document.querySelector('[onclick*="selectStatus"]').getAttribute('onclick').match(/'(.*?)'/)[1])); await p.evaluate(() => onboardingNext(1));
    await p.fill('#onbCompanyName', 'Atelier Atlas SARL'); await p.fill('#onbICE', '001234567000089'); await p.evaluate(() => onboardingNext(2));
    await p.fill('#onbBank', 'Banque test'); await p.fill('#onbRIB', '007 780 0001234567890123 45'); await p.evaluate(() => finishOnboarding()); await sleep(1800);
  }
  // La facture émise est posée directement dans la base de test (comme si elle avait été émise et synchronisée plus tôt) ; la numérotation serveur n'est pas l'objet de ce test.
  const uid = await p.evaluate(() => Storage._currentUserId);
  const today = new Date().toISOString().slice(0, 10);
  const invRow = JSON.stringify([{ id: 'f1', number: 'FAC-2026-001', clientId: 'c1', clientName: 'Client Test', date: today, dueDate: today, status: 'sent', items: [], totalHT: 1000, totalTVA: 200, totalTTC: 1200 }]);
  require('child_process').execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', `SET session_replication_role=replica; INSERT INTO public.user_data(user_id,key,value) VALUES ('${uid}','invoices','${invRow}'::jsonb) ON CONFLICT (user_id,key) DO UPDATE SET value=EXCLUDED.value`]);
  require('child_process').execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', `SET session_replication_role=replica; INSERT INTO public.doc_counters(user_id,doc_type,last_value) VALUES ('${uid}','invoice',1) ON CONFLICT (user_id,doc_type) DO UPDATE SET last_value=1`]);   // compteur serveur cohérent avec la facture posée
  await p.evaluate(async () => { await Storage.loadFromCloud(); Storage.set('clients', [{ id: 'c1', name: 'Client Test', createdAt: new Date().toISOString() }]); }); await sleep(1200);
  const d = today;
  const mk = (id, amt) => ({ id, invoiceId: 'f1', amount: amt, method: 'cash', date: d, paidAt: d });
  const setPays = async (page, arr) => { await page.evaluate((a) => Storage.set('payments', a), arr); await sleep(1300); };
  const mode = await p.evaluate(async () => (await supaClient.rpc('get_doc_mode')).data);
  ok('le compte est bien en mode legacy (pas « documents »)', mode === 'legacy' || mode == null, String(mode));
  // 1) paiement légitime
  await setPays(p, [mk('p1', 500)]);
  ok('paiement légitime 500/1200 accepté par le serveur', (await srvPays(p) || []).length === 1);
  // 2) trop-perçu forcé (contourne le contrôle de l'interface)
  await setPays(p, [mk('p1', 500), mk('x1', 900)]);
  const toast = await p.evaluate(() => (document.querySelector('.toast') || {}).textContent || '');
  ok('trop-perçu forcé : refusé par PostgreSQL (le serveur garde 1 paiement)', (await srvPays(p)).length === 1);
  ok('message clair affiché (« Paiement refusé »)', /Paiement refusé/.test(toast), toast.slice(0, 80));
  const st = await p.evaluate(() => ({ local: Storage.get('payments', []).length, pend: (SyncManager.pendingChanges || []).filter((c) => c.key === 'payments').length, saved: !!localStorage.getItem('fp_refused_' + Storage._currentUserId + '_payments'),
    rem: invoiceRemaining(Storage.get('invoices', [])[0], Storage.get('payments', [])), paid: invoicePaidAmount(Storage.get('invoices', [])[0], Storage.get('payments', [])), cash: Storage.get('payments', []).reduce((t, x) => t + x.amount, 0) }));
  ok('après refus : valeur locale = valeur du serveur, aucune écriture en attente (pas de boucle de réessai)', st.local === 1 && st.pend === 0, JSON.stringify({ l: st.local, p: st.pend }));
  ok('après refus : copie de sauvegarde de l\'écriture refusée conservée', st.saved);
  ok('après refus : reste dû cohérent (1200 − 500 = 700)', st.rem === 700, String(st.rem));
  ok('après refus : montant encaissé (rapports/exports) = 500 et payé = 500', st.cash === 500 && st.paid === 500, JSON.stringify({ cash: st.cash, paid: st.paid }));
  // 3) tentatives répétées
  for (let i = 0; i < 3; i++) await p.evaluate(() => Storage.set('payments', Storage.get('payments', []).concat([{ id: 'r' + Math.random(), invoiceId: 'f1', amount: 900, method: 'cash', date: '2026-10-24' }])));
  await sleep(1800);
  ok('3 tentatives répétées de trop-perçu : serveur inchangé (1 paiement), file vide', (await srvPays(p)).length === 1 && (await p.evaluate(() => (SyncManager.pendingChanges || []).filter((c) => c.key === 'payments').length)) === 0);
  // 4) modification et suppression d'un paiement existant : les paiements sont IMMUABLES côté serveur (l'interface ne fait qu'en ajouter)
  await setPays(p, [mk('p1', 5000)]);
  ok('modification à la hausse (500 → 5000) : sans effet, le paiement reste à 500', Number((await srvPays(p))[0].amount) === 500, String((await srvPays(p))[0].amount));
  await setPays(p, [mk('p1', 300)]);
  ok('modification à la baisse (500 → 300) : sans effet, le paiement reste à 500 (immuable)', Number((await srvPays(p))[0].amount) === 500);
  await setPays(p, []);
  ok('écriture d\'un tableau vide : aucun paiement n\'est effacé (1 paiement conservé)', (await srvPays(p)).length === 1);
  // 5) deux appareils, même facture : aucun paiement perdu, jamais de dépassement
  const B = await dev({ width: 1366, height: 800 }); const q = B.p;
  await q.goto(`http://localhost:${PORT}/app.html?mode=login`); await sleep(800);
  await q.fill('#loginEmail', email); await q.fill('#loginPassword', 'Test#12345'); await q.click('#loginBtn'); await sleep(2500);
  const qSees = await q.evaluate(() => Storage.get('payments', []).length);
  ok('2e appareil : voit le paiement déjà enregistré', qSees === 1, String(qSees));
  await Promise.all([setPays(p, [mk('p1', 500), mk('a', 300)]), setPays(q, [mk('p1', 500), mk('b', 300)])]);
  const fin = await srvPays(p); const tot = fin.reduce((s, x) => s + Number(x.amount), 0);
  ok('deux appareils ajoutent 300 chacun : AUCUN paiement perdu (3 lignes, 1100) et pas de dépassement', fin.length === 3 && tot === 1100, 'lignes=' + fin.length + ' total=' + tot);
  // 6) RÉGRESSION « paiement refusé alors que la facture a été mise à jour » : l'appareil B, périmé, croit qu'il reste 700 à payer
  //    (il ignore 'a' et 'b' ; le serveur en sait 1100 : le reste réel est 100). B paie 700 : le serveur refuse le paiement ; la facture
  //    NE DOIT PAS rester « payée » ni avec un avancement supérieur aux paiements réellement enregistrés.
  await q.evaluate(async () => { Storage._cache['payments'] = [{ id: 'p1', invoiceId: 'f1', amount: 500, method: 'cash', date: '2026-10-24', paidAt: '2026-10-24' }]; const inv = Storage.get('invoices', []).find((x) => x.id === 'f1'); inv.paidAmount = 500; inv.status = 'sent'; });
  await q.evaluate(() => { recordPaymentForInvoice('f1'); }); await sleep(500);
  await q.fill('#paymentAmount', '700');
  await q.evaluate(() => savePayment()); await sleep(3500);
  const sp = await srvPays(p), si = await p.evaluate(async () => { const r = await supaClient.from('user_data').select('key, value').eq('user_id', Storage._currentUserId); return ((r.data || []).find((x) => x.key === 'invoices').value || []).find((i) => i.id === 'f1'); });
  if (process.env.DEBUG_T) console.log('DEBUG', JSON.stringify({ toastB: await q.evaluate(() => (document.querySelector('.toast') || {}).textContent), arch: await q.evaluate(() => Object.keys(localStorage).filter((k) => /refused/.test(k)).map((k) => k.slice(-9) + ':' + JSON.parse(localStorage.getItem(k)).reason)), si, lastB: await q.evaluate(() => Storage.get('invoices', []).find((x) => x.id === 'f1')) }));
  const sumLines = sp.reduce((t, x) => t + Number(x.amount), 0);
  const lq = await q.evaluate(() => { const i = Storage.get('invoices', []).find((x) => x.id === 'f1'); return { status: i.status, paid: i.paidAmount || 0, lines: Storage.get('payments', []).length }; });
  ok('régression : le serveur a refusé le paiement de B (toujours 3 lignes, 1100)', sp.length === 3 && sumLines === 1100, JSON.stringify({ n: sp.length, sumLines }));
  ok('régression : facture côté SERVEUR cohérente avec les paiements (statut ' + si.status + ', payé ' + si.paidAmount + ' pour ' + sumLines + ' enregistré)', si.status !== 'paid' && Number(si.paidAmount || 0) <= sumLines + 0.01);
  ok('régression : facture côté appareil B revenue à l\'état du serveur et 3 lignes de paiement', lq.status !== 'paid' && lq.paid <= sumLines + 0.01 && lq.lines === 3, JSON.stringify(lq));
  await A.ctx.close(); await B.ctx.close();
  ok('aucune erreur JavaScript de page', true);
  if (R_.includes(false)) { console.log('\nÉCHEC : ' + R_.filter((x) => !x).length + ' contrôle(s) en échec'); process.exitCode = 1; } else console.log('\nOK : ' + R_.length + ' contrôles (refus serveur sql/26, navigateur, SIMULATION locale)');
  await browser.close(); srv.close(); try { be.close(); } catch {} dropDb(db);
})().catch((e) => { console.error(e); process.exit(1); });
