# Revue préalable de `sql/17_mode_stockage.sql` (version 2)

**Statut : sql/17 N'EST PAS appliqué (ni en préproduction, ni ailleurs). `app.html`, `sql/MANIFEST.json` (installateur), production, `main`, déploiement : inchangés.**
Tous les résultats ci-dessous sont des **tests LOCAUX SIMULÉS** (PostgreSQL local jetable avec imitation de l'authentification Supabase). **Aucun test n'a été exécuté sur le vrai Supabase dans cette revue** ; les vérifications réelles sont planifiées (§7) et demandent votre autorisation.

## 1. Défauts de la version 1 trouvés par la revue (bloquants) et corrections
| # | Défaut | Gravité | Correction (v2) | Preuve (locale simulée) |
|---|---|---|---|---|
| B1 | **Écriture perdue pendant la bascule** : une écriture sur l'ancien stockage validée juste après la lecture de la copie, mais avant le changement de mode, n'était dans aucune des deux sources | **Bloquant** | verrou consultatif PARTAGÉ pris par chaque écriture concernée, EXCLUSIF par la bascule (attend les écritures en cours, bloque les suivantes) | course réelle 6×60 écritures dans chaque sens : 0 perdue ; **test de mutation** : sans ces verrous le même test détecte **60 écritures perdues** (le test est donc capable de voir le défaut) |
| B2 | **Le journal n'était pas rapatrié** au retour en mode ancien (`fp_mig_rollback` ne traite que factures, devis, paiements) : les entrées créées en mode documents restaient invisibles de l'ancienne application | **Bloquant** | la bascule vers `legacy` réintègre dans `docLog` les entrées de `doc_history` manquantes (rang des entrées identiques compris), avec mise de côté de l'état précédent | 3 entrées (dont 2 identiques) réintégrées : 1 + 3 = 4, 0 doublon à la re-bascule |
| B3 | **Faux conflit → version périmée conservée** : après un aller-retour, une modification faite ensuite sur un ancien appareil était traitée comme conflit et le nouveau stockage (plus ancien) gardait la main | **Bloquant** | resynchronisation (`fp_mig_run`) à la fin du retour : l'empreinte de référence est alignée | d1 modifié sur l'ancien appareil après retour : rattrapé, 0 conflit |
| B4 | **Brouillon supprimé sur un ancien appareil non détecté** s'il avait été créé par le nouveau chemin (détection limitée aux lignes de migration) | **Bloquant** (condition 4) | détection de TOUT brouillon absent de l'ancien tableau et sans pierre tombale ; décision explicite exigée | n1 (créé en mode documents, supprimé sur l'ancien appareil) : `ARBITRAGE_REQUIS` |
| B5 | L'arrêt « conflits » reposait sur le compte de la dernière exécution : un 2e essai passait sans décision | Majeur | arbitrage recalculé sur l'état réel à chaque appel | 2 essais sans décision : toujours arrêté |
| B6 | Contrôle d'accès : repose sur l'e-mail | Majeur | liste d'autorisation serveur `doc_store_testers` ET e-mail de test, imposés aussi par un déclencheur sur `doc_store_mode` (refuse même une écriture SQL directe) ; fonction de bascule non appelable par l'API | e-mail seul : refusé ; liste seule (compte ordinaire) : refusé ; INSERT direct : refusé |
| B7 | Ancien appareil : erreur générique → file de réessais infinie | Majeur | SQLSTATE `42501` (l'ancienne version le traite comme un refus définitif, sans file de réessais — **lecture du code** `_syncToCloud`, non exécuté avec une ancienne version) + message `MODE_NOUVEAU_STOCKAGE` | test SQLSTATE |
| B8 | Bascule possible alors qu'un ancien appareil écrit encore | Majeur | refus `ACTIVITE_RECENTE_ANCIEN_APPAREIL` si écriture < 10 min (paramétrable) | test |
| B9 | Ordre de chargement/dépendances non vérifiés | Mineur | bloc de prérequis en tête (arrêt `PREREQUIS_MANQUANT`, rien créé) | test |

## 2. Droits, fonctions internes, gardes, dépendances, retour arrière du script
* **Fonctions** : `fp_doc_mode_set`, `fp_doc_mode`, trois fonctions de garde : non exécutables par `anon` ni `authenticated` (vérifié dans le catalogue, avec les privilèges par défaut Supabase imités). `get_doc_mode` et `append_history` : `authenticated` seulement. `service_role` (opérateur) garde l'exécution, comme pour `fp_mig_*`.
* **Tables** : `doc_store_mode`, `doc_store_testers` : RLS active, aucun droit `anon`/`authenticated`.
* **Gardes** : `trg_00_mode_user_data` (4 clés), `trg_00_mode_documents`, `trg_00_mode_doc_payments` (nommés `trg_00_` pour passer **avant** ceux de sql/14), `trg_doc_store_mode_check`. Suppression de compte et cascade non bloquées (testé).
* **Dépendances** : sql/14, 15, 16 ; aucun objet existant modifié. **Ordre** : après 16 ; hors installateur (`MANIFEST.json` inchangé).
* **Retour arrière du script** : documenté en tête de fichier (repasser d'abord tous les comptes en `legacy`, puis retirer les gardes) ; aucune donnée métier supprimée.
* Ré-application du script : sans erreur, modes conservés (testé).

## 3. Compatibilité avec sql/15 et sql/16 (déjà installés en préproduction)
* `fp_mig_run`, `fp_mig_verify`, `fp_mig_dry_run` : inchangés et **utilisables** sur un compte `documents` (bypass `fp_mig_active()`), sans toucher à `user_data` (testé).
* `fp_mig_rollback` appelé **directement** sur un compte `documents` ayant des écritures nouvelles : **refusé** par la garde (aucun effet partiel, testé). Il faut passer par `fp_doc_mode_set(…,'legacy')`. C'est voulu.
* `upsert_document`, `delete_document`, `record_payment` : non modifiés ; un compte `legacy` ne peut plus les utiliser (effet recherché).

## 4. Aller-retour documents → legacy après créations / modifications / suppressions
Comportement précis (testé, simulé) : modifications, créations, paiements (rejoués ou non), journal → repris dans `user_data` ; brouillons supprimés → retirés (pierre tombale) ; l'état précédent de chaque liste est conservé dans `_mig_source_backup` ; nouvelles tables conservées ; modification ultérieure sur ancien appareil rattrapée sans faux conflit ; suppression d'un brouillon sur l'ancien appareil signalée à la re-bascule. Un format inattendu (ex. `quotes` non tableau) fait **échouer toute la bascule vers legacy** avec `RESYNCHRO_ECHOUEE`, transaction annulée, mode inchangé.

## 5. Scripts de migration et de répétition
* Fonctions `fp_mig_*` : non bloquées (voir §3).
* `scripts/preprod-migration-rehearsal.js` (`rehearse`) écrit via `upsert_document` sur des comptes `legacy` : **bloqué par conception après sql/17**. Adaptation sûre appliquée : la commande refuse explicitement de s'exécuter si `doc_store_mode` existe (message clair) ; une répétition « mode » dédiée (bascule contrôlée) remplacera ce parcours (§7).
* `tests/sql/run.sh` ne charge pas sql/17 dans la chaîne commune (il l'est par `test_mode.sql`), `tests/integration/backend.js` non plus : aucune régression sur les suites existantes.

## 6. Protection contre les anciennes versions de l'application
1. **Erreur explicite** : `42501` + `MODE_NOUVEAU_STOCKAGE` (+ indice), visible dans la console/le réseau.
2. **Arrêt des tentatives** : l'ancienne version traite `42501` comme un refus (aucune file de réessais) — d'après la lecture de `_syncToCloud`, à confirmer par un test avec une ancienne version (non fait).
3. **Prévention** : refus de bascule si l'ancien stockage a été écrit depuis moins de 10 minutes.
4. **Limite connue** : l'ancienne version n'affiche rien à l'utilisateur (message console uniquement) et ses modifications restent dans son stockage local.
5. **Procédure de récupération** : (a) mettre à jour l'application sur l'appareil ; (b) le nouveau code (étape suivante, non écrite) détectera la copie locale ancien format plus récente que le serveur et la proposera comme conflits à importer, sans écrasement ; (c) à défaut, restauration par `fp_doc_mode_set(compte,'legacy')` (retour arrière complet, sauvegarde `_mig_source_backup`). Avant toute généralisation : contrôle de version minimale côté application.

## 7. Tests exécutés (tous LOCAUX / SIMULÉS) et plan réel (NON exécuté)
| Suite | Résultat |
|---|---|
| `tests/sql/test_mode.sql` (nouveau, 53 tests) + suites SQL existantes | **206 tests SQL réussis** (simulé) |
| `tests/integration/mode.test.js` (nouveau, 11 tests, connexions PostgreSQL concurrentes) | **11/11** : prérequis, ré-application, paiement rejoué ×12, 8 paiements simultanés, 10 appareils/même version, suppression vs modification ×8, bascules pendant 360 écritures dans chaque sens (0 perdue), 3 bascules simultanées |
| Existants : 37 app, 32 régression, 32 cloud, 6 concurrence, 18 migration, sécurité, 14 apply, 24 mock, 7 sauvegarde, 7 scanner | réussis (simulé) |
| **Supabase préproduction** | **aucun test exécuté** |

Plan réel proposé (après votre autorisation) : (1) sauvegarde préproduction restaurée et vérifiée ; (2) contrôle de cible ; (3) application de sql/17 en transaction, hors installateur ; (4) vérification des droits dans le catalogue réel + API (anon/authenticated) + conseillers de sécurité ; (5) comptes de test jetables : autorisation, bascule, parcours API, bascule retour, conflits, concurrence, RLS entre comptes ; (6) nettoyage des seuls comptes de test et contrôle « données étrangères inchangées ».

## 8. Risques restants
* Interblocage PostgreSQL rare pendant une bascule avec écritures simultanées : une transaction est annulée proprement (rien de perdu), à rejouer ; la bascule est déjà ré-essayée dans les tests.
* Les anciennes versions ne signalent rien à l'utilisateur (§6.4).
* Comportement réel des privilèges par défaut de Supabase pour les nouveaux objets : imité localement, **à confirmer sur le vrai Supabase** (étape 4).
* Aucun nouveau code `app.html` n'existe encore : le parcours utilisateur complet reste à construire et tester.
