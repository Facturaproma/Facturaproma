// Contrôles du plafond des paiements (record_payment après sql/25). Partagés par :
//   - tests/integration/paiements.sql-concurrence.test.js (base PostgreSQL LOCALE jetable : SIMULATION),
//   - scripts/preprod-paiements-validation.js (préproduction Supabase, comptes de test jetables, après autorisation).
// ctx : { pool, ck, U, V } ; U et V sont deux comptes de test en mode « documents » avec les factures f1..f4 et g1 (voir seedInvoices).
const inv = (id, n, ttc, extra = {}) => ({ id, type: 'invoice', number: 'FAC-2026-00' + n, status: 'sent', totalHT: ttc / 1.2, totalTVA: ttc - ttc / 1.2, totalTTC: ttc, ...extra });
const seedInvoices = () => [inv('f1', 1, 1000), inv('f2', 2, 1000), inv('f3', 3, 1000), inv('f4', 4, 600), inv('g1', 5, 0)];
function helpers(ctx) {
  const { pool, as } = ctx;
  const pay = (uid, invId, p) => as(uid, async (c) => (await c.query('SELECT public.record_payment($1,$2::jsonb,$3) r', [invId, JSON.stringify(p), 'op-' + p.id])).rows[0].r).then((r) => ({ ok: true, r }), (e) => ({ ok: false, msg: e.message }));
  const sel = async (sql, p = []) => (await pool.query(sql, p)).rows;
  const state = async (uid, id) => { const r = (await sel('SELECT paid_amount, status, version FROM public.documents WHERE user_id=$1 AND id=$2', [uid, id]))[0]; const s = (await sel('SELECT COALESCE(SUM(amount),0) s, count(*)::int n FROM public.doc_payments WHERE user_id=$1 AND invoice_id=$2', [uid, id]))[0]; return { paid: Number(r.paid_amount), status: r.status, sum: Number(s.s), n: s.n }; };
  return { pay, sel, state };
}
async function capChecks(ctx) {
  const { ck, U, V, as } = ctx; const { pay, sel, state } = helpers(ctx);
  const dg = (await sel("SELECT has_function_privilege('anon','public.record_payment(text,jsonb,text)','EXECUTE') a, has_function_privilege('authenticated','public.record_payment(text,jsonb,text)','EXECUTE') b"))[0];
  ck('PROPOSÉ : droits d\'exécution conservés (anon non, authenticated oui) après CREATE OR REPLACE', dg.a === false && dg.b === true, JSON.stringify(dg));
  const prop = await Promise.all(Array.from({ length: 10 }, (_, i) => pay(U, 'f2', { id: 'p' + i, amount: 400, date: '2026-10-01' })));
  const s2 = await state(U, 'f2');
  ck('PROPOSÉ : 10 paiements simultanés de 400 sur 1000 -> exactement 2 acceptés, 8 refusés PAIEMENT_SUPERIEUR_AU_RESTE', prop.filter((r) => r.ok).length === 2 && prop.filter((r) => !r.ok && /PAIEMENT_SUPERIEUR_AU_RESTE/.test(r.msg)).length === 8, JSON.stringify(prop.map((r) => r.ok)));
  ck('PROPOSÉ : cumul 800 <= 1000, facture non soldée, cohérente avec doc_payments', s2.sum === 800 && s2.paid === 800 && s2.status === 'sent' && s2.n === 2, JSON.stringify(s2));
  const last = await Promise.all(Array.from({ length: 5 }, (_, i) => pay(U, 'f2', { id: 'q' + i, amount: 200, date: '2026-10-02' })));
  const s3 = await state(U, 'f2');
  ck('PROPOSÉ : 5 paiements simultanés de 200 sur un reste de 200 -> 1 accepté, facture soldée à 1000 exactement', last.filter((r) => r.ok).length === 1 && s3.sum === 1000 && s3.status === 'paid', JSON.stringify(s3));
  const after = await pay(U, 'f2', { id: 'z1', amount: 0.02, date: '2026-10-03' });
  ck('PROPOSÉ : paiement sur facture soldée refusé', !after.ok && /PAIEMENT_SUPERIEUR_AU_RESTE/.test(after.msg), after.msg);
  const rp = await Promise.all(Array.from({ length: 8 }, () => pay(U, 'f3', { id: 'same', amount: 300, date: '2026-10-01' })));
  const s4 = await state(U, 'f3');
  ck('PROPOSÉ : même paiement (même identifiant) rejoué 8 fois en parallèle -> 8 réponses ok, une seule ligne, 300 une seule fois', rp.every((r) => r.ok) && s4.n === 1 && s4.sum === 300, JSON.stringify(s4));
  const acc = prop.findIndex((r) => r.ok);   // les 2 paiements acceptés dépendent de l'ordre d'arrivée : on rejoue un paiement réellement accepté
  const rp2 = await pay(U, 'f2', { id: 'p' + acc, amount: 400, date: '2026-10-01' });
  ck('PROPOSÉ : rejeu d\'un ancien paiement sur facture déjà soldée -> réponse ok (replay), rien ajouté', rp2.ok && rp2.r.replay === true && (await state(U, 'f2')).n === 3);
  const bad = await Promise.all([pay(U, 'f4', { id: 'b0', amount: 0, date: '2026-10-01' }), pay(U, 'f4', { id: 'b1', amount: -5, date: '2026-10-01' }), pay(U, 'f4', { id: 'b2', amount: 'abc', date: '2026-10-01' }), pay(U, 'g1', { id: 'b3', amount: 10, date: '2026-10-01' })]);
  ck('PROPOSÉ : montant nul, négatif, non numérique et facture à 0 refusés', bad.every((r) => !r.ok), JSON.stringify(bad.map((r) => r.msg)));
  const tol = await pay(U, 'f4', { id: 't1', amount: 600.01, date: '2026-10-01' });
  ck('PROPOSÉ : tolérance d\'arrondi 0,01 : 600,01 sur 600 accepté (même seuil que l\'application)', tol.ok);
  const iso = await pay(V, 'f1', { id: 'cur0', amount: 100, date: '2026-10-01' });
  ck('ISOLATION : le compte B paie sa propre facture avec le même identifiant de paiement que le compte A, sans lien entre comptes', iso.ok && (await state(V, 'f1')).sum === 100);
  const cross = await as(V, async (c) => (await c.query("SELECT count(*)::int n FROM public.doc_payments WHERE user_id=$1", [U])).rows[0].n);
  ck('ISOLATION (RLS) : le compte B ne voit aucun paiement du compte A', cross === 0);
  let direct = null; try { await as(U, (c) => c.query("INSERT INTO public.doc_payments(user_id,id,body,body_sha) VALUES ($1,'hack','{\"amount\":1}','')", [U])); } catch (e) { direct = e.message; }
  ck('Aucune écriture directe dans doc_payments par un utilisateur (seule la fonction écrit)', !!direct, direct);
  const tot = await sel("SELECT count(*)::int n FROM public.doc_payments WHERE user_id=$1 AND invoice_id='f2'", [U]);
  ck('Cohérence finale f2 : somme des lignes = paid_amount du document', (await state(U, 'f2')).sum === (await state(U, 'f2')).paid && tot[0].n === 3);
}
module.exports = { seedInvoices, helpers, capChecks, inv };
