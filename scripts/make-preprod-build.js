#!/usr/bin/env node
// Produit une COPIE de l'application pointant vers la PRÉPRODUCTION, dans .preprod-build/ (ignoré par Git, JAMAIS déployé).
// app.html du dépôt garde l'URL de production : seul ce build peut activer le nouveau stockage (verrou de docstore.js).
// Refus : si scripts/preprod-target.json est incohérent, si la clé fournie n'est pas la clé « anon » de la préproduction, si la cible est la production.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const T = require('./preprod-target.json');
const out = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, '.preprod-build');
const die = (m) => { console.error('REFUS : ' + m); process.exit(1); };
if (!T.preprodRef || !T.prodRef || T.preprodRef === T.prodRef) die('preprod-target.json incohérent.');
if (!/^[a-z0-9]{20}$/.test(T.preprodRef)) die('référence de préproduction invalide.');
const b64 = (s) => { try { return JSON.parse(Buffer.from(s.split('.')[1], 'base64url').toString()); } catch { return null; } };
const claims = b64(T.anonKey || '');
if (!claims || claims.role !== 'anon' || claims.ref !== T.preprodRef) die('la clé de preprod-target.json n\'est pas une clé « anon » de la préproduction.');
let html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const url = `https://${T.preprodRef}.supabase.co`;
const re1 = /^const SUPABASE_URL = .*$/m, re2 = /^const SUPABASE_ANON_KEY = .*$/m;
if (!re1.test(html) || !re2.test(html)) die('lignes SUPABASE_URL / SUPABASE_ANON_KEY introuvables dans app.html.');
html = html.replace(re1, `const SUPABASE_URL = '${url}';`).replace(re2, `const SUPABASE_ANON_KEY = '${T.anonKey}';`);
if (html.includes(T.prodRef)) die('la référence de PRODUCTION est encore présente dans le build.');
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'app.html'), html);
// Page publique « lien client » : mêmes constantes remplacées (sinon le build de préproduction appellerait la production)
let fjs = fs.readFileSync(path.join(ROOT, 'facture.js'), 'utf8');
if (!re1.test(fjs) || !re2.test(fjs)) die('lignes SUPABASE_URL / SUPABASE_ANON_KEY introuvables dans facture.js.');
fjs = fjs.replace(re1, `const SUPABASE_URL = '${url}';`).replace(re2, `const SUPABASE_ANON_KEY = '${T.anonKey}';`);
if (fjs.includes(T.prodRef)) die('la référence de PRODUCTION est encore présente dans facture.js du build.');
fs.writeFileSync(path.join(out, 'facture.js'), fjs);
fs.copyFileSync(path.join(ROOT, 'facture.html'), path.join(out, 'facture.html'));
for (const f of ['docstore.js', 'manifest.json']) fs.copyFileSync(path.join(ROOT, f), path.join(out, f));
for (const d of ['fonts']) if (fs.existsSync(path.join(ROOT, d))) fs.cpSync(path.join(ROOT, d), path.join(out, d), { recursive: true });
for (const f of fs.readdirSync(ROOT)) if (/^(icon-|favicon)/.test(f)) fs.copyFileSync(path.join(ROOT, f), path.join(out, f));
console.log(`Build de préproduction écrit dans ${path.relative(ROOT, out) || out} (cible ${T.preprodRef}). Service worker NON copié : le build n'est pas une application installable.`);
