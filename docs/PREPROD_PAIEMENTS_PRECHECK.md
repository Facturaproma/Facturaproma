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

## Quels comptes sont réellement protégés ? (vérification du 24/10/2026)
| Catégorie de compte | Protection contre le trop-perçu | Où |
|---|---|---|
| Mode « documents » (liste `doc_store_testers`, sql/17) | Navigateur **+ serveur** si `sql/25` est installé (`record_payment`) | sql/25 |
| Mode « legacy » (tous les autres, y compris tous les clients réels à ce jour) | Navigateur seulement ; **serveur seulement si `sql/26` est installé** (déclencheur sur `user_data`, clé `payments`) | sql/26 |
| Ancien navigateur / application non mise à jour / appel direct à l'API | Aucune sans `sql/25` ou `sql/26` | — |

Requête **en lecture seule** pour compter les comptes par mode (à exécuter par le propriétaire sur le projet voulu ; elle n'écrit rien) :
```sql
SELECT COALESCE(m.mode, 'legacy') AS mode, count(*) FROM auth.users u LEFT JOIN public.doc_store_mode m ON m.user_id = u.id GROUP BY 1;
```
Préproduction (lecture seule, vérifiée) : 3 comptes, tous en legacy, 0 en mode documents. Production : **non vérifiée** (interdit sans votre accord).

### Solution pour couvrir les comptes legacy : `sql/26_plafond_paiements_legacy.sql` (brouillon non appliqué)
- Déclencheur `BEFORE INSERT OR UPDATE` sur `user_data` pour la clé `payments` ; seuls les **nouveaux** paiements sont contrôlés (cumul par facture ≤ TTC + 0,01 ; TTC ≤ 0 refusé) ; un ancien trop-perçu ne bloque rien rétroactivement.
- L'application écrit par *upsert* : le test a révélé que l'ancienne valeur doit être relue dans la table (OLD n'existe pas dans le déclencheur INSERT), corrigé.
- Test local `tests/integration/paiements.legacy-plafond.test.js` : **13 contrôles OK** (dont la preuve que, sans sql/26, un paiement de 1500 sur 1000 passe), PostgreSQL 16 local jetable, données fictives.
- **Limites** : facture absente de `user_data` → paiement accepté ; cumul des lignes seulement (pas `paidAmount`) ; en mode legacy le dernier écrivain gagne (deux onglets simultanés écrasent, ce n'est pas nouveau) ; en cas de refus, **comportement de l'application à valider en préproduction** (message affiché, pas de réessai en boucle) avant toute production.
- Ordre d'application proposé, après vos autorisations distinctes : préproduction sql/25 puis sql/26 → test navigateur avec comptes jetables → décision pour la production.

### Concurrence, modification, suppression, refus : conclusions (24/10/2026, simulation locale)
- **Pourquoi un trigger suffit pour les comptes legacy** : l'application écrit le tableau complet des paiements (dernier écrivain gagne). L'état final est donc toujours un tableau que le serveur a validé ; il n'existe pas de fusion qui pourrait additionner deux ajouts valides en un dépassement. Deux onglets qui ajoutent chacun 700 sur 1200 donnent un total ≤ 1200 mais **un des deux ajouts est perdu** (limite préexistante du mode legacy, à signaler à l'utilisateur ; la solution de fond est le mode « documents »).
- **Sérialisation** : `sql/26` lit l'ancienne valeur `FOR UPDATE` (et les factures `FOR SHARE`) ; une seconde écriture attend la première puis est jugée sur la valeur validée (test à chevauchement réel : attente 1,3 s, puis refus).
- **Modification / suppression** : la règle porte sur l'**augmentation du cumul** par facture (hausse de montant, nouveau paiement, rattachement à une autre facture : contrôlés ; baisse et suppression : toujours acceptées).
- **Refus côté application** (correction dans `app.html`, `_syncToCloud`) : avant, un refus `PAIEMENT_SUPERIEUR_AU_RESTE` était traité comme une panne réseau → écriture remise en file **indéfiniment** et paiement fautif conservé localement (test sans correctif : encaissé 1400 pour une facture de 1200, reste 0, file non vide). Après : copie de sauvegarde, retour à la dernière valeur du serveur, file purgée, message « Paiement refusé », écrans recalculés (15 contrôles navigateur).
- **Comptes en mode documents** : `record_payment` (sql/25) verrouille la ligne de facture (`FOR UPDATE`) ; test de concurrence SQL de #58 (15 contrôles) + répétition de #64.
- **Limite restante** : si le refus de `payments` survient après l'acceptation de l'écriture de la facture (statut payé / `paidAmount` relevés), la facture peut afficher un avancement sans ligne de paiement correspondante ; `invoicePaidAmount` plafonne à son TTC, donc pas de dépassement affiché. À traiter dans un lot dédié si la préproduction le confirme.
- **Aucun de ces résultats n'est une preuve de sécurité en production** : simulation locale (PostgreSQL 16), pas de Supabase réel (RLS, pooler, latence réels non couverts).

### Migrations préparées, NON exécutées
| Fichier | Portée | Retour arrière |
|---|---|---|
| `sql/25_plafond_paiements.sql` | comptes en mode documents | ré-exécuter le bloc `record_payment` de sql/15 |
| `sql/26_plafond_paiements_legacy.sql` | comptes legacy (tous les clients actuels) | `DROP TRIGGER trg_10_payments_cap ON public.user_data; DROP FUNCTION public.guard_payments_cap_legacy();` |
Ordre : préproduction (après autorisation) → tests navigateur avec comptes jetables → production (autre autorisation).
