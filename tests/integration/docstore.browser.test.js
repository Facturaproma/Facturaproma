// Tests d'intégration NAVIGATEUR du nouveau stockage : app.html (greffe DocStoreGlue + docstore.js) + FAUX client Supabase
// + base PostgreSQL LOCALE jetable (sql 00…14 + 15 + 16 + 17 réels : RLS, déclencheurs, fonctions).
// SIMULATION LOCALE : ce n'est PAS Supabase. Aucune bascule de compte sur un serveur distant : les « bascules » ci-dessous se font dans la base locale jetable.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const { createDb, dropDb, makeBackend } = require('./backend');

const ROOT = path.join(__dirname, '..', '..');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PRE_URL = 'https://njjaomichdlnoscrnxlz.supabase.co', PROD_URL = 'https://mdozjptoecygmpkjlohr.supabase.co';   // chaînes inertes : le faux client ne contacte aucun réseau
const serve = (port, url) => http.createServer((q, r) => {
  const f = path.join(ROOT, q.url.split('?')[0] === '/' ? 'app.html' : q.url.split('?')[0]);
  fs.readFile(f, (e, d) => {
    if (e) { r.writeHead(404); return r.end(); }
    let body = d;
    if (f.endsWith('app.html')) body = d.toString('utf8')
      .replace(/^const SUPABASE_URL = .*$/m, `const SUPABASE_URL = '${url}';`)
      .replace(/^const SUPABASE_ANON_KEY = .*$/m, "const SUPABASE_ANON_KEY = 'fake-anon-key';");
    r.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
    r.end(body);
  });
}).listen(port);
const PRE = serve(8161, PRE_URL), PROD = serve(8162, PROD_URL);
const BASE_PRE = 'http://localhost:8161', BASE_PROD = 'http://localhost:8162';

const results = [];
const check = (name, cond, extra = '') => results.push([!!cond, name, extra]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const yr = new Date().getFullYear();
const T = 'dsa@facturapro-test.invalid', T2 = 'dsb@facturapro-test.invalid', ORD = 'ordinaire@example.test';

(async () => {
  const db = createDb({ docs: true });
  const be = makeBackend(db);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
  const errors = [];
  const nm = (...s) => path.join(ROOT, 'node_modules', ...s);

  async function newDevice(label, opts = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, serviceWorkers: 'block' });
    const p = await ctx.newPage();
    const dev = { ctx, p, label, answer: true, base: opts.base || BASE_PRE, dialogs: [], E: (fn, arg) => p.evaluate(fn, arg) };
    p.on('pageerror', e => errors.push(label + ' PAGEERR ' + e.message));
    p.on('dialog', d => { dev.dialogs.push(d.message().slice(0, 80)); if (d.type() === 'confirm' && !dev.answer) d.dismiss(); else d.accept(); });
    if (opts.startDown) await p.addInitScript(() => { window.__startDown = true; });
    await p.exposeFunction('__srv', (op, args) => be.handle(op, args));
    await p.route(/jsdelivr.*supabase/, r => r.fulfill({ body: FAKE, contentType: 'text/javascript' }));
    await p.route('**/jspdf.umd.min.js', r => r.fulfill({ path: nm('jspdf', 'dist', 'jspdf.umd.min.js'), contentType: 'text/javascript' }));
    await p.route('**/jspdf.plugin.autotable.min.js', r => r.fulfill({ path: nm('jspdf-autotable', 'dist', 'jspdf.plugin.autotable.min.js'), contentType: 'text/javascript' }));
    await p.route(/googleapis|gstatic|hcaptcha|supabase\.co/, r => r.abort());
    return dev;
  }
  async function signup(dev, email) {
    const { p } = dev;
    await p.goto(dev.base + '/app.html?mode=login'); await p.waitForTimeout(800);
    await p.evaluate(() => { const t = [...document.querySelectorAll('button,div,a')].find(e => e.textContent.trim() === 'Inscription'); t && t.click(); });
    await p.fill('#signupEmail', email); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345');
    await p.click('#signupBtn'); await p.waitForTimeout(2500);
    if (!(await p.isVisible('#mainApp'))) {
      await p.evaluate(() => selectStatus(document.querySelector('[onclick*="selectStatus"]').getAttribute('onclick').match(/'(.*?)'/)[1]));
      await p.evaluate(() => onboardingNext(1));
      await p.fill('#onbCompanyName', 'SARL Docs'); await p.fill('#onbICE', '001234567000089');
      await p.evaluate(() => onboardingNext(2));
      await p.fill('#onbBank', 'Banque test'); await p.fill('#onbRIB', '007 780 0001234567890123 45');
      await p.evaluate(() => finishOnboarding()); await p.waitForTimeout(1500);
    }
  }
  async function login(dev, email) {
    const { p } = dev;
    await p.goto(dev.base + '/app.html?mode=login'); await p.waitForTimeout(800);
    if (await p.isVisible('#loginEmail')) { await p.fill('#loginEmail', email); await p.fill('#loginPassword', 'Test#12345'); await p.click('#loginBtn'); await p.waitForTimeout(2500); }
  }
  const reload = async (dev) => { await dev.p.goto(dev.base + '/app.html'); await dev.p.waitForTimeout(2500); };
  // attend que la file du nouveau stockage soit vide (envois terminés)
  const quiet = async (dev, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const st = await dev.E(() => DocStoreGlue.store ? DocStoreGlue.store.status() : null); if (!st || (!st.pending && !st.flushing)) return st; await sleep(100); } return dev.E(() => DocStoreGlue.store && DocStoreGlue.store.status()); };
  const draft = (dev, desc = 'Prestation', price = 100, status = 'draft') => dev.E(async ([desc, price, status]) => {
    newInvoice(); document.getElementById('editorClient').value = 'c1';
    const r = document.querySelector('#itemsBody tr'); r.querySelector('.item-desc').value = desc; r.querySelector('.item-qty').value = '1'; r.querySelector('.item-price').value = String(price); updateTotals();
    await saveInvoice(status);
    return Storage.get('invoices', []).slice(-1)[0];
  }, [desc, price, status]);
  const seedClient = (dev) => dev.E(() => { Storage.set('clients', [{ id: 'c1', name: 'Client Docs', ice: '001122334455667', address: 'Rabat' }]); });
  const uid = async (email) => (await be.sql('SELECT id FROM auth.users WHERE email=$1', [email]))[0].id;
  const docsOf = (email) => be.sql("SELECT d.doc_type, d.id, d.number, d.status, d.version, d.body FROM public.documents d JOIN auth.users u ON u.id=d.user_id WHERE u.email=$1 ORDER BY d.created_at, d.id", [email]);
  const legacyVal = async (email, key) => (await be.sql("SELECT d.value, d.updated_at FROM public.user_data d JOIN auth.users u ON u.id=d.user_id WHERE u.email=$1 AND d.key=$2", [email, key]))[0];
  const legacyFp = async (email) => (await be.sql("SELECT string_agg(d.key||':'||md5(d.value::text)||':'||d.updated_at::text, '|' ORDER BY d.key) h FROM public.user_data d JOIN auth.users u ON u.id=d.user_id WHERE u.email=$1 AND d.key IN ('invoices','quotes','payments','docLog')", [email]))[0].h;
  const modeOf = async (email) => (await be.sql("SELECT public.fp_doc_mode(id) m FROM auth.users WHERE email=$1", [email]))[0].m;
  const flipTo = async (email, mode) => { const id = await uid(email); await be.sql('INSERT INTO public.doc_store_testers(user_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]); return (await be.sql('SELECT public.fp_doc_mode_set($1::uuid,$2,NULL,0) r', [id, mode]))[0].r; };
  const rpcCount = (dev, fn) => dev.E((fn) => window.__rpcLog.filter(l => l.fn === fn).length, fn);

  try {
    // ================= S1. Build de préproduction, compte de test, mode serveur « legacy » (défaut) =================
    const A = await newDevice('A');
    await signup(A, T);
    await seedClient(A); await A.p.waitForTimeout(600);
    check('S1 mode par défaut côté serveur = legacy', (await modeOf(T)) === 'legacy');
    const d1 = await draft(A, 'Brouillon legacy', 10);
    const i1 = await draft(A, 'Facture legacy', 100, 'sent');
    await A.p.waitForTimeout(1200);
    const mode1 = await A.E(() => ({ m: DocStoreGlue.mode, r: DocStoreGlue.store && DocStoreGlue.store.status().reason }));
    check('S1 compte de test + préproduction + serveur « legacy » : comportement historique (mode legacy)', mode1.m === 'legacy' && mode1.r === 'serveur', JSON.stringify(mode1));
    check('S1 get_doc_mode interrogé ; aucune fonction du nouveau stockage appelée', (await rpcCount(A, 'get_doc_mode')) >= 1 && (await rpcCount(A, 'upsert_document')) === 0 && (await rpcCount(A, 'append_history')) === 0);
    check('S1 écritures dans user_data (ancien chemin) ; aucune ligne dans documents', (await legacyVal(T, 'invoices')).value.length === 2 && (await docsOf(T)).length === 0);
    check('S1 facture émise : numéro serveur FAC-' + yr + '-001', i1.number === `FAC-${yr}-001`, i1.number);

    // ================= S2. Bascule (base locale jetable) puis rechargement : l'état vient des documents =================
    const fpBefore = await legacyFp(T);
    const flip = await flipTo(T, 'documents');
    check('S2 bascule contrôlée du compte de test (base LOCALE jetable)', flip.ok === true, JSON.stringify(flip).slice(0, 200));
    await reload(A);
    const s2 = await A.E(() => ({ m: DocStoreGlue.mode, inv: Storage.get('invoices', []).map(i => i.id + ':' + i.status), key: Storage._buildLocalKey('invoices', Storage._currentUserId) }));
    check('S2 après rechargement : mode « documents » décidé par le serveur', s2.m === 'documents', JSON.stringify(s2));
    check('S2 l\'application affiche les mêmes factures qu\'avant la bascule (2), lues dans documents', s2.inv.length === 2 && s2.inv.includes(d1.id + ':draft') && s2.inv.includes(i1.id + ':sent'), s2.inv.join(','));
    check('S2 copie locale séparée (clé fpd_…, jamais fp_… pour ces clés)', /^fpd_/.test(s2.key));
    check('S2 ancien stockage intact après la bascule', (await legacyFp(T)) === fpBefore);

    // ================= S3. Parcours complet en mode documents =================
    const dn = await draft(A, 'Nouveau brouillon', 40);
    await quiet(A);
    check('S3 brouillon créé : ligne documents (version 1), numéro provisoire, aucun appel au compteur', (await docsOf(T)).some(d => d.id === dn.id && d.version === 1 && d.status === 'draft') && dn.number.startsWith('BRO-'));
    await A.E(async (id) => { editInvoice(id); document.getElementById('editorNotes').value = 'modifié'; await saveInvoice('draft'); }, dn.id);
    await quiet(A);
    check('S3 modification : version 2 côté serveur', (await docsOf(T)).find(d => d.id === dn.id).version === 2);
    const issued = await A.E(async (id) => { editInvoice(id); await saveInvoice('sent'); return Storage.get('invoices', []).find(i => i.id === id); }, dn.id);
    await quiet(A);
    check(`S3 émission : numéro officiel du serveur FAC-${yr}-002, statut sent`, issued.number === `FAC-${yr}-002` && (await docsOf(T)).find(d => d.id === dn.id).number === `FAC-${yr}-002`, issued.number);
    await A.E((id) => { recordPayment(); document.getElementById('paymentInvoice').value = id; document.getElementById('paymentAmount').value = '20'; savePayment(); }, dn.id);
    await quiet(A);
    let row = (await docsOf(T)).find(d => d.id === dn.id);
    check('S3 paiement partiel : doc_payments 1 ligne, facture paidAmount 20 (calculé par le serveur)', Number(row.body.paidAmount) === 20 && (await be.sql("SELECT count(*)::int n FROM public.doc_payments p JOIN auth.users u ON u.id=p.user_id WHERE u.email=$1", [T]))[0].n === 1);
    await A.E((id) => { recordPayment(); document.getElementById('paymentInvoice').value = id; document.getElementById('paymentAmount').value = String((Storage.get('invoices', []).find(i => i.id === id).totalTTC || 0) - 20); savePayment(); }, dn.id);
    await quiet(A);
    row = (await docsOf(T)).find(d => d.id === dn.id);
    check('S3 solde payé : statut paid côté serveur, local identique', row.status === 'paid' && (await A.E((id) => Storage.get('invoices', []).find(i => i.id === id).status, dn.id)) === 'paid');
    await A.E(async (id) => { await createCreditFromInvoice(id); }, dn.id);
    await quiet(A);
    const credit = (await docsOf(T)).find(d => d.doc_type === 'credit');
    check(`S3 avoir : créé avec numéro serveur (type credit), montants négatifs`, credit && /^AVR-/.test(credit.number) && Number(credit.body.totalTTC) < 0, credit && credit.number);
    await A.E(async () => { newQuote(); document.getElementById('editorClient').value = 'c1'; const r = document.querySelector('#itemsBody tr'); r.querySelector('.item-desc').value = 'Devis docs'; r.querySelector('.item-qty').value = '1'; r.querySelector('.item-price').value = '300'; updateTotals(); await saveInvoice('draft'); });
    await quiet(A);
    const q = (await docsOf(T)).find(d => d.doc_type === 'quote');
    check('S3 devis : ligne documents de type quote', !!q);
    await A.E(async (id) => { await convertQuoteToInvoice(id, true); }, q.id);
    await quiet(A);
    const conv = (await docsOf(T)).filter(d => d.body.sourceQuote === q.id);
    check('S3 devis converti : facture brouillon liée + devis « accepted » (2 documents mis à jour)', conv.length === 1 && conv[0].status === 'draft' && (await docsOf(T)).find(d => d.id === q.id).status === 'accepted');
    await A.E((id) => { deleteInvoice(id); }, conv[0].id);
    await quiet(A);
    check('S3 suppression d\'un brouillon autorisée (ligne supprimée + pierre tombale)', !(await docsOf(T)).some(d => d.id === conv[0].id) && (await be.sql("SELECT count(*)::int n FROM public.doc_deleted g JOIN auth.users u ON u.id=g.user_id WHERE u.email=$1 AND g.id=$2", [T, conv[0].id]))[0].n === 1);
    await A.E((id) => { deleteInvoice(id); }, dn.id);
    await sleep(500);
    check('S3 suppression d\'une facture émise refusée (interface) : toujours sur le serveur', (await docsOf(T)).some(d => d.id === dn.id));
    const hist = await be.sql("SELECT h.action FROM public.doc_history h JOIN auth.users u ON u.id=h.user_id WHERE u.email=$1", [T]);
    check('S3 journal : émission, paiements, avoir, conversion, suppression enregistrés dans doc_history', ['emission', 'paiement', 'avoir', 'conversion_devis', 'suppression_brouillon'].every(a => hist.some(h => h.action === a)), hist.map(h => h.action).join(','));
    check('S3 AUCUNE écriture dans l\'ancien stockage pendant tout le parcours (empreinte user_data identique)', (await legacyFp(T)) === fpBefore);
    // société et compteur : restent dans user_data (clés non concernées par le nouveau stockage), cohérents avec les documents
    await A.E(() => { Storage.set('company', { ...Storage.get('company', {}), name: 'SARL Docs modifiée' }); }); await A.p.waitForTimeout(800);
    check('S3 données de société : toujours écrites dans user_data (même chemin qu\'avant), non concernées par le nouveau stockage', (await legacyVal(T, 'company')).value.name === 'SARL Docs modifiée');
    check('S3 compteur local aligné sur les numéros serveur (≥ 2 factures émises) et enregistré dans user_data', Number((await legacyVal(T, 'counter')).value.invoice) >= 2);
    // rechargement : l'état = le serveur
    await reload(A);
    const reloaded = await A.E(() => Storage.get('invoices', []).map(i => i.id).sort());
    const srvIds = (await docsOf(T)).filter(d => d.doc_type !== 'quote').map(d => d.id).sort();
    check('S3 rechargement : les factures/avoirs affichés = ceux du serveur', JSON.stringify(reloaded) === JSON.stringify(srvIds), reloaded.length + ' vs ' + srvIds.length);

    // ================= S4. Coupure réseau, reprise, réponse perdue (rejeu) =================
    await A.E(() => { window.__net.down = true; });
    const off = await draft(A, 'Hors ligne', 15);
    await A.p.waitForTimeout(600);
    const st4 = await A.E(() => DocStoreGlue.store.status());
    check('S4 hors ligne : brouillon enregistré localement, 1 opération en attente (bandeau affiché)', st4.pending >= 1 && (await A.E(() => !!document.getElementById('docstoreBanner'))), JSON.stringify(st4));
    check('S4 hors ligne : rien n\'est parti vers le serveur', !(await docsOf(T)).some(d => d.id === off.id));
    check('S4 hors ligne : file persistée localement', await A.E(() => JSON.parse(localStorage.getItem('fpd_q_' + Storage._currentUserId) || '[]').length >= 1));
    await A.E(() => { window.__net.down = false; });
    await reload(A);   // reprise après fermeture : la file persistée est rejouée
    await quiet(A);
    check('S4 après rechargement : l\'opération en attente est envoyée, brouillon sur le serveur, file vide', (await docsOf(T)).some(d => d.id === off.id) && (await A.E(() => DocStoreGlue.store.status().pending)) === 0);
    check('S4 le brouillon hors ligne est toujours affiché après reprise (pas perdu)', await A.E((id) => !!Storage.get('invoices', []).find(i => i.id === id), off.id));
    await A.E(() => { window.__net.dropAfter = ['upsert_document']; });
    const lost = await draft(A, 'Réponse perdue', 25);
    await A.p.waitForTimeout(3500);
    await quiet(A, 8000);
    const dupes = (await docsOf(T)).filter(d => d.id === lost.id);
    check('S4 réponse perdue puis rejeu (même op_id) : UNE seule ligne, version 1, file vidée', dupes.length === 1 && dupes[0].version === 1 && (await A.E(() => DocStoreGlue.store.status().pending)) === 0, JSON.stringify(dupes.map(d => d.version)));
    check('S4 l\'opération a été envoyée 2 fois au plus (1 essai + 1 rejeu), pas de boucle', (await A.E((id) => window.__rpcLog.filter(l => l.fn === 'upsert_document' && l.args.p_doc.id === id).length, lost.id)) === 2, String(await A.E((id) => window.__rpcLog.filter(l => l.fn === 'upsert_document' && l.args.p_doc.id === id).length, lost.id)));

    // ================= S5. Deux appareils, même compte : numérotation, conflits =================
    const B = await newDevice('B');
    await login(B, T); await B.p.waitForTimeout(800);
    check('S5 appareil B en mode documents (décidé par le serveur)', (await B.E(() => DocStoreGlue.mode)) === 'documents', JSON.stringify(await B.E(() => ({ m: DocStoreGlue.mode, s: DocStoreGlue.store && DocStoreGlue.store.status(), vis: document.getElementById('mainApp') && document.getElementById('mainApp').offsetParent !== null }))));
    const [rA, rB] = await Promise.all([draft(A, 'Concurrente A', 11, 'sent'), draft(B, 'Concurrente B', 22, 'sent')]);
    await quiet(A); await quiet(B);
    check('S5 émissions simultanées : numéros officiels distincts', rA.status === 'sent' && rB.status === 'sent' && rA.number !== rB.number, `${rA.number} / ${rB.number}`);
    const nums = (await docsOf(T)).filter(d => d.status !== 'draft' && d.doc_type === 'invoice').map(d => d.number);
    check('S5 aucun doublon de numéro côté serveur, aucune facture perdue', new Set(nums).size === nums.length && nums.includes(rA.number) && nums.includes(rB.number), nums.join(','));
    // même brouillon modifié sur les deux appareils
    const shared = await draft(A, 'Partagé', 50); await quiet(A);
    await reload(B);
    await A.E(async (id) => { editInvoice(id); document.getElementById('editorNotes').value = 'version A'; await saveInvoice('draft'); }, shared.id); await quiet(A);
    await B.E(async (id) => { editInvoice(id); document.getElementById('editorNotes').value = 'version B'; await saveInvoice('draft'); }, shared.id);
    await B.p.waitForTimeout(800);
    const stB = await B.E(() => DocStoreGlue.store.status());
    check('S5 modification du même brouillon sur 2 appareils : conflit explicite sur B (bandeau), rien écrasé', stB.conflicts === 1 && (await docsOf(T)).find(d => d.id === shared.id).body.notes === 'version A' && (await B.E(() => document.getElementById('docstoreBanner').textContent)).includes('conflit'), JSON.stringify(stB));
    check('S5 la version locale de B reste affichée jusqu\'au choix', await B.E((id) => Storage.get('invoices', []).find(i => i.id === id).notes, shared.id) === 'version B');
    B.answer = false;   // « Annuler » = garder la version du serveur
    await B.E(() => DocStoreGlue.showConflicts()); await quiet(B);
    check('S5 « garder le serveur » : B reprend la version A, conflit levé, aucune écriture', (await B.E((id) => Storage.get('invoices', []).find(i => i.id === id).notes, shared.id)) === 'version A' && (await B.E(() => DocStoreGlue.store.status().conflicts)) === 0 && (await docsOf(T)).find(d => d.id === shared.id).version === 2);
    await B.E(async (id) => { editInvoice(id); document.getElementById('editorNotes').value = 'B après arbitrage'; await saveInvoice('draft'); }, shared.id); await quiet(B);
    check('S5 après arbitrage, B peut de nouveau modifier (version 3)', (await docsOf(T)).find(d => d.id === shared.id).version === 3);
    // A modifie une version périmée ; B avait modifié : « garder la mienne »
    await A.E(async (id) => { editInvoice(id); document.getElementById('editorNotes').value = 'A périmé'; await saveInvoice('draft'); }, shared.id); await A.p.waitForTimeout(800);
    check('S5 A (version périmée) : conflit signalé', (await A.E(() => DocStoreGlue.store.status().conflicts)) === 1);
    A.answer = true;   // « OK » = garder ma version
    await A.E(() => DocStoreGlue.showConflicts()); await quiet(A);
    check('S5 « garder la mienne » : réappliquée sur la version serveur (4), notes = A périmé', (await docsOf(T)).find(d => d.id === shared.id).body.notes === 'A périmé' && (await docsOf(T)).find(d => d.id === shared.id).version === 4);
    // suppression d'un brouillon modifié ailleurs
    const del = await draft(A, 'À supprimer', 5); await quiet(A); await reload(B);
    await A.E(async (id) => { editInvoice(id); document.getElementById('editorNotes').value = 'modifié'; await saveInvoice('draft'); }, del.id); await quiet(A);
    B.answer = true; await B.E((id) => { deleteInvoice(id); }, del.id); await B.p.waitForTimeout(800);
    check('S5 suppression d\'un brouillon modifié ailleurs : conflit, document PAS supprimé côté serveur', (await docsOf(T)).some(d => d.id === del.id) && (await B.E(() => DocStoreGlue.store.status().conflicts)) === 1);
    B.answer = false; await B.E(() => DocStoreGlue.showConflicts()); await quiet(B);
    check('S5 « garder le serveur » : le brouillon réapparaît sur B avec la version du serveur', await B.E((id) => Storage.get('invoices', []).find(i => i.id === id)?.notes, del.id) === 'modifié');
    // modification d'un brouillon supprimé ailleurs
    const gone = await draft(A, 'Supprimé ailleurs', 5); await quiet(A); await reload(B);
    await A.E((id) => { deleteInvoice(id); }, gone.id); await quiet(A);
    await B.E(async (id) => { editInvoice(id); document.getElementById('editorNotes').value = 'éditée alors que supprimée'; await saveInvoice('draft'); }, gone.id); await B.p.waitForTimeout(800);
    const cg = await B.E(() => DocStoreGlue.store.conflicts.map(c => ({ id: c.id, server: c.server_doc })));
    check('S5 modification d\'un brouillon supprimé ailleurs : conflit « supprimé » (jamais recréé silencieusement)', cg.length === 1 && cg[0].server === null && !(await docsOf(T)).some(d => d.id === gone.id));
    B.answer = true; await B.E(() => DocStoreGlue.showConflicts()); await quiet(B);
    check('S5 « recréer » : le brouillon est recréé avec la version locale', (await docsOf(T)).find(d => d.id === gone.id)?.body.notes === 'éditée alors que supprimée');
    check('S5 refresh : un document supprimé sur A disparaît de B avec message', await (async () => {
      const d2 = await draft(A, 'Éphémère', 1); await quiet(A); await reload(B);
      await A.E((id) => { deleteInvoice(id); }, d2.id); await quiet(A);
      await B.E(async () => { await DocStoreGlue.store.reload(); });
      return !(await B.E((id) => !!Storage.get('invoices', []).find(i => i.id === id), d2.id));
    })());

    // ================= S6. Retour vers legacy pendant que l'application est ouverte =================
    const before6 = (await docsOf(T)).length;
    const back = await flipTo(T, 'legacy');
    check('S6 retour au mode ancien (base LOCALE jetable) : accepté', back.ok === true && back.mode === 'legacy', JSON.stringify(back).slice(0, 200));
    const ud = await legacyVal(T, 'invoices');
    check('S6 tous les documents sont repassés dans user_data.invoices (aucune perte)', ud.value.length >= (await docsOf(T)).filter(d => d.doc_type !== 'quote').length - 0, ud.value.length + ' vs ' + before6);
    const n0 = await rpcCount(A, 'upsert_document');
    await A.E(async (id) => { editInvoice(id); document.getElementById('editorNotes').value = 'après retour arrière'; await saveInvoice('draft'); }, shared.id);
    await A.p.waitForTimeout(2500);
    const st6 = await A.E(() => DocStoreGlue.store.status());
    check('S6 appareil resté en mode documents : écriture refusée MODE_ANCIEN_STOCKAGE, arrêt net (halted), 1 seul appel', st6.halted === 'mode_ancien' && (await rpcCount(A, 'upsert_document')) === n0 + 1, JSON.stringify(st6));
    check('S6 message explicite (bandeau) et modification conservée en file (pas perdue, pas rejouée)', (await A.E(() => document.getElementById('docstoreBanner').textContent)).includes('MODE_ANCIEN_STOCKAGE') && st6.pending === 1);
    await A.E(() => { DocStoreGlue.store.flushSoon(); window.dispatchEvent(new Event('online')); }); await A.p.waitForTimeout(1500);
    check('S6 « online » / flushSoon ne relance PAS les envois (pas de boucle)', (await rpcCount(A, 'upsert_document')) === n0 + 1);
    await A.E(() => { Storage.set('invoices', Storage.get('invoices', [])); });
    check('S6 nouvelles écritures locales refusées explicitement (jamais envoyées en ancien format)', (await rpcCount(A, 'upsert_document')) === n0 + 1);
    const fp6 = await legacyFp(T);
    await reload(A);
    check('S6 après rechargement : mode legacy, factures lues depuis user_data', (await A.E(() => DocStoreGlue.mode)) === 'legacy' && (await A.E(() => Storage.get('invoices', []).length)) === ud.value.length);
    check('S6 la modification en attente n\'a PAS été écrite dans l\'ancien stockage ni rejouée (reste conservée localement pour décision)', (await legacyFp(T)) === fp6 && await A.E(() => JSON.parse(localStorage.getItem('fpd_q_' + Storage._currentUserId) || '[]').length === 1));
    const orph = await A.E(() => ({ o: DocStoreGlue.orphan, banner: (document.getElementById('docstoreBanner') || {}).textContent || '', exp: DocStoreGlue.store.exportRecovery() }));
    check('REVUE retour au legacy avec file locale non vide : signalé (bandeau), exportable, jamais rejoué', orph.o && orph.o.pending === 1 && /non envoyées/.test(orph.banner) && /"queue"/.test(orph.exp) && orph.exp.includes('après retour arrière'), JSON.stringify(orph).slice(0, 300));
    // l'ancien chemin fonctionne de nouveau
    await draft(A, 'Retour legacy', 9); await A.p.waitForTimeout(1200);
    check('S6 écriture legacy de nouveau fonctionnelle après retour', (await legacyVal(T, 'invoices')).value.some(i => i.items && i.items[0].description === 'Retour legacy'));

    // ================= S7. Garde-fous : build de production, compte ordinaire, indicateur local =================
    await flipTo(T, 'documents');
    const P = await newDevice('P', { base: BASE_PROD });
    await login(P, T); await P.p.waitForTimeout(800);
    const p7 = await P.E(() => ({ m: DocStoreGlue.mode, st: DocStoreGlue.store && DocStoreGlue.store.status() }));
    check('S7 build de PRODUCTION, serveur en « documents » : get_doc_mode jamais appelé, mode legacy côté client', p7.m === 'legacy' && p7.st.reason === 'build_non_preprod' && (await rpcCount(P, 'get_doc_mode')) === 0, JSON.stringify(p7));
    const fp7 = await legacyFp(T);
    await P.E(async () => { newInvoice(); document.getElementById('editorClient').value = 'c1'; const r = document.querySelector('#itemsBody tr'); r.querySelector('.item-desc').value = 'Prod refusé'; r.querySelector('.item-qty').value = '1'; r.querySelector('.item-price').value = '5'; updateTotals(); await saveInvoice('draft'); });
    await P.p.waitForTimeout(1500);
    check('S7 build de production : l\'écriture ancien format est refusée par le serveur (MODE_NOUVEAU_STOCKAGE), l\'ancien stockage reste intact', (await legacyFp(T)) === fp7);
    check('S7 refus explicite : bandeau MODE_NOUVEAU_STOCKAGE, pas une « licence expirée »', (await P.E(() => DocStoreGlue.refused)) === 'nouveau' && (await P.E(() => (document.getElementById('docstoreBanner') || {}).textContent || '')).includes('MODE_NOUVEAU_STOCKAGE'));
    const n7 = await P.E(() => window.__rpcLog.length);
    await P.E(() => { Storage.set('invoices', Storage.get('invoices', [])); Storage.set('quotes', []); window.dispatchEvent(new Event('online')); }); await P.p.waitForTimeout(1500);
    check('S7 ensuite : écritures sur les 4 clés refusées localement, plus aucun appel serveur pour elles (pas de boucle)', (await P.E(() => window.__rpcLog.length)) === n7 && (await legacyFp(T)) === fp7);
    check('REVUE refus MODE_NOUVEAU_STOCKAGE : la valeur refusée est conservée localement (copie de récupération), non perdue en silence', (await P.E(() => localStorage.getItem('fp_refused_' + Storage._currentUserId + '_invoices') || '')).includes('Prod refusé'));
    const pending7 = await P.E(() => SyncManager.pendingChanges.filter(c => ['invoices', 'quotes', 'payments', 'docLog'].includes(c.key)).length);
    check('S7 file de synchronisation ancienne : aucune entrée en attente pour les 4 clés (pas de réessai infini)', pending7 === 0, String(pending7));
    // compte ordinaire sur build de préproduction
    const O = await newDevice('O'); await signup(O, ORD); await seedClient(O);
    await draft(O, 'Ordinaire', 7); await O.p.waitForTimeout(1000);
    check('S7 compte ORDINAIRE (build de préproduction) : legacy, get_doc_mode jamais appelé', (await O.E(() => DocStoreGlue.mode)) === 'legacy' && (await rpcCount(O, 'get_doc_mode')) === 0 && (await legacyVal(ORD, 'invoices')).value.length === 1);
    // ----- REVUE DE CODE : file d'attente ANCIEN format (SyncManager.syncPending) sur un compte legacy -----
    const sentUp = () => be.log.filter(l => l.op === 'table' && l.table === 'user_data' && l.tableOp === 'upsert').length;
    const pend = () => O.E(() => SyncManager.pendingChanges.map(c => c.key));
    const origHandle = be.handle; let forced = 0, forcedErr = null;
    be.handle = async (op, a) => { if (forcedErr && op === 'table' && a.table === 'user_data' && a.op === 'upsert') { forced++; return { data: null, error: forcedErr }; } return origHandle(op, a); };
    await O.E(() => { SyncManager.isOnline = true; SyncManager.isSyncing = false; SyncManager.pendingChanges = [{ type: 'storage', key: 'company', id: 'rv0', timestamp: 1 }]; });
    let u0 = sentUp(); await O.E(() => SyncManager.syncPending());
    check('REVUE syncPending envoie réellement l\'écriture en attente (avant : client inexistant, déclarée synchronisée sans envoi)', sentUp() === u0 + 1 && (await pend()).length === 0, sentUp() - u0 + ' envois, file ' + (await pend()).join(','));
    for (const [label, err] of [['licence (42501/RLS)', { code: '42501', message: 'new row violates row-level security policy for table "user_data"' }], ['session expirée (PGRST301)', { code: 'PGRST301', message: 'JWT expired' }], ['réseau', { message: 'TypeError: Failed to fetch' }]]) {
      forcedErr = err; forced = 0;
      await O.E(() => { SyncManager.isSyncing = false; SyncManager.pendingChanges = [{ type: 'storage', key: 'company', id: 'rv1', timestamp: 1 }]; });
      await O.E(() => SyncManager.syncPending()); await O.p.waitForTimeout(200);
      check('REVUE écriture ancien format refusée/échouée (' + label + ') : reste EN ATTENTE, jamais marquée synchronisée, un seul appel', (await pend()).join() === 'company' && forced === 1, 'file=' + (await pend()).join() + ' appels=' + forced);
      forced = 0; await O.E(() => { Storage.set('company', { ...Storage.get('company', {}), name: 'SARL Revue ' + Date.now() }); }); await O.p.waitForTimeout(600);
      check('REVUE  … écriture directe refusée (' + label + ') : mise en attente (pas perdue), sans boucle', (await pend()).includes('company') && forced === 1, 'file=' + (await pend()).join() + ' appels=' + forced);
      await O.E(() => { SyncManager.pendingChanges = []; });
    }
    forcedErr = null; await O.E(() => { SyncManager.isSyncing = false; SyncManager.pendingChanges = [{ type: 'storage', key: 'company', id: 'rv2', timestamp: 1 }]; });
    u0 = sentUp(); await O.E(() => SyncManager.syncPending());
    check('REVUE  … retour du service : une seule écriture, file vide (pas de doublon)', sentUp() === u0 + 1 && (await pend()).length === 0);
    await O.E(() => { Storage.set('company', { ...Storage.get('company', {}), name: 'A' }); Storage.set('company', { ...Storage.get('company', {}), name: 'B' }); });
    forcedErr = { message: 'TypeError: Failed to fetch' }; await O.E(() => { Storage.set('company', { ...Storage.get('company', {}), name: 'C' }); Storage.set('company', { ...Storage.get('company', {}), name: 'D' }); }); await O.p.waitForTimeout(500);
    check('REVUE plusieurs écritures hors ligne sur la même clé : une seule entrée en attente (valeur courante rejouée)', (await pend()).filter(k => k === 'company').length === 1, (await pend()).join());
    forcedErr = null; be.handle = origHandle;

    // indicateur local « documents » alors que le serveur dit legacy
    await flipTo(T, 'legacy');
    await A.E(() => { localStorage.setItem('fpd_hint_' + Storage._currentUserId, 'documents'); });
    await reload(A);
    check('S7 indicateur local « documents » + serveur « legacy » → legacy (le local ne peut pas autoriser)', (await A.E(() => DocStoreGlue.mode)) === 'legacy');
    await draft(A, 'Hint ignoré', 3); await A.p.waitForTimeout(1000);
    check('S7  … et les écritures vont à l\'ancien stockage', (await legacyVal(T, 'invoices')).value.some(i => i.items && i.items[0].description === 'Hint ignoré'));
    // hors ligne au chargement avec indicateur « documents » → lecture seule (restreint, n'autorise jamais)
    await A.E(() => { localStorage.setItem('fpd_hint_' + Storage._currentUserId, 'documents'); });
    await A.p.addInitScript(() => { window.__startDown = true; });
    await reload(A);
    check('S7 serveur injoignable au chargement + indicateur « documents » : mode BLOQUÉ (lecture seule), jamais documents', (await A.E(() => DocStoreGlue.mode)) === 'blocked');
    const fpB = await legacyFp(T), nB = await A.E(() => window.__rpcLog.length);
    await A.E(() => { Storage.set('invoices', []); });
    check('S7  … écritures refusées localement (message), aucune écriture ancien format, rien envoyé', (await legacyFp(T)) === fpB && (await A.E(() => window.__rpcLog.length)) === nB);
    await A.E(() => { localStorage.removeItem('fpd_hint_' + Storage._currentUserId); });

    // ================= S8. Réinitialisation interdite en mode documents =================
    await flipTo(T, 'documents');
    const R = await newDevice('R'); await login(R, T); await R.p.waitForTimeout(800);
    const nBefore = (await docsOf(T)).length;
    check('S8 appareil neuf : mode documents', (await R.E(() => DocStoreGlue.mode)) === 'documents');
    await R.E(async () => { await resetApp(); });
    check('S8 resetApp refusée en mode documents (message), aucune donnée touchée', (await docsOf(T)).length === nBefore && (await R.E(() => Storage.get('invoices', []).length)) > 0 && R.dialogs.some(d => /Réinitialisation indisponible/.test(d)), R.dialogs.join('|'));

    check('aucune erreur JavaScript pendant les tests', errors.length === 0, errors.slice(0, 5).join(' | '));
  } catch (e) {
    check('exécution des scénarios sans exception', false, e && e.stack || String(e));
  }

  let fail = 0;
  for (const [ok, name, extra] of results) { if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || !extra ? '' : '  -> ' + extra)); }
  console.log(`\n${results.length - fail}/${results.length} tests navigateur du nouveau stockage réussis (SIMULATION locale : faux client + PostgreSQL local, PAS Supabase)`);
  await browser.close(); PRE.close(); PROD.close(); await be.close(); dropDb(db);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERREUR HARNAIS', e); process.exit(2); });
