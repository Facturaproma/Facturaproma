# FacturaPro 2.0 — validation avant clients pilotes (1er novembre 2026)

Ce document distingue **ce qui a été exécuté** (tests automatisés, requêtes sur les bases réelles avec des comptes de test jetables)
de **ce qui demande votre intervention**. Aucune donnée réelle de client n'a été utilisée. Aucune opération destructive n'a été faite
en production. Les schémas de sauvegarde n'ont pas été supprimés.

## 1. Recette fonctionnelle (exécutée)

### 1.1 Parcours §6 de `docs/FACTURAPRO-2.0.md`, automatisé dans l'application

Test : `tests/integration/recette.browser.test.js`, 24 contrôles. Les 11 étapes sont exécutées dans l'interface réelle (Chromium), sur PostgreSQL local avec tous les scripts SQL :

| Étape | Résultat |
|---|---|
| 1 Comptes Banque 10 000 / Caisse 500 | ✓ |
| 3 Deux achats (10 × 50, 10 × 62) | ✓ stock 20, coût moyen 56 affiché dans Stock |
| 4 Loyer 2 000 « payé maintenant » depuis la Banque | ✗ → **anomalie A1**, corrigée puis ✓ |
| 5 Facture 1 000 HT, paiement partiel 600 en espèces | ✓ stock 15, Caisse 1 100, reste 600 |
| 6 Avoir avec retour d'1 sac / avoir sans retour | ✓ stock 10 → 11, puis inchangé |
| 7 BL facturé puis tentative d'annulation | ✓ stock 9 (pas de double sortie), annulation refusée |
| 8 Règlement 400 puis 300 (reste 200) ; virement puis annulation | ✓ 300 refusé ; soldes revenus |
| 9 Pilotage | ✓ CA 1 400, coût des ventes 616, marge 784, charges 2 000, résultat −1 216, créances 1 080, dettes 944, stock 504, trésorerie 8 700 |
| 10 Clôture du mois précédent | ✓ achat et paiement datés dans le mois refusés ; réouverture motivée |
| 11 Journaux de gestion | ✓ ventes HT = CA du pilotage ; charges = 2 000 ; encaissements = 600 ; trésorerie nette = −2 400 |
| Contrôle croisé | ✓ la trésorerie de l'écran Trésorerie = celle du Pilotage |

### 1.2 Recette sur les bases réelles

Elle a été faite en préproduction et en production, par requêtes SQL :

- deux comptes temporaires, avec le rôle `authenticated`, comme l'application ;
- transaction **annulée** à la fin, sans aucun résidu (vérifié).

Les résultats sont identiques au calcul à la main : CMUP 56, CA 1 000, coût des ventes 280, marge 720, résultat −1 280, créances 600, dettes 744, stock 840, trésorerie 8 000. Les plafonds, la clôture et l'isolation ont aussi été vérifiés.

Le scénario « annulation de paiement » est passé en préproduction : encaissé net 0, créance 1 200, trésorerie 0, plafond conservé.

### 1.3 Non exécuté (votre intervention)

- **Parcours au clic sur l'URL de production**, sur un vrai téléphone et un ordinateur, avec un compte de test. Prévoir une vingtaine de minutes en suivant le §6. Aucun navigateur relié à internet n'est disponible depuis cette session.
- **Deux appareils simultanés sur le même compte** (téléphone + ordinateur) : modification sur l'un, rechargement sur l'autre.

## 2. Anomalies trouvées et corrigées

| N° | Anomalie (constatée par un test) | Gravité | Correction | Test |
|---|---|---|---|---|
| A1 | « Nouvelle dépense » et « Enregistrer un paiement » : la liste des comptes, rechargée en arrière-plan, **remplaçait le compte choisi** par le compte par défaut. Un loyer payé par la Banque était enregistré sur la Caisse, sans message (total juste, répartition fausse). | Élevée (données financières fausses) | Le rechargement garde le choix de l'utilisateur | `recette` (échoue sans la correction : vérifié) |
| A2 | Une même pièce envoyée deux fois **en même temps** (nouvel essai réseau) : une seule pièce créée, mais le second appel renvoyait une erreur d'unicité au lieu de la pièce. L'utilisateur voyait « rien n'a été enregistré ». | Moyenne | Verrou par (compte, clé) dans 5 fonctions serveur | `concurrence-fp2` (échouait avant) |
| A3 | **Un paiement client erroné ne pouvait pas être corrigé** : les paiements sont immuables et aucune correction n'existait. | Élevée pour des clients réels | « ↩️ Annuler » dans l'historique : ligne inverse (montant négatif) avec motif, facture repassée « à payer », double annulation refusée | `paiement-annulation` (13) |
| A4 | **Copie locale conservée après déconnexion** : sur un appareil partagé, factures, clients et coordonnées restaient lisibles dans le navigateur (origine réelle des alertes CodeQL). | Élevée (confidentialité) | Purge à la déconnexion (bouton, écran de licence, inactivité), **sauf** s'il reste des modifications non envoyées | `deconnexion-locale` (5) |
| A5 | Une caisse pouvait devenir négative sans signal | Faible | Alerte dans Trésorerie | `recette` |

## 3. Audit de sécurité

### 3.1 Les 3 alertes CodeQL « stockage en clair » (`app.html`, localStorage)

- **Nature** : le cache hors ligne enregistre les données du compte (factures, clients, paiements…) dans le navigateur. Aucun mot de passe n'y est stocké. L'alerte « creditNumber » vient du mot *credit*, qui désigne ici le numéro d'**avoir** (faux positif sur une carte bancaire). Le jeton de session Supabase est stocké par la bibliothèque officielle, comme pour toute application Supabase.
- **Risque réel** : la lecture par une autre personne **sur le même appareil** après la déconnexion. C'est corrigé (A4).
- **Risque restant** :
  - un appareil laissé connecté, ou fermé sans se déconnecter (la déconnexion pour inactivité purge alors au prochain passage) ;
  - un script malveillant injecté (XSS), contre lequel l'échappement systématique est testé (`securite-xss`).
- **À faire par vous** : classer ces alertes dans GitHub › Security comme « risque accepté : cache hors ligne voulu, purgé à la déconnexion ». Je n'ai pas les droits pour le faire.

### 3.2 Supabase (production, requêtes en lecture seule)

| Contrôle | Résultat |
|---|---|
| Tables `public` sans RLS | aucune |
| Vues `public` | aucune |
| Fonctions exécutables sans connexion (`anon`) | `get_shared_invoice` (lien client par jeton de 256 bits, expiration vérifiée, voulu) et `doc_guard` (fonction de déclencheur, non appelable) |
| Fonctions SECURITY DEFINER accessibles aux connectés | toutes vérifient l'identité : `auth.uid()`, `fin_uid()`, `stock_uid()`, `share_uid()`, `support_uid()` ou un rôle admin. `get_contact_info` ne renvoie que le contact public. |
| `user_data` | 4 politiques « propriétaire uniquement » ; écriture soumise à une licence active ; clé `licenseInfo` protégée |
| 10 tables FacturaPro 2.0 | fermées : RLS sans politique, aucun droit pour `anon`/`authenticated` ; tout passe par des fonctions qui filtrent le compte |
| Stockage de fichiers (buckets) | aucun |
| Schémas de sauvegarde | aucun droit d'usage pour `anon`/`authenticated` ; seul `postgres` y a accès ; non exposés par l'API |
| Isolation entre comptes | testée en local (concurrence, tous les tests SQL) et sur la base réelle : B ne voit, ne règle et n'annule rien de A |

### 3.3 À activer par vous

Dans Supabase › Authentication, activer la **protection des mots de passe divulgués** (alerte Supabase « Leaked Password Protection Disabled »). C'est un réglage du tableau de bord, non modifiable par SQL.

## 4. Cohérence métier (vérifiée par tests)

| Sujet | Vérification | Test |
|---|---|---|
| Marges | CA − coût des ventes, retours déduits, marchandises non suivies ajoutées, achats suivis non recomptés | `test_indicateurs` (S18), `recette`, base réelle |
| CMUP | Exact sous 20 achats simultanés (49,5) ; chaîne recalculée identique ligne à ligne ; retours au coût d'origine, plafonnés | `concurrence-fp2`, `test_stock_cout`, `cmup` |
| Créances / dettes | Par facture, avoirs déduits, jamais négatives ; dettes nettes des règlements et annulations | `test_indicateurs`, `recette` |
| Paiements partiels / règlements | Reste exact ; plafond client (sql/26) et fournisseur ; 10 règlements simultanés → 7 acceptés sur une dette de 744 | `recette`, `concurrence-fp2` |
| Annulations | Achat réglé non annulable ; BL facturé non annulable ; virement annulé une seule fois même en rafale ; paiement annulable par ligne inverse | `concurrence-fp2`, `paiement-annulation`, `tresorerie` |
| Suppressions | Facture émise, paiement, achat, BL, mouvement : aucune suppression possible (serveur) ; produit suivi supprimable seulement à stock nul (historique conservé) | tests existants + audit du code |
| Clôtures | Mois clôturé : achats, BL, stock, trésorerie, factures émises et paiements refusés ; clôture unique en rafale | `test_cloture`, `cloture`, `concurrence-fp2`, `recette` |
| Journaux | Ventes = CA ; charges ; encaissements ; trésorerie nette = variation des comptes | `recette`, `journaux` |
| Erreurs | Hors ligne : les pièces serveur ne sont pas enregistrées et le message le dit ; les refus du serveur ne bouclent pas | `cloture`, `paiements.refus-serveur` |
| Simultanéité | Numérotation continue sans doublon, idempotence, plafonds, clôture | `concurrence-fp2` (15) |

## 5. Préparation commerciale

### 5.1 Commercialisable dès maintenant (clients pilotes)

- Devis, factures, avoirs, numérotation serveur continue, factures émises non modifiables, PDF, lien client.
- Paiements partiels, plafond, **annulation d'un paiement erroné**, relances, reçus.
- Achats et dépenses par nature, fournisseurs, bons de livraison, stock avec coût moyen pondéré et valeur.
- Trésorerie (banque, caisse, virements, règlements fournisseurs), clôture mensuelle, Pilotage (indicateurs de gestion), journaux CSV pour le comptable.

### 5.2 Limites à annoncer aux clients pilotes

- **Avoir** : total, ou partiel par ligne (quantité et/ou prix), plusieurs avoirs par facture ; le cumul ne peut pas dépasser le TTC de la facture (contrôlé aussi par le serveur, sql/43). Ajouté le 01/11/2026 (PR avoir partiel).
- **Achats** : pas d'avoir fournisseur. Une erreur se corrige par annulation puis nouvelle saisie, et un achat réglé doit d'abord voir ses règlements annulés.
- **Connexion obligatoire** pour achats, BL, trésorerie, clôture et pilotage. Les factures et paiements fonctionnent hors ligne.
- **Pilotage** : résultat de gestion **estimé**. Ni impôt, ni amortissements, ni charges sociales ; ce n'est pas un bilan ni une liasse fiscale.
- **Journaux CSV** : pas une comptabilité générale (aucun numéro de compte du plan comptable), à remettre au comptable.
- **Réouverture de clôture** : la réouverture de la première clôture rouvre tout l'historique.
- **Paiements sans compte** : les encaissements enregistrés sans compte de trésorerie ne comptent pas dans les soldes (c'est signalé).

### 5.3 Indispensable avant une diffusion large

1. **Ventes et paiements en tables dédiées.** Aujourd'hui ils sont en JSON dans `user_data` : volume limité par compte, protections assurées par des déclencheurs. La migration est préparée (sql/15–17) mais demande votre accord.
2. ~~Avoir partiel~~ (fait le 01/11/2026) et avoir fournisseur.
3. **Recette au clic** sur plusieurs appareils et **tests de charge réels**, avec un compte volumineux (milliers de factures).
4. **Sauvegardes automatiques** : vérifier le plan Supabase (sauvegardes quotidiennes, restauration à un instant donné) et prévoir un export régulier.
5. **Validations juridiques et fiscales** (§5.5).

### 5.4 Peut attendre

- Rapprochement bancaire (import de relevé), lettrage.
- Amortissements.
- Multi-devises.
- Plan comptable marocain et export vers un logiciel comptable précis.
- Écrans adaptés au mobile pour les grands tableaux (actuellement défilement horizontal).

### 5.5 À faire valider par des professionnels

Aucune conformité n'est affirmée ici.

- **Expert-comptable** :
  - définitions du Pilotage ;
  - usage des journaux CSV ;
  - traitement des avoirs, retours et annulations de paiement ;
  - TVA déductible ou non par achat ;
  - taux de TVA proposés (0/10/20 pour les nouvelles lignes, 7/14 conservés sur l'existant).
- **Fiscaliste ou DGI** :
  - mentions obligatoires sur les factures (ICE, IF, RC, patente, etc.) ;
  - règles de numérotation et de conservation ;
  - évolution vers la **facturation électronique DGI**, aucune spécification officielle n'étant intégrée.
- **Juriste** :
  - CGU, politique de confidentialité ;
  - **loi 09-08 / CNDP** : déclaration du traitement, hébergement des données hors du Maroc chez Supabase et conditions de transfert ;
  - responsabilité sur les chiffres de gestion.
- **Clauses commerciales** : tarifs et offres inchangés par cette mission.

## 6. Sauvegardes

| Contrôle | Préproduction | Production |
|---|---|---|
| Intégrité (empreinte MD5 recalculée sur chaque copie) | 30/30 tables intactes | 19/19 tables intactes |
| Restauration (copie dans une table de même structure, empreinte identique) | vérifiée le 01/11 | vérifiée le 01/11 |
| Accès non autorisé | aucun droit d'usage pour `anon` / `authenticated` | idem |

Les schémas `fp_backup_20261101` et `fp_restore_test` sont conservés, à supprimer uniquement sur votre décision. Ils ne contiennent pas `auth.users` (comptes et mots de passe) : les migrations n'y touchent pas.

## 7. Tests automatisés (dernière exécution)

| Suite | Résultat |
|---|---|
| Tests SQL | 693 réussis, 0 échec |
| Suites d'intégration (navigateur et concurrence) | 40 suites, 632 contrôles, 0 échec |
| Tests unitaires (`npm test`) | 23 vérifications |
| Nouveaux tests de cette validation | `recette` (24), `concurrence-fp2` (15), `paiement-annulation` (13), `deconnexion-locale` (5) |
