// Tests unitaires des règles et calculs fiscaux (bloc FISCAL-CALC de app.html), sans navigateur.
const fs = require('fs'), path = require('path'), assert = require('assert');
const html = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
const a = html.indexOf('// <FISCAL-CALC>'), b = html.indexOf('// </FISCAL-CALC>');
assert(a > 0 && b > a, 'bloc FISCAL-CALC introuvable');
const api = new Function(html.slice(a, b) + '\nreturn { FISCAL_RULES, aeCnssQuarter, vatPeriods, nextVatPeriod, vatCollected, vatDeductible, vatBalance, vatReportCsv, csvText, cnssForEmployee, cnssNextDue, fiscalDateFr };')();
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

// CNSS auto-entrepreneur : AMO fixe par tranche (décret 2.21.928 + barème CGI 73-II-B-6°) + retraite = AMO × 1,57
const ae = (ca, act) => api.aeCnssQuarter(ca, act || 'services');
ok('AE : CA 0 → impôt 0, T1, AMO 300 + retraite 471 = 771 DH (dû même sans CA)', (() => { const r = ae(0); return r.ir === 0 && r.tranche === 1 && r.amo === 300 && r.retraite === 471 && r.cnss === 771 && r.total === 771; })());
ok('AE services : CA 10 000 → impôt 100, impôt annuel 400 (< 500) : T1', (() => { const r = ae(10000); return r.ir === 100 && r.annualIr === 400 && r.tranche === 1 && r.amo === 300; })());
ok('AE : frontière T1/T2 — impôt annuel 496 → T1, 500 → T2', ae(12400).tranche === 1 && ae(12500).tranche === 2);
ok('AE : T2 inclut 1 000, T3 commence à 1 001 (impôt annuel)', ae(25000).tranche === 2 && ae(25100).tranche === 3);
ok('AE commerce : CA 100 000 → impôt 500 (0,5 %), annuel 2 000, T3, AMO 570, retraite 894,90', (() => { const r = ae(100000, 'commerce'); return r.ir === 500 && r.annualIr === 2000 && r.tranche === 3 && r.amo === 570 && r.retraite === 894.9 && r.cnss === 1464.9; })());
ok('AE services : CA 112 000 → impôt 1 120, annuel 4 480, T4, AMO 720', (() => { const r = ae(112000); return r.ir === 1120 && r.tranche === 4 && r.amo === 720 && r.retraite === 1130.4 && r.cnss === 1850.4 && r.total === 2970.4; })());
ok('AE : T7 inclut 50 000 (impôt annuel), T8 au-delà', ae(1250000).tranche === 7 && ae(1250100).tranche === 8 && ae(1500000).amo === 3600);
ok('AE : grille = 8 montants croissants, 6 bornes croissantes, coefficient retraite 1,57', (() => { const g = api.FISCAL_RULES.aeCnss; return g.amoAmounts.length === 8 && g.annualIrUpperBounds.length === 6 && g.amoAmounts.every((v, i, a) => !i || v > a[i - 1]) && g.annualIrUpperBounds.every((v, i, a) => !i || v > a[i - 1]) && g.pensionCoef === 1.57; })());
ok('AE : valeurs négatives ou invalides traitées comme 0', ae(-50).amo === 300 && ae('abc').cnss === 771);
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
