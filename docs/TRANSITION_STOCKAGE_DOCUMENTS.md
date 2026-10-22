# Transition progressive vers le stockage « une ligne par document » — architecture proposée

**Statut : PROPOSITION à valider. `app.html` n'est pas modifié. `sql/17_mode_stockage.sql` est un brouillon non appliqué, absent de `sql/MANIFEST.json` (donc de l'installateur).**
Périmètre : PRÉPRODUCTION et comptes de TEST uniquement. Aucune migration automatique, aucune bascule générale, ancien stockage conservé.

## 1. Principe : un mode par compte, décidé par le serveur, une seule source d'écriture
| Mode | Source qui fait autorité | Écritures refusées par le serveur | Ancien stockage (`user_data`) |
|---|---|---|---|
| `legacy` (défaut, tous les comptes) | `user_data` : invoices, quotes, payments, docLog | `documents`, `doc_payments`, `doc_history` via `upsert_document`, `delete_document`, `record_payment`, `append_history` → `MODE_ANCIEN_STOCKAGE` | lu et écrit comme aujourd'hui |
| `documents` (comptes `*@facturapro-test.invalid` uniquement) | `documents`, `doc_payments`, `doc_history` | écritures sur les 4 clés de `user_data` → `MODE_NOUVEAU_STOCKAGE` | **figé en lecture**, intact (retour arrière) |

* **Pas de double écriture** : l'application n'écrit jamais dans les deux. Et même si elle essayait (ancienne version, bogue), le serveur refuse : le mode est vérifié par des déclencheurs `trg_00_mode_*`, qui s'exécutent avant ceux de sql/14.
* **Pas de doublon** : chaque document a une identité unique `(compte, type, id)` ; la copie initiale est idempotente (sql/16) ; chaque écriture porte un identifiant d'opération (`op_id`) rejouable sans effet.
* Le mode est lu par `get_doc_mode()` (son propre compte uniquement). Seule la fonction interne `fp_doc_mode_set` (non appelable par l'API) le change, après : refus de tout compte non-test, rattrapage de copie, vérification, arbitrage des brouillons (§3).

## 2. Isolation du mode de test (trois verrous indépendants)
1. **Build** : `app.html` garde l'URL de production ; le nouveau code ne s'active que si la référence du projet Supabase de l'URL = la préproduction (`scripts/preprod-target.json`). Un build de production ne peut donc PAS l'activer. Pour tester, un script produit une copie `.preprod-build/app.html` (ignorée par Git, jamais déployée) avec l'URL/clé anon de la préproduction.
2. **Compte** : e-mail `*@facturapro-test.invalid` exigé côté client ET côté serveur (`fp_doc_mode_set` → `COMPTE_NON_TEST`).
3. **Serveur** : mode `documents` explicite par compte ; tous les autres restent `legacy` et leur comportement est strictement celui d'aujourd'hui (code ancien non modifié sur ce chemin, vérifié par les tests existants).

## 3. Brouillon supprimé sur un ancien appareil (cas explicite)
* **Après la bascule** : un ancien appareil qui tente de supprimer/modifier un brouillon dans l'ancien tableau reçoit `MODE_NOUVEAU_STOCKAGE` : la suppression n'est ni appliquée en silence ni perdue côté serveur ; elle est **signalée** (erreur visible) et l'élément reste dans le nouveau stockage.
* **Avant la bascule** (brouillon supprimé sur un ancien appareil alors que `documents` l'avait déjà copié) : `fp_doc_mode_set` détecte les brouillons de `documents` jamais modifiés depuis la copie et absents de l'ancien tableau, **s'arrête** (`ARBITRAGE_REQUIS`) en renvoyant la liste, et n'avance que sur décision explicite `keep` (conservé) ou `delete` (supprimé avec pierre tombale) ; la décision est notée dans `_mig_conflicts`.
* **Nouveau chemin, deux appareils** : suppression d'un brouillon modifié ailleurs → `delete_document` renvoie un conflit (version) : le brouillon est restauré localement avec une bannière, jamais supprimé. Modification d'un brouillon supprimé ailleurs → conflit « supprimé sur un autre appareil » : choix « recréer » ou « abandonner » (le contenu local reste affiché jusqu'au choix).
* **Retour arrière** : un brouillon supprimé sur un ancien appareil après la copie réapparaît dans `user_data` (comportement déjà vérifié sur Supabase préproduction, run 39744373405) : aucune perte.

## 4. Adaptation de l'application (à faire après validation) — greffe sous `Storage`, sans toucher aux écrans
`Storage.get/set('invoices'|'quotes'|'payments'|'docLog')` reste synchrone sur un cache : les ~100 usages de l'application ne changent pas.
* Nouveau module `docstore.js` (testable hors navigateur), chargé par `app.html` et ajouté au cache du service worker :
  * `detect()` : triple verrou (§2) → `legacy` (comportement actuel, inchangé) ou `documents`.
  * `load()` : lit `documents`, `doc_payments`, `doc_history` ; reconstruit les 4 tableaux du cache + table des versions `{type:id → version}`.
  * `commit(key, avant, après)` : à chaque `Storage.set` de ces clés, calcule la différence par identifiant → opérations :
    création/modification → `upsert_document(doc, version vue, op_id)` ; suppression de brouillon → `delete_document` ; nouveau paiement → `record_payment` (le serveur recalcule `paidAmount`/statut ; la modification de facture correspondante n'est pas renvoyée) ; nouvelles entrées de journal → `append_history` (identifiant par entrée).
  * **File d'opérations persistante** (localStorage par compte) : rejouée dans l'ordre après coupure réseau/rechargement ; les `op_id` rendent le rejeu inoffensif ; une erreur réseau ne perd rien, une erreur fonctionnelle (verrouillage, numéro, licence) est affichée.
  * **Conflits** (`ok:false, conflict:true`) : stockés, bannière « N conflit(s) » + fenêtre comparant version serveur / locale ; actions : garder le serveur, réappliquer les miennes (sur la nouvelle version), recréer/abandonner. Rien n'est écrasé sans choix.
  * `refresh()` (focus, retour en ligne) : applique les changements distants sans opération locale en attente ; document disparu côté serveur = suppression distante **signalée** (toast + journal local, restauration possible).
* `Storage.loadFromCloud` / `_syncToCloud` : en mode `documents`, ces 4 clés sont exclues de `user_data` (aucune écriture de ce côté).
* Numérotation : inchangée (`next_doc_number` puis `upsert_document` avec le numéro attribué).

## 5. Script SQL proposé : `sql/17_mode_stockage.sql` (brouillon)
Effet attendu : crée `doc_store_mode`, `fp_doc_mode`, `get_doc_mode`, `append_history`, `fp_doc_mode_set` (interne), 3 déclencheurs de garde `trg_00_mode_*`. **Ne modifie aucune fonction ni table existante.** Retour arrière documenté en tête du fichier (aucune donnée métier supprimée).
* Ordre : après 14, 15, 16. Compatibilité : mode `legacy` par défaut ⇒ aucun changement de comportement pour les comptes existants, y compris pour l'API de sql/15 (les écritures `documents` des comptes `legacy` sont désormais refusées : seul l'effet voulu).
* Conséquence à connaître : les tests de répétition de la migration (comptes `legacy` qui écrivent via `upsert_document`) ne fonctionneraient plus après sql/17 ; ils devraient d'abord basculer le compte en `documents` (déjà couvert par `tests/sql/test_mode.sql`).
* **Non ajouté à l'installateur** : `MANIFEST.json` / `ordre` inchangés. Si vous validez l'installation en préproduction : application manuelle, en transaction, comme pour 15/16 pendant la répétition.

## 6. Tests prévus (réels vs simulés)
| Niveau | Quoi | Nature |
|---|---|---|
| SQL local | `tests/sql/test_mode.sql` (27 tests réussis : modes, refus croisés, comptes ordinaires, brouillons à arbitrer, retour arrière, suppression de compte, anon) | **simulé** (PostgreSQL local) |
| Module | `tests/integration/docstore.test.js` : diff, file d'opérations, rejeu, conflits, coupure réseau sur la vraie base locale | **simulé** |
| Navigateur | Playwright : parcours facture/devis/avoir/paiement/journal (création, modification, suppression de brouillon, émission, consultation, rechargement, coupure réseau, 2 appareils) sur la vraie base locale + faux client | **simulé** |
| **Supabase préproduction** | mêmes parcours via un build de préproduction, comptes `mig-…@facturapro-test.invalid`, workflow GitHub Actions dédié, contrôle « données étrangères inchangées » avant/après, nettoyage des seuls comptes de test | **réel** |
| Régression | `npm run test:all` après chaque étape (37 app, 32 régression, 153+27 SQL, cloud, concurrence, …) | simulé |

## 7. Risques connus avant toute généralisation
* **Anciennes versions de l'application** déjà installées : en mode `documents`, elles reçoivent une erreur et leur file de synchronisation réessaiera indéfiniment ; avant toute généralisation il faudra un contrôle de version minimale côté client. Sans objet pour les seuls comptes de test.
* Le service worker met l'application en cache : le nouveau module doit être versionné avec elle.
* Bascule générale, migration de production, suppression de l'ancien stockage : **hors périmètre, autorisation distincte requise.**

## 8. Étapes et ce qui fait autorité
| Étape | Action | Autorité (par compte) |
|---|---|---|
| 0 (aujourd'hui) | rien | `user_data` |
| 1 | appliquer sql/17 en préproduction (après votre accord sur le script) | `user_data` (tous en `legacy`) |
| 2 | `docstore.js` + greffe `Storage`, tests locaux | `user_data` (rien n'est activable hors préproduction) |
| 3 | bascule d'un compte de test (`fp_doc_mode_set`) + tests réels | `documents` pour ce seul compte |
| 4 | rapport, risques, décision | — |
| 5 (non autorisé ici) | généralisation, production | — |
