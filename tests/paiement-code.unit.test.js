// Paiement lié au code (sql/32 + admin.html) : garde-fous statiques. Le comportement SQL est testé par tests/sql/test_paiement_code.sql.
const fs = require('fs'), path = require('path');
const rd = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const admin = rd('admin.html'), sql = rd('sql/32_paiement_lie_au_code.sql');
let bad = 0; const ok = (n, c) => { console.log((c ? 'OK   ' : 'FAIL ') + n); if (!c) bad++; };
ok('admin.html : les revenus ne comptent que les paiements encaissés (console admin ET profil assistant)',
  (admin.match(/\.filter\(p => !p\.status \|\| p\.status === 'paid'\)/g) || []).length >= 2);
ok('admin.html : les paiements en attente sont gardés à part (allPendingPayments) et affichés', /allPendingPayments = \(payments \|\| \[\]\)\.filter\(p => p\.status === 'pending'\)/.test(admin) && /id="pendingPaymentsTable"/.test(admin) && /renderPendingPayments\(\);/.test(admin));
ok('markAsPaid : encaisse le paiement lié via admin_confirm_payment (pas de doublon)', /allPendingPayments \|\| \[\]\)\.find\(p => p\.code_id === codeId\)/.test(admin) && /rpc\('admin_confirm_payment'/.test(admin));
ok('savePayment : propose d\'encaisser le paiement en attente plutôt qu\'un doublon', /const pend = \(allPendingPayments/.test(admin));
ok('sql/32 : trigger de création (AFTER INSERT), révocation, suppression, unicité code_id', /trg_code_paiement_attente AFTER INSERT ON public\.admin_codes/.test(sql) && /trg_code_paiement_statut AFTER UPDATE OF status/.test(sql) && /trg_code_paiement_suppr BEFORE DELETE/.test(sql) && /uq_admin_payments_code/.test(sql));
ok('sql/32 : les fonctions de trigger ne sont pas exécutables par les clients', ['code_prix_attendu(TEXT, TEXT)', 'code_creer_paiement()', 'code_sync_paiement()', 'code_supprimer_paiement()'].every((f) => sql.includes('REVOKE ALL ON FUNCTION public.' + f + ' FROM PUBLIC, anon, authenticated')));
process.exit(bad ? 1 : 0);
