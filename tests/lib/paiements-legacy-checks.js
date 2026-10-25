// Contrôles du plafond des paiements des comptes « legacy » (sql/26, déclencheur sur user_data, clé 'payments'). Partagés par :
//   - tests/integration/preprod-paiements-rehearsal.test.js (base PostgreSQL LOCALE jetable : SIMULATION),
//   - scripts/preprod-paiements-validation.js (préproduction Supabase, comptes de test jetables, après autorisation).
// ctx : { pool, as, ck, U, V } ; U et V sont deux comptes de test restés en mode legacy, avec les factures f1..f4 (1000, 1000, 1000, 600) et g1 (0)
// dans user_data/'invoices' (voir seedInvoices de paiements-sql-checks.js). Les écritures passent par le rôle « authenticated » (RLS appliquée).
const P = (id, invId, amount) => ({ id, invoiceId: invId, amount, method: 'cash', date: '2026-10-24' });
async function legacyChecks(ctx) {
  const { pool, as, ck, U, V } = ctx;
  const put = (uid, arr) => as(uid, async (c) => { await c.query("INSERT INTO public.user_data(user_id,key,value) VALUES ($1,'payments',$2::jsonb) ON CONFLICT (user_id,key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()", [uid, JSON.stringify(arr)]); return true; })
    .then(() => ({ ok: true })).catch((e) => ({ ok: false, msg: String(e.message) }));
  const stored = async (uid) => { const r = (await pool.query("SELECT value FROM public.user_data WHERE user_id=$1 AND key='payments'", [uid])).rows[0]; return r ? r.value : []; };
  const sum = (arr, inv) => arr.filter((x) => x.invoiceId === inv).reduce((t, x) => t + Number(x.amount), 0);
  const g = (await pool.query("SELECT has_function_privilege('anon','public.guard_payments_cap_legacy()','EXECUTE') a, has_function_privilege('authenticated','public.guard_payments_cap_legacy()','EXECUTE') b, (SELECT count(*) FROM pg_trigger WHERE tgname='trg_10_payments_cap' AND tgenabled='O')::int t")).rows[0];
  ck('LEGACY : déclencheur installé et actif ; fonction non exécutable par anon / authenticated', g.t === 1 && g.a === false && g.b === false, JSON.stringify(g));
  let r = await put(U, [P('a1', 'f1', 400)]); ck('LEGACY : paiement partiel 400 sur 1000 accepté', r.ok, r.msg);
  r = await put(U, [P('a1', 'f1', 400), P('a2', 'f1', 600)]); ck('LEGACY : solde exact 400 + 600 = 1000 accepté', r.ok, r.msg);
  r = await put(U, [P('a1', 'f1', 400), P('a2', 'f1', 600), P('a3', 'f1', 0.01)]); ck('LEGACY : tolérance 0,01 acceptée (même seuil que l\'application)', r.ok, r.msg);
  r = await put(U, [P('a1', 'f1', 400), P('a2', 'f1', 600), P('a3', 'f1', 0.01), P('a4', 'f1', 50)]);
  ck('LEGACY : trop-perçu refusé (PAIEMENT_SUPERIEUR_AU_RESTE) et valeur précédente intacte (3 lignes)', !r.ok && /PAIEMENT_SUPERIEUR_AU_RESTE/.test(r.msg) && (await stored(U)).length === 3, r.msg);
  r = await put(U, [P('z1', 'g1', 10)]); ck('LEGACY : nouveau paiement sur une facture à 0 refusé (PAIEMENT_FACTURE_NULLE)', !r.ok && /PAIEMENT_FACTURE_NULLE/.test(r.msg), r.msg);
  r = await put(U, [P('a1', 'f1', 5000)]); ck('LEGACY : modification d\'un paiement existant sans effet (reste 400) ; tableau absent des lignes : rien d\'effacé', r.ok && Number((await stored(U)).find((x) => x.id === 'a1').amount) === 400 && (await stored(U)).length === 3);
  r = await put(U, []); ck('LEGACY : écriture d\'un tableau vide n\'efface aucun paiement', r.ok && (await stored(U)).length === 3);
  // appareil périmé sur une autre facture (f2 = 1000)
  await put(U, [P('a1', 'f1', 400), P('a2', 'f1', 600), P('a3', 'f1', 0.01), P('s1', 'f2', 600)]);
  r = await put(U, [P('a1', 'f1', 400), P('s2', 'f2', 600)]);
  ck('LEGACY : appareil périmé qui ignore s1 : 600 + 600 > 1000 refusé, rien ajouté', !r.ok && /PAIEMENT_SUPERIEUR_AU_RESTE/.test(r.msg) && (await stored(U)).length === 4, r.msg);
  r = await put(U, [P('a1', 'f1', 400), P('s3', 'f2', 300)]);
  const st = await stored(U);
  ck('LEGACY : même appareil, 300 : accepté ; AUCUN paiement existant perdu (s1 conservé, 5 lignes, f2 = 900)', r.ok && st.length === 5 && sum(st, 'f2') === 900 && st.some((x) => x.id === 's1'), r.msg || JSON.stringify({ n: st.length, f2: sum(st, 'f2') }));
  // concurrence : 10 écrivains simultanés qui ajoutent chacun 200 sur f3 (1000)
  const base = await stored(U);
  const many = await Promise.all(Array.from({ length: 10 }, (_, i) => put(U, base.concat([P('c' + i, 'f3', 200)]))));
  const stc = await stored(U);
  ck('LEGACY : 10 écritures simultanées de 200 sur 1000 -> exactement 5 acceptées, 5 refusées, cumul 1000', many.filter((x) => x.ok).length === 5 && many.filter((x) => !x.ok && /PAIEMENT_SUPERIEUR_AU_RESTE/.test(x.msg)).length === 5 && sum(stc, 'f3') === 1000, JSON.stringify({ ok: many.filter((x) => x.ok).length, f3: sum(stc, 'f3') }));
  ck('LEGACY : aucun paiement perdu par la concurrence (toutes les lignes précédentes présentes)', base.every((b) => stc.some((x) => x.id === b.id)));
  const rp = await Promise.all(Array.from({ length: 8 }, () => put(U, stc.concat([P('same', 'f4', 300)]))));
  const str = await stored(U);
  ck('LEGACY : même paiement (même identifiant) rejoué 8 fois en parallèle -> une seule ligne, 300 une seule fois', rp.every((x) => x.ok) && str.filter((x) => x.id === 'same').length === 1 && sum(str, 'f4') === 300);
  // isolation entre comptes
  const iso = await put(V, [P('a1', 'f1', 1000)]);
  ck('LEGACY ISOLATION : le compte B paie sa propre f1 (1000) avec les mêmes identifiants que A, sans lien entre comptes', iso.ok && sum(await stored(V), 'f1') === 1000, iso.msg);
  const cross = await as(V, async (c) => (await c.query("SELECT count(*)::int n FROM public.user_data WHERE user_id=$1 AND key='payments'", [U])).rows[0].n);
  ck('LEGACY ISOLATION (RLS) : le compte B ne lit aucune ligne de paiements du compte A', cross === 0);
  const hijack = await as(V, async (c) => (await c.query("UPDATE public.user_data SET value='[]'::jsonb WHERE user_id=$1 AND key='payments'", [U])).rowCount).catch(() => -1);
  ck('LEGACY ISOLATION (RLS) : le compte B ne peut pas modifier les paiements du compte A', (hijack === 0 || hijack === -1) && (await stored(U)).length === str.length);
}
module.exports = { legacyChecks };
