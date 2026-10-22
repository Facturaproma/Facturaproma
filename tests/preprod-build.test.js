// Test local (SIMULATION) de scripts/make-preprod-build.js : cible, refus, absence de la référence de production.
const { execFileSync, spawnSync } = require('child_process'); const fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.join(__dirname, '..'); const T = require('../scripts/preprod-target.json');
const res = []; const ck = (n, ok, x = '') => { res.push(!!ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || !x ? '' : ' -> ' + String(x).slice(0, 200))); };
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-'));
execFileSync('node', [path.join(ROOT, 'scripts/make-preprod-build.js'), out]);
const html = fs.readFileSync(path.join(out, 'app.html'), 'utf8');
ck('build : URL = préproduction', html.includes(`const SUPABASE_URL = 'https://${T.preprodRef}.supabase.co';`));
ck('build : aucune trace de la référence de PRODUCTION', !html.includes(T.prodRef));
ck('build : docstore.js copié, service worker NON copié', fs.existsSync(path.join(out, 'docstore.js')) && !fs.existsSync(path.join(out, 'sw.js')));
ck('dépôt : app.html garde l\'URL de production (le build ne modifie pas la source)', fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8').includes(`https://${T.prodRef}.supabase.co`));
ck('.preprod-build/ est ignoré par Git', /\.preprod-build\//.test(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')));
fs.rmSync(out, { recursive: true, force: true });
const bad = res.filter((x) => !x).length; console.log(`\n${res.length - bad}/${res.length} tests du build de préproduction réussis (local)`); process.exit(bad ? 1 : 0);
