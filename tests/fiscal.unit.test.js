// Tests unitaires des règles et calculs fiscaux (bloc FISCAL-CALC de app.html), sans navigateur.
const fs = require('fs'), path = require('path'), assert = require('assert');
const html = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
const a = html.indexOf('// <FISCAL-CALC>'), b = html.indexOf('// </FISCAL-CALC>');
assert(a > 0 && b > a, 'bloc FISCAL-CALC introuvable');
const api = new Function(html.slice(a, b) + '\nreturn { FISCAL_RULES, aeCnssQuarter, aeCnssValidate, aeCnssRules, cnssValidate, cnssRules, vatPeriods, nextVatPeriod, vatCollected, vatDeductible, vatBalance, vatReportCsv, csvText, cnssForEmployee, cnssNextDue, fiscalDateFr, PAY_MODES, payModeLabel, deductionRows, dedSplit, deductionSheet, deductionXml, deductionXmlErrors, deductionXmlParams };')();
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
// Taux CNSS employeur modifiables par société
const cbase = () => JSON.parse(JSON.stringify(api.FISCAL_RULES.cnss));
ok('CNSS employeur : absent ou objet vide → référence ; référence valide', (() => { const a = api.cnssValidate({}), b = api.cnssValidate(cbase()); return a.ok && a.rules === null && b.ok && b.rules.ceilingDH === 6000 && b.rules.dueDay === 10 && b.rules.branches.length === 4; })());
ok('CNSS employeur : taux modifié appliqué (AMO salarié 3 % sur 5 000 → 150 + autres)', (() => { const c = cbase(); c.branches.find(b => b.id === 'amo').emp = 0.03; const v = api.cnssValidate(c); return v.ok && api.cnssForEmployee(5000, v.rules).emp === 5000 * (0.0448 + 0.03); })());
ok('CNSS employeur : plafond modifié (7 000) appliqué aux prestations', (() => { const c = cbase(); c.ceilingDH = 7000; const v = api.cnssValidate(c); return v.ok && api.cnssForEmployee(10000, v.rules).emp === 7000 * 0.0448 + 10000 * 0.0226; })());
ok('CNSS employeur : jour limite modifié (15) appliqué à l\'échéance', (() => { const c = cbase(); c.dueDay = 15; const v = api.cnssValidate(c); return v.ok && api.cnssNextDue('2026-10-12', v.rules).due === '2026-10-15'; })());
ok('CNSS employeur : valeurs invalides refusées (taux > 50 %, négatif, plafond 0, jour 0 ou 31, branche manquante, texte)', (() => { const mk = (f) => { const c = cbase(); f(c); return !api.cnssValidate(c).ok; }; return mk(c => { c.branches[0].er = 0.9; }) && mk(c => { c.branches[1].emp = -0.01; }) && mk(c => { c.ceilingDH = 0; }) && mk(c => { c.dueDay = 0; }) && mk(c => { c.dueDay = 31; }) && mk(c => { c.branches.pop(); }) && mk(c => { c.branches[2].er = 'abc'; }); })());
ok('CNSS employeur : sans réglage, cnssRules() = référence', api.cnssRules() === api.FISCAL_RULES.cnss);
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

// ---- Relevé des déductions ----
const oct = api.vatPeriods('monthly', 2026)[9], sep = api.vatPeriods('monthly', 2026)[8], q4 = api.vatPeriods('quarterly', 2026)[3];
ok('modes : codes 1 à 7 dans l\'ordre du logiciel de déclaration', api.PAY_MODES.map(m => m.code + '-' + m.label).join('|') === '1-Espèces|2-Chèque|3-Prélèvement|4-Virement|5-Effet|6-Compensation|7-Autres' && api.payModeLabel('') === '');
const sups = [{ id: 's1', name: 'STAR PNEUMATIQUE', if: '1620155', ice: '000094033000084', kind: 'societe' }, { id: 's2', name: 'Marché', kind: 'particulier' }];
const purA = { id: 'pa', number: 'ACH-2026-001', supplierRef: 'FC-25-470', supplierId: 's1', supplierName: 'STAR PNEUMATIQUE', date: '2026-09-07', status: 'active', includeVat: true,
  totalHT: 1500, totalTVA: 270, totalTTC: 1770,
  lines: [{ nature: 'expense', category: 'Fournitures', tva: 20, totalHT: 1000, totalTVA: 200 }, { nature: 'goods', tva: 14, totalHT: 500, totalTVA: 70 }], credits: [] };
const purNoVat = Object.assign({}, purA, { id: 'pn', includeVat: false });
const purCancel = Object.assign({}, purA, { id: 'pc', status: 'cancelled' });
const pays = [{ id: 'm1', purchaseId: 'pa', date: '2026-09-20', amount: 885, mode: 'virement' }, { id: 'm2', purchaseId: 'pa', date: '2026-10-05', amount: 885, mode: '' },
  { id: 'm3', purchaseId: 'pn', date: '2026-10-05', amount: 100, mode: 'cheque' }, { id: 'm4', purchaseId: 'pc', date: '2026-10-05', amount: 100, mode: 'cheque' }];
const rs = api.deductionRows(sep, [purA, purNoVat, purCancel], pays, sups, []);
ok('septembre : moitié payée, ventilée par taux (20 % et 14 %)', rs.rows.length === 2 && rs.rows[0].rate === 20 && rs.rows[0].tva === 100 && rs.rows[0].ht === 500 && rs.rows[1].rate === 14 && rs.rows[1].tva === 35 && rs.rows[1].ttc === 285);
ok('septembre : total TTC = montant payé, TVA 135', rs.ttc === 885 && rs.tva === 135 && rs.ht === 750);
ok('colonnes : facture fournisseur, IF, ICE, désignation par nature, date de paiement', rs.rows[0].facture === 'FC-25-470' && rs.rows[0].if === '1620155' && rs.rows[0].ice === '000094033000084'
  && rs.rows[0].designation === 'Charges : Fournitures + Achats de marchandises' && rs.rows[0].datePaiement === '2026-09-20' && rs.rows[0].dateFacture === '2026-09-07');
const ro = api.deductionRows(oct, [purA, purNoVat, purCancel], pays, sups, []);
ok('octobre : TVA non déductible et achat annulé exclus ; mode manquant signalé', ro.rows.length === 2 && ro.tva === 135 && ro.alerts === 2 && ro.rows[0].alerts.includes('Mode de paiement à compléter'));
ok('trimestre : les deux règlements d\'octobre seulement', api.deductionRows(q4, [purA], pays, sups, []).tva === 135);
ok('arrondis : 3 règlements de 590 = TVA totale 270', (() => { const p3 = [1, 2, 3].map(i => ({ id: 'x' + i, purchaseId: 'pa', date: '2026-10-0' + i, amount: 590, mode: 'virement' }));
  const r = api.deductionRows(oct, [purA], p3, sups, []); return r.ttc === 1770 && Math.abs(r.tva - 270) < 0.011 && r.rows.every(x => Math.abs(x.ht + x.tva - x.ttc) < 0.001); })());
ok('annulation de règlement : ligne négative', (() => { const r = api.deductionRows(oct, [purA], [{ id: 'r', purchaseId: 'pa', date: '2026-10-09', amount: -885, mode: 'virement', reversal: true }], sups, []);
  return r.tva === -135 && r.rows.every(x => x.reversal && !x.movementId && x.alerts.length === 0); })());
// Avoir reçu après paiement complet : régularisation au mois de l'avoir ; avoir avant paiement : rien à régulariser
const purB = Object.assign({}, purA, { id: 'pb', lines: [{ nature: 'expense', tva: 20, totalHT: 1000, totalTVA: 200 }], totalHT: 1000, totalTVA: 200, totalTTC: 1200,
  credits: [{ id: 'c1', number: 'AVF-1', date: '2026-10-15', totalHT: 100, totalTVA: 20, totalTTC: 120, lines: [{ tva: 20, totalHT: 100, totalTVA: 20 }] }] });
ok('avoir après paiement complet : −20 de TVA en octobre', (() => { const r = api.deductionRows(oct, [purB], [{ id: 'p', purchaseId: 'pb', date: '2026-09-10', amount: 1200, mode: 'virement' }], sups, []);
  return r.rows.length === 1 && r.rows[0].credit && r.tva === -20 && r.ttc === -120; })());
ok('avoir avant paiement : aucune régularisation, paiement du net', (() => { const r = api.deductionRows(oct, [purB], [{ id: 'p', purchaseId: 'pb', date: '2026-10-20', amount: 1080, mode: 'virement' }], sups, []);
  return r.rows.length === 1 && !r.rows[0].credit && r.tva === 180; })());
ok('avoir après paiement partiel (600 payés, avoir 120) : rien à régulariser', (() => { const r = api.deductionRows(oct, [purB], [{ id: 'p', purchaseId: 'pb', date: '2026-10-01', amount: 600, mode: 'virement' }], sups, []);
  return r.tva === 100 && r.rows.length === 1; })());
// Saisie manuelle : au mois du paiement
const man = [{ id: 'v1', date: '2026-09-28', ref: 'F-9', supplier: 'SPAB', if: '18719679', ice: '000305480000047', ht: 1000, tva: 200, rate: 20, mode: 'cheque', payDate: '2026-10-02', designation: 'Achats consommables' },
  { id: 'v2', date: '2026-10-03', ref: 'F-10', supplier: 'Ancien', ht: 100, tva: 20 }];
const rm = api.deductionRows(oct, [], [], sups, man);
ok('saisie manuelle : comptée au mois du paiement ; ancienne saisie sans paiement à la date de facture, signalée', rm.rows.length === 2 && rm.tva === 220
  && rm.rows.find(r => r.facture === 'F-10').alerts.includes('Date de paiement non saisie (date de facture utilisée)') && api.deductionRows(sep, [], [], sups, man).rows.length === 0);
ok('espèces signalé ; fournisseur particulier sans IF/ICE non signalé', (() => { const r = api.deductionRows(oct, [Object.assign({}, purA, { supplierId: 's2' })], [{ id: 'e', purchaseId: 'pa', date: '2026-10-01', amount: 100, mode: 'especes' }], sups, []);
  return r.rows.every(x => x.alerts.length === 1 && /espèces/.test(x.alerts[0])); })());
// XML
const prm = api.deductionXmlParams('monthly', api.vatPeriods('monthly', 2025)[11]), prq = api.deductionXmlParams('quarterly', q4);
ok('XML : régime 1 mensuel période 12 ; régime 2 trimestriel période 4', prm.annee === 2025 && prm.periode === 12 && prm.regime === 1 && prq.regime === 2 && prq.periode === 4);
const relX = api.deductionRows(oct, [], [], sups, [man[0]]);
const xml = api.deductionXml('33666706', 'monthly', oct, relX);
ok('XML : structure DeclarationReleveDeduction / rd / refF / mp, montants à 2 décimales, dates ISO', /^<\?xml version="1.0" encoding="UTF-8"\?>\n<DeclarationReleveDeduction>\n<identifiantFiscal>33666706<\/identifiantFiscal>\n<annee>2026<\/annee>\n<periode>10<\/periode>\n<regime>1<\/regime>\n<releveDeductions>/.test(xml)
  && xml.includes('<rd><ord>1</ord><num>F-9</num><des>Achats consommables</des><mht>1000.00</mht><tva>200.00</tva><ttc>1200.00</ttc><refF><if>18719679</if><nom>SPAB</nom><ice>000305480000047</ice></refF><tx>20.00</tx><mp><id>2</id></mp><dpai>2026-10-02</dpai><dfac>2026-09-28</dfac></rd>')
  && xml.trim().endsWith('</releveDeductions>\n</DeclarationReleveDeduction>'), xml);
ok('XML : caractères spéciaux échappés', api.deductionXml('1', 'monthly', oct, api.deductionRows(oct, [], [], sups, [Object.assign({}, man[0], { supplier: 'A & B <SARL>' })])).includes('<nom>A &amp; B &lt;SARL&gt;</nom>'));
ok('XML : relevé valide → aucune erreur', api.deductionXmlErrors('33666706', relX).length === 0);
const bad = api.deductionXmlErrors('', api.deductionRows(oct, [], [], sups, [Object.assign({}, man[0], { ice: '000305480000', if: '', mode: '' })]));
ok('XML : erreurs bloquantes (IF société, ICE ≠ 15 chiffres, IF fournisseur, mode)', bad.length === 4 && /société/.test(bad[0]) && bad.some(e => /ICE du fournisseur invalide/.test(e)) && bad.some(e => /IF du fournisseur/.test(e)) && bad.some(e => /mode de paiement/.test(e)), JSON.stringify(bad));
ok('XML : relevé vide refusé', api.deductionXmlErrors('1', { rows: [] }).some(e => /Aucune ligne/.test(e)));
const sh = api.deductionSheet('Ma société', oct, relX);
ok('Excel : en-têtes, IF/ICE en texte, montants en nombres, total', sh[3].length === 13 && sh[3][6].v === 'ICE' && sh[4][6].v === '000305480000047' && sh[4][7] === 1000 && sh[4][2] === '28/09/2026' && sh[5][1].v === 'TOTAL' && sh[5][9].v === 200);
console.log(`\n${n} tests OK`);
