// Formules configurables : validation, clé, intégration dans libellés/prix (admin) et cartes (appli), garde-fous SQL.
const fs = require('fs'), path = require('path'), assert = require('assert');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const admin = read('admin.html'), app = read('app.html'), sql = read('sql/20_formules_configurables.sql'), code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
const cut = (h, from, to) => { const a = h.indexOf(from), b = h.indexOf(to, a); assert(a > 0 && b > a, 'bloc introuvable : ' + from); return h.slice(a, b); };
const t = (n, c) => { assert(c, n); console.log('PASS ' + n); };

// ---- admin
const src = cut(admin, 'let customPlans = [];', 'let editingPlanKey') + cut(admin, 'function validatePlanInput', 'async function persistPlan');
const optsByIdx = {};
const mkSel = () => { const kids = []; return { kids, querySelectorAll: () => kids.filter(k => k.dataset.custom), appendChild: o => kids.push(o) }; };
const sels = { codeType: mkSel(), paymentType: mkSel() };
const document = { getElementById: id => sels[id] || null, createElement: () => ({ dataset: {}, remove() {} }) };
const PLAN_LABEL = { monthly: 'Mensuel' }, TIER_PRICES = { monthly: 49 }, TIER_LABELS = { monthly: '⭐ Mensuel' };
const api = new Function('document', 'PLAN_LABEL', 'TIER_PRICES', 'TIER_LABELS', 'supaClient', src + '\nreturn { get customPlans(){return customPlans;}, set customPlans(v){customPlans=v;}, planKeyFromLabel, applyCustomPlans, validatePlanInput, planLabelMap, planPriceMap, planPeriodText };')(document, PLAN_LABEL, TIER_PRICES, TIER_LABELS, null);
t('clé : préfixe p_, sans accents ni espaces', api.planKeyFromLabel('Trimestriel Été!') === 'p_trimestriel_ete');
api.customPlans = [{ key: 'p_trimestriel', label: 'Trimestriel', price_dh: 129, duration_days: 91, active: true }, { key: 'p_vieux', label: 'Vieux', price_dh: 10, duration_days: 30, active: false }];
t('clé : collision => suffixe', api.planKeyFromLabel('Trimestriel') === 'p_trimestriel_2');
t('validation : nom, prix, durée', api.validatePlanInput('A', 10, 30) && api.validatePlanInput('Ok', 0, 30) && api.validatePlanInput('Ok', 10, 0) && api.validatePlanInput('Ok', 10, 1.5) && api.validatePlanInput('Ok', 10, 5000) && api.validatePlanInput('Ok', 129, 91) === null);
api.applyCustomPlans();
t('libellés et prix reconnus partout (rapports, paiements)', PLAN_LABEL.p_trimestriel === 'Trimestriel' && TIER_PRICES.p_trimestriel === 129 && TIER_LABELS.p_trimestriel.includes('Trimestriel') && TIER_PRICES.monthly === 49);
t('seules les formules actives sont proposées dans les listes (codes, paiements)', sels.codeType.kids.length === 1 && sels.paymentType.kids.length === 1 && sels.codeType.kids[0].value === 'p_trimestriel');
api.customPlans = [];
api.applyCustomPlans();
t('formule retirée : plus de prix ni de libellé résiduel, offres historiques intactes', !('p_trimestriel' in TIER_PRICES) && TIER_PRICES.monthly === 49 && PLAN_LABEL.monthly === 'Mensuel');
t('durée affichée', api.planPeriodText(91) === '91 jours' && api.planPeriodText(90) === '90 jours (3 mois)' && api.planPeriodText(365) === '365 jours (1 an)');
t('admin : section réservée au Master, appel serveur dédié, cartes mappées dans les libellés locaux', /id="plansCard"/.test(admin) && /class="card master-only" id="plansCard"/.test(admin) && /rpc\('owner_save_plan'/.test(admin) && /\.\.\.planLabelMap\(\)/.test(admin) && /\.\.\.planPriceMap\(\)/.test(admin));

// ---- appli
const asrc = cut(app, 'function planPeriodLabel', 'function renderCustomPlanCards');
const a = new Function(asrc + '\nreturn { planPeriodLabel, planRank };')();
t('appli : période et rang des formules', a.planPeriodLabel(30) === 'mois' && a.planPeriodLabel(365) === 'an' && a.planPeriodLabel(90) === '3 mois' && a.planPeriodLabel(10) === '10 jours' && a.planRank(91) === 1 && a.planRank(183) === 2 && a.planRank(400) === 3);
t('appli : cartes créées sans innerHTML non échappé (libellé échappé)', /escapeHtml\(p\.label\)/.test(app) && /escapeHtml\(p\.tagline/.test(app) && /data-custom-plan/.test(app));
t('appli : achat et affichage de licence connaissent les formules', /TIER_CONFIG\[p\.key\] =/.test(app) && /info\.planLabel/.test(app) && /planKey: r\.plan_key/.test(app));

// ---- SQL
t('SQL : écriture réservée au Master, journalisée', /is_master\(\)/.test(sql) && /'plan_save'/.test(sql) && /REVOKE ALL ON public\.plans FROM PUBLIC, anon, authenticated/.test(sql));
t('SQL : aucune donnée ni contrainte existante modifiée', !/ALTER TABLE public\.(licenses|admin_codes|subscription_requests)/.test(code) && !/DELETE FROM public\.(licenses|admin_codes|admin_payments|user_data)|TRUNCATE|DROP TABLE/.test(code));
t('SQL : plafonds de sécurité (prix, durée, clé)', /price_dh <= 100000/.test(sql) && /BETWEEN 1 AND 3660/.test(sql) && /\^p_/.test(sql));
console.log('OK');
