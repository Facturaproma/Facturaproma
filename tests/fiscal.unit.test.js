// Tests unitaires des règles et calculs fiscaux (bloc FISCAL-CALC de app.html), sans navigateur.
const fs = require('fs'), path = require('path'), assert = require('assert');
const html = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
const a = html.indexOf('// <FISCAL-CALC>'), b = html.indexOf('// </FISCAL-CALC>');
assert(a > 0 && b > a, 'bloc FISCAL-CALC introuvable');
const api = new Function(html.slice(a, b) + '\nreturn { FISCAL_RULES, aeCnssQuarter, aeCnssValidate, aeCnssRules, vatPeriods, nextVatPeriod, vatCollected, vatDeductible, vatBalance, vatReportCsv, csvText, cnssForEmployee, cnssNextDue, fiscalDateFr };')();
let n = 0; const ok = (name, c) => { assert(c, name); n++; console.log('PASS ' + name); };

// Échéances trimestrielles : fin du mois suivant le trimestre
const q26 = api.vatPeriods('quarterly', 2026).map(p => p.due);
ok('T1..T4 2026 : 30/04, 31/07, 31/10, 31/01/2027', JSON.stringify(q26) === JSON.stringify(['2026-04-30', '2026-07-31', '2026-10-31', '2027-01-31']));
ok('mensuel janvier 2026 : échéance 28/02 (pas de 30 février)', api.vatPeriods('monthly', 2026)[0].due === '2026-02-28');
ok('mensuel décembre 2026 : échéance 31/01/2027', api.vatPeriods('monthly', 2026)[11].due === '2027-01-31');
ok('mensuel février 2028 (bissextile) : échéance 31/03', api.vatPeriods('monthly', 2028)[1].due === '2028-03-31');
// Cas de la capture : 22/10/2026 -> T3 à déposer avant le 31/10/2026 (et non « 31 décembre T4 »)
let nx = api.nextVatPeriod('quarterly', '2026-10-22');
ok('22/10/2026 trimestriel : T3 2026 avant le 31/10/2026', nx.label === 'T3 2026' && nx.due === '2026-10-31');
nx = api.nextVatPeriod('quarterly', '2026-11-05');
ok('05/11/2026 trimestriel : T4 2026 avant le 31/01/2027', nx.label === 'T4 2026' && nx.due === '2027-01-31');
nx = api.nextVatPeriod('quarterly', '2027-01-15');
ok('15/01/2027 trimestriel : T4 2026 encore à déposer', nx.label === 'T4 2026');
nx = api.nextVatPeriod('quarterly', '2027-02-01');
ok('01/02/2027 trimestriel : T1 2027', nx.label === 'T1 2027');
nx = api.nextVatPeriod('monthly', '2026-10-22');
ok('22/10/2026 mensuel : septembre 2026 avant le 31/10', nx.label === 'Septembre 2026' && nx.due === '2026-10-31');
ok('dernier jour inclus : 31/10/2026 reste à déposer', api.nextVatPeriod('quarterly', '2026-10-31').label === 'T3 2026');

// TVA collectée / déductible / solde
const inv = [
  { number: 'F1', status: 'paid', type: 'invoice', date: '2026-07-10', paidAt: '2026-10-02', clientName: 'A', totalHT: 100, totalTVA: 20, totalTTC: 120 },
  { number: 'F2', status: 'paid', type: 'invoice', date: '2026-08-10', paidAt: '2026-08-20', clientName: '=cmd', totalHT: 200, totalTVA: 40, totalTTC: 240 },
  { number: 'F3', status: 'sent', type: 'invoice', date: '2026-09-10', clientName: 'C', totalHT: 500, totalTVA: 100, totalTTC: 600 },
  { number: 'F4', status: 'draft', type: 'invoice', date: '2026-09-11', totalHT: 999, totalTVA: 199, totalTTC: 1198 },
  { number: 'A1', status: 'sent', type: 'credit', date: '2026-09-12', clientName: 'A', totalHT: -50, totalTVA: -10, totalTTC: -60 }
];
const t3 = api.vatPeriods('quarterly', 2026)[2];
let c = api.vatCollected(inv, t3, 'paid');
ok('base encaissements T3 : seule F2 (F1 payée en octobre), brouillon/envoyée exclues', c.rows.length === 1 && c.tva === 40 && c.ht === 200);
ok('base encaissements : avoir signalé, non déduit', c.creditsIgnored === 1);
c = api.vatCollected(inv, t3, 'issued');
ok('base factures émises T3 : F1+F2+F3 - avoir = 150 de TVA', c.tva === 150 && c.ht === 750 && c.rows.length === 4);
const t4 = api.vatPeriods('quarterly', 2026)[3];
ok('F1 payée le 02/10 comptée en T4 sur la base encaissements', api.vatCollected(inv, t4, 'paid').tva === 20);
const d = api.vatDeductible([{ id: 1, date: '2026-09-01', supplier: 'S', ref: 'R1', ht: 100, tva: 20 }, { id: 2, date: '2026-10-01', supplier: 'S', ht: 50, tva: 10 }], t3);
ok('TVA déductible : seul l\'achat de la période', d.rows.length === 1 && d.tva === 20);
ok('solde = collecté - déductible', api.vatBalance(40, 20).amount === 20 && !api.vatBalance(40, 20).credit);
ok('crédit de TVA si déductible > collecté', api.vatBalance(10, 30).amount === -20 && api.vatBalance(10, 30).credit);
ok('arrondi à 2 décimales', api.vatCollected([{ status: 'paid', type: 'invoice', date: '2026-07-01', paidAt: '2026-07-01', totalHT: 0.1, totalTVA: 0.1, totalTTC: 0.2 }, { status: 'paid', type: 'invoice', date: '2026-07-01', paidAt: '2026-07-01', totalHT: 0.2, totalTVA: 0.2, totalTTC: 0.4 }], t3, 'paid').tva === 0.3);

// CSV
const csv = api.vatReportCsv(t3, 'issued', api.vatCollected(inv, t3, 'issued'), d, api.vatBalance(150, 20));
ok('CSV : formule neutralisée (=cmd -> \'=cmd)', csv.includes("'=cmd") && !/;=cmd/.test(csv));
ok('CSV : totaux et mention non officielle', csv.includes('Total collecté') && csv.includes('Total déductible') && csv.includes('Estimation non officielle'));
ok('CSV : séparateur ; et guillemets', api.csvText('a;b"c') === '"a;b""c"');

// CNSS auto-entrepreneur : AMO fixe par tranche (décret 2.21.928 + barème CGI 73-II-B-6°) ; la retraite (AMO × 1,57) n'est pas ajoutée tant que includePension est faux
const ae = (ca, act) => api.aeCnssQuarter(ca, act || 'services');
ok('AE : CA 0 → impôt 0, T1, AMO 300 = cotisation 300 DH (dû même sans CA), retraite non incluse', (() => { const r = ae(0); return r.ir === 0 && r.tranche === 1 && r.amo === 300 && r.cnss === 300 && r.total === 300 && r.includePension === false; })());
ok('AE services : CA 10 000 → impôt 100, impôt annuel 400 (< 500) : T1', (() => { const r = ae(10000); return r.ir === 100 && r.annualIr === 400 && r.tranche === 1 && r.amo === 300; })());
ok('AE : frontière T1/T2 — impôt annuel 496 → T1, 500 → T2', ae(12400).tranche === 1 && ae(12500).tranche === 2);
ok('AE : T2 inclut 1 000, T3 commence à 1 001 (impôt annuel)', ae(25000).tranche === 2 && ae(25100).tranche === 3);
ok('AE commerce : CA 100 000 → impôt 500 (0,5 %), annuel 2 000, T3, cotisation 570, total 1 070', (() => { const r = ae(100000, 'commerce'); return r.ir === 500 && r.annualIr === 2000 && r.tranche === 3 && r.cnss === 570 && r.total === 1070; })());
ok('AE services : CA 112 000 → impôt 1 120, annuel 4 480, T4, cotisation 720, total 1 840', (() => { const r = ae(112000); return r.ir === 1120 && r.tranche === 4 && r.cnss === 720 && r.total === 1840; })());
ok('AE : T7 inclut 50 000 (impôt annuel), T8 au-delà', ae(1250000).tranche === 7 && ae(1250100).tranche === 8 && ae(1500000).amo === 3600);
ok('AE : retraite calculée (AMO × 1,57) mais ajoutée seulement si includePension', (() => { const g = JSON.parse(JSON.stringify(api.FISCAL_RULES.aeCnss)); g.includePension = true; const on = api.aeCnssQuarter(0, 'services', g), off = ae(0); return on.retraite === 471 && on.cnss === 771 && off.retraite === 471 && off.cnss === 300; })());
ok('AE : grille = 8 montants croissants, 6 bornes croissantes, coefficient retraite 1,57', (() => { const g = api.FISCAL_RULES.aeCnss; return g.amoAmounts.length === 8 && g.annualIrUpperBounds.length === 6 && g.amoAmounts.every((v, i, a) => !i || v > a[i - 1]) && g.annualIrUpperBounds.every((v, i, a) => !i || v > a[i - 1]) && g.pensionCoef === 1.57; })());
ok('AE : valeurs négatives ou invalides traitées comme 0', ae(-50).amo === 300 && ae('abc').cnss === 300);
// Barème AE modifiable par la société : validation et application
const base = () => JSON.parse(JSON.stringify(api.FISCAL_RULES.aeCnss));
ok('AE barème : absent ou objet vide → barème de référence (ok, rules null)', (() => { const a = api.aeCnssValidate(null), b = api.aeCnssValidate({}); return a.ok && a.rules === null && b.ok && b.rules === null; })());
ok('AE barème : le barème de référence est valide et identique après normalisation', (() => { const v = api.aeCnssValidate(base()); return v.ok && JSON.stringify(v.rules.amoAmounts) === JSON.stringify(api.FISCAL_RULES.aeCnss.amoAmounts) && v.rules.irRates.services === 0.01; })());
ok('AE barème : un montant modifié est appliqué au calcul', (() => { const c = base(); c.amoAmounts[0] = 320; const v = api.aeCnssValidate(c); return v.ok && api.aeCnssQuarter(0, 'services', v.rules).cnss === 320; })());
ok('AE barème : une borne modifiée déplace la tranche', (() => { const c = base(); c.t1BelowAnnualIr = 1000; c.annualIrUpperBounds = [2000, 3000, 5000, 10000, 25000, 50000]; const v = api.aeCnssValidate(c); return v.ok && api.aeCnssQuarter(12500, 'services', v.rules).tranche === 1; })());
ok('AE barème : taux modifié (services 2 %)', (() => { const c = base(); c.irRates.services = 0.02; const v = api.aeCnssValidate(c); return v.ok && api.aeCnssQuarter(10000, 'services', v.rules).ir === 200; })());
ok('AE barème : retraite activée → ajoutée au total', (() => { const c = base(); c.includePension = true; const v = api.aeCnssValidate(c); return v.ok && api.aeCnssQuarter(0, 'services', v.rules).cnss === 771; })());
ok('AE barème : montants non croissants refusés', (() => { const c = base(); c.amoAmounts[3] = 100; const v = api.aeCnssValidate(c); return !v.ok && v.rules === null && v.errors.length > 0; })());
ok('AE barème : bornes non croissantes ou ≤ seuil T1 refusées', (() => { const c = base(); c.annualIrUpperBounds[1] = 900; const d = base(); d.annualIrUpperBounds[0] = 400; return !api.aeCnssValidate(c).ok && !api.aeCnssValidate(d).ok; })());
ok('AE barème : taux hors 0–10 %, négatifs, texte, NaN refusés', (() => { const c = base(); c.irRates.services = 0.5; const d = base(); d.amoAmounts[0] = -1; const e = base(); e.amoAmounts[2] = 'abc'; const f = base(); f.pensionCoef = NaN; return [c, d, e, f].every(x => !api.aeCnssValidate(x).ok); })());
ok('AE barème : mauvais nombre de tranches refusé ; virgule décimale acceptée', (() => { const c = base(); c.amoAmounts.pop(); const d = base(); d.amoAmounts[0] = '310,5'; const v = api.aeCnssValidate(d); return !api.aeCnssValidate(c).ok && v.ok && v.rules.amoAmounts[0] === 310.5; })());
ok('AE barème : sans barème personnalisé, aeCnssRules() = référence', api.aeCnssRules() === api.FISCAL_RULES.aeCnss);
// CNSS
ok('CNSS : taux salarié 6,74 % et employeur 21,09 % sous le plafond', (() => { const r = api.cnssForEmployee(5000); return r.emp === 337 && r.er === 1054.5; })());
ok('CNSS : plafond 6 000 sur les prestations, AMO/allocations/formation sans plafond', (() => { const r = api.cnssForEmployee(10000); return r.emp === 494.8 && r.er === 1749.8; })());
ok('CNSS : salaire négatif traité comme 0', api.cnssForEmployee(-5).emp === 0);
let cn = api.cnssNextDue('2026-10-22');
ok('CNSS 22/10/2026 : échéance 10/11/2026 pour octobre 2026', cn.due === '2026-11-10' && cn.periodLabel === 'octobre 2026');
cn = api.cnssNextDue('2026-11-10');
ok('CNSS 10/11/2026 : dernier jour, encore 10/11 pour octobre', cn.due === '2026-11-10');
cn = api.cnssNextDue('2026-12-20');
ok('CNSS 20/12/2026 : échéance 10/01/2027 pour décembre 2026', cn.due === '2027-01-10' && cn.periodLabel === 'décembre 2026');
cn = api.cnssNextDue('2027-01-05');
ok('CNSS 05/01/2027 : période = décembre 2026', cn.due === '2027-01-10' && cn.periodLabel === 'décembre 2026');
ok('date française', api.fiscalDateFr('2026-10-31') === '31 octobre 2026' && api.fiscalDateFr('2026-11-01') === '1er novembre 2026');
console.log(`\n${n} tests OK`);
