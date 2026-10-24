// Règles de montants encaissés / restants (bloc PAIEMENTS-CALC de app.html), sans navigateur.
const fs = require('fs'), path = require('path'), assert = require('assert');
const html = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
const a = html.indexOf('// <PAIEMENTS-CALC>'), b = html.indexOf('// </PAIEMENTS-CALC>');
assert(a > 0 && b > a, 'bloc PAIEMENTS-CALC introuvable');
const api = new Function(html.slice(a, b) + '\nreturn { money2, invoicePaidAmount, invoiceRemaining, checkPaymentAmount, reconcileInvoicesAfterPaymentRefusal, invoiceCreditedAmount, isCancelledByCredit };')();
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
// Rapprochement après refus serveur d'un paiement (cause racine : facture et paiements écrits séparément)
{
  const rec = api.reconcileInvoicesAfterPaymentRefusal;
  const mkp = (id, inv, amt) => ({ id, invoiceId: inv, amount: amt });
  const srv = [mkp('p1', 'f1', 500), mkp('a', 'f1', 300)];            // ce que le serveur a réellement enregistré : 800
  const refused = [mkp('p1', 'f1', 500), mkp('b', 'f1', 700)];        // ce que l'appareil périmé voulait écrire : 1200
  const invs = [{ id: 'f1', status: 'paid', paidAmount: 1200, paidAt: '2026-10-24', totalTTC: 1200 }, { id: 'f2', status: 'sent', paidAmount: 50, totalTTC: 400 }];
  const r = rec(invs, srv, refused);
  ok('refus : la facture « payée » à tort repasse « envoyée » avec 800 payés', r.changed === 1 && r.invoices[0].status === 'sent' && r.invoices[0].paidAmount === 800 && !('paidAt' in r.invoices[0]));
  ok('refus : une autre facture n\'est pas touchée', r.invoices[1] === invs[1]);
  ok('refus : les entrées ne sont pas modifiées (nouveaux objets)', invs[0].status === 'paid' && invs[0].paidAmount === 1200);
  const legacy = [{ id: 'f1', status: 'sent', paidAmount: 700, totalTTC: 1200 }];     // 600 payés avant l'existence des lignes de paiement + 100 refusés
  const r2 = rec(legacy, [], [mkp('x', 'f1', 100)]);
  ok('refus : un avancement ancien sans ligne de paiement est conservé (700 − 100 = 600)', r2.invoices[0].paidAmount === 600 && r2.invoices[0].status === 'sent');
  ok('refus : jamais sous les paiements du serveur', rec([{ id: 'f1', status: 'sent', paidAmount: 100, totalTTC: 1200 }], [mkp('a', 'f1', 300)], [mkp('a', 'f1', 300), mkp('b', 'f1', 900)]).changed === 0);
  ok('refus : facture déjà cohérente → aucun changement', rec([{ id: 'f1', status: 'sent', paidAmount: 800, totalTTC: 1200 }], srv, refused).changed === 0);
  ok('refus : brouillons et entrées vides ignorés, aucune exception', rec([null, { id: 'd', status: 'draft' }], srv, refused).changed === 0 && rec(undefined, undefined, undefined).changed === 0);
}

// --- Facture annulée par un avoir ---
const cr = (o) => Object.assign({ id: 'a1', type: 'credit', status: 'sent', totalTTC: -1200, relatedInvoiceId: 'f1', relatedInvoiceNumber: 'FAC-1' }, o);
const f1 = inv({ number: 'FAC-1' });
ok('avoir total : facture annulée, reste 0', api.isCancelledByCredit(f1, [f1, cr()]) && api.invoiceRemaining(f1, [], [f1, cr()]) === 0);
ok('avoir total : paiement refusé avec message dédié', /annulée par un avoir/.test(api.checkPaymentAmount(f1, 100, [], [f1, cr()]).reason));
ok('avoir partiel (500) : reste = 1200 - 500, paiement du reste accepté', api.invoiceRemaining(f1, [], [f1, cr({ totalTTC: -500 })]) === 700 && api.checkPaymentAmount(f1, 700, [], [f1, cr({ totalTTC: -500 })]).ok === true && !api.isCancelledByCredit(f1, [f1, cr({ totalTTC: -500 })]));
ok('avoir partiel : paiement supérieur à 700 refusé', api.checkPaymentAmount(f1, 800, [], [f1, cr({ totalTTC: -500 })]).ok === false);
ok('avoir en brouillon ignoré', api.invoiceRemaining(f1, [], [f1, cr({ status: 'draft' })]) === 1200);
ok('avoir d\'une autre facture ignoré', api.invoiceRemaining(f1, [], [f1, cr({ relatedInvoiceId: 'f9', relatedInvoiceNumber: 'FAC-9' })]) === 1200);
ok('ancien avoir sans identifiant : rapproché par numéro', api.isCancelledByCredit(f1, [f1, cr({ relatedInvoiceId: undefined })]));
ok('facture déjà payée puis créditée : reste « payée » (remboursement non géré)', api.isCancelledByCredit(inv({ status: 'paid', number: 'FAC-1' }), [cr()]) === false);
ok('sans liste de pièces, comportement inchangé', api.invoiceRemaining(f1, []) === 1200 && api.checkPaymentAmount(f1, 100, []).ok === true);
ok('encaissement partiel puis avoir total : reste 0', api.invoiceRemaining(f1, [pay(400)], [f1, cr()]) === 0);
console.log('\nOK : ' + n + ' contrôles (paiements)');
