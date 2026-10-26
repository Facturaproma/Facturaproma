// Garde-fous de sécurité (non-régression) : échoue si l'on réintroduit l'une des failles corrigées lors de l'audit du 26/10/2026.
//  1. injection stockée via gestionnaires en ligne et attributs (OWASP A03)   2. champs saisis par un client affichés bruts dans la console admin
//  3. protections de chargement (intégrité des scripts externes, anti-clickjacking)   4. cellules CSV (injection de formule)
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const R = path.join(__dirname, '..');
const rd = (f) => fs.readFileSync(path.join(R, f), 'utf8');
let bad = 0; const ok = (n, c, x = '') => { console.log((c ? 'OK   ' : 'FAIL ') + n + (x ? ' ' + x : '')); if (!c) bad++; };
const app = rd('app.html'), admin = rd('admin.html'), sw = rd('sw.js');
const fn = (h, name) => { const a = h.indexOf('function ' + name + '('); if (a < 0) return ''; return h.slice(a, h.indexOf('\n}\n', a) + 3); };

// 1. Gestionnaires en ligne : aucune interpolation entre apostrophes (' ${…} ') — toujours jsArg()
for (const [f, h] of [['app.html', app], ['admin.html', admin]]) {
  const lines = h.split('\n'); const bads = [];
  lines.forEach((l, i) => { if (/\bon(click|change|input|keyup|submit)="[^"]*'\$\{/.test(l)) bads.push(i + 1); });
  ok(f + " : aucun gestionnaire on…=\"…'${…}'…\" (utiliser jsArg)", bads.length === 0, bads.slice(0, 5).join(','));
  const ctx = {}; vm.createContext(ctx); vm.runInContext(fn(h, 'jsArg') + ';this.jsArg=jsArg;', ctx);
  const evil = ctx.jsArg("x');window.__p=1;//\"<img onerror=1>&");
  ok(f + ' : jsArg ne laisse passer ni apostrophe, ni guillemet, ni < > & (hors délimiteurs)', !/['"<>&]/.test(evil.slice(1, -1)) && ctx.jsArg('f1') === "'f1'" && ctx.jsArg("L'Atelier").indexOf("'") === 0, evil);
}
// échappement HTML : quatre caractères + guillemets
{
  const c1 = {}; vm.createContext(c1); vm.runInContext(fn(app, 'escapeHtml') + ';this.e=escapeHtml;', c1);
  const c2 = {}; vm.createContext(c2); vm.runInContext(fn(admin, 'esc') + ';this.e=esc;', c2);
  ok('app.html escapeHtml : & < > " \' neutralisés', c1.e('&<>"\'') === '&amp;&lt;&gt;&quot;&#39;');
  ok('admin.html esc : & < > " \' neutralisés', c2.e('&<>"\'') === '&amp;&lt;&gt;&quot;&#39;');
}
// 2. Console admin : champs qu'un client peut écrire (subscription_requests, e-mail du compte) jamais bruts
const RAW = /\$\{(?:[A-Za-z_]+\.)+(?:client_email|client_name|company_name|company_status|promo_code)(?: \|\| '[^']*')?\}/g;
const rawHits = []; admin.split('\n').forEach((l, i) => { if (/confirm\(|prompt\(|showToast\(|pdf\.text\(|sub:|alert\(/.test(l)) return; const m = l.match(RAW); if (m) rawHits.push((i + 1) + ':' + m[0]); });
ok('admin.html : client_email / company_name / company_status / promo_code toujours via esc() ou jsArg()', rawHits.length === 0, rawHits.slice(0, 4).join(' | '));
ok('admin.html : prefillPayment passe par esc(JSON.stringify(…)) dans un attribut entre guillemets', /onclick="prefillPayment\(\$\{esc\(JSON\.stringify\(/.test(admin) && !/onclick='prefillPayment/.test(admin));

// 3. Chargement
for (const [f, h] of [['app.html', app], ['admin.html', admin]]) {
  const sup = (h.match(/<script[^>]*supabase-js@[^>]*>/) || [''])[0];
  ok(f + ' : script Supabase avec intégrité SRI (sha256) + crossorigin', /integrity="sha256-7jvo3hkrl8sdc9HpXWuCux9rZYwPl8TvdX\/DMZlu09M="/.test(sup) && /crossorigin="anonymous"/.test(sup) && /supabase-js@2\.118\.0\//.test(sup));
  ok(f + ' : aucun script chargé depuis cdnjs (jsPDF hébergé dans vendor/)', !/<script[^>]*src="https:\/\/cdnjs/.test(h) && /src="vendor\/jspdf\.umd\.min\.js"/.test(h));
  ok(f + ' : anti-clickjacking en tête de page', /id="fp-antiframe"/.test(h) && h.indexOf('fp-antiframe') < h.indexOf('<script src='));
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(R, f))).digest('hex');
ok('vendor/jspdf.umd.min.js = jsPDF 2.5.1 (empreinte figée)', sha('vendor/jspdf.umd.min.js') === crypto.createHash('sha256').update(fs.readFileSync(path.join(R, 'node_modules', 'jspdf', 'dist', 'jspdf.umd.min.js'))).digest('hex'));
ok('vendor/jspdf.plugin.autotable.min.js = autotable 3.5.31 (empreinte figée)', sha('vendor/jspdf.plugin.autotable.min.js') === crypto.createHash('sha256').update(fs.readFileSync(path.join(R, 'node_modules', 'jspdf-autotable', 'dist', 'jspdf.plugin.autotable.min.js'))).digest('hex'));
ok('sw.js : fichiers vendor mis en cache, version du cache incrémentée', /vendor\/jspdf\.umd\.min\.js/.test(sw) && !/cdnjs/.test(sw) && !/facturapro-v17-/.test(sw));

// 4. CSV admin : formules neutralisées
{
  const c = {}; vm.createContext(c); vm.runInContext(fn(admin, 'csvCell') + ';this.c=csvCell;', c);
  ok("CSV admin : =, +, -, @ neutralisés ; guillemets doublés", c.c('=HYPERLINK("x")', true) === '"\'=HYPERLINK(""x"")"' && c.c('@a') === "'@a" && c.c('ok') === 'ok');
}
// 5. Mot de passe à la création : 8 caractères minimum (la connexion des comptes existants n'est pas bloquée)
ok('inscription et changement de mot de passe : 8 caractères minimum', /password\.length < 8/.test(app) && /newPwd\.length < 8/.test(app) && /minlength="8"/.test(app));
process.exit(bad ? 1 : 0);
