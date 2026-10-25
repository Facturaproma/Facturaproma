// Offre Fondateur : interrupteur ouverte/fermée, plafond de 30, messages d'erreur serveur, options désactivées. Logique pure extraite de admin.html (aucun réseau).
const fs = require('fs'), path = require('path'), assert = require('assert');
const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
const sqlText = fs.readFileSync(path.join(__dirname, '..', 'sql', '27_offre_fondateur.sql'), 'utf8');
const cut = (from, to) => { const a = html.indexOf(from), b = html.indexOf(to, a); assert(a > 0 && b > a, 'bloc introuvable : ' + from); return html.slice(a, b); };
const t = (n, c) => { assert(c, n); console.log('PASS ' + n); };
const src = cut('let founderOpen = true;', 'async function loadFounderSetting') + cut('function founderBlockMessage', 'async function toggleFounderOffer') + cut('function countFounderCodes() {', 'function refreshFounderCounter() {');
const mk = (codes, open) => new Function('allCodes', 'open', 'const FOUNDER_LIMIT = 30;\n' + src + '\nfounderOpen = open;\nreturn { block: founderBlockMessage, err: founderErrorText, count: countFounderCodes };')(codes, open);
const codes = (n, extra = []) => Array.from({ length: n }, (_, i) => ({ note: 'FONDATEUR 299 DH/an', status: 'pending', code: 'F' + i })).concat(extra);

t('offre ouverte, 0 code : possible', mk([], true).block() === null);
t('offre ouverte, 29 codes : possible', mk(codes(29), true).block() === null);
t('offre ouverte, 30 codes : refusée (limite)', /Limite atteinte : 30/.test(mk(codes(30), true).block()));
t('les codes révoqués ne comptent pas', mk(codes(29, [{ note: 'FONDATEUR x', status: 'revoked' }, { note: 'FONDATEUR y', status: 'revoked' }]), true).block() === null && mk(codes(29, [{ note: 'FONDATEUR x', status: 'revoked' }]), true).count() === 29);
t('les codes annuels ordinaires ne comptent pas', mk(codes(2, Array.from({ length: 40 }, () => ({ note: '', status: 'pending' }))), true).count() === 2);
t('offre fermée : refusée même sous 30', /fermée/.test(mk(codes(3), false).block()));
t('offre fermée ET complète : le message « fermée » prime', /fermée/.test(mk(codes(30), false).block()));
const e = mk([], true).err;
t('erreur serveur OFFRE_FONDATEUR_FERMEE : message clair', /fermée/.test(e({ message: 'OFFRE_FONDATEUR_FERMEE: l\'offre' })));
t('erreur serveur LIMITE_FONDATEUR_ATTEINTE : message clair', /Limite atteinte/.test(e({ message: 'LIMITE_FONDATEUR_ATTEINTE: 30' })));
t('erreur serveur MASTER_REQUIS : message clair', /propriétaire/.test(e({ message: 'MASTER_REQUIS: x' })));
t('autre erreur : pas de message fondateur (null)', e({ message: 'duplicate key' }) === null && e(null) === null);
// Cohérence navigateur / base : mêmes valeurs et mêmes mots-clés
t('même limite (30) côté navigateur et côté base', /FOUNDER_LIMIT = 30/.test(html) && /n >= 30/.test(sqlText));
t('mêmes codes d\'erreur côté navigateur et côté base', ['OFFRE_FONDATEUR_FERMEE', 'LIMITE_FONDATEUR_ATTEINTE', 'MASTER_REQUIS'].every((k) => html.includes(k) && sqlText.includes(k)));
t('génération et activation vérifient l\'offre avant d\'insérer', (html.match(/founderBlockMessage\(\)/g) || []).length >= 3);
t('le bouton de bascule est réservé au Master (contrôle navigateur + base)', /if \(!currentAdmin \|\| !currentAdmin\.isMaster\)/.test(html) && /is_master\(\)/.test(sqlText));
t('sql/27 : brouillon non appliqué, retour arrière documenté', /BROUILLON : NON APPLIQUÉ/.test(sqlText) && /RETOUR ARRIÈRE/.test(sqlText));
console.log('\nOK : 16 contrôles (offre Fondateur, logique du navigateur)');
