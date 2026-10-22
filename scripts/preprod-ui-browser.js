// Section navigateur RÉEL (Chromium) de scripts/preprod-ui-validation.js : le build de préproduction (scripts/make-preprod-build.js)
// est servi en local par ce script ; le navigateur parle au VRAI Supabase de préproduction (GoTrue + PostgREST).
// Aucun appel n'est simulé, sauf mention contraire : « réseau coupé » = coupure du navigateur (Playwright setOffline),
// « réponse perdue » = la requête est envoyée au vrai serveur puis la réponse est supprimée avant le client,
// « jeton invalide » = en-tête Authorization altéré, la réponse 401 est celle du vrai serveur.
const http = require('http'), fs = require('fs'), path = require('path');

exports.run = async function run(h) {
  const { rec, q, q1, uidOf, EMAIL, pw, CTX, NATURE, sleep, clip, jstr, toDocuments } = h;
  const { chromium } = require('playwright-core');
  const BUILD = path.join(__dirname, '..', '.preprod-build');
  if (!fs.existsSync(path.join(BUILD, 'app.html'))) throw new Error('build de préproduction absent : lancer scripts/make-preprod-build.js');
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.ttf': 'font/ttf', '.png': 'image/png', '.svg': 'image/svg+xml' };
  const server = http.createServer((rq, rs) => {
    const rel = decodeURIComponent(rq.url.split('?')[0]); const f = path.normalize(path.join(BUILD, rel === '/' ? 'app.html' : rel));
    if (!f.startsWith(BUILD)) { rs.writeHead(403); return rs.end(); }
    fs.readFile(f, (e, d) => { if (e) { rs.writeHead(404); return rs.end('404'); } rs.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); rs.end(d); });
  }).listen(8190, '127.0.0.1');
  const BASE = 'http://127.0.0.1:8190';
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const errors = [];
  const NETB = 'RÉEL (serveur) + réseau coupé côté navigateur';
  const until = async (fn, ms = 25000) => { const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t0 > ms) return false; await sleep(250); } };

  async function newDev(label) {
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage(); const log = [];
    p.on('pageerror', (e) => errors.push(label + ' : ' + clip(e.message, 200)));
    p.on('dialog', (d) => d.accept());
    p.on('response', async (r) => {
      const u = r.url(); if (!u.startsWith(CTX.url)) return;
      const rel = u.slice(CTX.url.length).split('?')[0]; if (!/^\/(rest\/v1\/(user_data|documents|doc_payments|doc_history|rpc\/)|auth\/v1\/token)/.test(rel)) return;
      let body = ''; if (!rel.startsWith('/auth')) { try { body = (await r.text()).slice(0, 400); } catch {} }
      log.push({ m: r.request().method(), rel, status: r.status(), body });
    });
    const net = [], cons = [], relOf = (u) => u.startsWith(CTX.url) ? u.slice(CTX.url.length).split('?')[0] : null;
    p.on('request', (r) => { const rel = relOf(r.url()); if (rel) net.push({ k: r.method() + ' ' + rel, s: 'en attente' }); });
    p.on('response', (r) => { const rel = relOf(r.url()); if (!rel) return; const e = net.find((x) => x.k === r.request().method() + ' ' + rel && x.s === 'en attente'); if (e) e.s = String(r.status()); });
    p.on('requestfailed', (r) => { const rel = relOf(r.url()); if (!rel) return; const e = net.find((x) => x.k === r.method() + ' ' + rel && x.s === 'en attente'); if (e) e.s = 'ÉCHEC ' + clip((r.failure() || {}).errorText, 60); });
    p.on('console', (m) => { if (['error', 'warning'].includes(m.type())) cons.push(clip(m.text(), 180)); });
    p.on('requestfailed', (r) => { const u = r.url(); if (u.startsWith(CTX.url)) log.push({ m: r.method(), rel: u.slice(CTX.url.length).split('?')[0], status: 0, body: 'requête interrompue côté navigateur' }); });
    return { ctx, p, log, net, cons, label, E: (fn, arg) => p.evaluate(fn, arg) };
  }
  async function login(dv, k) {
    const { p } = dv;
    await p.goto(BASE + '/app.html?mode=login'); await p.waitForTimeout(1500);
    await p.fill('#loginEmail', EMAIL(k)); await p.fill('#loginPassword', pw(k)); await p.click('#loginBtn');
    // attend un écran réellement VISIBLE (application ou 1re étape d'intégration) ; sinon échoue avec le texte visible (message d'erreur d'authentification éventuel), sans aucun secret
    const shown = await until(async () => (await p.isVisible('#mainApp')) || (await p.isVisible('#onbStep1')), 45000);
    if (!shown) {
      const seen = await p.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300));
      const bt = await p.evaluate(() => (document.getElementById('loginBtn') || {}).textContent || '').catch(() => '?');
      throw new Error('connexion par l\'interface : ni application ni intégration visibles après 45 s ; texte visible : « ' + seen + ' » ; bouton : « ' + clip(bt, 40) + ' » ; requêtes vers Supabase : ' + (dv.net.map((x) => x.k + ' → ' + x.s).join(' | ') || 'AUCUNE') + ' ; console (erreurs) : ' + (dv.cons.slice(0, 8).join(' | ') || 'aucune') + ' ; erreurs de page : ' + (errors.slice(-3).join(' | ') || 'aucune'));
    }
    await p.waitForTimeout(800);
    if (!(await p.isVisible('#mainApp'))) {
      await p.evaluate(() => selectStatus(document.querySelector('[onclick*="selectStatus"]').getAttribute('onclick').match(/'(.*?)'/)[1]));
      await p.evaluate(() => onboardingNext(1));
      await p.fill('#onbCompanyName', 'SARL Validation'); await p.fill('#onbICE', '001234567000089');
      await p.evaluate(() => onboardingNext(2));
      await p.fill('#onbBank', 'Banque test'); await p.fill('#onbRIB', '007 780 0001234567890123 45');
      await p.evaluate(() => finishOnboarding()); await p.waitForTimeout(2500);
    }
    await until(() => p.evaluate(() => !!(window.Storage && Storage._currentUserId)), 15000);
  }
  const offline = async (dv, on) => { await dv.ctx.setOffline(on); await dv.p.evaluate((o) => window.dispatchEvent(new Event(o ? 'offline' : 'online')), on); };
  const pendKeys = (dv) => dv.E(() => SyncManager.pendingChanges.map((c) => c.key));
  const setCompany = (dv, name) => dv.E((n) => { Storage.set('company', { ...Storage.get('company', {}), name: n }); }, name);
  const company = async (uid) => (await q1("SELECT value->>'name' n FROM public.user_data WHERE user_id=$1::uuid AND key='company'", [uid])) || {};
  const drain = (dv) => dv.E(async () => { try { await License.refresh(); } catch {} SyncManager.isSyncing = false; await SyncManager.syncPending(); });
  const lic = (uid, active) => q(active ? "UPDATE public.licenses SET status='active', expires_at = now() + interval '30 days', updated_at = now() WHERE user_id=$1::uuid" : "UPDATE public.licenses SET status='suspended', expires_at = now() - interval '60 days', updated_at = now() WHERE user_id=$1::uuid", [uid]);
  const since = (dv, i) => dv.log.slice(i);
  const post = (arr) => arr.filter((x) => x.m === 'POST' && x.rel === '/rest/v1/user_data');

  try {
    // =================================================================== B : ANCIEN STOCKAGE (compte l, jamais basculé)
    const L = await newDev('L'); await login(L, 'l'); const lUid = await uidOf('l');
    const m0 = await L.E(() => ({ mode: DocStoreGlue.mode, reason: DocStoreGlue.store && DocStoreGlue.store.status().reason }));
    rec('B0', 'compte de test non basculé, build de préproduction : ancien stockage (le serveur répond legacy)', 'mode legacy, raison serveur', jstr(m0), m0.mode === 'legacy' && m0.reason === 'serveur', { proof: 'get_doc_mode réel interrogé : ' + L.log.filter((x) => x.rel === '/rest/v1/rpc/get_doc_mode').map((x) => x.status + ' ' + x.body).join(' | ') });

    // B1 : écriture hors ligne → reconnexion → envoi effectif
    await offline(L, true); await sleep(500);
    const V1 = 'B1-hors-ligne-' + Date.now();
    await setCompany(L, V1); await sleep(800);
    const k1 = await pendKeys(L), persisted = await L.E(() => JSON.parse(localStorage.getItem('fp_pending_sync') || '[]').map((c) => c.key));
    const dbMid = (await company(lUid)).n;
    rec('B1a', 'écriture hors ligne : mise en attente (mémoire + stockage local), RIEN envoyé au serveur', 'company en attente, base ≠ nouvelle valeur', `file ${k1} / persistée ${persisted} ; base : ${dbMid}`, k1.includes('company') && persisted.includes('company') && dbMid !== V1, { nature: NETB, proof: 'valeur côté serveur avant reconnexion : ' + dbMid, fatal: true });
    await offline(L, false);
    const arrived = await until(async () => (await company(lUid)).n === V1, 30000);
    await sleep(1500);
    const k1b = await pendKeys(L);
    rec('B1b', 'reconnexion : l\'écriture est ENVOYÉE (vérifiée côté serveur) puis seulement alors retirée de la file', 'base = nouvelle valeur, file vide', `base ${(await company(lUid)).n} ; file ${k1b}`, !!arrived && !k1b.includes('company'), { nature: NETB, proof: 'ligne user_data.company relue en SQL après la reconnexion', fatal: true });

    // B2 : licence inactive (refus RÉEL du serveur : 42501)
    await lic(lUid, false); const i2 = L.log.length;
    const V2 = 'B2-licence-' + Date.now();
    await setCompany(L, V2); await sleep(3500);
    const r2 = post(since(L, i2)), k2 = await pendKeys(L);
    rec('B2a', 'licence inactive : le serveur refuse l\'écriture (RLS), elle RESTE en attente, jamais marquée synchronisée', 'POST 403/42501, company en attente, base inchangée', `POST ${r2.map((x) => x.status + ' ' + x.body).join(' | ')} ; file ${k2} ; base ${(await company(lUid)).n}`, r2.length >= 1 && r2.every((x) => x.status >= 400) && /42501/.test(r2[0].body) && k2.includes('company') && (await company(lUid)).n !== V2, { sqlstate: '42501', nature: NATURE, proof: 'réponse PostgREST : ' + clip(r2[0] && r2[0].body, 200), fatal: true });
    const calls2 = post(since(L, i2)).length; await sleep(4000);
    rec('B2b', 'aucune boucle de nouvelles tentatives pendant 4 s', `${calls2} appel(s), inchangé`, `${post(since(L, i2)).length} appel(s)`, post(since(L, i2)).length === calls2);
    await lic(lUid, true); await drain(L);
    const ok2 = await until(async () => (await company(lUid)).n === V2, 20000);
    rec('B2c', 'licence rétablie : l\'écriture conservée arrive au serveur, file vide', 'base = valeur B2, file vide', `base ${(await company(lUid)).n} ; file ${await pendKeys(L)}`, !!ok2 && !(await pendKeys(L)).includes('company'), { fatal: true });

    // B3 : session invalide (jeton altéré → vraie réponse 401 du serveur)
    let tamper = false;
    await L.ctx.route(/\/rest\/v1\/user_data/, async (route) => {
      if (tamper && route.request().method() === 'POST') { const hd = { ...route.request().headers() }; const a = hd.authorization || ''; hd.authorization = a.slice(0, -4) + (a.endsWith('AAAA') ? 'BBBB' : 'AAAA'); return route.continue({ headers: hd }); }
      return route.continue();
    });
    tamper = true; const i3 = L.log.length; const V3 = 'B3-session-' + Date.now();
    await setCompany(L, V3); await sleep(3500);
    const r3 = post(since(L, i3)), k3 = await pendKeys(L);
    rec('B3a', 'session expirée / jeton refusé : vraie réponse 401 du serveur, l\'écriture RESTE en attente', 'POST 401, company en attente, base inchangée', `POST ${r3.map((x) => x.status + ' ' + clip(x.body, 80)).join(' | ')} ; file ${k3} ; base ${(await company(lUid)).n}`, r3.length >= 1 && r3.every((x) => x.status === 401) && k3.includes('company') && (await company(lUid)).n !== V3, { sqlstate: (r3[0] && (/"code":"([^"]+)"/.exec(r3[0].body) || [])[1]) || 'HTTP 401', proof: 'en-tête Authorization altéré dans le navigateur ; réponse du serveur : ' + clip(r3[0] && r3[0].body, 160), fatal: true });
    tamper = false; await drain(L);
    rec('B3b', 'session rétablie : l\'écriture arrive, file vide', 'base = valeur B3', `base ${(await company(lUid)).n}`, !!(await until(async () => (await company(lUid)).n === V3, 20000)), { fatal: true });

    // B4 : réponse perdue après acceptation par le serveur
    let lose = false;
    await L.ctx.route(/\/rest\/v1\/user_data/, async (route) => {
      if (lose && route.request().method() === 'POST') { lose = false; await route.fetch(); return route.abort('connectionreset'); }   // le serveur applique, le navigateur ne reçoit rien
      return route.continue();
    });
    lose = true; const V4 = 'B4-reponse-perdue-' + Date.now();
    await setCompany(L, V4); await sleep(3000);
    const k4 = await pendKeys(L), db4 = (await company(lUid)).n;
    rec('B4a', 'réponse perdue : le serveur a appliqué, le navigateur garde l\'écriture en attente', 'base = valeur B4 déjà, file contient company', `base ${db4} ; file ${k4}`, db4 === V4 && k4.includes('company'), { nature: NETB, proof: 'requête transmise au vrai serveur (route.fetch) puis réponse supprimée', fatal: true });
    await drain(L); await sleep(1500);
    const rows4 = await q1("SELECT count(*)::int n FROM public.user_data WHERE user_id=$1::uuid AND key='company'", [lUid]);
    rec('B4b', 'rejeu : valeur identique, une seule ligne, file vide (aucune duplication)', '1 ligne company, file vide', `${rows4.n} ligne ; base ${(await company(lUid)).n} ; file ${await pendKeys(L)}`, rows4.n === 1 && (await company(lUid)).n === V4 && !(await pendKeys(L)).includes('company'), { nature: NETB, fatal: true });

    // B5 : compte ordinaire sur le build de préproduction
    const O = await newDev('O'); await login(O, 'o'); const oUid = await uidOf('o');
    const mo = await O.E(() => ({ mode: DocStoreGlue.mode, reason: DocStoreGlue.store && DocStoreGlue.store.status().reason }));
    const askedMode = O.log.filter((x) => x.rel === '/rest/v1/rpc/get_doc_mode').length;
    await setCompany(O, 'B5-ordinaire'); await sleep(2500);
    rec('B5', 'compte ORDINAIRE sur le build de préproduction : ancien stockage (le serveur répond legacy : compte non listé testeur), écriture user_data normale', 'legacy / serveur, get_doc_mode appelé, écriture acceptée', `${jstr(mo)} ; appels get_doc_mode ${askedMode} ; base ${(await company(oUid)).n}`, mo.mode === 'legacy' && mo.reason === 'serveur' && askedMode >= 1 && (await company(oUid)).n === 'B5-ordinaire', { fatal: true });

    // =================================================================== U : NOUVEAU STOCKAGE (compte f, basculé)
    const F = await newDev('F'); await login(F, 'f'); const fUid = await uidOf('f');
    const mf = await F.E(() => ({ mode: DocStoreGlue.mode, reason: DocStoreGlue.store && DocStoreGlue.store.status().reason }));
    rec('U0', 'compte basculé, build de préproduction : mode documents décidé par le serveur', 'documents / serveur', jstr(mf), mf.mode === 'documents' && mf.reason === 'serveur', { proof: 'get_doc_mode : ' + F.log.filter((x) => x.rel === '/rest/v1/rpc/get_doc_mode').map((x) => x.status + ' ' + x.body).join(' | '), fatal: true });
    await F.E(() => { Storage.set('clients', [{ id: 'c1', name: 'Client Validation', ice: '001122334455667', address: 'Rabat' }]); });
    const quiet = async (dv) => until(async () => { const st = await dv.E(() => DocStoreGlue.store.status()); return !st.pending && !st.flushing && st; }, 30000);
    const draft = (dv, desc, price) => dv.E(async ([desc, price]) => { newInvoice(); document.getElementById('editorClient').value = 'c1'; const r = document.querySelector('#itemsBody tr'); r.querySelector('.item-desc').value = desc; r.querySelector('.item-qty').value = '1'; r.querySelector('.item-price').value = String(price); updateTotals(); await saveInvoice('draft'); return Storage.get('invoices', []).slice(-1)[0]; }, [desc, price]);
    const dA = await draft(F, 'U1 brouillon réel', 25); await quiet(F);
    const rowA = await q1("SELECT version, status FROM public.documents WHERE user_id=$1::uuid AND id=$2", [fUid, dA.id]);
    const udInv = await q1("SELECT count(*)::int n FROM public.user_data WHERE user_id=$1::uuid AND key IN ('invoices','quotes','payments','docLog')", [fUid]);
    rec('U1', 'création d\'un brouillon dans l\'interface : ligne documents (version 1) ; aucune écriture user_data pour les 4 clés', 'documents v1, user_data 0', `documents ${jstr(rowA)} ; user_data ${udInv.n}`, !!rowA && rowA.version === 1 && udInv.n === 0, { proof: 'RPC upsert_document : ' + F.log.filter((x) => /upsert_document/.test(x.rel)).map((x) => x.status).join(','), fatal: true });
    await F.p.goto(BASE + '/app.html'); await F.p.waitForTimeout(3500);
    const gets = F.log.filter((x) => x.m === 'GET' && x.rel === '/rest/v1/documents').map((x) => x.status);
    const shown = await F.E((id) => Storage.get('invoices', []).some((i) => i.id === id), dA.id);
    rec('U2', 'rechargement : le brouillon est relu depuis PostgREST (GET documents) et affiché', 'GET 200, facture présente', `GET ${gets.join(',')} ; présente ${shown}`, gets.length >= 1 && gets.every((s) => s === 200) && shown, { fatal: true });
    await offline(F, true); await sleep(400);
    const dB = await draft(F, 'U3 hors ligne', 35); await sleep(800);
    const stB = await F.E(() => ({ s: DocStoreGlue.store.status(), q: JSON.parse(localStorage.getItem('fpd_q_' + Storage._currentUserId) || '[]').length }));
    const dbB0 = await q1("SELECT 1 x FROM public.documents WHERE user_id=$1::uuid AND id=$2", [fUid, dB.id]);
    rec('U3a', 'hors ligne : brouillon conservé en file persistée, non envoyé', 'pending 1, file persistée 1, absent en base', `pending ${stB.s.pending}, persistée ${stB.q}, base ${dbB0 ? 'présent' : 'absent'}`, stB.s.pending === 1 && stB.q === 1 && !dbB0, { nature: NETB, fatal: true });
    await offline(F, false);
    const sentB = await until(async () => (await q1("SELECT 1 x FROM public.documents WHERE user_id=$1::uuid AND id=$2", [fUid, dB.id])), 30000);
    const stB2 = await quiet(F);
    rec('U3b', 'reconnexion : brouillon envoyé (une fois), file vide', 'présent en base, pending 0', `base ${sentB ? 'présent' : 'absent'}, pending ${stB2 && stB2.pending}`, !!sentB && !!stB2 && stB2.pending === 0, { nature: NETB, fatal: true });
    // refus RÉEL de l'ancien chemin (simule une ancienne version / un autre onglet) par le vrai serveur
    const iR = F.log.length;
    await F.E(async () => { await Storage._syncToCloud('invoices', [{ id: 'ancien', type: 'invoice', status: 'draft' }]); }); await sleep(2000);
    const rr = post(since(F, iR)), st4 = await F.E(() => ({ refused: DocStoreGlue.refused, banner: (document.getElementById('docstoreBanner') || {}).textContent || '', archive: !!localStorage.getItem('fp_refused_' + Storage._currentUserId + '_invoices'), licenceScreen: !document.getElementById('licenseScreen') || document.getElementById('licenseScreen').classList.contains('hidden') }));
    rec('U4a', 'ancien chemin sur un compte basculé : refus explicite du serveur (42501 + MODE_NOUVEAU_STOCKAGE), distinct d\'une licence', 'POST refusé, refused=nouveau, bandeau MODE_NOUVEAU_STOCKAGE, écran de licence non affiché', `POST ${rr.map((x) => x.status + ' ' + clip(x.body, 120)).join(' | ')} ; ${jstr({ refused: st4.refused, archive: st4.archive, licenceScreenCache: st4.licenceScreen })} ; bandeau ${clip(st4.banner, 80)}`, rr.length === 1 && rr[0].status >= 400 && /MODE_NOUVEAU_STOCKAGE/.test(rr[0].body) && st4.refused === 'nouveau' && /MODE_NOUVEAU_STOCKAGE/.test(st4.banner) && st4.licenceScreen, { sqlstate: (rr[0] && (/"code":"([^"]+)"/.exec(rr[0].body) || [])[1]) || '', proof: clip(rr[0] && rr[0].body, 220), fatal: true });
    rec('U4b', 'la valeur refusée est conservée localement (copie de récupération), non perdue', 'archive présente', String(st4.archive), st4.archive);
    const nBefore = post(F.log).length; await F.E(() => { Storage.set('invoices', Storage.get('invoices', [])); Storage.set('quotes', []); }); await sleep(1500);
    rec('U4c', 'ensuite : plus aucune écriture ancien format vers le serveur (pas de boucle)', 'aucun nouvel appel', `${post(F.log).length - nBefore} nouvel(s) appel(s)`, post(F.log).length === nBefore, { fatal: true });
    const dupl = await q1("SELECT count(*)::int n FROM public.documents WHERE user_id=$1::uuid", [fUid]);
    rec('U4d', 'documents du compte : exactement ceux créés (2), aucun doublon', '2', String(dupl.n), dupl.n === 2, { fatal: true });
    rec('B-js', 'aucune erreur JavaScript non gérée dans les pages testées', '0', errors.length ? errors.slice(0, 4).join(' | ') : '0', errors.length === 0);
  } finally {
    try { await browser.close(); } catch {}
    server.close();
  }
};
