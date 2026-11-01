# FacturaPro 2.0 — gestion et pilotage financier

Ce document décrit ce que contient la version 2.0, comment la déployer et comment revenir en arrière. Il remplace, pour ces
sujets, les instructions SQL de `docs/DEPLOY.md`.

## 1. Les 9 PR (branches empilées, chacune basée sur la précédente)

| PR | Branche | Contenu | SQL |
|----|---------|---------|-----|
| 1 | `fp2/pr1-corrections-chiffres` | Encaissé par **date de paiement** ; CA facturé HT **net des avoirs** par date d'émission ; TVA 2026 (0/10/20) pour les nouvelles lignes, anciens taux conservés et signalés ; un produit à 0 % ne passe plus à 20 % | — |
| 2 | `fp2/pr2-avoir-retour` | **Avoir commercial ≠ retour physique** : le stock n'est remis que pour les lignes et quantités déclarées « revenues » | — |
| 3 | `fp2/pr3-cmup` | **Coût moyen pondéré (CMUP) figé** sur chaque mouvement ; retours au coût de la sortie d'origine, plafonnés ; valeur du stock à date | `sql/36_stock_cout.sql` |
| 4 | `fp2/pr4-achats-serveur` | Achats et dépenses **côté serveur** : pièces immuables, numéro `ACH-AAAA-NNN`, nature par ligne (marchandise / charge / investissement), annulation motivée (jamais de suppression), reprise automatique des anciens achats | `sql/37_achats_serveur.sql` |
| 5 | `fp2/pr5-livraisons-serveur` | Bons de livraison **côté serveur** : numéro `BL-AAAA-NNN`, lien facture contrôlé (même client, facture non émise), annulation au coût d'origine, reprise des anciens BL | `sql/38_livraisons_serveur.sql` |
| 6 | `fp2/pr6-tresorerie` | **Trésorerie** : comptes (banque, caisse) avec solde d'ouverture daté, mouvements immuables (annulation par ligne inverse), virements, règlements fournisseurs plafonnés à la dette, encaissements clients lus (jamais recopiés) | `sql/39_tresorerie.sql` |
| 7 | `fp2/pr7-cloture` | **Clôture mensuelle** : plus aucune écriture datée dans un mois clôturé (factures émises, paiements, achats, BL, stock, trésorerie), contrôles avant clôture, réouverture de la dernière clôture avec motif journalisé | `sql/40_cloture.sql` |
| 8 | `fp2/pr8-indicateurs` | **Pilotage** : CA, coût des ventes, marge, charges, résultat de gestion estimé, créances, dettes, stock, trésorerie, flux, fiabilité, 12 mois, export CSV — calculés sur le serveur | `sql/41_indicateurs.sql` |
| 9 | `fp2/pr9-export-docs` | **Journaux de gestion** (CSV unique : ventes, achats par nature, encaissements, trésorerie) ; documentation | — |

## 2. Règles financières appliquées (les 8 corrections de la contre-expertise)

1. **Quatre notions séparées** : résultat de gestion (Pilotage), trésorerie (argent disponible), créances / dettes, et aucun résultat fiscal. L'écran Pilotage l'indique en toutes lettres.
2. **CMUP sécurisé** : coût calculé sous verrou par produit, figé sur chaque sortie ; une entrée sans prix est valorisée au CMUP courant et signalée « coût estimé ».
3. **Dates** : CA à la date d'émission, encaissement à la date de paiement, achat à la date de la pièce, règlement à sa date, stock à la date du mouvement.
4. **Aucun double comptage** : un achat de marchandise suivie va en stock (pas en charge) ; il n'entre dans le coût des ventes qu'à la sortie. Un règlement fournisseur est un flux de trésorerie, jamais une charge. Les encaissements clients ne sont stockés qu'une fois (paiements) et lus par la trésorerie.
5. **Avoir ≠ retour** : l'avoir corrige le CA ; seul un retour déclaré remet du stock, au coût de la sortie d'origine.
6. **Aucun calcul fiscal automatisé** (IS, IR, CPU, amortissements, charges sociales) : règles CGI 2026 non validées.
7. **Aucune facturation électronique DGI** : spécifications officielles non disponibles.
8. **Soldes d'ouverture et mouvements immuables** : solde d'ouverture daté par compte ; mouvements jamais modifiés ni supprimés.

## 3. Sécurité et isolation

- Toutes les nouvelles tables sont **fermées** : RLS activée **sans aucune politique** et `REVOKE ALL` pour `anon` et `authenticated`. Aucun accès direct possible, même en lecture.
- Tout passe par des fonctions `SECURITY DEFINER` à `search_path` fixé, qui n'opèrent que sur le compte connecté (`fin_uid()` : utilisateur authentifié **et e-mail confirmé**).
- Écriture réservée aux licences actives (`has_active_license`). La lecture reste possible pour une licence expirée.
- Idempotence : chaque écriture porte une clé (`idem_key`, unique par compte). Un double clic ou un renvoi réseau ne crée pas de doublon.
- Immuabilité par déclencheurs : achats, BL, mouvements de stock et de trésorerie, clôtures. Seuls les changements prévus sont admis : annulation motivée, lien BL ↔ facture, archivage de compte, réouverture motivée.
- Plafonds : règlement ≤ reste dû ; retour ≤ quantité sortie ; volume par compte.
- Journal `fin_audit` pour les opérations sensibles : annulations, clôtures, réouvertures.
- Suppression d'un compte utilisateur : toutes ses données financières sont supprimées en cascade (`ON DELETE CASCADE`).
- Tests d'isolation dans chaque fichier SQL : l'utilisateur B ne lit ni ne modifie rien de A ; `anon` n'a aucun droit d'exécution.

## 4. Déploiement

**Ordre impératif : SQL d'abord, application ensuite.** Le code des PR 3 à 9 appelle des fonctions qui n'existent qu'après le SQL. À l'inverse, le SQL seul ne change rien pour l'application actuelle :

- `trg_20_fin_closure` ne fait rien tant qu'aucun mois n'est clôturé ;
- les autres scripts ajoutent des tables ou des fonctions, ou remplacent `stock_record` et `stock_list` en restant compatibles avec les appels existants.

### 4.1 Préproduction (njjaomichdlnoscrnxlz)

Dans l'éditeur SQL Supabase, collez **un script à la fois, dans cet ordre**, en prenant les fichiers de la **dernière branche** (`fp2/pr9-export-docs`). Deux scripts ont été retouchés dans des PR ultérieures :

- `sql/36` a reçu la colonne `return_of` dans `stock_list` en PR 5 ;
- `sql/37` a été rendu non destructif pour les points d'extension en PR 7.

| Ordre | Script | Prérequis vérifié par le script |
|---|---|---|
| 1 | `sql/36_stock_cout.sql` | sql/34, sql/35 (déjà en production) |
| 2 | `sql/37_achats_serveur.sql` | sql/36 |
| 3 | `sql/38_livraisons_serveur.sql` | sql/37 |
| 4 | `sql/39_tresorerie.sql` | sql/37 |
| 5 | `sql/40_cloture.sql` | sql/39 |
| 6 | `sql/41_indicateurs.sql` | sql/36–39 |

Tous les scripts sont **réexécutables** : en cas d'erreur, corrigez puis recollez-les. Après le dernier script, contrôlez que les six tables existent avec RLS activée et sans politique :

```sql
SELECT relname, relrowsecurity, (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname) AS policies
FROM pg_class c WHERE relname IN ('purchases','purchase_lines','deliveries','delivery_lines','cash_accounts','cash_movements','period_closures','stock_cost_state','fin_counters','fin_audit');
```

Attendu : `relrowsecurity = true` et `policies = 0` partout.

Ensuite, testez l'application de la branche `fp2/pr9-export-docs` sur la préproduction en suivant le parcours du §6.

### 4.2 Production (mdozjptoecygmpkjlohr)

Uniquement après validation en préproduction et **par vous** :

1. Collez les mêmes 6 scripts, dans le même ordre.
2. Lancez la même requête de contrôle.
3. Fusionnez ensuite les PR **dans l'ordre 1 → 9** (chaque PR a pour base la précédente). Le déploiement GitHub Pages suit la fusion dans `main`.

État constaté en production (lecture seule, comptages) : 0 achat, 0 BL, 0 fournisseur dans les données JSON. La reprise des anciens achats et BL n'a donc rien à migrer, mais elle reste en place pour les comptes qui en auraient créé d'ici là. Les 3 mouvements de stock existants reçoivent un coût via la reprise de `sql/36` (CMUP estimé, signalé).

## 5. Retour arrière

- **Application** : revenir au commit `main` précédent (révocation de la fusion). L'ancienne application ignore les nouvelles tables.
- **SQL** : chaque script décrit en tête son retour arrière exact (section « RETOUR ARRIÈRE »). Ordre inverse : 41 → 40 → 39 → 38 → 37 → 36.
  - `41` : uniquement des fonctions, sans risque.
  - `40` : supprimer d'abord les déclencheurs, **indispensable avant de revenir à une application sans clôture**.
  - `39`, `38`, `37` : les `DROP TABLE` suppriment les pièces saisies. Exportez d'abord les journaux (Export comptable › Journaux de gestion).
  - `36` : recoller `stock_record` (sql/35) et `stock_list` (sql/34). Les colonnes de coût peuvent rester : elles sont ignorées.
- Ne supprimez pas les tables tant que des clients ont saisi des pièces : retirer l'application suffit à masquer les fonctions.

## 6. Parcours de recette conseillé (préproduction)

1. Trésorerie : créer « Banque » (solde réel au 1er du mois) et « Caisse ».
2. Produits : cocher « Suivre le stock » sur un produit.
3. Achats : saisir deux achats de ce produit à des prix différents, avec une échéance. Vérifier le coût moyen dans Stock.
4. Achats : saisir une dépense (loyer), « payée maintenant » depuis la Banque.
5. Factures : émettre une facture du produit, puis enregistrer un paiement partiel en espèces (compte Caisse).
6. Factures : créer un avoir avec retour d'une unité, puis un avoir sans retour. Vérifier que le stock ne change que pour le premier.
7. Bons de livraison : créer un BL, le facturer, puis tenter de l'annuler (refusé une fois la facture émise).
8. Trésorerie : régler l'achat en deux fois (le second au-delà du reste doit être refusé), faire un virement Banque → Caisse puis l'annuler.
9. Pilotage : comparer CA, coût des ventes, marge, charges et résultat avec un calcul à la main. Lire les alertes de fiabilité.
10. Clôturer le mois précédent : la saisie d'un achat ou d'un paiement daté dans ce mois doit être refusée ; rouvrir avec un motif.
11. Export comptable › Journaux de gestion : ouvrir le CSV dans Excel.

## 7. Tests automatisés

- `bash tests/sql/run.sh` : tous les scripts SQL dans une base PostgreSQL jetable, puis tous les tests SQL. Ajouter `ONLY=cloture` (par exemple) pour ne lancer qu'un fichier.
- `npm test` : tests unitaires.
- `npm run test:integration` : application réelle dans Chromium, avec faux client Supabase et PostgreSQL local. Jamais Supabase réel.

| Domaine | Tests SQL | Contrôles navigateur |
|---|---|---|
| CMUP (sql/36) | `test_stock_cout.sql` (36) | `cmup` (15) |
| Achats (sql/37) | `test_achats.sql` (48) | `achats` (27) |
| BL (sql/38) | `test_livraisons.sql` (33) | `livraisons` (24) |
| Trésorerie (sql/39) | `test_tresorerie.sql` (34) | `tresorerie` (21) |
| Clôture (sql/40) | `test_cloture.sql` (38) | `cloture` (17) |
| Indicateurs (sql/41) | `test_indicateurs.sql` (21) | `pilotage` (14) |
| Journaux | — | `journaux` (12) |
| Chiffres / avoirs | — | `chiffres` (11), `avoir-retour` (13) |

## 8. Limites connues (à traiter après 2.0)

- **Ventes et paiements restent dans `user_data`** (JSON). Le serveur garantit leur immuabilité après émission (sql/14/19/26) et la clôture (sql/40). Le passage à des tables dédiées (`sql/15–17`, préparé) reste un chantier séparé qui demande votre accord écrit.
- **Cas non gérés** :
  - pas d'avoir fournisseur : une erreur sur un achat se corrige par annulation puis nouvelle saisie ;
  - pas de lettrage bancaire automatique ;
  - pas de multi-devises.
- **Amortissements non calculés** : les investissements sont affichés hors résultat.
- **Coût des ventes approximatif** quand des sorties ont lieu avant la saisie des achats (coût estimé, signalé dans Pilotage).
- **Délai de BL** : un BL non facturé compte son coût à la date de livraison et sa vente à la date de facture. C'est signalé dans Pilotage.
- **Réouverture de la première clôture** : elle rouvre tout l'historique, car il n'y a qu'une seule date de verrouillage.
