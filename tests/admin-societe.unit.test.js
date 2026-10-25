// Nom de société dans l'admin (sql/28) : vérifications statiques de admin.html (la logique SQL est testée dans tests/sql/test_nom_societe.sql).
const fs = require('fs'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', '28_admin_nom_societe.sql'), 'utf8');
const manifest = fs.readFileSync(path.join(__dirname, '..', 'sql', 'MANIFEST.json'), 'utf8');
let bad = 0; const ok = (n, c) => { console.log((c ? 'OK   ' : 'FAIL ') + n); if (!c) bad++; };
ok('admin.html appelle admin_account_companies dans un try/catch (sql/28 facultatif)', /try \{\s*const \{ data: cos, error: cErr \} = await supaClient\.rpc\('admin_account_companies'\)/.test(html) && /sql\/28 absent/.test(html));
ok('la société est affichée échappée (esc) sous l\'e-mail', /esc\(a\.company_name\)/.test(html));
ok('la recherche couvre l\'e-mail ET la société', /a\.company_name \|\| ''\)\.toLowerCase\(\)\.includes\(search\)/.test(html));
ok('admin_list_accounts n\'est pas modifiée par sql/28', !/CREATE OR REPLACE FUNCTION public\.admin_list_accounts/.test(sql) && !/DROP FUNCTION IF EXISTS public\.admin_list_accounts/.test(sql));
ok('sql/28 : réservé is_admin(), pas de droit anon, retour arrière documenté', /is_admin\(\)/.test(sql) && /FROM PUBLIC, anon/.test(sql) && /RETOUR ARRI.RE/.test(sql));
ok('sql/28 : brouillon hors MANIFEST (ne s\'applique jamais automatiquement)', !/28_admin_nom_societe/.test(manifest));
process.exit(bad ? 1 : 0);
