// Accès PostgreSQL à la PRÉPRODUCTION uniquement. Aucun mot de passe dans le dépôt : PREPROD_DB_URL vient de l'environnement.
const { T } = require('./preprod-guard');
function parseDbUrl(str) {
  const fail = (m) => { throw new Error('REFUS (garde-fou base) : ' + m); };
  if (!str) fail('PREPROD_DB_URL absent.');
  if (str.includes(T.prodRef)) fail('la chaîne de connexion mentionne la PRODUCTION.');
  let u; try { u = new URL(str); } catch { fail('chaîne de connexion illisible.'); }
  if (!/^postgres(ql)?:$/.test(u.protocol)) fail('protocole non postgres.');
  const user = decodeURIComponent(u.username), host = u.hostname;
  // Pooler : utilisateur « postgres.<ref> » ; connexion directe : hôte « db.<ref>.supabase.co »
  const mUser = /^postgres\.([a-z0-9]{20})$/.exec(user), mHost = /^db\.([a-z0-9]{20})\.supabase\.co$/.exec(host);
  const ref = mUser ? mUser[1] : (mHost ? mHost[1] : null);
  if (!ref) fail('projet non identifiable (utilisateur « postgres.<ref> » ou hôte « db.<ref>.supabase.co » attendu).');
  if (ref === T.prodRef) fail('cible = PRODUCTION.');
  if (ref !== T.preprodRef) fail(`projet ${ref} non autorisé (seul ${T.preprodRef} l'est).`);
  if (mUser && !/\.pooler\.supabase\.com$/.test(host)) fail('hôte de pooler inattendu : ' + host);
  if (mHost && mUser) fail('combinaison utilisateur/hôte ambiguë.');
  return { ref, host, port: u.port || '5432', database: (u.pathname || '/postgres').slice(1) || 'postgres', user, password: decodeURIComponent(u.password) };
}
async function connect() {
  const { Client } = require('pg');
  const p = parseDbUrl(process.env.PREPROD_DB_URL);
  const c = new Client({ host: p.host, port: Number(p.port), database: p.database, user: p.user, password: p.password, ssl: { rejectUnauthorized: false }, statement_timeout: 120000 });
  await c.connect();
  return { client: c, ref: p.ref };
}
module.exports = { parseDbUrl, connect };
