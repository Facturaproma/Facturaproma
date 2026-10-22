// Rapports de l'administration : filtre de période (dont mois dernier et dates personnalisées) et rapprochement filtré.
const fs = require('fs'), path = require('path'), assert = require('assert');
const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
const cut = (from, to) => { const a = html.indexOf(from), b = html.indexOf(to, a); assert(a > 0 && b > a, 'bloc introuvable : ' + from); return html.slice(a, b); };
const src = cut('function getDateRange(period) {', 'function onReportPeriodChange') + cut('function isInRange(dateStr, range) {', 'function renderReports()') +
  cut('function codeOfferKey(c)', 'function renderReconciliation(range)');
const make = (inputs) => new Function('document', 'allCodes', 'allPayments', 'TIER_PRICES', src + '\nreturn { getDateRange, isInRange, computeReconciliation };');
const t = (n, c) => { assert(c, n); console.log('PASS ' + n); };
const el = (v) => ({ value: v });
const doc = (vals) => ({ getElementById: (id) => (id in vals ? el(vals[id]) : null) });
const mk = (codes, pays, vals = {}) => make()(doc(vals), codes, pays, { monthly: 49, annual: 449, founder: 299, lifetime: 0 });

const api = mk([], []);
t('« Tout l\'historique » : aucun filtre', api.getDateRange('all') === null && api.isInRange('2000-01-01', null));
const lm = api.getDateRange('lastmonth'), now = new Date();
t('mois dernier : du 1er au dernier jour du mois précédent', lm.start.getDate() === 1 && lm.start.getMonth() === ((now.getMonth() + 11) % 12) && lm.end.getMonth() === lm.start.getMonth() && new Date(lm.end.getTime() + 1000).getDate() === 1);
const cu = mk([], [], { reportFrom: '2026-09-01', reportTo: '2026-09-30' }).getDateRange('custom');
t('dates personnalisées : bornes incluses (1er septembre 00:00 → 30 septembre 23:59)', cu.start.getDate() === 1 && cu.start.getMonth() === 8 && cu.end.getDate() === 30 && cu.end.getHours() === 23);
t('personnalisé : un document du 30/09 à 18h est inclus, celui du 01/10 exclu', api.isInRange('2026-09-30T18:00:00', cu) && !api.isInRange('2026-10-01T00:00:01', cu));
const open = mk([], [], { reportFrom: '', reportTo: '' }).getDateRange('custom');
t('personnalisé sans dates : tout jusqu\'à maintenant (pas d\'erreur)', open.start.getTime() === 0 && open.end <= new Date(Date.now() + 1000));

// Rapprochement filtré
const codes = [
  { code: 'A', status: 'used', type: 'monthly', created_at: '2026-08-20', activated_at: '2026-09-02', client_email: 'x@x.com' },
  { code: 'B', status: 'pending', type: 'monthly', created_at: '2026-09-10', client_email: 'y@y.com' },
  { code: 'C', status: 'used', type: 'annual', created_at: '2026-10-05', activated_at: '2026-10-06', client_email: 'z@z.com' }
];
const pays = [{ amount: 49, type: 'monthly', payment_date: '2026-09-02', client_email: 'x@x.com' }, { amount: 449, type: 'annual', payment_date: '2026-10-06', client_email: 'z@z.com' }];
const sep = mk(codes, pays, { reportFrom: '2026-09-01', reportTo: '2026-09-30' });
const r = sep.computeReconciliation(sep.getDateRange('custom'));
t('septembre : 1 code généré (B), 1 activé (A, par date d\'activation), 49 DH attendus et reçus', r.offers.monthly.gen === 1 && r.offers.monthly.pending === 1 && r.offers.monthly.used === 1 && r.offers.monthly.expected === 49 && r.offers.monthly.received === 49 && !r.offers.annual);
t('septembre : seul le client de septembre apparaît', r.clients.length === 1 && r.clients[0].email === 'x@x.com');
const all = sep.computeReconciliation(null);
t('tout l\'historique : 2 activés, 498 DH attendus et reçus, écart nul', all.offers.monthly.used + all.offers.annual.used === 2 && all.offers.monthly.expected + all.offers.annual.expected === 498 && all.offers.monthly.received + all.offers.annual.received === 498);
console.log('OK');
// Interface : barre de période visible (sticky) avant les chiffres, choix demandés présents, rapprochement relié au filtre
t('barre de période collante placée avant les indicateurs', html.indexOf('class="report-filter-bar"') > 0 && html.indexOf('class="report-filter-bar"') < html.indexOf('<!-- KPIs principaux -->') && /\.report-filter-bar \{ position: sticky/.test(html));
t('choix de période : mois dernier et dates personnalisées', /value="lastmonth"/.test(html) && /value="custom"/.test(html) && /id="reportFrom"/.test(html) && /id="reportTo"/.test(html));
t('le rapprochement suit la période (plus « indépendant du filtre »)', /renderReconciliation\(range\);/.test(html) && !/indépendant du filtre/.test(html));
console.log('OK UI');
