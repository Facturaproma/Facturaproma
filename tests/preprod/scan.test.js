// Vérifie que le scanner de secrets DÉTECTE bien un identifiant (cas positifs) et laisse passer les exemples (cas négatifs).
const { spawnSync } = require('child_process'); const fs = require('fs'), os = require('os'), path = require('path');
const d = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-')); const res = [];
const ck = (n, ok) => { res.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + n); };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (o) => `eyJhbGciOiJIUzI1NiJ9.${b64(o)}.abcdefghijklmnop`;
const FAKE = ['Qw8r', 'Tz51', 'kd20', 'Lm7x'].join('');   // valeur fictive assemblée à l'exécution : aucun littéral dans le dépôt
const PG = 'postgres' + 'ql://';
const scan = (txt, env = {}) => { const f = path.join(d, 'x.txt'); fs.writeFileSync(f, txt); return spawnSync('node', [path.join(__dirname, '../../scripts/scan-secrets.js'), '--file', f], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }); };
ck('URL de connexion avec mot de passe détectée', scan('x ' + PG + 'postgres.abc:' + FAKE + '@host:5432/postgres').status === 1);
ck('exemple [YOUR-PASSWORD] toléré', scan('postgresql://postgres.abc:[YOUR-PASSWORD]@host/db').status === 0);
ck('JWT service_role détecté', scan(jwt({ role: 'service_role', ref: 'njjaomichdlnoscrnxlz' })).status === 1);
ck('JWT anon de la préproduction toléré (clé publique)', scan(jwt({ role: 'anon', ref: 'njjaomichdlnoscrnxlz' })).status === 0);
ck('sb_secret_ détecté', scan('k=sb_secret_' + 'a'.repeat(30)).status === 1);
const r = scan('le mot de passe est ' + FAKE + '-unique ici', { PREPROD_DB_URL: PG + 'postgres.abc:' + FAKE + '-unique@host/db' });
ck('mot de passe exact (issu de l\'environnement) détecté', r.status === 1);
ck('la valeur trouvée n\'est jamais affichée', !r.stdout.includes(FAKE) && !r.stderr.includes(FAKE));
fs.rmSync(d, { recursive: true, force: true }); const n = res.filter(Boolean).length; console.log(`${n}/${res.length} tests du scanner réussis`); process.exit(n === res.length ? 0 : 1);
