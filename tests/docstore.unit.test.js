// Tests unitaires de docstore.js : logique PURE + faux client en mémoire. SIMULATION locale : aucun réseau, aucune base, aucun Supabase.
const DS = require('../docstore.js');
const res = []; const ck = (n, ok, x = '') => { res.push(!!ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || !x ? '' : ' -> ' + String(x).slice(0, 300))); };
const PRE = 'https://njjaomichdlnoscrnxlz.supabase.co', PROD = 'https://mdozjptoecygmpkjlohr.supabase.co';
const mem = () => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; }, m }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const idle = async (st) => { for (let i = 0; i < 200 && st.status().flushing; i++) await sleep(2); };
const flushAll = async (st) => { await sleep(3); await idle(st); await st.flush(); await idle(st); await sleep(3); };

// faux serveur programmable : répond à chaque rpc selon un script, enregistre les appels
function fakeClient(script = {}) {
  const calls = [];
  return {
    calls, script,
    async rpc(fn, args) {
      calls.push({ fn, args: JSON.parse(JSON.stringify(args || {})) });
      const s = script[fn]; const r = typeof s === 'function' ? s(args, calls.length) : s;
      return r || { data: { ok: true, version: 1 }, error: null };
    },
    from(table) { const st = { table, filters: {} }; const b = { select() { return b; }, eq() { return b; }, order() { return b; }, range() { return b; },
      then(res, rej) { return Promise.resolve((script.__tables || {})[table] || { data: [], error: null }).then(res, rej); } }; return b; }
  };
}
const mk = (over = {}) => {
  const storage = over.storage || mem(); const client = over.client || fakeClient({ get_doc_mode: { data: 'documents', error: null } });
  const notes = []; let n = 0; const timers = [];
  const st = DS.createStore({ client, userId: 'u1', email: over.email || 'a@facturapro-test.invalid', url: over.url || PRE, storage, uuid: () => 'id' + (++n),
    notify: (l, m) => notes.push([l, m]), timers: { set: (f, ms) => { const t = { f, ms }; timers.push(t); return t; }, clear: () => {} }, isOnline: () => !over.offline, onChange: () => {}, onReload: over.onReload });
  return { st, client, storage, notes, timers };
};

(async () => {
  // ---------- verrous de build / compte / serveur ----------
  ck('build : URL de préproduction acceptée', DS.buildAllowsDocuments(PRE));
  ck('build : URL de PRODUCTION refusée', !DS.buildAllowsDocuments(PROD));
  ck('build : URL inconnue, vide ou factice refusée', !DS.buildAllowsDocuments('https://fake.supabase.test') && !DS.buildAllowsDocuments('') && !DS.buildAllowsDocuments(PRE + '.evil.com'));
  ck('compte : seuls les e-mails @facturapro-test.invalid sont admis', DS.isTestEmail('x@facturapro-test.invalid') && !DS.isTestEmail('x@gmail.com') && !DS.isTestEmail('x@facturapro-test.invalid.com') && !DS.isTestEmail('x@facturapro-ordinary.invalid'));
  { const t = mk({ url: PROD }); const m = await t.st.detect(); ck('build de production : mode legacy, get_doc_mode JAMAIS appelé', m === 'legacy' && t.client.calls.length === 0); }
  { const t = mk({ email: 'x@gmail.com' }); const m = await t.st.detect(); ck('compte ordinaire : mode legacy, get_doc_mode JAMAIS appelé', m === 'legacy' && t.client.calls.length === 0); }
  { const t = mk({ client: fakeClient({ get_doc_mode: { data: 'legacy', error: null } }) }); t.storage.setItem('fpd_hint_u1', 'documents');
    const m = await t.st.detect(); ck('indicateur local « documents » + serveur « legacy » → legacy (le local ne peut pas autoriser)', m === 'legacy' && t.storage.getItem('fpd_hint_u1') === null); }
  { const t = mk({ client: fakeClient({ get_doc_mode: { data: null, error: { message: 'TypeError: Failed to fetch' } } }) });
    const m = await t.st.detect(); ck('mode inconnu (réseau) sans indicateur → legacy ; avec indicateur → BLOQUÉ (lecture seule)', m === 'legacy' && t.st.status().reason === 'mode_inconnu');
    t.storage.setItem('fpd_hint_u1', 'documents'); const m2 = await t.st.detect(); ck('  … avec indicateur « documents » → bloqué (restreint, n\'autorise jamais)', m2 === 'blocked'); }
  { const t = mk({ client: fakeClient({ get_doc_mode: { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.get_doc_mode' } } }) });
    ck('sql/17 absent (fonction introuvable) → legacy', (await t.st.detect()) === 'legacy' && t.st.status().reason === 'sql17_absent'); }
  { const t = mk({ client: fakeClient({ get_doc_mode: { data: 'bizarre', error: null } }) }); ck('réponse de mode inattendue → bloqué', (await t.st.detect()) === 'blocked'); }
  { const t = mk({ client: fakeClient({ get_doc_mode: { data: null, error: { code: '42501', message: 'permission denied' } } }) }); ck('erreur de mode non réseau → bloqué (pas de repli silencieux)', (await t.st.detect()) === 'blocked'); }

  // ---------- diff ----------
  const snapOf = (docs) => new Map(docs.map((d) => [d.id, { canon: DS.canon(d), doc: JSON.parse(JSON.stringify(d)) }]));
  const inv = (id, over2 = {}) => ({ id, type: 'invoice', number: 'BRO-' + id, status: 'draft', totalTTC: 10, ...over2 });
  { const s = snapOf([inv('a'), inv('b')]); const ops = DS.diffDocs('invoices', s, [inv('a', { totalTTC: 12 }), inv('c')]);
    ck('diff : modification (a), création (c), suppression (b)', ops.length === 3 && ops.find((o) => o.id === 'a').kind === 'upsert' && ops.find((o) => o.id === 'a').expected === null && ops.find((o) => o.id === 'c').expected === 0 && ops.find((o) => o.id === 'b').kind === 'delete'); }
  { const s = snapOf([inv('a', { status: 'sent', number: 'FAC-1', totalTTC: 100 })]);
    ck('diff : mise à jour du règlement seul sur facture émise → aucune opération (le serveur fait foi)', DS.diffDocs('invoices', s, [inv('a', { status: 'paid', number: 'FAC-1', totalTTC: 100, paidAmount: 100, paidAt: '2026-01-01' })]).length === 0);
    ck('diff : autre modification d\'une facture émise → opération envoyée (le serveur la refusera : FACTURE_VERROUILLEE)', DS.diffDocs('invoices', s, [inv('a', { status: 'sent', number: 'FAC-1', totalTTC: 999 })]).length === 1); }
  { const ops = DS.diffDocs('quotes', new Map(), [{ id: 'q1', type: 'quote', status: 'draft' }, { id: 'q2' }]); ck('diff : devis → type « quote » ; un avoir garde « credit »', ops.every((o) => o.type === 'quote') && DS.diffDocs('invoices', new Map(), [{ id: 'c1', type: 'credit', status: 'sent' }])[0].type === 'credit'); }

  // ---------- démarrage, chargement ----------
  const tables = { documents: { data: [{ doc_type: 'invoice', id: 'i1', version: 3, body: inv('i1', { status: 'sent', number: 'FAC-1' }) }, { doc_type: 'quote', id: 'q1', version: 1, body: { id: 'q1', type: 'quote', status: 'draft' } }], error: null },
    doc_payments: { data: [{ id: 'p1', body: { id: 'p1', invoiceId: 'i1', amount: 5 } }], error: null }, doc_history: { data: [{ seq: 2, ts: '2026-01-02T00:00:00Z', body: { action: 'b' } }, { seq: 1, ts: '2026-01-01T00:00:00Z', body: { action: 'a' } }], error: null } };
  const withTables = (script = {}) => fakeClient({ get_doc_mode: { data: 'documents', error: null }, __tables: tables, ...script });
  { const t = mk({ client: withTables() }); const r = await t.st.start();
    ck('start : factures/avoirs, devis, paiements, journal (trié) et versions chargés depuis le serveur', r.mode === 'documents' && r.state.invoices.length === 1 && r.state.quotes.length === 1 && r.state.payments.length === 1 && r.state.docLog[0].action === 'a' && t.st.versions['invoice:i1'] === 3); }

  { const t = mk({ client: fakeClient({ get_doc_mode: { data: 'documents', error: null }, __tables: { documents: { data: [], error: null }, doc_payments: { data: [], error: null }, doc_history: { data: [{ seq: 3, ts: null, body: { a: 3 } }, { seq: 2, ts: new Date('2026-01-02'), body: { a: 2 } }, { seq: 1, ts: '2026-01-01T00:00:00Z', body: { a: 1 } }], error: null } } }) }); const r = await t.st.start();
    ck('journal : tri robuste (ISO, Date, absent) sans exception', r.state.docLog.map((e) => e.a).join() === '3,1,2'); }
  // ---------- écritures : création, modification, suppression, numéros, rejeu ----------
  { const t = mk({ client: withTables({ upsert_document: (a) => ({ data: { ok: true, version: a.p_expected_version + 1 }, error: null }) }) }); const r = await t.st.start();
    const list = r.state.invoices; list.push(inv('n1')); t.st.commit('invoices', list); await flushAll(t.st);
    const c = t.client.calls.filter((x) => x.fn === 'upsert_document');
    ck('création : upsert_document(expected 0, op_id fourni, type renseigné), file vidée', c.length === 1 && c[0].args.p_expected_version === 0 && /^u:n1:/.test(c[0].args.p_op_id) && c[0].args.p_doc.type === 'invoice' && t.st.queue.length === 0 && t.st.versions['invoice:n1'] === 1);
    list[list.length - 1] = inv('n1', { totalTTC: 77 }); t.st.commit('invoices', list); await flushAll(t.st);
    const c2 = t.client.calls.filter((x) => x.fn === 'upsert_document')[1];
    ck('modification : expected = version serveur connue (1), nouvel op_id', c2.args.p_expected_version === 1 && c2.args.p_op_id !== c[0].args.p_op_id && t.st.versions['invoice:n1'] === 2);
    t.st.commit('invoices', list.filter((d) => d.id !== 'n1')); await flushAll(t.st);
    const d = t.client.calls.find((x) => x.fn === 'delete_document');
    ck('suppression d\'un brouillon : delete_document(expected = version connue)', d && d.args.p_id === 'n1' && d.args.p_expected_version === 2 && t.st.queue.length === 0); }
  { const t = mk({ client: withTables(), offline: true }); const r = await t.st.start(); const base = r.state.invoices.slice();
    t.st.commit('invoices', [...base, inv('z1')]); t.st.commit('invoices', [...base, inv('z1', { totalTTC: 50 })]);
    ck('hors ligne : 2 modifications du même brouillon créé → UNE seule opération en file (fusion), rien envoyé', t.st.queue.length === 1 && t.st.queue[0].doc.totalTTC === 50 && t.client.calls.filter((x) => x.fn === 'upsert_document').length === 0);
    ck('hors ligne : la file est persistée (reprise après rechargement)', JSON.parse(t.storage.getItem('fpd_q_u1')).length === 1);
    t.st.commit('invoices', base); ck('créé puis supprimé avant tout envoi → file vide, aucun appel', t.st.queue.length === 0 && t.client.calls.filter((x) => x.fn !== 'get_doc_mode').length === 0); }
  { const storage = mem(); const t1 = mk({ client: withTables(), offline: true, storage }); const r1 = await t1.st.start(); const base = r1.state.invoices.slice();
    t1.st.commit('invoices', [...base, inv('r1')]);
    // le cache local est écrit par la glue de l'application (Storage.set) : on le reproduit ici
    storage.setItem('fpd_u1_invoices', JSON.stringify([...base, inv('r1')])); storage.setItem('fpd_u1_quotes', JSON.stringify(r1.state.quotes)); storage.setItem('fpd_u1_payments', '[]'); storage.setItem('fpd_u1_docLog', '[]');
    const t2 = mk({ client: withTables({ upsert_document: { data: { ok: true, version: 1 }, error: null } }), storage }); const r = await t2.st.start();
    ck('reprise : la file persistée est rechargée ; l\'état local (cache) fait foi tant qu\'elle n\'est pas passée', t2.st.queue.length === 1 && r.state.invoices.some((d) => d.id === 'r1'));
    await t2.st.flush(); await idle(t2.st); ck('reprise : la file est envoyée au retour en ligne puis vidée', t2.st.queue.length === 0 && t2.client.calls.some((x) => x.fn === 'upsert_document')); }

  // ---------- paiements ----------
  { const t = mk({ client: withTables({ record_payment: { data: { ok: true, version: 4, paid_amount: 15 }, error: null } }) }); const r = await t.st.start();
    const pays = r.state.payments; pays.push({ id: 'p2', invoiceId: 'i1', amount: 10, date: '2026-02-01' }); t.st.commit('payments', pays);
    const invs = r.state.invoices; invs[0] = { ...invs[0], paidAmount: 15, status: 'paid', paidAt: '2026-02-01' }; t.st.commit('invoices', invs); await flushAll(t.st);
    const rp = t.client.calls.filter((x) => x.fn === 'record_payment'), up = t.client.calls.filter((x) => x.fn === 'upsert_document');
    ck('paiement : record_payment(p_op_id stable) ; la mise à jour dérivée de la facture n\'est PAS renvoyée (pas de double écriture)', rp.length === 1 && rp[0].args.p_invoice_id === 'i1' && up.length === 0 && t.st.versions['invoice:i1'] === 4);
    t.st.commit('payments', pays); await flushAll(t.st); ck('même état de paiements re-validé : aucun nouvel envoi (pas de doublon)', t.client.calls.filter((x) => x.fn === 'record_payment').length === 1);
    t.st.commit('payments', []); ck('suppression d\'un paiement : signalée (non prise en charge), jamais silencieuse', t.notes.some((n) => /PAIEMENT_NON_SUPPORTE/.test(n[1]))); }

  // ---------- journal ----------
  { const t = mk({ client: withTables({ append_history: { data: { ok: true, added: 1 }, error: null } }) }); const r = await t.st.start();
    const log = r.state.docLog; log.push({ ts: 'x', action: 'emission', docId: 'i1' }); log.push({ ts: 'x', action: 'emission', docId: 'i1' }); t.st.commit('docLog', log); await flushAll(t.st);
    const h = t.client.calls.filter((x) => x.fn === 'append_history');
    ck('journal : seules les NOUVELLES entrées sont envoyées (2 identiques → 2 identifiants distincts), anciennes non renvoyées', h.length === 1 && h[0].args.p_entries.length === 2 && h[0].args.p_entries[0].id !== h[0].args.p_entries[1].id && log.slice(0, 2).every((e) => !('id' in e) || e.action !== 'a'));
    t.st.commit('docLog', log); await flushAll(t.st); ck('journal : même état re-validé → aucun renvoi', t.client.calls.filter((x) => x.fn === 'append_history').length === 1);
    const log2 = log.slice(1); t.st.commit('docLog', log2); await flushAll(t.st); ck('journal tronqué (plafond 2000) → aucun envoi ni suppression', t.client.calls.filter((x) => x.fn === 'append_history').length === 1); }

  // ---------- erreurs : réseau (3 essais max), fonctionnelles, modes ----------
  { let fail = true; const t = mk({ client: withTables({ upsert_document: () => fail ? { data: null, error: { message: 'TypeError: Failed to fetch' } } : { data: { ok: true, version: 1 }, error: null } }) }); const r0 = await t.st.start(); const b0 = r0.state.invoices.slice();
    t.st.commit('invoices', [...b0, inv('w1')]); await sleep(10); await idle(t.st);   // un seul envoi déclenché par l'action ; pas d'appel manuel supplémentaire
    const calls1 = t.client.calls.filter((x) => x.fn === 'upsert_document').length;
    ck('erreur réseau : l\'opération reste en file, un essai programmé (2 s)', t.st.queue.length === 1 && t.timers.length === 1 && t.timers[0].ms === 2000);
    for (let i = 0; i < 6; i++) { const tm = t.timers.shift(); if (!tm) break; await tm.f(); await sleep(5); }
    const calls = t.client.calls.filter((x) => x.fn === 'upsert_document').length;
    ck('erreur réseau persistante : 1 + 3 essais automatiques AU PLUS (2 s, 8 s, 30 s), puis plus rien sans événement', calls === 4 && t.st.queue.length === 1 && t.timers.length === 0, calls + ' appels');
    fail = false; t.st.flushSoon(); await sleep(20); ck('nouvel événement (retour en ligne / action) : la file repart et se vide', t.st.queue.length === 0); }
  { const t = mk({ client: withTables({ upsert_document: { data: null, error: { code: 'P0001', message: 'FACTURE_VERROUILLEE: modification interdite (FAC-1 / totalTTC)' } } }) }); const r0 = await t.st.start(); const b0 = r0.state.invoices.slice();
    t.st.commit('invoices', [...b0, inv('v1')]); await flushAll(t.st);
    ck('erreur fonctionnelle (FACTURE_VERROUILLEE) : signalée, retirée de la file, JAMAIS rejouée', t.st.queue.length === 0 && t.client.calls.filter((x) => x.fn === 'upsert_document').length === 1 && t.notes.some((n) => /FACTURE_VERROUILLEE/.test(n[1]))); }
  { const t = mk({ client: withTables({ upsert_document: { data: null, error: { code: 'P0001', message: 'MODE_ANCIEN_STOCKAGE: ce compte n\'est pas en mode nouveau stockage', hint: 'MODE_ANCIEN_STOCKAGE' } } }) }); const r0 = await t.st.start(); const b0 = r0.state.invoices.slice();
    t.st.commit('invoices', [...b0, inv('m1')]); await flushAll(t.st); const before = t.client.calls.length; t.st.commit('invoices', [...b0, inv('m1'), inv('m2')]); await flushAll(t.st); t.st.flushSoon(); await sleep(20);
    ck('MODE_ANCIEN_STOCKAGE : arrêt net, message explicite, file CONSERVÉE (rien perdu), aucune nouvelle tentative', t.st.status().halted === 'mode_ancien' && t.st.queue.length >= 1 && t.client.calls.length === before && t.notes.some((n) => /MODE_ANCIEN_STOCKAGE/.test(n[1])));
    const q = JSON.parse(t.storage.getItem('fpd_q_u1')); ck('  … et persistée pour un rechargement ultérieur', q.length >= 1); }
  { const t = mk({ client: withTables({ upsert_document: { data: null, error: { code: '42501', message: 'new row violates row-level security policy' } } }) }); const r0 = await t.st.start(); const b0 = r0.state.invoices.slice();
    t.st.commit('invoices', [...b0, inv('d1')]); await flushAll(t.st); t.st.flushSoon(); await sleep(20);
    ck('42501 (refus de droits/licence) : arrêt, UN seul appel, message, file conservée, pas de boucle', t.st.status().halted === 'refuse' && t.client.calls.filter((x) => x.fn === 'upsert_document').length === 1 && t.st.queue.length === 1); }
  ck('classification : 42501+MODE_NOUVEAU_STOCKAGE ≠ licence', DS.classify({ code: '42501', message: 'MODE_NOUVEAU_STOCKAGE: x' }) === 'mode_nouveau' && DS.classify({ code: '42501', message: 'rls' }) === 'refuse');

  // ---------- conflits ----------
  { const t = mk({ client: withTables({ upsert_document: { data: { ok: false, conflict: true, server_version: 7, server_doc: inv('c1', { clientName: 'SERVEUR' }) }, error: null } }) }); const r = await t.st.start(); const b0 = r.state.invoices.slice();
    t.st.commit('invoices', [...b0, inv('c1', { clientName: 'MOI' })]); await flushAll(t.st);
    ck('conflit : opération retirée, conflit enregistré avec les 2 versions, rien écrasé, bandeau possible', t.st.queue.length === 0 && t.st.conflicts.length === 1 && t.st.conflicts[0].mine.clientName === 'MOI' && t.st.conflicts[0].server_doc.clientName === 'SERVEUR' && t.st.conflicts[0].server_version === 7);
    ck('conflit non résolu : reload() refuse d\'écraser l\'état local', (await t.st.reload()) === null);
    t.client.script.upsert_document = { data: { ok: true, version: 8 }, error: null };
    t.st.resolveConflict('c1', 'keep-mine', [inv('c1', { clientName: 'MOI' })]); await flushAll(t.st);
    const last = t.client.calls.filter((x) => x.fn === 'upsert_document').slice(-1)[0];
    ck('« garder ma version » : réappliquée avec expected = version serveur (7), conflit levé', last.args.p_expected_version === 7 && last.args.p_doc.clientName === 'MOI' && t.st.conflicts.length === 0 && t.st.versions['invoice:c1'] === 8); }
  { let applied = null; const t = mk({ client: withTables({ upsert_document: { data: { ok: false, conflict: true, server_version: null, server_doc: null }, error: null } }) }); const r0 = await t.st.start(); const b0 = r0.state.invoices.slice();
    t.st.commit('invoices', [...b0, inv('g1')]); await flushAll(t.st);
    ck('modification d\'un document supprimé ailleurs → conflit « supprimé » (server_doc null)', t.st.conflicts.length === 1 && t.st.conflicts[0].server_doc === null);
    t.st.resolveConflict('g1', 'keep-server', []); ck('  … « abandonner » : conflit levé sans nouvelle opération', t.st.conflicts.length === 0 && t.st.queue.length === 0); }
  { const t = mk({ client: withTables({ delete_document: { data: { ok: false, conflict: true, server_version: 9, server_doc: inv('i2', { clientName: 'modifié ailleurs' }) }, error: null } }) }); const r = await t.st.start();
    const l = r.state.invoices.concat([inv('i2')]); t.st.commit('invoices', l); await flushAll(t.st); t.st.commit('invoices', r.state.invoices.filter((d) => d.id !== 'i2')); await flushAll(t.st);
    ck('suppression d\'un brouillon modifié ailleurs → conflit (jamais supprimé), version serveur proposée', t.st.conflicts.some((c) => c.id === 'i2' && c.server_doc && c.server_doc.clientName === 'modifié ailleurs')); }

  // ---------- reload / suppressions distantes ----------
  { let got = null; const t = mk({ client: withTables(), onReload: (s, i) => { got = i; } }); await t.st.start(); tables.documents = { data: [], error: null };
    await t.st.reload(); ck('reload : documents disparus du serveur → signalés (suppression sur un autre appareil)', got && got.removedRemotely.length === 2 && t.notes.some((n) => /supprimé/.test(n[1]))); }

  // ---------- REVUE DE CODE (régressions) ----------
  // R1 : licence inactive côté serveur → l'édition n'est PAS jetée : file conservée, arrêt net, un seul appel, pas de boucle
  { const t = mk({ client: withTables({ upsert_document: { data: null, error: { code: 'P0001', message: 'LICENCE_INACTIVE' } } }) }); const r = await t.st.start();
    t.st.commit('invoices', r.state.invoices.concat([inv('n1')])); await flushAll(t.st); const calls1 = t.client.calls.filter((c) => c.fn === 'upsert_document').length;
    await t.st.flush(); await t.st.flush();
    ck('R1 LICENCE_INACTIVE : modification conservée en file (aucune perte), arrêt net, message dédié (ni réseau ni fonctionnelle)', t.st.status().pending === 1 && t.st.status().halted === 'licence' && /licence/i.test(t.notes.map((n) => n[1]).join(' ')), JSON.stringify(t.st.status()));
    ck('R1  … un seul appel, aucun réessai automatique (ni flush répété, ni minuterie)', calls1 === 1 && t.client.calls.filter((c) => c.fn === 'upsert_document').length === 1 && t.timers.length === 0);
    t.client.script.upsert_document = { data: { ok: true, version: 1 }, error: null }; await t.st.retryNow(); await flushAll(t.st);
    ck('R1  … licence renouvelée + « Réessayer » : la modification est envoyée (rien perdu)', t.st.status().pending === 0 && t.client.calls.filter((c) => c.fn === 'upsert_document').length === 2); }
  // R1b : jeton expiré (401) distingué de la licence : arrêt, file conservée, texte explicite
  { const t = mk({ client: withTables({ upsert_document: { data: null, error: { code: 'PGRST301', message: 'JWT expired' }, status: 401 } }) }); const r = await t.st.start();
    t.st.commit('invoices', r.state.invoices.concat([inv('n1')])); await flushAll(t.st);
    ck('R1b session expirée (401/JWT) : arrêt « authentification », file conservée, distinct de la licence', t.st.status().halted === 'auth' && t.st.status().pending === 1, JSON.stringify(t.st.status())); }
  // R2 : déconnexion (reset) pendant un envoi en cours → la file persistée n'est PAS vidée
  { let release; const gate = new Promise((r) => { release = r; });
    const t = mk({ client: withTables({ upsert_document: () => gate.then(() => ({ data: { ok: true, version: 1 }, error: null })) }) }); const r = await t.st.start();
    t.st.commit('invoices', r.state.invoices.concat([inv('a1')])); await sleep(5);          // a1 : envoi en cours (non terminé)
    t.st.commit('invoices', r.state.invoices.concat([inv('a1'), inv('a2')])); await sleep(2);   // a2 : encore en file
    const before = JSON.parse(t.storage.getItem('fpd_q_u1') || '[]').length;
    t.st.reset(); release(); await sleep(20);
    const after = JSON.parse(t.storage.getItem('fpd_q_u1') || '[]');
    ck('R2 déconnexion pendant un envoi : la file persistée n\'est pas effacée (a2 reste à envoyer)', before === 2 && after.some((o) => o.id === 'a2'), 'avant=' + before + ' après=' + JSON.stringify(after.map((o) => o.id))); }
  // R3 : opération rejetée (erreur fonctionnelle) → archivée localement, récupérable (pas de perte silencieuse)
  { const t = mk({ client: withTables({ upsert_document: { data: null, error: { code: 'P0001', message: 'NUMERO_EN_DOUBLE' } } }) }); const r = await t.st.start();
    t.st.commit('invoices', r.state.invoices.concat([inv('r1', { clientName: 'à ne pas perdre' })])); await flushAll(t.st);
    const arch = JSON.parse(t.storage.getItem('fpd_r_u1') || '[]');
    ck('R3 opération rejetée par le serveur : archivée avec le document et la raison (récupérable)', arch.length === 1 && arch[0].id === 'r1' && arch[0].doc && arch[0].doc.clientName === 'à ne pas perdre' && /NUMERO_EN_DOUBLE/.test(arch[0].reason) && t.st.status().rejected === 1, JSON.stringify(arch).slice(0, 200)); }
  // R4 : retour au mode ancien avec une file locale non vide → signalé (orphelin), jamais rejoué, récupérable
  { const storage = mem(); storage.setItem('fpd_q_u1', JSON.stringify([{ kind: 'upsert', key: 'invoices', type: 'invoice', id: 'o1', doc: inv('o1'), expected: 0, opId: 'u:o1:1' }])); storage.setItem('fpd_c_u1', '[]');
    const t = mk({ storage, client: fakeClient({ get_doc_mode: { data: 'legacy', error: null } }) }); const r = await t.st.start();
    ck('R4 retour au legacy avec file non vide : signalé (orphan), mode legacy, rien rejoué', r.mode === 'legacy' && r.orphan && r.orphan.pending === 1 && t.client.calls.every((c) => c.fn === 'get_doc_mode'), JSON.stringify(r));
    t.st.flushSoon(); await flushAll(t.st);
    ck('R4  … la file reste intacte (récupération manuelle) et aucun envoi n\'a lieu en mode legacy', JSON.parse(storage.getItem('fpd_q_u1')).length === 1 && t.client.calls.every((c) => c.fn === 'get_doc_mode')); }

  // R5 : une modification faite PENDANT une relecture serveur n'est pas écrasée par l'état rechargé (course reload / commit)
  { let release; const gate = new Promise((r) => { release = r; }); let reloaded = null;
    const t = mk({ client: withTables(), onReload: (s) => { reloaded = s; } }); const r = await t.st.start();
    const saved = tables.documents; tables.documents = gate.then(() => saved);
    const p = t.st.reload(); await sleep(5);
    const mine = r.state.invoices.concat([inv('pendant')]); t.st.commit('invoices', mine);   // l'utilisateur crée un brouillon pendant la relecture
    release(); const out = await p; tables.documents = saved; await flushAll(t.st);
    ck('R5 relecture concurrente à une modification : état rechargé NON appliqué (pas d\'écrasement), brouillon envoyé une seule fois', out === null && reloaded === null && t.client.calls.filter((c) => c.fn === 'upsert_document' && c.args.p_doc.id === 'pendant').length === 1, 'out=' + (out && 'état') + ' reloaded=' + !!reloaded);
    t.st.commit('invoices', mine); await flushAll(t.st);
    ck('R5  … l\'instantané reste cohérent : une réécriture identique n\'envoie rien de plus', t.client.calls.filter((c) => c.fn === 'upsert_document' && c.args.p_doc.id === 'pendant').length === 1); }

  const bad = res.filter((x) => !x).length;
  console.log(`\n${res.length - bad}/${res.length} tests de docstore.js réussis (SIMULATION locale : faux client, aucun Supabase)`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
