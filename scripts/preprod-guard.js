// Garde-fou : n'autorise QUE le projet de préproduction déclaré dans preprod-target.json.
// Refuse si : URL absente/mal formée, référence ≠ préproduction déclarée, référence = production,
// clé absente, clé non « anon » (une clé service_role est refusée), ou clé appartenant à un autre projet.
const T = require('./preprod-target.json');
function b64json(s) { return JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); }
function guard(url, key) {
  const fail = (m) => { console.error('REFUS (garde-fou préproduction) : ' + m); process.exit(1); };
  if (!url || !key) fail('PREPROD_URL et PREPROD_ANON_KEY requis.');
  const m = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec(url);
  if (!m) fail('URL non reconnue (attendu https://<20 caractères>.supabase.co).');
  const ref = m[1];
  if (ref === T.prodRef) fail('cette URL est celle de la PRODUCTION.');
  if (ref !== T.preprodRef) fail(`projet ${ref} non autorisé (seul ${T.preprodRef} l'est).`);
  let p; try { p = b64json(key.split('.')[1]); } catch { fail('clé illisible : fournir la clé anon (JWT) du projet de préproduction.'); }
  if (p.role !== 'anon') fail(`la clé a le rôle « ${p.role} » : seule la clé anon est acceptée (jamais service_role).`);
  if (p.ref !== ref) fail('la clé appartient à un autre projet que l\'URL.');
  return { url: url.replace(/\/$/, ''), key, ref };
}
module.exports = { guard, T };
