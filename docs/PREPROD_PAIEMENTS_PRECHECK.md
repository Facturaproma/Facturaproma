# Plafond des paiements : contrôles préalables en préproduction (lecture seule)

Relevé du 24/10/2026. **Seules des requêtes de lecture** ont été exécutées (aucune écriture, aucune migration, production non interrogée). Avant la fusion de cette PR, rien n'est installé : `sql/25_plafond_paiements.sql` n'est pas dans `sql/MANIFEST.json` et `ops/preprod-paiements.json` reste « non autorisé ».

## 1. Identification certaine du projet cible
| Contrôle | Résultat |
|----------|----------|
| Référence dans `scripts/preprod-target.json` | `njjaomichdlnoscrnxlz` (préproduction) ; production déclarée à part : `mdozjptoecygmpkjlohr` |
| Projet lu via l'API de gestion | nom `facturapro-preprod`, région eu-north-1, statut ACTIVE_HEALTHY, créé le 21/10/2026, base PostgreSQL 17 |
| Les deux projets sont distincts | oui (2 projets : `facturapro-preprod` et `facturapro-prod`, créé le 29/04/2026) |
| Garde-fous du script | refus de toute URL de connexion mentionnant la production ou un autre projet ; marqueur `public._fp_env` exigé ; vérifiés dans `tests/integration/preprod-paiements-rehearsal.test.js` |

## 2. État de la préproduction (lecture seule)
- `record_payment` présent ; **empreinte md5 de sa définition = `437d99973de84c9b3ad9f7bcc456635c`, identique à celle de sql/15 installé dans la base locale de test** : la préproduction exécute bien la fonction que les tests simulent.
- Droits : `anon` sans droit d'exécution, `authenticated` avec.
- Tables `documents`, `doc_payments`, `doc_history`, `doc_store_mode`, `doc_store_testers`, `doc_counters`, `user_data`, `licenses` présentes (sql/15, 16, 17 installés).
- Données : 3 comptes, 0 document, 0 paiement, 0 compte en mode « documents ». Aucun risque d'effet sur des données existantes ; les comptes `pay-a` / `pay-b` seraient les seuls à passer en mode « documents ».
- Limite : la requête avait la transaction non en lecture seule par défaut (réglage de l'outil) ; elle ne contenait que des SELECT. Le script officiel (`precheck`) ouvre `BEGIN READ ONLY` et le vérifie.

## 3. Ce qui a été préparé (rien d'exécuté sur Supabase)
- `sql/25_plafond_paiements.sql` : brouillon, prérequis vérifiés, droits ré-affirmés, retour arrière = bloc `record_payment` de sql/15.
- `scripts/preprod-paiements-validation.js` : phases `precheck` (lecture seule), `install` (sauvegarde de la définition, application), `test` (comptes jetables `pay-a` / `pay-b`, mêmes contrôles que la simulation locale), `cleanup` (suppression des comptes de test, `--rollback` restaure sql/15). Les trois phases d'écriture sont refusées sans autorisation écrite dans `ops/preprod-paiements.json`.
- `.github/workflows/preprod-paiements.yml` : copie adaptée du circuit existant (déclenché seulement sur `dev/fondations` par une modification de `ops/preprod-paiements.json`, secret `PREPROD_DB_URL`, sauvegarde restaurée avant install/test, analyse de secrets). **Inerte tant qu'il n'est pas présent sur `dev/fondations`.**
- Répétition locale complète des 4 phases et des refus : `tests/integration/preprod-paiements-rehearsal.test.js` (9 contrôles, base PostgreSQL locale jetable : SIMULATION).

## 4. Pour lancer (après votre autorisation écrite)
1. Vous autorisez explicitement la préproduction (phrase du type « J'autorise l'installation et la validation de sql/25 sur la préproduction facturapro-preprod »).
2. Je rejoue `precheck` via le circuit (secret `PREPROD_DB_URL` de l'environnement GitHub « preprod »), puis `install`, `test`, `cleanup`, chacune par une modification de `ops/preprod-paiements.json` (`authorized: true`, `authorized_on`).
3. Le rapport est publié sur la branche `preprod-reports` après analyse de secrets (aucun identifiant dans le rapport).
4. Décision go / no-go, puis seulement ensuite la question de la production.

## 5. Non couvert par ce plan
- Le message d'erreur affiché à l'utilisateur quand le serveur refuse (à vérifier avec un navigateur sur la préproduction déployée, après installation).
- Les comptes « legacy » (hors nouveau stockage) : `record_payment` ne les concerne pas.
- `tests/integration/mode.test.js` enregistre 15 DH sur une facture de 12 : à adapter si sql/25 devient définitif.
