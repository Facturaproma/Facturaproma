// Demandes d'abonnement : 1) envoi du montant + RIB (e-mail / WhatsApp), 2) après paiement, génération et envoi du code.
const fs = require('fs'), path = require('path'), assert = require('assert');
const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
const cut = (from, to) => { const a = html.indexOf(from), b = html.indexOf(to, a); assert(a > 0 && b > a, 'bloc introuvable : ' + from); return html.slice(a, b); };
const t = (n, c) => { assert(c, n); console.log('PASS ' + n); };
const api = new Function(cut('function buildPaymentMessage', '// ---- Fenêtre') + '\nreturn { buildPaymentMessage, buildCodeMessage, mailtoLink };')();
const msg = api.buildPaymentMessage('client@x.ma', 'Annuel (449 DH/an)', 449, { bank_rib: 'RIB-DE-TEST', bank_beneficiary: 'Benef SARL', bank_name: 'Banque Test' });
t('message de paiement : formule, montant, RIB, bénéficiaire, banque, référence', ['Annuel (449 DH/an)', '449 DH', 'RIB-DE-TEST', 'Benef SARL', 'Banque Test', 'client@x.ma'].every(x => msg.includes(x)));
t('message de paiement : ne promet pas le code avant paiement (« dès réception du paiement »)', /dès réception du paiement/.test(msg) && !/sous 24h/.test(msg));
const code = api.buildCodeMessage('FP-AAAA-BBBB-CCCC');
t('message du code : code + marche à suivre', code.includes('FP-AAAA-BBBB-CCCC') && /Licence/.test(code) && /Activer/.test(code));
const ml = api.mailtoLink('a+b@x.ma', 'Sujet é', 'Ligne1\nLigne2 & plus');
t('mailto : adresse, sujet et corps encodés', ml.startsWith('mailto:a%2Bb%40x.ma?subject=Sujet%20%C3%A9&body=Ligne1%0ALigne2%20%26%20plus'));
// Parcours dans l'interface
t('actions « En attente » : Contacter (e-mail/WhatsApp) + Générer code + Rejeter', /contactRequest\('\$\{esc\(r\.id\)\}'\)/.test(html) && /processRequest\('\$\{esc\(r\.id\)\}'\)/.test(html) && /rejectRequest\('\$\{esc\(r\.id\)\}'\)/.test(html));
t('une demande « Contacté » garde ses actions (avant : seulement « Rouvrir »)', /r\.status === 'pending' \|\| r\.status === 'contacted'\) \? `/.test(html));
t('le RIB vient des Réglages et le message est refusé s\'il est vide', /bank_rib\) \{\s*showToast\('Renseignez/.test(html));
t('la demande passe à « Contacté » seulement après l\'envoi (e-mail/WhatsApp), pas à la simple copie', /kind !== 'copy' && c\.afterSend/.test(html) && /update\(\{ status: 'contacted' \}\)/.test(html));
t('génération du code : confirmation du paiement, puis choix e-mail / WhatsApp', /Le paiement de \$\{r\.final_price\} DH est-il bien reçu/.test(html) && /title: '🎁 Envoyer le code au client'/.test(html));
t('avertissement si le RIB n\'a pas été envoyé avant', /n'ont pas encore été envoyés à ce client/.test(html));
t('filtre par défaut « À traiter » (attente + contacté)', /<option value="open" selected>/.test(html));
t('plus d\'ancienne fonction WhatsApp sans numéro ni de confirm() pour le code', !/contactByWhatsApp/.test(html) && !/Voulez-vous l'envoyer maintenant par WhatsApp/.test(html));
console.log('OK');
