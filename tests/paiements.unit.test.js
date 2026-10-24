// Règles de montants encaissés / restants (bloc PAIEMENTS-CALC de app.html), sans navigateur.
const fs = require('fs'), path = require('path'), assert = require('assert');
const html = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
const a = html.indexOf('// <PAIEMENTS-CALC>'), b = html.indexOf('// </PAIEMENTS-CALC>');
assert(a > 0 && b > a, 'bloc PAIEMENTS-CALC introuvable');
const api = new Function(html.slice(a, b) + '\nreturn { money2, invoicePaidAmount, invoiceRemaining, checkPaymentAmount };')();
let n = 0; const ok = (name, c) => { assert(c, name); n++; console.log('PASS ' + name); };
const inv = (o) => Object.assign({ id: 'f1', status: 'sent', totalTTC: 1200 }, o);
const pay = (amount, id = 'f1') => ({ id: 'p' + Math.random(), invoiceId: id, amount });

ok('arrondi à 2 décimales', api.money2(0.1 + 0.2) === 0.3 && api.money2('12.345') === 12.35 && api.money2(null) === 0);
ok('facture sans paiement : rien encaissé, tout à payer', api.invoicePaidAmount(inv(), []) === 0 && api.invoiceRemaining(inv(), []) === 1200);
ok('paiement partiel : encaissé et reste cohérents', api.invoicePaidAmount(inv(), [pay(500)]) === 500 && api.invoiceRemaining(inv(), [pay(500)]) === 700);
ok('deux paiements partiels additionnés', api.invoiceRemaining(inv(), [pay(500), pay(200)]) === 500);
ok('paiements d\'une autre facture ignorés', api.invoiceRemaining(inv(), [pay(500, 'autre')]) === 1200);
ok('facture « payée » : soldée même sans ligne de paiement (anciennes données)', api.invoiceRemaining(inv({ status: 'paid' }), []) === 0 && api.invoicePaidAmount(inv({ status: 'paid' }), []) === 1200);
ok('paidAmount stocké pris en compte si les paiements manquent', api.invoiceRemaining(inv({ paidAmount: 300 }), []) === 900);
ok('trop-perçu hérité des anciennes données : encaissé plafonné au TTC', api.invoicePaidAmount(inv(), [pay(1500)]) === 1200 && api.invoiceRemaining(inv(), [pay(1500)]) === 0);
ok('brouillon : jamais de reste ni d\'encaissé', api.invoiceRemaining(inv({ status: 'draft' }), []) === 0 && api.invoicePaidAmount(inv({ status: 'draft' }), [pay(100)]) === 0);
ok('avoir (TTC négatif) : pas de reste à payer', api.invoiceRemaining(inv({ totalTTC: -300 }), []) === 0);
ok('flottants : 3 × 0,10 sur 0,30 = soldé', api.invoiceRemaining(inv({ totalTTC: 0.3 }), [pay(0.1), pay(0.1), pay(0.1)]) === 0);

ok('paiement du reste exact accepté', api.checkPaymentAmount(inv(), 700, [pay(500)]).ok === true);
ok('paiement partiel accepté', api.checkPaymentAmount(inv(), 100, []).ok === true);
const over = api.checkPaymentAmount(inv(), 700.01, [pay(500)]);
ok('trop-perçu refusé avec message', over.ok === false && /supérieur/.test(over.reason));
ok('facture soldée : nouveau paiement refusé', api.checkPaymentAmount(inv({ status: 'paid' }), 10, []).ok === false);
ok('montant nul, négatif ou vide refusé', [0, -5, '', NaN, null].every(v => api.checkPaymentAmount(inv(), v, []).ok === false));
ok('facture inconnue refusée', api.checkPaymentAmount(undefined, 10, []).ok === false);
console.log('\nOK : ' + n + ' contrôles (paiements)');
