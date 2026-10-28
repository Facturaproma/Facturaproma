// Dernière connexion des admins : repli sur la dernière connexion réelle du compte (admin_list_accounts).
const fs = require('fs'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
let bad = 0; const ok = (n, c) => { console.log((c ? 'OK   ' : 'FAIL ') + n); if (!c) bad++; };
const m = html.match(/function adminLastLogin\(a\) \{[\s\S]*?\n\}\n/);
ok('fonction adminLastLogin présente', !!m);
const mk = (accounts) => new Function('allAccounts', m[0] + '; return adminLastLogin;')(accounts);
const accs = [{ email: 'Boss@Test.invalid', last_sign_in: '2026-10-25T12:00:00Z' }, { email: 'autre@test.invalid', last_sign_in: null }];
const f = mk(accs);
ok('utilise la connexion du compte (e-mail insensible à la casse)', f({ email: 'boss@test.invalid' }) === '2026-10-25T12:00:00Z');
ok('la valeur admins.last_login garde la priorité si elle existe', f({ email: 'boss@test.invalid', last_login: '2026-01-01T00:00:00Z' }) === '2026-01-01T00:00:00Z');
ok('jamais connecté : null (affiche —)', f({ email: 'autre@test.invalid' }) === null);
ok('compte inconnu ou liste vide : null, sans erreur', f({ email: 'x@test.invalid' }) === null && mk([])({ email: 'x@test.invalid' }) === null && f(null) === null);
ok('le tableau des admins utilise adminLastLogin', /adminLastLogin\(a\) \? formatDate\(adminLastLogin\(a\)\)/.test(html));
process.exit(bad ? 1 : 0);
