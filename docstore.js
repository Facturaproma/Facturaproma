/* docstore.js — couche « nouveau stockage » (une ligne par document) de FacturaPro.
 *
 * STATUT : PRÉPARATION, PRÉPRODUCTION UNIQUEMENT. Ce module n'active rien tout seul : le mode « documents » n'est utilisé que si
 *   (1) l'URL Supabase du build est celle de la PRÉPRODUCTION (jamais la production),
 *   (2) l'e-mail du compte est *@facturapro-test.invalid,
 *   (3) le SERVEUR répond « documents » à get_doc_mode() (mode décidé par le serveur, autorisé par la liste doc_store_testers).
 * Un indicateur local (localStorage) ne peut JAMAIS activer le mode documents : il ne sert qu'à restreindre (lecture seule) hors ligne.
 *
 * Une seule source de vérité par compte :
 *   legacy    → user_data (comportement historique, inchangé) ; ce module n'écrit rien.
 *   documents → documents / doc_payments / doc_history via upsert_document, delete_document, record_payment, append_history ;
 *               AUCUNE écriture sur les 4 clés de user_data (le serveur les refuse : MODE_NOUVEAU_STOCKAGE) ; pas de double écriture.
 * Aucune synchronisation silencieuse entre les deux modes. Aucune boucle de réessai : au plus 3 essais automatiques sur erreur réseau,
 * puis attente d'un événement (retour en ligne, nouvelle action, bouton). Erreurs fonctionnelles : jamais réessayées, toujours signalées.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.DocStore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const PREPROD_REF = 'njjaomichdlnoscrnxlz';
  const PROD_REF = 'mdozjptoecygmpkjlohr';
  const TEST_EMAIL_RE = /@facturapro-test\.invalid$/i;
  const KEYS = ['invoices', 'quotes', 'payments', 'docLog'];
  const DERIVED = ['paidAmount', 'status', 'paidAt', 'updatedAt', 'payments'];   // champs que le serveur recalcule à l'enregistrement d'un paiement
  const RETRY_DELAYS = [2000, 8000, 30000];                                     // 3 essais automatiques au maximum, puis plus rien sans événement

  // ---------- fonctions pures (testables sans navigateur) ----------
  const projectRef = (url) => { const m = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/i.exec(String(url || '')); return m ? m[1].toLowerCase() : null; };
  const buildAllowsDocuments = (url) => { const r = projectRef(url); return r === PREPROD_REF && r !== PROD_REF; };
  const isTestEmail = (email) => TEST_EMAIL_RE.test(String(email || ''));
  const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)) ? Object.keys(x).sort().reduce((o, kk) => (o[kk] = x[kk], o), {}) : x);
  const tms = (x) => { const t = x ? new Date(x).getTime() : 0; return Number.isFinite(t) ? t : 0; };   // ISO, Date ou absent
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const docType = (key, d) => key === 'quotes' ? 'quote' : (d && d.type === 'credit' ? 'credit' : 'invoice');
  const dkey = (type, id) => type + ':' + id;
  const isDraft = (d) => !d || (d.status || 'draft') === 'draft';
  const onlyDerivedChange = (a, b) => { const s = (o) => { const c = { ...o }; DERIVED.forEach((f) => delete c[f]); return canon(c); }; return s(a) === s(b); };
  const errText = (e) => String((e && (e.message || e.details || e.hint)) || '') + ' ' + String((e && e.hint) || '');
  const isNetworkError = (e, status) => !!e && (status === 0 || status >= 500 || (!e.code && /fetch|network|timeout|timed out|offline|load failed/i.test(e.message || '')));
  const classify = (e, status) => {
    const t = errText(e);
    if (/MODE_ANCIEN_STOCKAGE/.test(t)) return 'mode_ancien';
    if (/MODE_NOUVEAU_STOCKAGE/.test(t)) return 'mode_nouveau';
    if (e && (e.code === 'PGRST202' || e.code === '42883')) return 'fonction_absente';
    if (/LICENCE_INACTIVE|LICENCE_EXPIREE/.test(t)) return 'licence';                     // licence : l'édition est CONSERVÉE (jamais jetée comme une erreur fonctionnelle)
    if (isNetworkError(e, status)) return 'reseau';
    if (e && (e.code === 'PGRST301' || e.code === '401' || status === 401 || /JWT/i.test(e.message || ''))) return 'auth';   // session expirée / jeton refusé
    if (e && (e.code === '42501' || status === 403)) return 'refuse';
    return 'fonctionnelle';
  };
  const functionalCode = (e) => { const m = /^\s*([A-Z_]{5,})/.exec((e && e.message) || ''); return m ? m[1] : (e && e.code) || 'ERREUR'; };

  // Différence entre l'état déjà transmis (instantané) et l'état courant d'une clé → liste d'opérations. Pure.
  //  snap : Map id → { canon, doc }   (instantané des documents tels que connus du serveur ou en file)
  function diffDocs(key, snap, next) {
    const ops = [], seen = new Set();
    for (const d of next || []) {
      if (!d || !d.id) continue;
      seen.add(d.id);
      const prev = snap.get(d.id), type = docType(key, d);
      if (!prev) ops.push({ kind: 'upsert', key, type, id: d.id, doc: { ...clone(d), type }, expected: 0 });
      else if (prev.canon !== canon(d)) {
        if (key === 'invoices' && !isDraft(prev.doc) && onlyDerivedChange(prev.doc, d)) continue;   // règlement : le serveur fait foi (record_payment)
        ops.push({ kind: 'upsert', key, type, id: d.id, doc: { ...clone(d), type }, expected: null });
      }
    }
    for (const [id, prev] of snap) if (!seen.has(id)) ops.push({ kind: 'delete', key, type: docType(key, prev.doc), id, expected: null });
    return ops;
  }

  function createStore(cfg) {
    const { client, userId, email, url } = cfg;
    const storage = cfg.storage || { getItem() { return null; }, setItem() {}, removeItem() {} };
    const uuid = cfg.uuid || (() => 'x' + Math.random().toString(36).slice(2) + Date.now().toString(36));
    const notify = cfg.notify || (() => {});
    const timers = cfg.timers || { set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t) };
    const isOnline = cfg.isOnline || (() => (typeof navigator === 'undefined' || navigator.onLine !== false));
    const K = { q: 'fpd_q_' + userId, c: 'fpd_c_' + userId, r: 'fpd_r_' + userId, hint: 'fpd_hint_' + userId, cache: (k) => 'fpd_' + userId + '_' + k };
    const rd = (k, def) => { try { const v = storage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } };
    const wr = (k, v) => { if (S && S.dead) return; try {   // un magasin « mort » (déconnexion) n'écrit plus jamais : il écraserait la file persistée du prochain magasin
       storage.setItem(k, JSON.stringify(v)); } catch (e) { /* quota : la file reste en mémoire */ } };

    const S = {
      mode: 'inactive',          // inactive | legacy | documents | blocked
      reason: '',
      halted: null,              // null | 'mode_ancien' | 'licence' | 'auth' | 'refuse' | 'fonction_absente' : plus aucun envoi (file conservée)
      versions: {},              // 'type:id' → version serveur connue
      snaps: { invoices: new Map(), quotes: new Map() },
      payIds: new Set(),
      logCount: new Map(),       // canon(entrée) → nombre d'entrées déjà transmises
      queue: rd(K.q, []),
      conflicts: rd(K.c, []),
      rejected: rd(K.r, []),     // opérations rejetées par le serveur (erreur fonctionnelle) : archivées pour récupération, jamais perdues en silence
      dead: false, rev: 0,       // rev : compteur de modifications locales (détecte une écriture pendant une relecture)
      flushing: false, attempts: 0, timer: null, lastError: null, needReload: false
    };
    const persist = () => { wr(K.q, S.queue); wr(K.c, S.conflicts); wr(K.r, S.rejected); };
    const emit = () => { try { cfg.onChange && cfg.onChange(api.status()); } catch (e) { /* l'interface ne doit pas bloquer */ } };

    function takeSnapshot(state) {
      for (const key of ['invoices', 'quotes']) {
        S.snaps[key] = new Map();
        for (const d of state[key] || []) if (d && d.id) S.snaps[key].set(d.id, { canon: canon(d), doc: clone(d) });
      }
      S.payIds = new Set((state.payments || []).map((p) => p && p.id).filter(Boolean));
      S.logCount = new Map();
      for (const e of state.docLog || []) { const c = canon(e); S.logCount.set(c, (S.logCount.get(c) || 0) + 1); }
    }

    async function fetchAll(table, cols, orderCol) {
      const out = []; const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const r = await client.from(table).select(cols).eq('user_id', userId).order(orderCol, { ascending: true }).range(from, from + PAGE - 1);
        if (r.error) { const e = new Error(r.error.message || 'lecture impossible'); e.code = r.error.code; e.status = r.status; e.cause = r.error; throw e; }
        out.push(...(r.data || []));
        if ((r.data || []).length < PAGE) break;
      }
      return out;
    }

    const api = {
      // ----- état -----
      get mode() { return S.mode; },
      status() { return { mode: S.mode, reason: S.reason, halted: S.halted, pending: S.queue.length, conflicts: S.conflicts.length, rejected: S.rejected.length, flushing: S.flushing, attempts: S.attempts, lastError: S.lastError }; },
      get queue() { return S.queue; },
      get conflicts() { return S.conflicts; },
      get versions() { return S.versions; },

      // ----- détection : le serveur décide -----
      async detect() {
        S.halted = null;
        if (!buildAllowsDocuments(url)) { S.mode = 'legacy'; S.reason = 'build_non_preprod'; return S.mode; }
        if (!isTestEmail(email)) { S.mode = 'legacy'; S.reason = 'compte_non_test'; return S.mode; }
        let r;
        try { r = await client.rpc('get_doc_mode'); } catch (e) { r = { data: null, error: { message: String(e && e.message || e) } }; }
        if (r.error) {
          const c = classify(r.error, r.status);
          if (c === 'fonction_absente') { S.mode = 'legacy'; S.reason = 'sql17_absent'; return S.mode; }
          if (c === 'reseau') {
            // mode inconnu : l'indicateur local ne peut que RESTREINDRE (lecture seule), jamais autoriser le mode documents
            if (storage.getItem(K.hint) === 'documents') { S.mode = 'blocked'; S.reason = 'mode_inconnu_hors_ligne'; }
            else { S.mode = 'legacy'; S.reason = 'mode_inconnu'; }
            return S.mode;
          }
          S.mode = 'blocked'; S.reason = 'erreur_mode:' + functionalCode(r.error); return S.mode;
        }
        if (r.data === 'documents') { try { storage.setItem(K.hint, 'documents'); } catch {} S.mode = 'documents'; S.reason = 'serveur'; }
        else if (r.data === 'legacy') { try { storage.removeItem(K.hint); } catch {} S.mode = 'legacy'; S.reason = 'serveur'; }
        else { S.mode = 'blocked'; S.reason = 'mode_inattendu'; }
        return S.mode;
      },

      // ----- chargement depuis le serveur (en mode documents uniquement) -----
      async load(dry) {   // dry : lit sans toucher à l'instantané ni aux versions (retourne { state, versions }) ; l'appelant décide de les appliquer
        if (S.mode !== 'documents') throw new Error('load() hors mode documents');
        const docs = await fetchAll('documents', 'doc_type,id,version,body,created_at', 'created_at');
        const pays = await fetchAll('doc_payments', 'id,body,created_at', 'created_at');
        const hist = await fetchAll('doc_history', 'seq,ts,body', 'seq');
        const state = { invoices: [], quotes: [], payments: pays.map((p) => p.body), docLog: hist.slice().sort((a, b) => tms(a.ts) - tms(b.ts) || (a.seq || 0) - (b.seq || 0)).map((h) => h.body) };
        const versions = {};
        for (const d of docs) { (d.doc_type === 'quote' ? state.quotes : state.invoices).push(d.body); versions[dkey(d.doc_type, d.id)] = d.version; }
        if (dry) return { state, versions };
        S.versions = versions;
        takeSnapshot(state);
        return state;
      },

      // ----- démarrage : mode, file en attente, état local ou serveur -----
      async start() {
        await api.detect();
        if (S.mode !== 'documents') {
          // retour au mode ancien (ou mode inconnu) avec des modifications locales jamais envoyées : JAMAIS rejouées automatiquement (pas de double source), mais signalées et exportables
          const orphan = (S.queue.length || S.conflicts.length || S.rejected.length) ? { pending: S.queue.length, conflicts: S.conflicts.length, rejected: S.rejected.length } : null;
          return { mode: S.mode, reason: S.reason, orphan };
        }
        let state = null;
        if (S.queue.length) {
          // des opérations n'ont pas encore été envoyées : l'état local (cache) fait foi tant qu'elles ne sont pas passées
          state = { invoices: rd(K.cache('invoices'), []), quotes: rd(K.cache('quotes'), []), payments: rd(K.cache('payments'), []), docLog: rd(K.cache('docLog'), []) };
          takeSnapshot(state);
          // l'instantané doit refléter ce que le serveur connaît : les opérations en file seront rejouées (op_id) ; versions inconnues → résolues à l'envoi
          S.versions = rd('fpd_v_' + userId, {});
          S.needReload = true;       // une fois la file vidée, l'état local est réaligné sur le serveur
        } else {
          try { state = await api.load(); }
          catch (e) {
            const local = { invoices: rd(K.cache('invoices'), null), quotes: rd(K.cache('quotes'), null), payments: rd(K.cache('payments'), null), docLog: rd(K.cache('docLog'), null) };
            if (local.invoices === null && local.quotes === null) { S.mode = 'blocked'; S.reason = 'chargement_impossible'; S.lastError = String(e.message || e); return { mode: S.mode, reason: S.reason }; }
            state = { invoices: local.invoices || [], quotes: local.quotes || [], payments: local.payments || [], docLog: local.docLog || [] };
            takeSnapshot(state); S.versions = rd('fpd_v_' + userId, {});
            S.reason = 'hors_ligne_cache_local';
          }
        }
        wr('fpd_v_' + userId, S.versions);
        return { mode: 'documents', state };
      },

      // export de récupération (file, conflits, rejets, copies locales) — lecture seule, n'envoie rien
      exportRecovery() {
        const caches = {}; KEYS.forEach((k) => { caches[k] = rd(K.cache(k), null); });
        return JSON.stringify({ userId, at: new Date().toISOString(), queue: S.queue, conflicts: S.conflicts, rejected: S.rejected, caches }, null, 1);
      },

      cacheKey: K.cache,

      // ----- validation d'une écriture locale : calcule et met en file les opérations (aucun envoi synchrone) -----
      commit(key, next) {
        if (S.mode !== 'documents') throw new Error('commit() hors mode documents');
        if (S.halted) return { refused: true, reason: S.halted };
        S.rev++;
        const ops = [];
        if (key === 'invoices' || key === 'quotes') {
          ops.push(...diffDocs(key, S.snaps[key], next));
          // l'instantané avance : ce qui est en file est considéré comme transmis (le rejeu est protégé par op_id)
          S.snaps[key] = new Map();
          for (const d of next || []) if (d && d.id) S.snaps[key].set(d.id, { canon: canon(d), doc: clone(d) });
        } else if (key === 'payments') {
          const seen = new Set();
          for (const p of next || []) {
            if (!p || !p.id) continue; seen.add(p.id);
            if (!S.payIds.has(p.id)) ops.push({ kind: 'payment', key, id: p.id, payment: clone(p), invoiceId: p.invoiceId });
          }
          const lost = [...S.payIds].filter((id) => !seen.has(id));
          if (lost.length) notify('error', 'PAIEMENT_NON_SUPPORTE : la suppression ou la modification d\'un paiement n\'est pas prise en charge par le nouveau stockage.');
          for (const p of next || []) if (p && p.id) S.payIds.add(p.id);
        } else if (key === 'docLog') {
          const budget = new Map(S.logCount), fresh = [];
          for (const e of next || []) {
            const c = canon(e), n = budget.get(c) || 0;
            if (n > 0) budget.set(c, n - 1); else { if (!e.id) e.id = 'h-' + uuid(); fresh.push(clone(e)); }
          }
          for (const e of fresh) { const c = canon(e); S.logCount.set(c, (S.logCount.get(c) || 0) + 1); }
          for (let i = 0; i < fresh.length; i += 100) { const part = fresh.slice(i, i + 100); ops.push({ kind: 'history', key, entries: part, id: part[0].id }); }
        } else return { ignored: true };

        for (const op of ops) enqueue(op);
        persist(); emit();
        api.flushSoon();
        return { queued: ops.length };
      },

      flushSoon() { if (S.mode === 'documents' && !S.halted && isOnline()) { S.attempts = 0; Promise.resolve().then(() => api.flush()); } },

      // ----- envoi séquentiel, sans boucle de réessai -----
      async flush() {
        if (S.mode !== 'documents' || S.flushing || S.halted) return;
        S.flushing = true; emit();
        let resync = false;
        try {
          while (S.queue.length && !S.halted) {
            if (!isOnline()) { scheduleRetry(); break; }
            const op = S.queue[0];
            const res = await send(op);
            if (S.dead) return;                       // déconnecté pendant l'envoi : ne touche plus à rien (l'opération sera rejouée avec le même op_id)
            if (res.kind === 'ok') { S.queue.shift(); S.attempts = 0; S.lastError = null; wr('fpd_v_' + userId, S.versions); persist(); emit(); continue; }
            if (res.kind === 'reseau') { S.lastError = res.text; scheduleRetry(); break; }
            if (res.kind === 'conflit') { S.queue.shift(); dropQueuedFor(op); recordConflict(op, res); persist(); emit(); notify('warning', 'Conflit : ce document a été modifié sur un autre appareil. Résolvez-le avant de continuer.'); continue; }
            if (res.kind === 'mode_ancien' || res.kind === 'refuse' || res.kind === 'fonction_absente' || res.kind === 'licence' || res.kind === 'auth') {
              S.halted = res.kind; S.lastError = res.text; persist(); emit();
              notify('error', res.kind === 'mode_ancien' ? 'MODE_ANCIEN_STOCKAGE : ce compte est repassé à l\'ancien stockage. Vos modifications en attente sont conservées sur cet appareil ; rechargez l\'application.'
                : res.kind === 'licence' ? 'Licence inactive ou expirée (LICENCE_INACTIVE). Vos modifications sont conservées sur cet appareil ; renouvelez la licence puis cliquez sur « Réessayer ».'
                : res.kind === 'auth' ? 'Session expirée ou refusée (authentification). Vos modifications sont conservées ; reconnectez-vous puis cliquez sur « Réessayer ».'
                : 'Écriture refusée par le serveur (' + (res.text || res.kind) + '). Aucune nouvelle tentative automatique.');
              break;
            }
            // erreur fonctionnelle : l'opération est retirée (jamais rejouée), signalée, puis l'état est réaligné sur le serveur
            S.queue.shift(); S.lastError = res.text; resync = true; archiveRejected(op, res.text); persist(); emit();
            notify('error', res.text);
          }
        } finally { S.flushing = false; emit(); }
        if ((resync || S.needReload) && !S.queue.length && !S.halted) { S.needReload = false; try { await api.reload(); } catch (e) { S.lastError = String(e.message || e); } }
      },

      // ----- relecture serveur → remplace l'état local (jamais s'il reste des opérations ou des conflits non résolus) -----
      async reload() {
        if (S.mode !== 'documents' || S.queue.length || S.conflicts.length || S.flushing) return null;   // jamais d'écrasement de l'état local en attente ou en conflit
        const before = new Set([...S.snaps.invoices.keys(), ...S.snaps.quotes.keys()]);
        const rev0 = S.rev;
        const loaded = await api.load(true);
        // une modification a eu lieu PENDANT la relecture : l'état rechargé est périmé, on ne l'applique pas (instantané et versions inchangés)
        if (S.dead || S.queue.length || S.conflicts.length || S.flushing || S.rev !== rev0) return null;
        const state = loaded.state; S.versions = loaded.versions; takeSnapshot(state);
        const after = new Set([...state.invoices, ...state.quotes].map((d) => d.id));
        const gone = [...before].filter((id) => !after.has(id));
        wr('fpd_v_' + userId, S.versions);
        if (cfg.onReload) cfg.onReload(state, { removedRemotely: gone });
        if (gone.length) notify('warning', gone.length + ' document(s) supprimé(s) sur un autre appareil.');
        return state;
      },

      // ----- résolution explicite d'un conflit : rien n'est écrasé sans choix -----
      resolveConflict(id, choice, currentDocs) {
        const i = S.conflicts.findIndex((c) => c.id === id);
        if (i < 0) return false;
        const c = S.conflicts[i];
        if (choice === 'keep-server') {                       // abandonner la version locale
          if (c.server_doc) { S.versions[dkey(c.type, c.id)] = c.server_version; snapReplace(c, c.server_doc); if (cfg.onApply) cfg.onApply(c.key, c.server_doc, 'replace'); }
          else { delete S.versions[dkey(c.type, c.id)]; snapRemove(c); if (cfg.onApply) cfg.onApply(c.key, null, 'remove', c.id); }
        } else if (choice === 'keep-mine') {                  // réappliquer la version locale sur la version serveur actuelle
          const mine = (currentDocs && currentDocs.find((d) => d.id === c.id)) || c.mine;
          enqueue({ kind: 'upsert', key: c.key, type: c.type, id: c.id, doc: { ...clone(mine), type: c.type }, expected: c.server_doc ? c.server_version : 0 });
          snapReplace(c, mine);
        } else return false;
        S.conflicts.splice(i, 1); persist(); emit(); api.flushSoon();
        return true;
      },

      // ----- bouton « réessayer » explicite -----
      retryNow() { S.attempts = 0; S.halted = S.halted === 'mode_ancien' ? S.halted : null; return api.flush(); },
      reset() { S.dead = true; if (S.timer) timers.clear(S.timer); S.timer = null; S.mode = 'inactive'; S.queue = []; S.conflicts = []; S.flushing = false; }
    };

    // ----- internes -----
    function enqueue(op) {
      op.opId = op.kind[0] + ':' + (op.id || '') + ':' + uuid();
      if (op.kind === 'upsert') {
        // fusion : une modification d'un document dont la création/modification est encore en file remplace cette opération
        const same = S.queue.findIndex((q, idx) => q.kind === 'upsert' && q.key === op.key && q.id === op.id && !(idx === 0 && S.flushing));
        if (same >= 0) { const q = S.queue[same]; q.doc = op.doc; q.opId = op.opId; return; }
      }
      if (op.kind === 'delete') {
        const mine = S.queue.findIndex((q, idx) => q.kind === 'upsert' && q.key === op.key && q.id === op.id && q.expected === 0 && !(idx === 0 && S.flushing));
        if (mine >= 0) { S.queue.splice(mine, 1); return; }                       // créé puis supprimé avant tout envoi : rien à envoyer
        for (let i = S.queue.length - 1; i >= 0; i--) { const q = S.queue[i]; if (q.kind === 'upsert' && q.key === op.key && q.id === op.id && !(i === 0 && S.flushing)) S.queue.splice(i, 1); }
      }
      S.queue.push(op);
    }
    function archiveRejected(op, reason) {   // le contenu rejeté reste récupérable (copie locale), il n'est pas rejoué
      S.rejected.push({ id: op.id, kind: op.kind, key: op.key, doc: op.doc || op.payment || op.entries || null, reason: String(reason || ''), at: new Date().toISOString() });
      if (S.rejected.length > 50) S.rejected.splice(0, S.rejected.length - 50);
    }
    function dropQueuedFor(op) { S.queue = S.queue.filter((q) => !(q.key === op.key && q.id === op.id && q.kind !== 'payment')); }
    function snapReplace(c, doc) { if (S.snaps[c.key]) S.snaps[c.key].set(c.id, { canon: canon(doc), doc: clone(doc) }); }
    function snapRemove(c) { if (S.snaps[c.key]) S.snaps[c.key].delete(c.id); }
    function recordConflict(op, res) {
      const cur = op.kind === 'upsert' ? op.doc : (S.snaps[op.key].get(op.id) || {}).doc || null;
      const d = res.data || {};
      S.conflicts = S.conflicts.filter((x) => !(x.key === op.key && x.id === op.id));
      S.conflicts.push({ key: op.key, type: op.type, id: op.id, kind: op.kind, mine: cur, server_version: d.server_version == null ? null : d.server_version, server_doc: d.server_doc || null, at: new Date().toISOString() });
    }
    function scheduleRetry() {
      if (S.timer || S.attempts >= RETRY_DELAYS.length) return;      // plafond : 3 essais automatiques, puis événement requis
      const ms = RETRY_DELAYS[S.attempts++];
      S.timer = timers.set(() => { S.timer = null; api.flush(); }, ms);
    }
    async function send(op) {
      let r;
      try {
        if (op.kind === 'upsert') {
          const exp = op.expected == null ? (S.versions[dkey(op.type, op.id)] == null ? 0 : S.versions[dkey(op.type, op.id)]) : op.expected;
          r = await client.rpc('upsert_document', { p_doc: op.doc, p_expected_version: exp, p_op_id: op.opId });
        } else if (op.kind === 'delete') {
          const exp = op.expected == null ? (S.versions[dkey(op.type, op.id)] == null ? 0 : S.versions[dkey(op.type, op.id)]) : op.expected;
          r = await client.rpc('delete_document', { p_type: op.type, p_id: op.id, p_expected_version: exp, p_op_id: op.opId });
        } else if (op.kind === 'payment') {
          r = await client.rpc('record_payment', { p_invoice_id: op.invoiceId, p_payment: op.payment, p_op_id: op.opId });
        } else if (op.kind === 'history') {
          r = await client.rpc('append_history', { p_entries: op.entries, p_op_id: op.opId });
        } else return { kind: 'fonctionnelle', text: 'opération inconnue' };
      } catch (e) { r = { data: null, error: { message: String(e && e.message || e) }, status: 0 }; }
      if (r.error) {
        const c = classify(r.error, r.status), text = functionalCode(r.error) + ' : ' + String(r.error.message || '').replace(/^[A-Z_]{5,}:?\s*/, '');
        if (c === 'mode_nouveau') return { kind: 'refuse', text };
        return { kind: c, text: c === 'fonctionnelle' ? text : text };
      }
      const d = r.data || {};
      if (d.conflict) return { kind: 'conflit', data: d };
      if (d.ok === false) return { kind: 'fonctionnelle', text: 'Réponse inattendue du serveur' };
      if (op.kind === 'upsert' && d.version != null) S.versions[dkey(op.type, op.id)] = d.version;
      if (op.kind === 'delete') delete S.versions[dkey(op.type, op.id)];
      if (op.kind === 'payment' && d.version != null) S.versions[dkey('invoice', op.invoiceId)] = d.version;
      return { kind: 'ok' };
    }
    return api;
  }

  return { createStore, diffDocs, projectRef, buildAllowsDocuments, isTestEmail, classify, canon, KEYS, PREPROD_REF, PROD_REF, RETRY_DELAYS };
});
