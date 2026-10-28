// Tests d'intégration « cloud » : app.html + FAUX client Supabase + VRAIE base PostgreSQL locale
// (RLS, déclencheurs et fonctions SQL du dépôt). Ce n'est PAS Supabase lui-même : voir tests/README.md.
// Prérequis : PostgreSQL local (PGHOST/PGPORT/PGUSER), npm install, Chromium (CHROMIUM_PATH).
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const { createDb, dropDb, makeBackend } = require('./backend');

const ROOT = path.join(__dirname, '..', '..');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const srv = http.createServer((q, r) => {
  const f = path.join(ROOT, q.url.split('?')[0] === '/' ? 'app.html' : q.url.split('?')[0]);
  fs.readFile(f, (e, d) => {
    if (e) { r.writeHead(404); return r.end(); }
    let body = d;
    if (f.endsWith('app.html')) body = d.toString('utf8')
      .replace(/^const SUPABASE_URL = .*$/m, "const SUPABASE_URL = 'https://fake.supabase.test';")
      .replace(/^const SUPABASE_ANON_KEY = .*$/m, "const SUPABASE_ANON_KEY = 'fake-anon-key';").replace(/ integrity="[^"]*" crossorigin="anonymous"/g, '');
    r.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
    r.end(body);
  });
}).listen(8153);

const results = [];
const check = (name, cond, extra = '') => results.push([!!cond, name, extra]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const yr = new Date().getFullYear();

(async () => {
  const db = createDb();
  const be = makeBackend(db);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
  const errors = [];
  const nm = (...s) => path.join(ROOT, 'node_modules', ...s);

  async function newDevice(label) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, serviceWorkers: 'block' });
    const p = await ctx.newPage();
    p.on('pageerror', e => errors.push(label + ' PAGEERR ' + e.message));
    p.on('dialog', d => d.accept());
    await p.exposeFunction('__srv', (op, args) => be.handle(op, args));
    await p.route(/jsdelivr.*supabase/, r => r.fulfill({ body: FAKE, contentType: 'text/javascript' }));
    await p.route('**/jspdf.umd.min.js', r => r.fulfill({ path: nm('jspdf', 'dist', 'jspdf.umd.min.js'), contentType: 'text/javascript' }));
    await p.route('**/jspdf.plugin.autotable.min.js', r => r.fulfill({ path: nm('jspdf-autotable', 'dist', 'jspdf.plugin.autotable.min.js'), contentType: 'text/javascript' }));
    await p.route(/googleapis|gstatic|hcaptcha/, r => r.abort());
    return { ctx, p, E: (fn, arg) => p.evaluate(fn, arg) };
  }
  async function signup(dev, email) {
    const { p } = dev;
    await p.goto('http://localhost:8153/app.html?mode=login'); await p.waitForTimeout(800);
    await p.evaluate(() => { const t = [...document.querySelectorAll('button,div,a')].find(e => e.textContent.trim() === 'Inscription'); t && t.click(); });
    await p.fill('#signupEmail', email); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345');
    await p.click('#signupBtn'); await p.waitForTimeout(2500);
    if (!(await p.isVisible('#mainApp'))) {
      await p.evaluate(() => selectStatus(document.querySelector('[onclick*="selectStatus"]').getAttribute('onclick').match(/'(.*?)'/)[1]));
      await p.evaluate(() => onboardingNext(1));
      await p.fill('#onbCompanyName', 'SARL Cloud'); await p.fill('#onbICE', '001234567000089');
      await p.evaluate(() => onboardingNext(2));
      await p.fill('#onbBank', 'Banque test'); await p.fill('#onbRIB', '007 780 0001234567890123 45');
      await p.evaluate(() => finishOnboarding()); await p.waitForTimeout(1500);
    }
  }
  async function login(dev, email) {
    const { p } = dev;
    await p.goto('http://localhost:8153/app.html?mode=login'); await p.waitForTimeout(800);
    if (await p.isVisible('#loginEmail')) {
      await p.fill('#loginEmail', email); await p.fill('#loginPassword', 'Test#12345'); await p.click('#loginBtn'); await p.waitForTimeout(2500);
    }
  }
  const draftAndIssue = (dev, status, desc = 'Prestation', price = 100) => dev.E(async ([status, desc, price]) => {
    newInvoice();
    document.getElementById('editorClient').value = 'c1';
    const r = document.querySelector('#itemsBody tr'); r.querySelector('.item-desc').value = desc; r.querySelector('.item-qty').value = '1'; r.querySelector('.item-price').value = String(price); updateTotals();
    await saveInvoice(status);
    return Storage.get('invoices', []).slice(-1)[0];
  }, [status, desc, price]);
  const serverInvoices = async (email) => {
    const r = await be.sql("SELECT d.value FROM public.user_data d JOIN auth.users u ON u.id=d.user_id WHERE u.email=$1 AND d.key='invoices'", [email]);
    return r.length ? r[0].value : [];
  };
  const counter = async (email, type) => (await be.sql("SELECT c.last_value FROM public.doc_counters c JOIN auth.users u ON u.id=c.user_id WHERE u.email=$1 AND c.doc_type=$2", [email, type]))[0]?.last_value ?? 0;
  const seedClient = (dev) => dev.E(() => { Storage.set('clients', [{ id: 'c1', name: 'Client Cloud', ice: '001122334455667', address: 'Rabat' }]); });

  try {
    // ================= S1. Émission = appel réel du numéro serveur =================
    const A = await newDevice('A');
    await signup(A, 'a@test.invalid');
    check('S1 application connectée au serveur de test', await A.p.isVisible('#mainApp'));
    await seedClient(A); await A.p.waitForTimeout(800);
    const draft = await draftAndIssue(A, 'draft');
    check('S1 brouillon : numéro provisoire, aucun appel au compteur serveur', draft.number.startsWith('BRO-') && (await A.E(() => window.__rpcLog.filter(l => l.fn === 'next_doc_number').length)) === 0);
    const inv1 = await draftAndIssue(A, 'sent');
    check(`S1 émission : l'appli appelle next_doc_number et reçoit FAC-${yr}-001`, inv1.number === `FAC-${yr}-001` && (await A.E(() => window.__rpcLog.filter(l => l.fn === 'next_doc_number').length)) >= 1, inv1.number);
    await A.p.waitForTimeout(800);
    check('S1 compteur serveur = 1', (await counter('a@test.invalid', 'invoice')) === 1);
    const srv1 = await serverInvoices('a@test.invalid');
    check('S1 facture présente côté serveur avec le même numéro', srv1.some(i => i.number === `FAC-${yr}-001` && i.status === 'sent'));
    const ev = await be.sql("SELECT action,number FROM public.doc_events e JOIN auth.users u ON u.id=e.user_id WHERE u.email='a@test.invalid'");
    check('S1 journal serveur : émission tracée automatiquement', ev.some(e => e.action === 'emission' && e.number === `FAC-${yr}-001`));

    // ================= S2. Panne réseau pendant l'émission =================
    await A.E(() => { window.__net.down = true; });
    const off = await draftAndIssue(A, 'sent', 'Hors ligne', 50);
    check('S2 panne réseau : émission refusée, la facture reste brouillon', off.status === 'draft' && off.number.startsWith('BRO-'), JSON.stringify([off.status, off.number]));
    check('S2 aucun numéro local « officiel » créé', !(await A.E(() => Storage.get('invoices', []).some(i => i.status !== 'draft' && i.number.endsWith('-002')))));
    check('S2 le message explique la situation', await A.E(() => [...document.querySelectorAll('.toast')].some(t => /brouillon/i.test(t.textContent))));
    check('S2 compteur serveur inchangé (1)', (await counter('a@test.invalid', 'invoice')) === 1);
    // 2e tentative toujours hors ligne
    await A.E(() => { const i = Storage.get('invoices', []).find(x => x.number && x.number.startsWith('BRO-') && x.items && x.items[0].description === 'Hors ligne'); editInvoice(i.id); });
    await A.E(async () => { await saveInvoice('sent'); });
    check('S2 réessai hors ligne : toujours brouillon', await A.E(() => Storage.get('invoices', []).find(i => i.items[0].description === 'Hors ligne').status === 'draft'));
    // retour réseau
    await A.E(() => { window.__net.down = false; });
    await A.E(async () => { const i = Storage.get('invoices', []).find(x => x.items[0].description === 'Hors ligne'); editInvoice(i.id); await saveInvoice('sent'); });
    await A.p.waitForTimeout(800);
    const back = await A.E(() => Storage.get('invoices', []).find(i => i.items[0].description === 'Hors ligne'));
    check(`S2 réseau rétabli : émission réussie avec FAC-${yr}-002 (aucun trou)`, back.status === 'sent' && back.number === `FAC-${yr}-002`, JSON.stringify([back.status, back.number]));

    // ================= S3. Serveur non mis à jour (SQL 14 absent) =================
    await A.E(() => { window.__net.missingRpc = ['next_doc_number']; });
    const nosql = await draftAndIssue(A, 'sent', 'Sans SQL 14', 10);
    check('S3 fonction serveur absente : émission bloquée proprement (brouillon)', nosql.status === 'draft' && await A.E(() => [...document.querySelectorAll('.toast')].some(t => /Mise à jour du serveur/.test(t.textContent))));
    await A.E(() => { window.__net.missingRpc = []; });

    // ================= S4. Deux appareils, émissions concurrentes =================
    const B = await newDevice('B');
    await login(B, 'a@test.invalid');
    check('S4 appareil B connecté au même compte', await B.p.isVisible('#mainApp'));
    await B.p.waitForTimeout(800);
    const [rA, rB] = await Promise.all([draftAndIssue(A, 'sent', 'Concurrente A', 11), draftAndIssue(B, 'sent', 'Concurrente B', 22)]);
    await A.p.waitForTimeout(1500); await B.p.waitForTimeout(1500);
    check('S4 numéros officiels distincts sur les deux appareils', rA.number !== rB.number && rA.status === 'sent' && rB.status === 'sent', `${rA.number} / ${rB.number}`);
    const srv4 = await serverInvoices('a@test.invalid');
    const nums = srv4.filter(i => i.status !== 'draft').map(i => i.number);
    check('S4 aucun doublon de numéro côté serveur', new Set(nums).size === nums.length, nums.join(','));
    check('S4 aucune facture émise perdue (fusion) : les deux factures concurrentes sont sur le serveur', srv4.some(i => i.number === rA.number) && srv4.some(i => i.number === rB.number), nums.join(','));
    check('S4 le compteur serveur couvre les numéros émis', (await counter('a@test.invalid', 'invoice')) >= 4);

    // ================= S5. Reconnexion / synchronisation =================
    const C = await newDevice('C');
    await login(C, 'a@test.invalid');
    await C.p.waitForTimeout(1000);
    const cNums = await C.E(() => Storage.get('invoices', []).filter(i => i.status !== 'draft').map(i => i.number).sort());
    check('S5 nouvel appareil : toutes les factures émises sont rechargées', JSON.stringify(cNums) === JSON.stringify([...nums].sort()), cNums.join(','));
    // brouillon créé hors ligne puis réseau rétabli
    await C.E(() => { window.__net.down = true; });
    await C.E(async () => { newInvoice(); document.getElementById('editorClient').value = 'c1'; const r = document.querySelector('#itemsBody tr'); r.querySelector('.item-desc').value = 'Brouillon hors ligne'; r.querySelector('.item-price').value = '5'; updateTotals(); await saveInvoice('draft'); });
    check('S5 brouillon enregistré localement hors ligne', await C.E(() => Storage.get('invoices', []).some(i => i.items[0].description === 'Brouillon hors ligne')));
    await C.E(() => { window.__net.down = false; window.dispatchEvent(new Event('online')); });
    await C.p.waitForTimeout(2500);
    let onServer = (await serverInvoices('a@test.invalid')).some(i => i.items && i.items[0].description === 'Brouillon hors ligne');
    if (!onServer) {   // le prochain enregistrement resynchronise la liste complète
      await C.E(async () => { const i = Storage.get('invoices', []); Storage.set('invoices', i); });
      await C.p.waitForTimeout(1200);
      onServer = (await serverInvoices('a@test.invalid')).some(i => i.items && i.items[0].description === 'Brouillon hors ligne');
    }
    check('S5 après retour du réseau, le brouillon hors ligne atteint le serveur', onServer);
    // déconnexion / reconnexion
    await C.E(async () => { await Auth.logout(); });
    await C.p.waitForTimeout(500);
    await login(C, 'a@test.invalid');
    const rc = await C.E(() => ({ inv: Storage.get('invoices', []).filter(i => i.status !== 'draft').length, cl: Storage.get('clients', []).length, uid: Storage._currentUserId, vis: (document.getElementById('authScreen')||document.body).innerText.slice(0,300).replace(/\n/g,' '), err: (document.getElementById('loginError')||{}).textContent, toast: [...document.querySelectorAll('.toast')].map(t=>t.textContent).join('|'), auth: getComputedStyle(document.getElementById('authScreen')||document.body).display, keys: Object.keys(localStorage).join(','), login: document.getElementById('loginEmail') && document.getElementById('loginEmail').value }));
    check('S5 après déconnexion/reconnexion : factures et clients toujours là', rc.inv >= 4 && rc.cl === 1, JSON.stringify(rc));

    // ================= S6. Isolation entre deux comptes (via l'application) =================
    const D = await newDevice('D');
    await signup(D, 'b@test.invalid');
    await D.p.waitForTimeout(800);
    check('S6 compte B : aucune facture ni client de A visible', await D.E(() => Storage.get('invoices', []).length === 0 && Storage.get('clients', []).length === 0));
    const aId = (await be.sql("SELECT id FROM auth.users WHERE email='a@test.invalid'"))[0].id;
    const peek = await D.E(async (aId) => {
      const r = await supaClient.from('user_data').select('key, value').eq('user_id', aId);
      return r.data ? r.data.length : -1;
    }, aId);
    check('S6 compte B : lecture directe des données de A renvoie 0 ligne', peek === 0, String(peek));
    await seedClient(D);
    const num = (await draftAndIssue(D, 'sent', 'Facture de B', 70)) || {};
    check(`S6 compte B : sa première facture est FAC-${yr}-001 (compteur indépendant)`, num.number === `FAC-${yr}-001`, num.number);

    // ================= S7. Modification directe d'une facture émise =================
    const attack = await A.E(async () => {
      const uid = Storage._currentUserId;
      const inv = Storage.get('invoices', []).map(i => ({ ...i }));
      const target = inv.find(i => i.status === 'sent');
      const out = {};
      target.totalTTC = 1;
      let r = await supaClient.from('user_data').upsert({ user_id: uid, key: 'invoices', value: inv });
      out.montant = r.error && r.error.message;
      const inv2 = inv.filter(i => i.id !== target.id);
      r = await supaClient.from('user_data').upsert({ user_id: uid, key: 'invoices', value: inv2 });
      out.suppression = r.error && r.error.message;
      r = await supaClient.from('user_data').delete().eq('user_id', uid);
      out.effacement = r.error && r.error.message;
      const fake = Storage.get('invoices', []).map(i => ({ ...i })); fake.push({ id: 'zz', number: `FAC-${new Date().getFullYear()}-099`, type: 'invoice', status: 'sent', totalTTC: 5 });
      r = await supaClient.from('user_data').upsert({ user_id: uid, key: 'invoices', value: fake });
      out.fauxNumero = r.error && r.error.message;
      return out;
    });
    check('S7 modification directe du montant refusée par le serveur', /FACTURE_VERROUILLEE/.test(attack.montant || ''), attack.montant);
    check('S7 suppression directe d\'une facture émise refusée', /FACTURE_VERROUILLEE/.test(attack.suppression || ''), attack.suppression);
    check('S7 effacement direct de toutes les données refusé', /FACTURE_VERROUILLEE/.test(attack.effacement || ''), attack.effacement);
    check('S7 facture émise avec numéro inventé refusée', /NUMERO_NON_ATTRIBUE/.test(attack.fauxNumero || ''), attack.fauxNumero);
    const after = await serverInvoices('a@test.invalid');
    check('S7 les factures émises du serveur sont intactes après les attaques', after.filter(i => i.status !== 'draft').length === nums.length && !after.some(i => i.totalTTC === 1));

    // ================= S8. Interface : tentative de contournement depuis l'application =================
    const ui = await A.E(async () => {
      const issued = Storage.get('invoices', []).find(i => i.status === 'sent');
      deleteInvoice(issued.id);
      const stillThere = !!Storage.get('invoices', []).find(i => i.id === issued.id);
      editInvoice(issued.id);
      const saved = await persistEditor('draft');
      return { stillThere, saved };
    });
    check('S8 interface : suppression et modification d\'une facture émise refusées', ui.stillThere && ui.saved === null);

    check('aucune erreur JavaScript pendant les tests', errors.length === 0, errors.join(' | '));
  } catch (e) {
    check('exécution des scénarios sans exception', false, e && e.stack || String(e));
  }

  let fail = 0;
  for (const [ok, name, extra] of results) { if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || !extra ? '' : '  -> ' + extra)); }
  console.log(`\n${results.length - fail}/${results.length} tests d'intégration réussis`);
  await browser.close(); srv.close(); await be.close(); dropDb(db);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERREUR HARNAIS', e); process.exit(2); });
