# Ventes et paiements dans de vraies tables — procédure (01/11/2026)

Autorisée par le propriétaire le 01/11/2026 (« Migration des ventes et paiements vers de vraies tables : oui »).

## Principe

- Chaque compte a **une seule source** pour ses factures, avoirs, devis, paiements et journal :
  - `legacy` : `user_data` (tableaux JSON, comportement historique) ;
  - `documents` : tables `documents`, `doc_payments`, `doc_history` (une ligne par pièce).
- Le **serveur** décide du mode, compte par compte (`get_doc_mode`). L'application suit. Un appareil qui écrit dans la mauvaise source est refusé (`MODE_NOUVEAU_STOCKAGE` / `MODE_ANCIEN_STOCKAGE`), jamais en silence.
- La bascule d'un compte est faite par l'opérateur avec `fp_doc_mode_set(compte, 'documents')` :
  1. copie idempotente (sql/16) ;
  2. vérification par empreintes ;
  3. arrêt sur tout conflit ou brouillon à arbitrer.
- Le retour arrière `fp_doc_mode_set(compte, 'legacy')` recopie tout dans `user_data`, y compris ce qui a été créé après la bascule.
- Seul verrou d'accès au nouveau mode : la liste `doc_store_testers`, posée par l'opérateur, jamais par l'API. Jusqu'au 01/11/2026, il fallait en plus un e-mail `@facturapro-test.invalid` et un build de préproduction ; ces deux verrous sont retirés.

## Ce que fait sql/45

- **Sources uniques** : `fp_sales_array` et `fp_payments_array` lisent la source du mode du compte.
- **Fonctions FacturaPro 2.0 réécrites** (même résultat qu'avant en mode legacy) : Pilotage, journaux, encaissements, statut de facture pour les BL, contrôle avant clôture, liste admin.
- **`record_payment`** :
  - plafond = TTC − avoirs − encaissements ;
  - annulation d'un paiement par ligne inverse (`reversesId`, une seule fois, même montant) ;
  - période clôturée refusée ;
  - statut « payée » ↔ « envoyée » recalculé ;
  - compte de trésorerie conservé.
- **Déclencheur `trg_10_fin_documents`** : refuse l'émission dans une période clôturée, et plafonne le cumul des avoirs au TTC de la facture.

## Vérifications

| Contrôle | Résultat |
|---|---|
| `tests/sql/test_ventes_tables.sql` | 27/27 : mêmes chiffres avant/après bascule, plafonds, annulation, clôture, retour arrière avec mêmes chiffres |
| Tests FacturaPro 2.0 avec sql/45 chargé | 429/429 |
| Suite SQL complète | 755/755 |
| Script de déploiement appliqué sur une base « comme la production » (sans 15/16/17) | 341/341 |
| `tests/integration/ventes-tables.browser.test.js` | 14/14 : application réelle, bascule, paiement, annulation, avoir partiel, Pilotage, trésorerie, retour arrière |
| `docstore` (unitaire 59, navigateur 82) | OK |

## Déploiement

1. **Sauvegarde** : sauvegarde chiffrée quotidienne (GitHub) et copie de toutes les tables dans un schéma de sauvegarde, accès retiré à `anon` et `authenticated`.
2. **Préproduction** : sql/17 (fonctions modifiées) et sql/45. Essai complet sur un compte temporaire, annulé à la fin.
3. **Production** : sql/15, 16, 17 et 45 (création de tables et de fonctions, aucune donnée modifiée), puis l'application.
   Lancement par le propriétaire : GitHub › Actions › **ventes-tables-deploy** › Run workflow (cible `preprod` puis `prod`, mot `APPLIQUER`).
   Une seule transaction, contrôles avant/après, aucun mot de passe affiché. Ces scripts contiennent des fonctions de suppression
   (brouillons, retour arrière) : l'outil de l'assistant exige alors une confirmation humaine qu'il ne peut pas obtenir, d'où ce lancement manuel.
4. **Bascule des comptes**, un par un :

   ```sql
   INSERT INTO doc_store_testers(user_id) VALUES (…);
   SELECT fp_doc_mode_set(…, 'documents');
   ```

   Un compte actif dans les 10 dernières minutes est reporté (`ACTIVITE_RECENTE_ANCIEN_APPAREIL`).
5. **Retour arrière d'un compte** : `SELECT fp_doc_mode_set(…, 'legacy');`.

## Exécution (02/11/2026)

- Production : sql/15, 16, 17 et 45 appliqués par le workflow `ventes-tables-deploy` (lancé par le propriétaire, vert).
- Essai complet sur un compte temporaire en production, annulé à la fin :
  - bascule faite, chiffres identiques ;
  - plafond des paiements, annulation de paiement, refus d'écriture dans l'ancien stockage ;
  - retour arrière : 3 paiements recopiés.
- **Les 14 comptes ont été basculés** : 14/14 réussis, chiffres de gestion identiques avant et après pour chacun. 25 documents et 18 paiements, soit exactement le contenu de l'ancien stockage.
- sql/46 : tout nouveau compte démarre directement en mode documents (vérifié en production sur un compte temporaire, annulé).
- Préproduction : pas encore mise à jour. Pour le faire, ajouter `main` aux branches autorisées de l'environnement « preprod ».
