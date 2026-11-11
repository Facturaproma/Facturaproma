# Comptes partagés et abonnements (11/11/2026)

Décision du propriétaire du 11/11/2026 : **1 compte = 1 entreprise = 1 espace de travail partagé**. Plus de multi-sociétés. Plusieurs utilisateurs par compte selon la formule.

> **Statut.** Grille validée comme référence commerciale. **Rien n'est appliqué en production** : ni prix, ni abonnement, ni migration. L'étape T1 (`sql/48_comptes_partages.sql`) est écrite et testée en local ; son application demande un accord distinct.

## 1. Grille tarifaire

| Formule | HT / mois | TTC / mois (TVA 20 %) | HT / an (10 mois) | TTC / an | Économie annuelle HT | Utilisateurs max |
|---|---|---|---|---|---|---|
| Essentielle | 79 DH | 94,80 DH | 790 DH | 948 DH | 158 DH | 1 |
| Pro | 179 DH | 214,80 DH | 1 790 DH | 2 148 DH | 358 DH | 2 |
| Business | 299 DH | 358,80 DH | 2 990 DH | 3 588 DH | 598 DH | 3 |
| Premium | 499 DH | 598,80 DH | 4 990 DH | 5 988 DH | 998 DH | 5 |

- TTC seulement si FacturaPro est vendu par une entité assujettie à la TVA ; sinon le prix HT est le prix payé (à confirmer avec le comptable).
- Pas de prix d'utilisateur supplémentaire : au-delà de la limite, on passe à la formule supérieure.
- **Factures, devis, clients et produits illimités dans toutes les formules.**

## 2. Matrice des fonctionnalités

Chaque ligne correspond à un écran ou une fonction **qui existe aujourd'hui** dans `app.html`, sauf mention « à développer ». La colonne « clé » est le nom utilisé dans `plan_catalog.features`.

| Fonction (écran actuel) | Clé | Essentielle | Pro | Business | Premium |
|---|---|---|---|---|---|
| Factures et devis, numérotation, brouillons (Factures, Devis) | `ventes` | ✓ | ✓ | ✓ | ✓ |
| Avoirs (total et partiel) | `avoirs` | ✓ | ✓ | ✓ | ✓ |
| Clients et produits | `clients_produits` | ✓ | ✓ | ✓ | ✓ |
| Suivi des paiements, reçus (Paiements) | `paiements` | ✓ | ✓ | ✓ | ✓ |
| PDF professionnels, lien client, envoi WhatsApp | `pdf_partage` | ✓ | ✓ | ✓ | ✓ |
| Tableau de bord (Accueil) | `tableau_bord` | ✓ | ✓ | ✓ | ✓ |
| Impôts & TVA : TVA sur les ventes, échéances | `tva_ventes` | ✓ | ✓ | ✓ | ✓ |
| Sauvegarde et export de ses propres données | `export_donnees` | ✓ | ✓ | ✓ | ✓ |
| Achats, fournisseurs, avoirs fournisseurs | `achats` | — | ✓ | ✓ | ✓ |
| Relevé des déductions de TVA, fichier XML SIMPL | `tva_deductions` | — | ✓ | ✓ | ✓ |
| Bons de livraison | `livraisons` | — | ✓ | ✓ | ✓ |
| Stock | `stock` | — | ✓ | ✓ | ✓ |
| Relances clients | `relances` | — | ✓ | ✓ | ✓ |
| Statistiques (Rapports) | `statistiques` | — | ✓ | ✓ | ✓ |
| Exports avancés : journaux de gestion, export comptable (Sage, EBP, FEC), Excel détaillés | `exports_avances` | — | — | ✓ | ✓ |
| Tableaux de bord avancés (Pilotage, indicateurs) | `pilotage` | — | — | ✓ | ✓ |
| Trésorerie (comptes, mouvements) | `tresorerie` | — | — | ✓ | ✓ |
| Automatisations : factures récurrentes | `automatisations` | — | — | ✓ | ✓ |
| CNSS | `cnss` | — | — | ✓ | ✓ |
| Clôture mensuelle | `cloture` | — | — | ✓ | ✓ |
| Rapports avancés | `rapports_avances` | — | — | — | **à développer** |
| Support prioritaire | `support_prioritaire` | — | — | — | ✓ (organisation, pas de code) |
| Messagerie avec le support | — | ✓ | ✓ | ✓ | ✓ |
| Utilisateurs | — | 1 | 2 | 3 | 5 |

### Écarts avec la matrice proposée le 11/11, à valider

| Point | Proposé | Ce que je recommande | Pourquoi |
|---|---|---|---|
| TVA sur les ventes | non cité | **toutes les formules** | Une SARL seule en Essentielle doit déclarer sa TVA ; c'est de la facturation fiable |
| Export de ses données | non cité | **toutes les formules** | Réversibilité : le client garde ses données, quelle que soit sa formule |
| Relevé des déductions | non cité | Pro, avec les achats | Il se calcule à partir des achats et de leurs règlements |
| Stock, bons de livraison | non cités | Pro | Le stock vient des achats ; le BL sort du stock |
| Trésorerie, CNSS, clôture | non cités | Business | Pilotage financier et obligations d'une structure avec salariés |
| Rapports avancés | Premium | Premium, **mais rien d'existant ne correspond** | À définir et développer avant de le vendre (marges par client et produit, comparaisons de périodes…) |

### Clients actuels : rien n'est retiré

Le site promet « Tout illimité » aux formules actuelles (essai, mensuel, annuel, Fondateurs, à vie). Formule `legacy` :

- **toutes les fonctions existantes**, comme aujourd'hui ;
- **1 utilisateur**, comme aujourd'hui (le multi-utilisateurs n'a jamais été livré) ;
- à leur renouvellement, ils choisissent une formule de la nouvelle grille. Les licences **à vie restent en `legacy` sans limite de durée**. Les conditions de passage (offre de bascule) sont une décision commerciale.

## 3. Architecture cible

```
auth.users ──< account_members >── accounts ──> plan_catalog
 (personne)    rôle, profil,        (entreprise)   (formule, utilisateurs max,
               actif/désactivé           │           fonctions)
                                         │
              account_invitations ───────┤ (jeton haché, 7 jours, une adresse)
              account_audit ─────────────┤ (qui a fait quoi)
                                         │
        tables métier (documents, achats, stock, trésorerie, clients, produits…)
        chaque ligne porte account_id ; RLS : account_id = fp_my_account()
```

### Rôles et permissions

| Permission | Owner | Admin | Member « complet » | Member « ventes » | Member « lecture » |
|---|---|---|---|---|---|
| Consulter les données du compte (`lire`) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Devis, factures, clients, encaissements (`ecrire_ventes`) | ✓ | ✓ | ✓ | ✓ | — |
| Avoirs, annulations (`avoirs_annulations`) | ✓ | ✓ | ✓ | — | — |
| Réglages de l'entreprise, RIB, numérotation (`parametres`) | ✓ | ✓ | — | — | — |
| Inviter, désactiver, changer un rôle (`utilisateurs`) | ✓ | ✓ (membres seulement) | — | — | — |
| Nommer un admin | ✓ | — | — | — | — |
| Abonnement, propriété du compte (`abonnement`) | ✓ | — | — | — | — |

Une permission de fonction (`achats`, `stock`…) demande **le rôle et la formule** : `fp_account_can('stock')` est faux en Essentielle, même pour le propriétaire.

### Règles

- **Un utilisateur appartient à un seul compte** (index unique). Un compte a **un seul propriétaire** (index unique partiel). Le propriétaire n'est jamais désactivé ni rétrogradé par un admin.
- **Invitation** : l'owner ou un admin saisit une adresse ; le serveur renvoie **une seule fois** un jeton de 64 caractères (seul son SHA-256 est stocké), valable 7 jours. L'invité ouvre le lien, crée son compte ou se connecte **avec cette adresse** (e-mail confirmé), et accepte. Jeton inconnu, expiré, annulé, déjà utilisé ou autre adresse : même message `INVITATION_INVALIDE`.
- Aucun envoi d'e-mail par le serveur à cette étape : le lien est partagé par l'owner (WhatsApp, e-mail). Un envoi automatique demanderait une fonction serveur (Edge Function) et un service d'e-mail.
- **Un utilisateur qui possède déjà un compte ne peut pas en rejoindre un autre** (`DEJA_MEMBRE_D_UN_COMPTE`) : ses propres données ne sont jamais abandonnées sans décision.
- **Désactiver** un membre lui retire l'accès **dès sa requête suivante** et libère sa place. Ses actions passées restent dans le journal. Aucune donnée supprimée.

### Modifications simultanées

| Donnée | Aujourd'hui | Cible |
|---|---|---|
| Factures, devis, avoirs | table `documents`, numéro attribué par le serveur sous verrou | inchangé ; verrou et compteur **par compte** au lieu de par utilisateur |
| Achats, stock, trésorerie, BL | tables serveur, verrous par utilisateur | verrous et compteurs par compte |
| Clients, produits, fournisseurs, fiche entreprise, salariés CNSS | **un bloc JSON par clé dans `user_data`** : la dernière écriture écrase tout | **une ligne par élément**, colonne `version` : une mise à jour envoie la version lue ; si quelqu'un a modifié entre-temps, `CONFLIT_MODIFICATION` et l'écran recharge la fiche (verrouillage optimiste) |

## 4. Supabase et RLS

### Étape T1 (sql/48, prêt)

- Tables `plan_catalog`, `accounts`, `account_members`, `account_invitations`, `account_audit` : **RLS active sans aucune politique** et aucun droit pour `anon` / `authenticated`. Lecture et écriture uniquement par des fonctions `SECURITY DEFINER` à `search_path` fixe.
- Fonctions exposées à `authenticated` : `fp_my_account`, `fp_account_role`, `fp_account_can`, `account_ensure`, `account_info`, `account_invite`, `account_invitation_revoke`, `account_accept_invitation`, `account_member_update`, `account_set_plan` (administration FacturaPro, 2FA comprise via `is_admin`).
- Fonctions internes, non exposées : `fp_acc_uid`, `fp_license_ok`, `fp_account_seats`, `fp_account_log`, `fp_accounts_backfill`.

### Étapes suivantes : modèle de politique

```sql
-- T2 : colonne et remplissage (aucun effet visible)
ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES public.accounts(id);
UPDATE public.documents d SET account_id = m.account_id FROM public.account_members m
 WHERE m.user_id = d.user_id AND m.role = 'owner' AND d.account_id IS NULL;
-- T5 : politique par compte (sous-requête pour un seul calcul par requête)
CREATE POLICY documents_account_select ON public.documents FOR SELECT TO authenticated
  USING (account_id = (SELECT public.fp_my_account()));
```

- `user_id` reste dans chaque ligne : il devient « auteur », utile au journal.
- Les écritures continuent de passer par les fonctions serveur, qui vérifient `fp_account_can(...)` au lieu de `fin_uid()` seul.
- Les licences passent de l'utilisateur au compte (`licenses.user_id` du propriétaire au départ, puis `account_id`).

### Tables concernées par T2

`documents`, `doc_payments`, `doc_history`, `doc_events`, `doc_counters`, `doc_deleted`, `invoice_shares`, `purchases`, `purchase_lines`, `purchase_credits`, `purchase_credit_lines`, `payment_modes`, `deliveries`, `delivery_lines`, `stock_movements`, `stock_cost_state`, `cash_accounts`, `cash_movements`, `period_closures`, `fin_counters`, `fin_audit`, `user_data` (jusqu'à T3). Environ 57 fonctions serveur utilisent `fin_uid()` ou `auth.uid()` et sont revues en T4.

## 5. Plan de migration

| Étape | Contenu | Effet visible | Risque | Retour arrière |
|---|---|---|---|---|
| T0 | Préproduction remise au niveau de la production | aucun | faible | — |
| **T1** | `sql/48` : comptes, membres, invitations, formules ; reprise : un compte par utilisateur existant, propriétaire, formule `legacy` | aucun | faible | DROP des tables et fonctions de sql/48 |
| T2 | `account_id` sur les tables métier, rempli depuis le propriétaire ; rempli automatiquement à l'insertion | aucun | moyen | colonne ignorée puis supprimée |
| T3 | Clients, produits, fournisseurs, fiche entreprise, salariés : tables avec `version` ; l'application lit les deux pendant la transition | aucun si réussi | **élevé** (synchronisation) | ancien `user_data` conservé intact jusqu'à validation |
| T4 | Fonctions serveur par compte et par permission ; numérotation par compte | aucun pour un compte à 1 utilisateur | **élevé** | anciennes fonctions gardées sous un autre nom |
| T5 | RLS par compte, en parallèle des anciennes règles puis seule | aucun | **élevé** (sécurité) | réactivation des anciennes règles |
| T6 | Écrans : page Équipe réelle, invitation, rôles ; ouverture d'un lien d'invitation | **oui** | moyen | masquage de la page |
| T7 | Limites par formule dans les écrans et le serveur ; console admin pour attribuer une formule ; page Tarifs | **oui** (commercial) | moyen | formule `legacy` partout |

Chaque étape : préproduction, sauvegarde, workflow lancé par le propriétaire (comme `releve-deductions-deploy`), contrôles avant et après dans la même transaction. **Aucune étape ne supprime de donnée.**

## 6. Règles de limitation des utilisateurs

1. **Places occupées** = membres actifs + invitations en attente non expirées. Le propriétaire compte pour 1.
2. Invitation, acceptation et réactivation refusées si les places occupées atteignent la limite : `LIMITE_UTILISATEURS: n sur max`. Vérifié **par le serveur** ; l'écran ne fait qu'afficher.
3. Passage à une formule plus petite **refusé** tant que les places occupées dépassent la nouvelle limite : `TROP_D_UTILISATEURS_POUR_CETTE_FORMULE`. Personne n'est exclu automatiquement ; l'owner désactive d'abord.
4. Une fonction hors formule est refusée par le serveur (`fp_account_can`) ; l'écran affiche « disponible en Pro / Business… » au lieu de masquer silencieusement.
5. Licence expirée : lecture seule pour tous les membres (règle actuelle étendue au compte).

## 7. Scénarios de test des abonnements

**Écrits et réussis** (`tests/sql/test_comptes_partages.sql`, 48 contrôles) :

- tables fermées, droits des fonctions, fonctions internes non exposées ;
- grille 79/179/299/499, 1/2/3/5 utilisateurs, 10 mois par an ; formules cumulatives ; facturer présent partout ; `legacy` ne perd rien ;
- reprise : un compte par utilisateur, propriétaire, nom repris, réexécutable, aucune autre donnée touchée ;
- e-mail non confirmé refusé ; lecture directe des tables impossible ;
- `legacy` (1 utilisateur) : invitation refusée ; changement de formule réservé à l'administration ;
- Business : 3 places, 4e invitation refusée ; adresse normalisée ; doublon refusé ;
- jeton : 64 caractères, seule l'empreinte stockée, usage unique, autre adresse refusée, inconnu refusé, expiré refusé, annulé refusé ;
- rôles : membre sans gestion ; admin ne touche ni au propriétaire ni aux admins ; profil « ventes » sans avoirs ;
- désactivation immédiate, place libérée et réutilisée, réactivation refusée au-delà de la limite ;
- isolation : un autre compte ne voit ni ne modifie rien de A ; propriétaire d'un autre compte ne peut pas rejoindre A ;
- passage en Essentielle refusé avec 2 membres ; Pro accepté ; fonction Business alors refusée ;
- journal complet avec auteur ; un seul propriétaire, un seul compte par utilisateur.

**À écrire avant T2 à T7** :

- deux navigateurs émettent une facture en même temps : numéros consécutifs, aucun doublon ;
- deux personnes modifient deux clients différents : rien de perdu ; la même fiche : la seconde reçoit `CONFLIT_MODIFICATION` ;
- pour chaque table métier, un membre de B ne lit ni n'écrit rien de A, par l'écran et par appel direct à l'API ;
- les 14 comptes existants retrouvent exactement leurs données après T2 à T5 (comparaison avant/après sur une copie) ;
- licence expirée du compte : lecture seule pour tous ses membres ;
- écran Équipe : invitation, lien, acceptation, désactivation, sur ordinateur, tablette, mobile, en français et en arabe.

## 8. Coûts et marge par formule

Hypothèses : Supabase Pro 25 $/mois (≈ 250 DH) plus e-mails et domaine, soit **300 DH/mois de coûts fixes à 100 comptes** (3 DH par compte) ; frais d'encaissement 3 % ; **support** estimé à 15 / 20 / 30 / 60 minutes par mois selon la formule, valorisé à 100 DH/heure.

| Formule | Prix HT payé / mois | Coût technique + encaissement | Marge technique | Support estimé | Marge après support |
|---|---|---|---|---|---|
| Essentielle mensuel | 79,00 | 5,37 | 93,2 % | 25,00 | 61,6 % |
| Essentielle annuel | 65,83 | 4,97 | 92,4 % | 25,00 | 54,5 % |
| Pro mensuel | 179,00 | 8,37 | 95,3 % | 33,33 | 76,7 % |
| Pro annuel | 149,17 | 7,47 | 95,0 % | 33,33 | 72,6 % |
| Business mensuel | 299,00 | 11,97 | 96,0 % | 50,00 | 79,3 % |
| Business annuel | 249,17 | 10,47 | 95,8 % | 50,00 | 75,7 % |
| Premium mensuel | 499,00 | 17,97 | 96,4 % | 100,00 | 76,4 % |
| Premium annuel | 415,83 | 15,47 | 96,3 % | 100,00 | 72,2 % |

- L'infrastructure ne pèse presque rien ; **c'est le temps de support qui fait la marge**, surtout en Essentielle.
- Le nombre d'utilisateurs n'a pas d'effet mesurable sur Supabase (100 000 utilisateurs actifs inclus dans le plan Pro).
