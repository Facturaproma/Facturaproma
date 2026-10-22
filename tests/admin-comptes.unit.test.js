// Comptes « réels » dans l'administration : jamais connecté + offre non payante = masqué par défaut.
const fs = require('fs'), path = require('path'), assert = require('assert');
const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
const m = html.match(/function isRealAccount\(a\) \{[^\n]*\}/);
assert(m, 'isRealAccount introuvable');
const isReal = new Function("const PAID_TYPES = ['monthly','semestrial','annual','business','lifetime'];" + m[0] + '; return isRealAccount;')();
const t = (n, c) => { assert(c, n); console.log('PASS ' + n); };
t('inscription jamais connectée (essai) masquée', !isReal({ last_sign_in: null, is_staff: false, type: 'trial' }));
t('compte connecté affiché', isReal({ last_sign_in: '2026-10-22T10:00:00Z', is_staff: false, type: 'trial' }));
t('abonné payant jamais connecté reste affiché (jamais caché)', isReal({ last_sign_in: null, is_staff: false, type: 'annual' }));
t('équipe toujours affichée', isReal({ last_sign_in: null, is_staff: true, type: 'lifetime' }));
t('les 3 sites de stats utilisent le même filtre', (html.match(/!a\.is_staff && isRealAccount\(a\)/g) || []).length === 3);
t('filtre de liste présent, défaut « connectés »', /id="filterConnected"[\s\S]*?<option value="real">/.test(html));
console.log('OK');
// Page de connexion admin : l'e-mail du compte Master n'est plus affiché ni pré-suggéré
const a0 = html.indexOf('id="adminEmail"'), loginBlock = html.slice(a0 - 600, a0 + 2600);
assert(/Se connecter/.test(loginBlock), 'bloc de connexion introuvable');
t('connexion admin : e-mail Master absent du texte et des placeholders visibles', !/webnour@gmail\.com/.test(loginBlock));
