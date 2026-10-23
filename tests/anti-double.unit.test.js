// Anti double abonnement : règle « formule plus longue seulement » côté appli et administration + garde-fous SQL.
const fs = require('fs'), path = require('path'), assert = require('assert');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const admin = read('admin.html'), app = read('app.html'), sql = read('sql/22_anti_double_abonnement.sql');
const cut = (h, from, to) => { const a = h.indexOf(from), b = h.indexOf(to, a); assert(a > 0 && b > a, 'bloc introuvable : ' + from); return h.slice(a, b); };
const t = (n, c) => { assert(c, n); console.log('PASS ' + n); };
const future = new Date(Date.now() + 20 * 864e5).toISOString(), past = new Date(Date.now() - 864e5).toISOString();

// admin
const asrc = cut(admin, 'const ADMIN_TIER_DAYS', 'async function processRequest(requestId) {');
const mk = (accts, codes, plans) => new Function('PAID_TYPES', 'customPlans', 'accountsAvailable', 'allAccounts', 'allCodes', asrc + '\nreturn { doubleSubscriptionBlock, isDoubleSubError };')(['monthly', 'semestrial', 'annual', 'business', 'lifetime'], plans || [], true, accts, codes || []);
const a = mk([
  { email: 'm@x.ma', type: 'monthly', status: 'active', expires_at: future },
  { email: 'old@x.ma', type: 'monthly', status: 'active', expires_at: past },
  { email: 'v@x.ma', type: 'lifetime', status: 'active', expires_at: null },
  { email: 's@x.ma', type: 'monthly', status: 'suspended', expires_at: future },
  { email: 'c@x.ma', type: 'monthly', status: 'active', expires_at: future, code: 'C1' },
  { email: 't@x.ma', type: 'trial', status: 'active', expires_at: future }
], [{ code: 'C1', type: 'p_trim' }], [{ key: 'p_trim', duration_days: 91 }, { key: 'p_court', duration_days: 10 }]);
t('abonné Mensuel actif : Mensuel refusé, Annuel autorisé', a.doubleSubscriptionBlock('m@x.ma', 'monthly') && a.doubleSubscriptionBlock('m@x.ma', 'annual') === null);
t('formule configurée : plus courte refusée, plus longue (91 j) autorisée', a.doubleSubscriptionBlock('m@x.ma', 'p_court') && a.doubleSubscriptionBlock('m@x.ma', 'p_trim') === null);
t('abonnement expiré, essai ou suspendu : pas de blocage', a.doubleSubscriptionBlock('old@x.ma', 'monthly') === null && a.doubleSubscriptionBlock('t@x.ma', 'monthly') === null && a.doubleSubscriptionBlock('s@x.ma', 'monthly') === null);
t('accès à vie : tout refusé', a.doubleSubscriptionBlock('v@x.ma', 'lifetime') && a.doubleSubscriptionBlock('v@x.ma', 'annual'));
t('abonné via une formule de 91 jours : Mensuel refusé, Annuel autorisé', a.doubleSubscriptionBlock('c@x.ma', 'monthly') && a.doubleSubscriptionBlock('c@x.ma', 'annual') === null);
t('e-mail inconnu : pas de blocage', a.doubleSubscriptionBlock('nouveau@x.ma', 'monthly') === null);
t('admin : contrôle branché sur les 3 écrans de génération + erreur serveur lisible', (admin.match(/doubleSubscriptionBlock\(/g) || []).length >= 5 && (admin.match(/isDoubleSubError\(err\)/g) || []).length === 3 && /Déjà abonné/.test(admin));

// appli
const psrc = cut(app, 'const TIER_DAYS', 'function planRank');
const ap = (info, plans) => new Function('CUSTOM_PLANS', 'License', 'PAID_TIER_TYPES', 'document', psrc + '\nreturn { tierDays, currentPaidDays };')(plans || [], { get: () => info, isExpired: () => info.expired }, ['lifetime', 'monthly', 'semestrial', 'annual', 'business'], { getElementById: () => null });
t('appli : abonné actif Mensuel => 30 j ; expiré / essai => 0', ap({ type: 'monthly', status: 'active' }).currentPaidDays() === 30 && ap({ type: 'monthly', status: 'active', expired: true }).currentPaidDays() === 0 && ap({ type: 'trial', status: 'active' }).currentPaidDays() === 0);
t('appli : formule configurée active (91 j) => 91 j ; à vie => infini', ap({ type: 'monthly', status: 'active', planKey: 'p_trim' }, [{ key: 'p_trim', duration_days: 91 }]).currentPaidDays() === 91 && ap({ type: 'lifetime', status: 'active' }).currentPaidDays() > 1e6);
t('appli : achat bloqué sauf formule plus longue, cartes masquées, erreur serveur lisible', /tierDays\(tier\) <= curDays/.test(app) && /applyPricingEligibility\(\);/.test(app) && /already_subscribed/.test(app) && /data-tier="monthly"/.test(app) && /data-tier="annual"/.test(app));

// SQL
const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
t('SQL : déclencheurs sur admin_codes et subscription_requests, formule plus longue seulement', /trg_block_double_code BEFORE INSERT ON public\.admin_codes/.test(code) && /trg_block_double_request BEFORE INSERT ON public\.subscription_requests/.test(code) && /plan_days\(v_type\) <= v_cur/.test(code));
t('SQL : activate_license, licences et codes existants non modifiés', !/activate_license|UPDATE public\.|DELETE FROM|DROP TABLE|ALTER TABLE/.test(code));
console.log('OK');
