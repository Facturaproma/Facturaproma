// FacturaPro 2.0 — opérations SIMULTANÉES sur les fonctions serveur (connexions PostgreSQL parallèles, comptes de test jetables) :
// numérotation des achats sans doublon ni trou, idempotence sous rafale, plafond des règlements, CMUP cohérent, retours plafonnés,
// clôture unique, annulation unique d'un virement, isolation. Base locale jetable, jamais Supabase réel.
const { createDb, dropDb, makeBackend } = require('./backend');
(async () => {
  const db = createDb({ stock: true }); const be = makeBackend(db); const res = [];
  const ck = (n, ok, x = '') => res.push([!!ok, n, x]);
  try {
    const mk = async (e) => (await be.handle('signUp', { email: e })).session;
    const A = await mk('fa@test.invalid'), B = await mk('fb@test.invalid');
    const rpc = (s, fn, args) => be.handle('rpc', { fn, args, token: s.access_token });
    const today = new Date().toISOString().slice(0, 10);
    const goods = (key, pu, qty = 10) => ({ p: { key, supplier_name: 'Minoterie', date: today, lines: [{ nature: 'goods', product_id: 'A', product_name: 'Farine', track_stock: true, description: 'Farine', qty, unit_price: pu, tva_rate: 20 }] } });

    // 1) 20 achats simultanés : numéros distincts, sans trou ; coût moyen = moyenne pondérée exacte
    const prices = Array.from({ length: 20 }, (_, i) => 40 + i);   // 40..59
    const outs = await Promise.all(prices.map((pu, i) => rpc(A, 'purchase_record', goods('c' + i, pu))));
    const errs = outs.filter(o => o.error);
    ck('20 achats simultanés : aucune erreur', errs.length === 0, errs.map(e => e.error.message).slice(0, 2).join(';'));
    const nums = outs.map(o => o.data && o.data.number).filter(Boolean).map(n => Number(n.split('-').pop())).sort((a, b) => a - b);
    ck('numéros ACH distincts et continus 1..20', nums.length === 20 && new Set(nums).size === 20 && nums[0] === 1 && nums[19] === 20, nums.join(','));
    const st = (await be.sql("SELECT qty::float q, cmup::float c FROM stock_cost_state s JOIN auth.users u ON u.id = s.user_id WHERE u.email = 'fa@test.invalid' AND product_id = 'A'"))[0];
    const exact = prices.reduce((t, p) => t + p * 10, 0) / 200;   // 49.5
    ck('stock 200, coût moyen = moyenne pondérée exacte (49,5) malgré la simultanéité', st.q === 200 && Math.abs(st.c - exact) < 0.001, JSON.stringify(st));
    const chain = await be.sql("SELECT qty::float q, unit_cost::float u, cmup_after::float c FROM stock_movements m JOIN auth.users u ON u.id = m.user_id WHERE u.email = 'fa@test.invalid' ORDER BY seq");
    let q = 0, c = null, okChain = true;
    for (const m of chain) { c = q <= 0 || c === null ? m.u : Math.round(((q * c + m.q * m.u) / (q + m.q)) * 10000) / 10000; q += m.q; if (Math.abs(c - m.c) > 0.0002) okChain = false; }
    ck('chaîne des CMUP recalculée dans l\'ordre d\'enregistrement : identique à chaque ligne', okChain && chain.length === 20);

    // 2) Même clé envoyée 10 fois en même temps : une seule pièce
    const dup = await Promise.all(Array.from({ length: 10 }, () => rpc(A, 'purchase_record', goods('rafale', 50))));
    const nDup = (await be.sql("SELECT count(*)::int n FROM purchases WHERE idem_key = 'rafale'"))[0].n;
    ck('même clé x10 simultanés : une seule pièce, aucune erreur (les doublons renvoient la pièce existante)', nDup === 1 && dup.every(d => !d.error && d.data.id === dup[0].data.id), `${nDup} ; erreurs=${dup.filter(d => d.error).map(d => d.error.message).join('|')}`);
    const nMv = (await be.sql("SELECT count(*)::int n FROM stock_movements WHERE idem_key LIKE 'pur:%' AND ref_id IN (SELECT id::text FROM purchases WHERE idem_key = 'rafale')"))[0].n;
    ck('… et une seule entrée de stock', nMv === 1, String(nMv));

    // 2b) Même clé en rafale pour un règlement, un mouvement et un compte : idempotents aussi
    const accR = await Promise.all(Array.from({ length: 5 }, () => rpc(A, 'cash_account_create', { p: { key: 'acc-r', name: 'Coffre', kind: 'cash', opening_balance: 1, opening_date: today } })));
    ck('compte : même clé x5 simultanés → un seul compte, aucune erreur', accR.every(r => !r.error && r.data.id === accR[0].data.id), accR.map(r => r.error ? r.error.message : 'ok').join('|'));
    const mvR = await Promise.all(Array.from({ length: 5 }, () => rpc(A, 'cash_movement_record', { p: { key: 'mv-r', kind: 'owner_in', account_id: accR[0].data.id, amount: 10, date: today } })));
    ck('mouvement : même clé x5 simultanés → un seul mouvement, aucune erreur', mvR.every(r => !r.error && r.data.id === mvR[0].data.id) && (await be.sql("SELECT count(*)::int n FROM cash_movements WHERE idem_key = 'mv-r'"))[0].n === 1);
    const blR = await Promise.all(Array.from({ length: 5 }, () => rpc(A, 'delivery_record', { p: { key: 'bl-r', client_id: 'c1', client_name: 'Client', date: today, lines: [{ product_id: 'A', product_name: 'Farine', track_stock: true, description: 'Farine', qty: 1, unit_price: 100, tva_rate: 20 }] } })));
    ck('BL : même clé x5 simultanés → un seul BL et une seule sortie, aucune erreur', blR.every(r => !r.error && r.data.id === blR[0].data.id) && (await be.sql("SELECT count(*)::int n FROM stock_movements WHERE idem_key LIKE 'bl:' || $1 || ':%'", [blR[0].data.id]))[0].n === 1);

    // 3) Règlements simultanés : 10 x 100 sur une dette de 744 → 7 acceptés au plus
    const acc = (await rpc(A, 'cash_account_create', { p: { name: 'Banque', kind: 'bank', opening_balance: 10000, opening_date: today } })).data.id;
    const pur = (await rpc(A, 'purchase_record', { p: { key: 'dette', supplier_name: 'X', date: today, lines: [{ nature: 'expense', category: 'Loyer', description: 'Loyer', qty: 1, unit_price: 620, tva_rate: 20 }] } })).data;
    const st2 = await Promise.all(Array.from({ length: 10 }, (_, i) => rpc(A, 'supplier_settle', { p: { key: 's' + i, purchase_id: pur.id, account_id: acc, amount: 100, date: today } })));
    const okN = st2.filter(o => !o.error).length, refused = st2.filter(o => o.error && /REGLEMENT_SUPERIEUR/.test(o.error.message)).length;
    const paid = (await be.sql("SELECT coalesce(sum(amount),0)::float s FROM cash_movements WHERE purchase_id = $1", [pur.id]))[0].s;
    ck('10 règlements de 100 simultanés sur 744 : 7 acceptés, 3 refusés, jamais plus que la dette', okN === 7 && refused === 3 && paid === 700, `${okN}/${refused}/${paid}`);

    // 4) Retours simultanés sur une même sortie de 5 : jamais plus de 5 remis en stock
    await rpc(A, 'stock_record', { p_moves: [{ product_id: 'A', type: 'out', qty: 5, date: today, source: 'invoice', key: 'inv:F1:0' }] });
    const rets = await Promise.all(Array.from({ length: 8 }, (_, i) => rpc(A, 'stock_record', { p_moves: [{ product_id: 'A', type: 'in', qty: 1, date: today, source: 'credit', key: 'cr:C' + i + ':0', return_of: 'inv:F1:0' }] })));
    const back = (await be.sql("SELECT coalesce(sum(qty),0)::float s FROM stock_movements WHERE return_of = 'inv:F1:0'"))[0].s;
    ck('8 retours d\'une unité simultanés sur une sortie de 5 : 5 acceptés, 3 refusés', back === 5 && rets.filter(r => r.error && /RETOUR_SUPERIEUR/.test(r.error.message)).length === 3, String(back));

    // 5) Annulation simultanée d'un virement : une seule paire d'annulations
    const acc2 = (await rpc(A, 'cash_account_create', { p: { name: 'Caisse', kind: 'cash', opening_balance: 0, opening_date: today } })).data.id;
    const tr = (await rpc(A, 'cash_movement_record', { p: { kind: 'transfer', account_id: acc, to_account_id: acc2, amount: 300, date: today } })).data.id;
    await Promise.all(Array.from({ length: 6 }, () => rpc(A, 'cash_movement_reverse', { p_id: tr, p_reason: 'erreur' })));
    const nRev = (await be.sql("SELECT count(*)::int n FROM cash_movements WHERE kind = 'reversal' AND reverses_id IN (SELECT id FROM cash_movements WHERE transfer_id IS NOT NULL)"))[0].n;
    ck('6 annulations simultanées d\'un virement : exactement 2 lignes inverses (une par jambe)', nRev === 2, String(nRev));

    // 6) Clôture simultanée du même mois : une seule clôture active
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); const pm = d.toISOString().slice(0, 7);
    const cl = await Promise.all(Array.from({ length: 5 }, () => rpc(B, 'period_close', { p_month: pm, p_note: 'x' })));
    const nCl = (await be.sql("SELECT count(*)::int n FROM period_closures c JOIN auth.users u ON u.id = c.user_id WHERE u.email = 'fb@test.invalid' AND reopened_at IS NULL"))[0].n;
    ck('5 clôtures simultanées du même mois : une seule active, les autres « déjà clôturé »', nCl === 1 && cl.filter(r => r.error && /DEJA_CLOTURE/.test(r.error.message)).length === 4, `${nCl} ${cl.map(r => r.error ? r.error.message.slice(0, 20) : 'ok').join('|')}`);

    // 7) Isolation sous charge : B ne voit rien de A
    const bl = await rpc(B, 'purchase_list', { p_from: null, p_to: null, p_status: null, p_limit: 500, p_offset: 0 });
    const bs = await rpc(B, 'fin_summary', { p_from: today.slice(0, 8) + '01', p_to: today });
    ck('isolation : B ne voit aucun achat ni montant de A', Array.isArray(bl.data) && bl.data.length === 0 && Number(bs.data.payables) === 0 && Number(bs.data.stock_value) === 0);
    const steal = await rpc(B, 'supplier_settle', { p: { purchase_id: pur.id, account_id: acc, amount: 1, date: today } });
    ck('isolation : B ne peut pas régler un achat de A avec un compte de A', !!steal.error && /ACHAT_INTROUVABLE/.test(steal.error.message), steal.error && steal.error.message);
  } catch (e) { ck('exécution', false, e.stack); }
  let f = 0; for (const [ok, n, x] of res) { if (!ok) f++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || !x ? '' : ' -> ' + x)); }
  console.log(`\n${f ? 'ÉCHEC' : 'OK'} : ${res.length - f}/${res.length} contrôles (opérations simultanées FacturaPro 2.0)`);
  await be.close(); dropDb(db); process.exit(f ? 1 : 0);
})();
