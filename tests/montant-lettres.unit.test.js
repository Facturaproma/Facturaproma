// Montant en toutes lettres (bloc WORDS-CALC de app.html), sans navigateur.
const fs = require('fs'), path = require('path'), assert = require('assert');
const html = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
const a = html.indexOf('// <WORDS-CALC>'), b = html.indexOf('// </WORDS-CALC>');
assert(a > 0 && b > a, 'bloc WORDS-CALC introuvable');
const { amountInWordsFr, integerInWordsFr } = new Function(html.slice(a, b) + '\nreturn { amountInWordsFr, integerInWordsFr };')();
let n = 0; const eq = (v, exp) => { assert.strictEqual(v, exp); n++; console.log('PASS ' + exp); };
const w = integerInWordsFr;
eq(w(0), 'zéro'); eq(w(1), 'un'); eq(w(16), 'seize'); eq(w(17), 'dix-sept'); eq(w(21), 'vingt-et-un'); eq(w(22), 'vingt-deux');
eq(w(70), 'soixante-dix'); eq(w(71), 'soixante-et-onze'); eq(w(77), 'soixante-dix-sept');
eq(w(80), 'quatre-vingts'); eq(w(81), 'quatre-vingt-un'); eq(w(91), 'quatre-vingt-onze'); eq(w(99), 'quatre-vingt-dix-neuf');
eq(w(100), 'cent'); eq(w(101), 'cent-un'); eq(w(200), 'deux-cents'); eq(w(201), 'deux-cent-un'); eq(w(280), 'deux-cent-quatre-vingts'); eq(w(999), 'neuf-cent-quatre-vingt-dix-neuf');
eq(w(1000), 'mille'); eq(w(1001), 'mille-un'); eq(w(2000), 'deux-mille'); eq(w(80000), 'quatre-vingt-mille'); eq(w(200000), 'deux-cent-mille');   // pas de « s » devant « mille »
eq(w(11700), 'onze-mille-sept-cents'); eq(w(1000000), 'un-million'); eq(w(2000000), 'deux-millions'); eq(w(2500000), 'deux-millions-cinq-cent-mille'); eq(w(1000000000), 'un-milliard');
const f = amountInWordsFr;
eq(f(0), 'zéro dirham'); eq(f(1), 'un dirham'); eq(f(2), 'deux dirhams');
eq(f(11700), 'onze mille sept cents dirhams'); eq(f(720), 'sept cent vingt dirhams'); eq(f(1200), 'mille deux cents dirhams');
eq(f(120.5), 'cent vingt dirhams et cinquante centimes'); eq(f(0.01), 'zéro dirham et un centime'); eq(f(1.99), 'un dirham et quatre-vingt-dix-neuf centimes'.replace(/-/g, ' '));
eq(f(-300), 'trois cents dirhams'); eq(f(0.005 + 10), 'dix dirhams et un centime'); eq(f(NaN), 'zéro dirham'); eq(f('abc'), 'zéro dirham'); eq(f(1234567.89), 'un million deux cent trente quatre mille cinq cent soixante sept dirhams et quatre vingt neuf centimes');
console.log('\nOK : ' + n + ' contrôles (montant en lettres)');
