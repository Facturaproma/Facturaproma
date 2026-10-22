// Journal d'administration : filtres par login, par action, par période + libellés.
const fs = require('fs'), path = require('path'), assert = require('assert');
const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
const cut = (from, to) => { const a = html.indexOf(from), b = html.indexOf(to, a); assert(a > 0 && b > a, 'bloc introuvable : ' + from); return html.slice(a, b); };
const src = cut('const AUDIT_ACTION_LABELS', 'function fillAuditSelects') + cut('function getDateRange(period, ids) {', 'function onReportPeriodChange') + cut('function isInRange(dateStr, range) {', 'function renderReports()');
const t = (n, c) => { assert(c, n); console.log('PASS ' + n); };
const doc = { getElementById: () => null };
const api = new Function('document', 'MASTER_EMAIL', 'PLAN_LABEL', 'let auditStaffEmails = new Set(["aide@x.com"]);\n' + src + '\nreturn { auditRoleOf, auditDetailText, filterAuditRows, auditActionLabel, getDateRange };')(doc, 'owner@x.com', { monthly: 'Mensuel', annual: 'Annuel' });
const rows = [
  { at: '2026-10-02T10:00:00', admin_email: 'Owner@x.com', action: 'set_license', target_email: 'a@a.com', details: { before: { type: 'monthly' }, after: { type: 'annual', expires_at: '2027-10-02' }, note: 'upgrade' } },
  { at: '2026-10-03T10:00:00', admin_email: 'aide@x.com', action: 'staff_payment', target_email: 'b@b.com', details: { amount: 49, type: 'monthly' } },
  { at: '2026-09-15T10:00:00', admin_email: 'adm@x.com', action: 'delete_account', target_email: 'c@c.com', details: { data_rows: 3 } }
];
t('rôles : owner, assistant, administrateur', api.auditRoleOf('OWNER@x.com') === 'owner' && api.auditRoleOf('aide@x.com') === 'assistant' && api.auditRoleOf('adm@x.com') === 'administrateur');
t('filtre login (insensible à la casse)', api.filterAuditRows(rows, 'owner@x.com', '', null).length === 1);
t('filtre action', api.filterAuditRows(rows, '', 'staff_payment', null).length === 1 && api.filterAuditRows(rows, '', '', null).length === 3);
t('filtre login + action sans résultat', api.filterAuditRows(rows, 'aide@x.com', 'set_license', null).length === 0);
const rg = api.getDateRange('custom', { from: 'auditFrom', to: 'auditTo' });
t('période personnalisée sans dates : pas d\'erreur', rg && rg.start.getTime() === 0);
t('libellés lisibles', /Licence/.test(api.auditActionLabel('set_license')) && api.auditActionLabel('autre') === '• autre');
t('détails : licence, paiement, suppression', /Mensuel → Annuel/.test(api.auditDetailText(rows[0])) && /49 DH/.test(api.auditDetailText(rows[1])) && /3 données/.test(api.auditDetailText(rows[2])));
t('interface : sélecteurs « Tous les logins » et « Toutes actions »', /id="auditActor"/.test(html) && /Toutes actions/.test(html) && /id="auditAction"/.test(html));
console.log('OK');
