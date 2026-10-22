# Intégration du nouveau stockage dans `app.html` — rapport de préparation

**Branche locale `dev/integration-documents`** (issue de `dev/fondations` f7a2a171). **Rien n'est poussé, rien n'est fusionné, rien n'est déployé.**
Périmètre : PRÉPRODUCTION et comptes de TEST uniquement. Aucun compte basculé sur Supabase, aucune ligne `doc_store_mode` créée, aucune migration de données, `main`, l'installateur, le manifeste et la production intacts.

## 1. Audit de `app.html` (11 821 lignes)
Tous les accès passent par `Storage.get/set` (cache synchrone + copie locale `fp_<uid>_<clé>` + envoi asynchrone vers `user_data`). Inventaire (fonction → clé) :

| Clé | Lectures (`Storage.get`) | Écritures (`Storage.set`) |
|---|---|---|
| `invoices` (factures + avoirs) | 37 sites : tableau de bord, liste, éditeur, doublon, suppression, avoir, conversion de devis, clients (garde de suppression), CNSS, taxes, 10 rapports et exports CSV, export/compta, `resetApp`, paiements, relances | `deleteInvoice`, `createCreditFromInvoice`, `convertQuoteToInvoice`, `savePayment`, et `persistEditor` (clé dynamique `storageKey`) |
| `quotes` | 8 sites | `persistEditor`, `convertQuoteToInvoice`, `deleteQuote` |
| `payments` | `renderPayments`, `savePayment`, `exportData` | `savePayment` (seul point d'écriture) |
| `docLog` (journal) | `logDoc`, `applyEditorLock`, `exportData` | `logDoc` (tronqué à 2000 ; le tableau du cache est muté en place puis réécrit) |
| `counter` | `getNextNumber`, `getNextNumberPreview`, `exportData` | `getNextNumber` — le numéro officiel vient de `next_doc_number` (serveur) |
| `company` | 22 fonctions (PDF, relances, CNSS, compta…) | `finishOnboarding`, `handleLogoUpload`, `removeLogo`, `saveCompany` |

Synchronisation : `Storage._syncToCloud` (upsert de la clé entière dans `user_data`), `SyncManager.syncPending` (file `fp_pending_sync`), `Storage.loadFromCloud` (hydrate le cache), `Storage.clearAll` (supprime toutes les lignes `user_data`), `resetApp`.
Constats utiles : (a) les 4 clés sont écrites **en bloc** (tableau complet) → un diff par identifiant est nécessaire pour passer à une ligne par document ; (b) `savePayment` écrit les paiements **puis** modifie la facture (`paidAmount`, `status`) : en mode documents le serveur recalcule ces champs (`record_payment`), la mise à jour dérivée n'est donc pas renvoyée ; (c) `_syncToCloud` traitait tout `42501` comme « licence expirée » (`License.refresh()` puis silence) : un refus `MODE_NOUVEAU_STOCKAGE` (aussi SQLSTATE 42501) aurait été masqué ; (d) `SyncManager.syncPending` **ignorait** l'objet `error` renvoyé par l'upsert et comptait toujours « synchronisé » ; (e) `clearAll`/`resetApp` suppriment tout `user_data` ; (f) la copie locale des 4 clés partageait la même clé que l'ancien stockage.

## 2. Architecture : une seule source de vérité par compte
| Mode (décidé par le SERVEUR) | Source d'autorité | Chemin d'écriture des 4 clés | Copie locale |
|---|---|---|---|
| `legacy` (défaut, tous les comptes, **tous les builds de production**) | `user_data` | `Storage._syncToCloud` — comportement historique | `fp_<uid>_<clé>` |
| `documents` | `documents`, `doc_payments`, `doc_history` | `docstore.js` : `upsert_document`, `delete_document`, `record_payment`, `append_history` ; **aucune** écriture dans `user_data` pour ces clés | `fpd_<uid>_<clé>` (séparée) |
| `blocked` (mode inconnu/inattendu, chargement impossible) | aucune | lecture seule, écritures refusées localement avec message | `fpd_…` si elle existe |

Pas de double écriture ni de synchronisation silencieuse entre les deux modes : un compte n'a qu'un chemin d'écriture ; le serveur refuse l'autre (déclencheurs `trg_00_mode_*` de `sql/17`). Les autres clés (`company`, `clients`, `products`, `counter`…) restent dans `user_data` dans les deux modes.

**Trois verrous indépendants pour entrer en mode `documents`** (`docstore.js`, `detect()`), tous nécessaires :
1. URL Supabase du build = **préproduction** (`njjaomichdlnoscrnxlz`), jamais la production. `app.html` du dépôt garde l'URL de production : seul un build produit par `scripts/make-preprod-build.js` (dossier `.preprod-build/`, ignoré par Git, jamais déployé) peut activer le mode.
2. E-mail du compte `*@facturapro-test.invalid` (le serveur l'exige aussi : `COMPTE_NON_TEST`).
3. Le serveur répond `documents` à `get_doc_mode()` (liste `doc_store_testers` + e-mail, vérifiés côté serveur). Un indicateur local (`fpd_hint_<uid>`) ne peut **jamais** autoriser ce mode : hors ligne il ne fait que **restreindre** (`blocked`, lecture seule).
Si `get_doc_mode` est absente (sql/17 non installé) → `legacy`. Sur un build de production ou un compte ordinaire, `get_doc_mode` n'est même pas appelé.

## 3. Gestion des erreurs (aucun masquage, aucune boucle)
| Situation | Comportement |
|---|---|
| Ancien chemin reçoit `42501` + `MODE_NOUVEAU_STOCKAGE` | **distinct de la licence** : drapeau `refused`, bandeau explicite « rechargez », entrées de file ancienne des 4 clés purgées, écritures suivantes refusées localement (toast), **aucun nouvel appel**, `License.refresh()` non déclenché |
| Nouveau chemin reçoit `MODE_ANCIEN_STOCKAGE` (compte repassé en legacy) | arrêt (`halted`), bandeau explicite, modifications en attente **conservées** (persistées) mais non rejouées, aucune nouvelle tentative automatique ; rechargement → mode `legacy` |
| `42501` autre / `PGRST301` / 401-403 (droits, licence) | arrêt, message, **un seul** appel, file conservée, bouton « Réessayer » |
| Erreur réseau | file conservée et persistée ; **3 essais automatiques au plus** (2 s, 8 s, 30 s) puis attente d'un événement (retour en ligne, nouvelle action, bouton) |
| Erreur fonctionnelle (`FACTURE_VERROUILLEE`, `NUMERO_EN_DOUBLE`, `LICENCE_INACTIVE`, `PAIEMENT_*`…) | message, opération retirée (jamais rejouée), état réaligné sur le serveur |
| Conflit de version (2 appareils) | opération retirée, conflit conservé avec **les deux versions** ; bandeau ; choix explicite « garder la mienne » (réappliquée sur la version serveur) / « garder le serveur » ; une version locale n'est jamais écrasée sans choix ; `reload()` refuse d'écraser tant qu'il reste file ou conflit |
| Réponse perdue (serveur a appliqué, client non informé) | rejeu avec le même `op_id` : une seule ligne, aucune duplication |
| Document supprimé sur un autre appareil | signalé au rechargement (message), jamais recréé silencieusement ; modification d'un document supprimé ailleurs → conflit « supprimé » (recréer / abandonner) |

## 4. Fichiers modifiés ou ajoutés
`docstore.js` (nouveau), `app.html` (glue `DocStoreGlue` ; `Storage._buildLocalKey/set/_syncToCloud/loadFromCloud/setCurrentUser/clearAll`, `SyncManager.syncPending`, `resetApp`, 3 déconnexions), `sw.js` (cache `docstore.js`, version v17), `scripts/make-preprod-build.js` (nouveau), `.gitignore`, `package.json`, `tests/docstore.unit.test.js`, `tests/preprod-build.test.js`, `tests/integration/docstore.browser.test.js` (nouveaux), `tests/integration/backend.js` et `fake_supabase.js` (support des tables/RPC du nouveau stockage, réponse perdue, démarrage hors ligne), `tests/integration/mode.test.js` (cause d'arrêt conservée, reprise sur « activité récente », prérequis sans `catch` silencieux), `scripts/preprod-mode-validation.js` (même reprise légitime), workflows `preprod*.yml` (voir §6), ce document. **Inchangés :** `sql/*`, `sql/MANIFEST.json`, installateur, `main`, production.

## 5. Tests exécutés — TOUS SIMULÉS (aucun n'a touché Supabase)
| Suite | Résultat | Nature |
|---|---|---|
| `tests/app.test.js`, `regression.test.js` | 37/37, 32/32 | navigateur + stockage local (inchangés) |
| `tests/docstore.unit.test.js` | 47/47 | logique pure + faux client en mémoire : verrous build/compte/serveur, indicateur local, diff, file, fusion, reprise, plafond de 3 essais, erreurs, conflits, journal, paiements |
| `tests/integration/docstore.browser.test.js` | 68/68 | `app.html` + faux client Supabase + **PostgreSQL local** (sql 00…17 réels) : parcours complet (brouillon, modification, émission, paiements partiel/total, avoir, devis, conversion, suppression, journal, société, compteur), rechargement, coupure réseau + reprise, réponse perdue, 2 appareils (numérotation concurrente, 4 types de conflits), retour vers legacy, build de production, compte ordinaire, indicateur local, hors-ligne bloqué, `resetApp` |
| `cloud`, `concurrence`, `migration`, `mode` (intégration) | 32/32, 6/6, 18/18, 11/11 | PostgreSQL local (mode : 30 exécutions consécutives sans échec après correction du test) |
| `tests/sql` | 206/206 | PostgreSQL local |
| `test:preprod-local` | tout réussi, dont 5/5 build de préproduction | simulé |
Tests de mutation (code volontairement cassé → les tests échouent) : refus `MODE_NOUVEAU_STOCKAGE` non traité (2 échecs), verrou de build ouvert (3 + 3 échecs), plafond de réessai supprimé (2 échecs).
**Réel (Supabase préproduction) pour cette étape : AUCUN.** Seuls les résultats de `sql/15–17` (101/101, rapports de la branche `preprod-reports`) sont réels ; ils ne prouvent pas le comportement de l'interface.

## 6. Scripts et workflows (point 8)
Supprimés : `|| true` sur la lecture de `preprod-reports` et sur la création de la branche orpheline (5 workflows `preprod*.yml`) → vérification explicite, échec si le dépôt distant est illisible. Le test `mode.test.js` n'ignorait plus silencieusement l'échec de ses prérequis. **Exceptions restantes, justifiées :** `set +e` des étapes d'analyse de secrets (le code de retour est capturé puis fait échouer le job) ; `.catch(() => {})` sur `ROLLBACK`/fermeture de connexion (l'erreur d'origine est relancée ou enregistrée). **À examiner (non modifié, hors périmètre préproduction) :** `.github/workflows/backup.yml:80` convertit l'échec de l'export des comptes en simple avertissement ; `preprod-logscan.yml` compte les journaux indisponibles sans faire échouer le job.

## 7. Risques restants
1. **Non validé sur Supabase.** Lectures PostgREST (`.order().range()` sur `documents`/`doc_payments`/`doc_history`, politiques RLS), jetons réels, latence : à valider (§8). Un défaut a été trouvé et corrigé par relecture du schéma (`doc_history` n'a pas de colonne `created_at`) ; d'autres écarts simulation/réel sont possibles.
2. **Changement de comportement du chemin legacy** (à relire avant toute généralisation) : `SyncManager.syncPending` ne déclare plus « synchronisé » une écriture refusée ; une erreur réseau garde l'entrée en file (avant : perdue en silence) ; `_syncToCloud` traite d'abord `MODE_NOUVEAU_STOCKAGE`. Aucun effet sur les comptes dont la base n'a pas `sql/17`, mais le comportement hors ligne évolue.
3. **Anciennes versions de l'application** : en mode `documents` elles reçoivent `42501 MODE_NOUVEAU_STOCKAGE` et le traitent comme une licence expirée (silence). Sans objet pour les seuls comptes de test ; indispensable à traiter (version minimale) avant tout élargissement.
4. **Retour vers legacy avec modifications en attente** : la file `fpd_q_<uid>` est conservée localement mais jamais rejouée ni fusionnée automatiquement dans l'ancien stockage (volontaire : pas de synchronisation silencieuse). Procédure de reprise manuelle à définir.
5. Paiements : la modification/suppression d'un paiement n'est pas prise en charge côté serveur (signalée, jamais silencieuse). Interface de conflit minimale (`confirm()`), à améliorer. Deux onglets du même appareil partagent la file (rejeux sans effet grâce aux `op_id`, mais non testé en navigateur).
6. Une facture issue d'une coupure pendant l'émission reste soumise à la numérotation serveur existante (`getNextNumber`), inchangée.
7. `app.html` ajoute ~190 lignes : relecture humaine du diff recommandée (`git diff dev/fondations -- app.html`).

## 8. Procédure de validation manuelle (chaque étape réelle exige votre autorisation)
0. Revue du diff, exécution locale de `npm run test:all` (PostgreSQL local requis).
1. `node scripts/make-preprod-build.js` → `.preprod-build/` ; le servir en local (`python3 -m http.server -d .preprod-build`). *Aucun déploiement.*
2. **[autorisation requise]** Créer 2 comptes jetables `*@facturapro-test.invalid` sur la préproduction, les inscrire dans `doc_store_testers`, créer quelques factures en mode legacy avec le build, puis basculer UN compte (`fp_doc_mode_set`) ; sauvegarde préalable restaurée/vérifiée et empreinte des données préexistantes avant/après, comme pour `sql/17`.
3. Compte basculé : créer/modifier/supprimer un brouillon, émettre (numéro serveur), encaisser (partiel puis solde), créer un avoir, un devis puis le convertir ; recharger ; vérifier côté base (`documents`, `doc_payments`, `doc_history`) et que `user_data` n'a pas bougé.
4. Deux navigateurs sur le même compte : émissions simultanées (numéros distincts) ; modification simultanée d'un brouillon (conflit, les deux choix) ; suppression vs modification.
5. Couper le réseau (mode avion), créer un brouillon, recharger hors ligne puis en ligne : reprise sans doublon.
6. Repasser le compte en legacy (`fp_doc_mode_set`) avec l'application ouverte : message `MODE_ANCIEN_STOCKAGE`, aucune boucle ; recharger : toutes les données présentes.
7. Compte ordinaire sur le même build : comportement strictement historique.
8. Nettoyage des seuls comptes créés ; vérification des orphelins et de l'empreinte.
