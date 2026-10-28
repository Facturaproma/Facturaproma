// Teste le mécanisme de validation documentée des références fiscales (scripts/check-release.js) sur une COPIE du dépôt.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const R = []; const ok = (n, c, x = '') => { R.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? ' ' + x : '')); };
function copy() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-')); fs.cpSync(ROOT, d, { recursive: true, filter: (s) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(s) }); return d; }
const run = (root, args = []) => spawnSync('node', [path.join(ROOT, 'scripts', 'check-release.js'), ...args], { env: { ...process.env, FP_RELEASE_ROOT: root }, encoding: 'utf8' });
const regPath = (d) => path.join(d, 'docs', 'validations-fiscales.json');
const setReg = (d, fn) => { const j = JSON.parse(fs.readFileSync(regPath(d), 'utf8')); fn(j); fs.writeFileSync(regPath(d), JSON.stringify(j, null, 2)); };
const d1 = copy();
let r = run(d1); ok('état réel : références non vérifiées → contrôle de publication en ÉCHEC', r.status !== 0 && /TVA_AE_ARTICLE_6/.test(r.stdout) && /NON VÉRIFIÉE/.test(r.stdout));
r = run(d1, ['--guards']); ok('garde-fous seuls (npm test) : passent (le blocage ne casse pas les tests)', r.status === 0);
// validation incomplète : ne débloque pas
setReg(d1, (j) => { const c = j.claims.find((x) => x.id === 'TVA_AE_ARTICLE_6'); c.status = 'valide'; c.validated_by = 'X'; });
r = run(d1); ok('« valide » sans date, référence ni preuve : toujours bloquant', /validation incomplète/.test(r.stdout) && r.status !== 0);
// validation complète : la ligne passe
setReg(d1, (j) => { const c = j.claims.find((x) => x.id === 'TVA_AE_ARTICLE_6'); Object.assign(c, { status: 'valide', validated_by: 'Cabinet comptable fictif (test)', validated_on: '2026-11-01', reference: 'Référence fictive de test', evidence: 'docs/preuve-fictive-test.pdf' }); });
r = run(d1); ok('validation complète : la ligne passe (les autres restent bloquantes)', /OK\s+référence fiscale « TVA_AE_ARTICLE_6 »/.test(r.stdout) && /FAIL\s+référence fiscale « CONSERVATION_10_ANS »/.test(r.stdout));
// date invalide
setReg(d1, (j) => { j.claims.find((x) => x.id === 'TVA_AE_ARTICLE_6').validated_on = 'hier'; });
r = run(d1); ok('date de validation invalide : bloquant', /FAIL\s+référence fiscale « TVA_AE_ARTICLE_6 »/.test(r.stdout));
// nouvelle référence non enregistrée → garde-fou en échec
const d2 = copy(); fs.appendFileSync(path.join(d2, 'app.html'), '\n<!-- Article 77 du CGI : exonération -->\n');
r = run(d2, ['--guards']); ok('nouvelle référence « Article 77 du CGI » non enregistrée : garde-fou en ÉCHEC', r.status !== 0 && /Article 77 du CGI/.test(r.stdout));
// affirmation retirée du produit : plus de blocage
const d3 = copy(); for (const f of ['app.html', 'index.html']) fs.writeFileSync(path.join(d3, f), fs.readFileSync(path.join(d3, f), 'utf8').split('Article 6 du CGI').join('(mention à confirmer avec votre comptable)'));
r = run(d3); ok('mention retirée du produit : plus de blocage pour cette référence', /OK\s+référence fiscale « TVA_AE_ARTICLE_6 » : plus présente|plus présente dans le produit/.test(r.stdout) && !/FAIL\s+référence fiscale « TVA_AE_ARTICLE_6 »/.test(r.stdout));
for (const d of [d1, d2, d3]) fs.rmSync(d, { recursive: true, force: true });
if (R.includes(false)) { console.log('\nÉCHEC : ' + R.filter((x) => !x).length); process.exit(1); } else console.log('\nOK : ' + R.length + ' contrôles (mécanisme de validation fiscale du contrôle de publication)');
