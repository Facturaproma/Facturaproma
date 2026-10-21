#!/usr/bin/env node
// Vérifications automatiques contre un VRAI projet Supabase de PRÉPRODUCTION (API REST publique, sans clé secrète).
// Variables d'environnement requises (jamais à communiquer dans un chat) :
//   PREPROD_URL, PREPROD_ANON_KEY, TEST_A_EMAIL, TEST_A_PASSWORD, TEST_B_EMAIL, TEST_B_PASSWORD
// Prérequis : deux comptes de TEST déjà créés et confirmés dans la préproduction (essai actif).
// EFFETS DE BORD (tous limités aux 2 comptes de TEST « …@facturapro-test.invalid », vérifié au démarrage) :
//   - consomme ~25 numéros de facture du compte A et 1 du compte B (compteurs de test) ;
//   - écrit 1 facture émise fictive (verrouillée) dans user_data du compte A + lignes du journal doc_events ;
//   - tentatives d'écriture/suppression qui DOIVENT être refusées (si l'une réussissait, elle ne toucherait que ces comptes de test) ;
//   - aucune suppression de compte, aucune lecture/écriture d'un autre utilisateur ; aucun appel d'administration réussi attendu.
// Nettoyage : `node scripts/preprod-apply.js cleanup` (supprime uniquement ces 2 comptes et leurs données en cascade).
// Les factures de test émises sont verrouillées : supprimez ensuite les comptes de test (Dashboard > Authentication > Users ;
// la suppression du compte efface ses données). REFUSE de s'exécuter contre la production.
const need = ['PREPROD_URL', 'PREPROD_ANON_KEY', 'TEST_A_EMAIL', 'TEST_A_PASSWORD', 'TEST_B_EMAIL', 'TEST_B_PASSWORD'];
const miss = need.filter(k => !process.env[k]); if (miss.length) { console.error('Variables manquantes : ' + miss.join(', ')); process.exit(1); }
const { guard } = require('../../scripts/preprod-guard');
const G = guard(process.env.PREPROD_URL, process.env.PREPROD_ANON_KEY);
const URL_ = G.url, ANON = G.key;
const TEST_DOMAIN = '@facturapro-test.invalid';
for (const k of ['TEST_A_EMAIL', 'TEST_B_EMAIL']) if (!process.env[k].toLowerCase().endsWith(TEST_DOMAIN)) { console.error(`REFUS : ${k} doit se terminer par ${TEST_DOMAIN} (comptes de test uniquement).`); process.exit(1); }
if (process.env.TEST_A_EMAIL === process.env.TEST_B_EMAIL) { console.error('REFUS : les comptes A et B doivent être différents.'); process.exit(1); }
const res = []; const ck = (n, ok, x = '') => { res.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || !x ? '' : '  -> ' + x)); };
const H = (tok) => ({ apikey: ANON, 'content-type': 'application/json', authorization: 'Bearer ' + (tok || ANON) });
async function req(method, p, tok, body, extra = {}) {
  const r = await fetch(URL_ + p, { method, headers: { ...H(tok), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; const t = await r.text(); try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j };
}
const login = async (e, p) => { const r = await req('POST', '/auth/v1/token?grant_type=password', null, { email: e, password: p }); return (r.status === 200 && r.body.user.email.toLowerCase().endsWith(TEST_DOMAIN)) ? { tok: r.body.access_token, id: r.body.user.id } : null; };
const num = (tok, type = 'invoice') => req('POST', '/rest/v1/rpc/next_doc_number', tok, { p_type: type, p_floor: 0 });
(async () => {
  const A = await login(process.env.TEST_A_EMAIL, process.env.TEST_A_PASSWORD), B = await login(process.env.TEST_B_EMAIL, process.env.TEST_B_PASSWORD);
  ck('connexion réelle des comptes A et B (Supabase Auth)', !!A && !!B); if (!A || !B) process.exit(1);
  // comme l'application à la connexion : crée l'essai (my_license) côté serveur
  const la = await req('POST', '/rest/v1/rpc/my_license', A.tok, {}), lb = await req('POST', '/rest/v1/rpc/my_license', B.tok, {});
  ck('my_license() crée l\'essai des deux comptes de test', la.status === 200 && lb.status === 200 && la.body && la.body.ok === true && lb.body && lb.body.ok === true, JSON.stringify([la.status, la.body]).slice(0, 160));
  const bad = await req('POST', '/auth/v1/token?grant_type=password', null, { email: process.env.TEST_A_EMAIL, password: 'mauvais-mot-de-passe-xyz' });
  ck('mauvais mot de passe refusé', bad.status >= 400 && bad.status < 500, String(bad.status));
  const anon = await req('POST', '/rest/v1/rpc/next_doc_number', null, { p_type: 'invoice', p_floor: 0 });
  ck('numérotation refusée sans connexion (rôle anon)', anon.status >= 400, JSON.stringify(anon.body).slice(0, 120));
  const anonRead = await req('GET', '/rest/v1/user_data?select=key&limit=5', null);
  ck('lecture de user_data sans connexion : aucune ligne', anonRead.status >= 400 || (Array.isArray(anonRead.body) && anonRead.body.length === 0));
  // numérotation
  const n1 = await num(A.tok), n2 = await num(A.tok);
  ck('SQL 14 appliqué : next_doc_number répond (200)', n1.status === 200, JSON.stringify(n1.body).slice(0, 160));
  const v1 = Number(n1.body), v2 = Number(n2.body);
  ck('deux appels consécutifs = numéros consécutifs', v2 === v1 + 1, `${v1},${v2}`);
  const par = await Promise.all(Array.from({ length: 20 }, () => num(A.tok)));
  const vals = par.map(p => p.body);
  ck('20 émissions simultanées : 20 numéros distincts', par.every(p => p.status === 200) && new Set(vals).size === 20, JSON.stringify(vals).slice(0, 120));
  const nb = await num(B.tok);
  ck('compteur du compte B indépendant de celui de A', nb.status === 200 && Number(nb.body) < v1 + 22, JSON.stringify(nb.body));
  // écritures directes interdites sur compteurs / journal
  const dc = await req('POST', '/rest/v1/doc_counters', A.tok, { user_id: A.id, doc_type: 'invoice', last_value: 0 });
  ck('écriture directe dans doc_counters refusée', dc.status >= 400, String(dc.status));
  const de = await req('POST', '/rest/v1/doc_events', A.tok, { user_id: A.id, action: 'x', detail: {} });
  ck('écriture directe dans doc_events (journal) refusée', de.status >= 400, String(de.status));
  // isolation
  const year = new Date().getFullYear();
  const number = `FAC-${year}-${String(Number((await num(A.tok)).body)).padStart(3, '0')}`;
  const inv = { id: 'pp-' + Date.now(), number, type: 'invoice', status: 'sent', date: new Date().toISOString().slice(0, 10), clientId: 'c', clientName: 'Client test', items: [], totalHT: 100, totalTVA: 20, totalTTC: 120 };
  const up = (tok, uid, value) => req('POST', '/rest/v1/user_data?on_conflict=user_id,key', tok, { user_id: uid, key: 'invoices', value }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
  const w = await up(A.tok, A.id, [inv]);
  ck('A peut enregistrer une facture émise avec un numéro attribué par le serveur', w.status < 300, JSON.stringify(w.body).slice(0, 200));
  const peek = await req('GET', `/rest/v1/user_data?select=key,value&user_id=eq.${A.id}`, B.tok);
  ck('isolation : B ne voit aucune donnée de A', peek.status === 200 && Array.isArray(peek.body) && peek.body.length === 0, JSON.stringify(peek.body).slice(0, 100));
  const evil = await up(B.tok, A.id, [{ ...inv, totalTTC: 1 }]);
  ck('isolation : B ne peut pas écrire dans le compte de A', evil.status >= 400, String(evil.status));
  // verrouillage
  const mod = await up(A.tok, A.id, [{ ...inv, totalTTC: 1 }]);
  ck('verrouillage : modification du montant d\'une facture émise refusée', mod.status >= 400 && /FACTURE_VERROUILLEE/.test(JSON.stringify(mod.body)), JSON.stringify(mod.body).slice(0, 160));
  const del = await up(A.tok, A.id, []);
  ck('verrouillage : suppression d\'une facture émise refusée', del.status >= 400 && /FACTURE_VERROUILLEE/.test(JSON.stringify(del.body)));
  const delAll = await req('DELETE', `/rest/v1/user_data?user_id=eq.${A.id}&key=eq.invoices`, A.tok);
  ck('verrouillage : effacement de la ligne des factures refusé', delAll.status >= 400, String(delAll.status));
  const fake = await up(A.tok, A.id, [inv, { ...inv, id: 'pp-fake', number: `FAC-${year}-9999` }]);
  ck('numéro inventé (non attribué par le serveur) refusé', fake.status >= 400 && /NUMERO_NON_ATTRIBUE/.test(JSON.stringify(fake.body)), JSON.stringify(fake.body).slice(0, 160));
  const still = await req('GET', `/rest/v1/user_data?select=value&user_id=eq.${A.id}&key=eq.invoices`, A.tok);
  ck('la facture émise est intacte après les tentatives', still.status === 200 && still.body[0] && still.body[0].value[0].totalTTC === 120);
  const ev = await req('GET', `/rest/v1/doc_events?select=action,number&user_id=eq.${A.id}`, A.tok);
  ck('journal serveur : l\'émission est tracée', ev.status === 200 && ev.body.some(e => e.action === 'emission' && e.number === number), JSON.stringify(ev.body).slice(0, 120));
  const lic = await req('POST', '/rest/v1/rpc/admin_list_accounts', A.tok, {});
  ck('compte non administrateur : admin_list_accounts refusé', lic.status >= 400, String(lic.status));
  const fails = res.filter(x => !x).length; console.log(`\n${res.length - fails}/${res.length} vérifications de préproduction réussies`); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('ERREUR', e.message); process.exit(2); });
