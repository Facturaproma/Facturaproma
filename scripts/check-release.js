#!/usr/bin/env node
// Contrôle de mise en vente (lecture seule : aucun réseau, aucune base, aucun secret).
//   node scripts/check-release.js            -> GARDE-FOUS + BLOCAGES : échoue tant que des contacts ou champs légaux factices subsistent
//   node scripts/check-release.js --guards   -> GARDE-FOUS seulement (utilisé par « npm test ») : défauts déjà corrigés qui ne doivent pas revenir
// Ne vérifie PAS ce qu'un fichier ne peut pas prouver (domaine possédé, boîte e-mail réelle, statut juridique, validation fiscale) : voir « À CONFIRMER ».
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const guardsOnly = process.argv.includes('--guards');
const guards = [], blockers = [];
const guard = (name, ok, extra = '') => guards.push([!!ok, name, extra]);
const blocker = (name, ok, extra = '') => blockers.push([!!ok, name, extra]);

const app = read('app.html'), idx = read('index.html'), legal = read('legal.html'), admin = read('admin.html'), readme = read('README.md');

// ---- GARDE-FOUS : défauts corrigés qui ne doivent pas revenir
guard('aucune mention « le seul logiciel » (non démontrable)', !/le seul logiciel/i.test(idx + app));
guard('aucune promesse « déclarations CNSS et impôts automatiques »', !/déclarations CNSS et impôts automatiques/i.test(app + idx));
guard('aucun « ID demande » inventé côté client (il ne correspond à aucune ligne en base)', !/ID demande/.test(app));
guard('les relances ne sont pas présentées comme « automatiques »', !/relances automatiques/i.test(app + idx + readme));
const certLines = (app + idx + legal + readme).split('\n').filter((l) => /certifi/i.test(l) && !/(non|pas|n'est|jamais|sans)\b/i.test(l));
guard('aucune affirmation « certifié » (DGI ou autre) sans négation', certLines.length === 0, certLines.slice(0, 2).map((l) => l.trim().slice(0, 100)).join(' | '));
const priceOk = (t) => /49\s*DH/.test(t) && /449\s*DH/.test(t) && /299\s*DH/.test(t);
guard('tarifs 49 / 449 / 299 DH présents et cohérents (accueil, conditions, administration)', priceOk(idx) && priceOk(legal) && priceOk(admin));
guard('README: plus de tarifs périmés (Lifetime, 99 DH, 199 DH) ni de codes promo périmés', !/Lifetime|99 DH\/mois|199 DH\/mois|LANCEMENT2026|WELCOME10/.test(readme));
const docLinks = [...readme.matchAll(/\]\((docs\/[^)]+)\)/g)].map((m) => m[1]);
const missingDocs = docLinks.filter((p) => !fs.existsSync(path.join(ROOT, p)));
guard('README: tous les liens vers docs/ existent', missingDocs.length === 0, missingDocs.join(', '));
const localHrefs = [...(idx + app + legal).matchAll(/href="([^"#?][^"]*)"/g)].map((m) => m[1]).filter((h) => !/^(https?:|mailto:|tel:|data:|javascript:)/.test(h));
const missingFiles = [...new Set(localHrefs.map((h) => h.split(/[?#]/)[0]))].filter((p) => p && !fs.existsSync(path.join(ROOT, p)));
guard('liens locaux de l\'accueil, de l\'application et des conditions : fichiers existants', missingFiles.length === 0, missingFiles.join(', '));

// ---- BLOCAGES : valeurs factices à remplacer avant d'ouvrir à des clients (nécessitent une décision de ton côté)
// Le WhatsApp et l'e-mail de support ne sont PLUS dans le code : ils se saisissent dans Admin → Réglages (fonction SQL get_contact_info).
guard('app.html : aucun numéro ou e-mail de contact factice codé en dur', !/6XX|wa\.me\/2126000|hello@facturapro\.ma/.test(app));
guard('index.html : aucun numéro ou e-mail de contact factice codé en dur', !/6XX|wa\.me\/2126000|hello@facturapro\.ma/.test(idx));
guard('app.html : plus d\'offre « espèces » pour payer l\'abonnement ; plus de code promo public', !/Espèces \(Casa|ESPÈCES|COMPTABLE'/.test(app) && !/sectionPromoCode"/.test(app.replace(/getElementById\('sectionPromoCode'\)/g, '')));
guard('offre Fondateur : 30 places partout (accueil, conditions, administration, README)', [idx, legal, admin, readme].every((t) => !/\b20 (places|codes|max)/.test(t)) && /30 places/.test(idx) && /30 places/.test(legal) && /FOUNDER_LIMIT = 30/.test(admin));
guard('admin.html : le message au client n\'envoie jamais un RIB factice (« [À COMPLÉTER] ») ; le RIB vient des Réglages', !/À COMPLÉTER/i.test(admin) && /cfg\.bank_rib/.test(admin));
guard('admin.html : « Réglages enregistrés » n\'est affiché que si l\'écriture a réussi', /upErr\) throw upErr/.test(admin));
const sqlContact = fs.existsSync(path.join(ROOT, 'sql/18_contact_public.sql'));
guard('sql/18_contact_public.sql présent (fonction get_contact_info utilisée par app.html)', sqlContact && /get_contact_info/.test(app));
const todos = (legal.match(/class="todo"/g) || []).length;
blocker('legal.html : champs « [À compléter] » renseignés (société, ICE, TTC, paiement, remboursement, tribunal, CNDP)', todos === 0, todos + ' champ(s) restant(s)');
blocker('legal.html : adresse e-mail légale réelle (pas hello@facturapro.ma tant que le domaine n\'est pas acheté)', !/hello@facturapro\.ma|e-mail de contact à créer/.test(legal));
blocker('README : contact réel (pas « +212 6XX… »)', !/\+212 6XX/.test(readme));

const show = (title, list) => { console.log('\n' + title); for (const [ok, name, extra] of list) console.log((ok ? '  OK   ' : '  FAIL ') + name + (ok || !extra ? '' : ' -> ' + extra)); };
show('GARDE-FOUS (défauts corrigés)', guards);
let bad = guards.filter((g) => !g[0]).length;
if (!guardsOnly) {
  show('BLOCAGES AVANT VENTE (décisions requises)', blockers);
  bad += blockers.filter((b) => !b[0]).length;
  console.log('\nÀ CONFIRMER (non vérifiable par un fichier) :');
  console.log('  - Admin → Réglages renseigné en base (WhatsApp, e-mail, RIB) APRÈS application du SQL 18 en préproduction puis en production (sur autorisation)');
  console.log('  - sql/18_contact_public.sql ajouté à sql/MANIFEST.json au moment du déploiement (non fait ici)');
  console.log('  - le statut juridique pour encaisser (conditions de vente et mentions légales)');
  console.log('  - la mention TVA des auto-entrepreneurs imprimée sur le PDF (référence d\'article du CGI) : validation par un comptable');
  console.log('  - la déclaration CNDP et la qualification de l\'hébergement hors du Maroc');
}
console.log(`\n${bad === 0 ? 'OK' : 'ÉCHEC'} : ${guards.filter((g) => g[0]).length}/${guards.length} garde-fous${guardsOnly ? '' : ', ' + blockers.filter((b) => b[0]).length + '/' + blockers.length + ' blocages levés'}`);
process.exit(bad ? 1 : 0);
