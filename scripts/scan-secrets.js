#!/usr/bin/env node
// Recherche d'identifiants dans : l'arbre de travail Git, une ou plusieurs branches distantes, l'historique complet, des fichiers donnés.
//   node scripts/scan-secrets.js --tree --history --branch origin/preprod-reports --file reports/backup.md
// Détecte : URL de connexion AVEC identifiants, jetons Supabase/GitHub, JWT autres que la clé publique « anon » de la préproduction,
// et (si PREPROD_DB_URL est défini) le mot de passe / l'URL exacts. N'affiche JAMAIS la valeur trouvée : seulement fichier, ligne, type.
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const T = JSON.parse(fs.readFileSync(path.join(__dirname, 'preprod-target.json'), 'utf8'));
const git = (a) => execFileSync('git', a, { cwd: ROOT, maxBuffer: 1024 * 1024 * 1024, encoding: 'utf8' });
const PLACEHOLDER = /^(motdepasse|…|\.{3}|\[.*\]|<.*>|\*+|x{3,}|\$\{?[A-Za-z_]+\}?|%s|.*(FAKE|EXAMPLE|PLACEHOLDER|YOUR-PASSWORD|MOT_DE_PASSE|PASSWORD).*)$/i;
const exact = [];
if (process.env.PREPROD_DB_URL) {
  exact.push(['URL de connexion exacte', process.env.PREPROD_DB_URL]);
  try { const u = new URL(process.env.PREPROD_DB_URL); for (const v of [decodeURIComponent(u.password), u.password]) if (v && v.length >= 8) exact.push(['mot de passe de la base', v]); } catch { /* ignoré */ }
}
function b64json(x) { try { return JSON.parse(Buffer.from(x.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch { return null; } }
function scanText(name, text) {
  const f = [];
  text.split('\n').forEach((line, i) => {
    const at = (kind) => f.push({ where: `${name}:${i + 1}`, kind });
    for (const m of line.matchAll(/postgres(?:ql)?:\/\/([^\s:\/@'"`]+):([^\s@'"`]+)@/gi)) if (!PLACEHOLDER.test(decodeURIComponent(m[2]))) at('URL de connexion avec mot de passe');
    if (/sb_secret_[A-Za-z0-9_-]{16,}/.test(line)) at('clé secrète Supabase (sb_secret_)');
    if (/sbp_[a-f0-9]{30,}/.test(line)) at('jeton d\'accès personnel Supabase');
    if (/gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/.test(line)) at('jeton GitHub');
    for (const m of line.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.([A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g)) {
      const p = b64json(m[1]);
      if (!p || p.role !== 'anon' || p.ref !== T.preprodRef && p.ref !== T.prodRef) at(`JWT non « anon » ou illisible (rôle ${p && p.role})`);
    }
    for (const [k, v] of exact) if (line.includes(v)) at(k + ' (valeur exacte du secret)');
  });
  return f;
}
const findings = [];
const add = (arr) => arr.forEach((x) => findings.push(x));
let scanned = 0;
const isText = (b) => !b.includes(0);
if (args.includes('--tree')) for (const f of git(['ls-files']).split('\n').filter(Boolean)) {
  if (!fs.existsSync(path.join(ROOT, f)) || fs.statSync(path.join(ROOT, f)).isDirectory()) continue;
  const b = fs.readFileSync(path.join(ROOT, f)); if (b.length > 5e6 || !isText(b)) continue; scanned++; add(scanText('arbre:' + f, b.toString('utf8')));
}
args.forEach((a, i) => {
  if (a === '--branch') { const ref = args[i + 1]; for (const f of git(['ls-tree', '-r', '--name-only', ref]).split('\n').filter(Boolean)) {
    const t = git(['show', `${ref}:${f}`]); scanned++; add(scanText(`${ref}:${f}`, t)); } }
  if (a === '--file') { const f = args[i + 1]; const t = fs.readFileSync(f, 'utf8'); scanned++; add(scanText('fichier:' + f, t)); }
});
if (args.includes('--history')) { scanned++; add(scanText('historique(toutes les branches)', git(['log', '--all', '-p', '--no-color', '--format=commit %H']))); }
const byKind = {}; findings.forEach((x) => { byKind[x.kind] = (byKind[x.kind] || 0) + 1; });
console.log(`Analyse de secrets : ${scanned} source(s) examinée(s), ${findings.length} découverte(s).`);
findings.slice(0, 30).forEach((x) => console.log(`  - ${x.kind} : ${x.where}`));
process.exit(findings.length ? 1 : 0);
