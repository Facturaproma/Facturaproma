// Crée des factures FICTIVES émises (numéros attribués par le serveur, via l'API réelle) pour les 2 comptes de test préproduction,
// afin que la preuve « numéros conservés après restauration » porte sur plusieurs factures et sur 2 comptes. Refuse la production.
const { guard } = require('../../scripts/preprod-guard');
const G = guard(process.env.PREPROD_URL, process.env.PREPROD_ANON_KEY);
const D = '@facturapro-test.invalid';
const H = (tok) => ({ apikey: G.key, 'content-type': 'application/json', authorization: 'Bearer ' + tok });
const req = async (m, p, tok, b, x = {}) => { const r = await fetch(G.url + p, { method: m, headers: { ...H(tok), ...x }, body: b === undefined ? undefined : JSON.stringify(b) }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j }; };
(async () => {
  const year = new Date().getFullYear();
  for (const [k, count] of [['A', 5], ['B', 4]]) {
    const email = process.env[`TEST_${k}_EMAIL`]; if (!email || !email.endsWith(D)) throw new Error('REFUS : compte de test attendu.');
    const l = await req('POST', '/auth/v1/token?grant_type=password', G.key, { email, password: process.env[`TEST_${k}_PASSWORD`] });
    if (l.status !== 200 || !l.body.user.email.endsWith(D)) throw new Error('connexion impossible pour ' + k);
    const tok = l.body.access_token, uid = l.body.user.id;
    const cur = await req('GET', `/rest/v1/user_data?select=value&key=eq.invoices&user_id=eq.${uid}`, tok);
    const items = (cur.status === 200 && cur.body[0] && Array.isArray(cur.body[0].value)) ? cur.body[0].value.slice() : [];   // on AJOUTE aux factures existantes (les factures émises sont verrouillées)
    const before = items.length;
    for (let i = 0; i < count; i++) {
      const n = await req('POST', '/rest/v1/rpc/next_doc_number', tok, { p_type: 'invoice', p_floor: 0 });
      if (n.status !== 200) throw new Error('numérotation refusée : ' + n.status);
      items.push({ id: `seed-${k}-${i}`, number: `FAC-${year}-${String(n.body).padStart(3, '0')}`, type: 'invoice', status: i === 0 ? 'paid' : 'sent', date: new Date().toISOString().slice(0, 10), clientName: 'Client fictif', items: [], totalHT: 100 + i, totalTVA: 20, totalTTC: 120 + i });
    }
    items.push({ id: `seed-${k}-draft`, number: 'BRO-1', type: 'invoice', status: 'draft', totalTTC: 1 });
    const w = await req('POST', '/rest/v1/user_data?on_conflict=user_id,key', tok, { user_id: uid, key: 'invoices', value: items }, { Prefer: 'resolution=merge-duplicates,return=minimal' });
    console.log(`Compte ${k} : ${before} facture(s) existante(s) conservée(s), ${count} émises + 1 brouillon ajoutées (HTTP ${w.status})`);
    if (w.status >= 300) throw new Error('enregistrement refusé : ' + JSON.stringify(w.body).slice(0, 150));
  }
})().catch((e) => { console.error('ÉCHEC : ' + e.message); process.exit(1); });
