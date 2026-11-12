# Comptes partagés et abonnements (11/11/2026, grille mise à jour le 12/11/2026)

Décision du propriétaire du 11/11/2026 : **1 compte = 1 entreprise = 1 espace de travail partagé**. Plus de multi-sociétés. Plusieurs utilisateurs par compte selon la formule.

> **Statut.** Grille validée comme référence commerciale le **12/11/2026** (elle remplace celle du 11/11 : 79 / 179 / 299 / 499). **Rien n'est appliqué en production** : ni prix, ni abonnement, ni migration. L'étape T1 (`sql/48_comptes_partages.sql`) est écrite et testée en local ; son application demande un accord distinct.

## 1. Grille tarifaire

| Formule | HT / mois | TTC / mois (TVA 20 %) | HT / an (10 mois) | TTC / an | Économie annuelle HT | Utilisateurs max |
|---|---|---|---|---|---|---|
| Essentielle | 99 DH | 118,80 DH | 990 DH | 1 188 DH | 198 DH | 1 |
| Pro | 199 DH | 238,80 DH | 1 990 DH | 2 388 DH | 398 DH | 2 |
| Business | 349 DH | 418,80 DH | 3 490 DH | 4 188 DH | 698 DH | 3 |
| Premium | 549 DH | 658,80 DH | 5 490 DH | 6 588 DH | 1 098 DH | 5 |

- TTC seulement si FacturaPro est vendu par une entité assujettie à la TVA ; sinon le prix HT est le prix payé (à confirmer avec le comptable).
- Annuel : **10 mois facturés pour 12 mois d'utilisation** (2 mois offerts, soit 16,7 %).
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
| Rapports avancés | `rapports_avances` | — | — | — | **non vendu** : n'existe pas ; absent de `plan_catalog` tant qu'il n'est pas développé |
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
| Rapports avancés | Premium | **Retiré de la vente** (décision du 12/11) | Rien d'existant ne correspond ; à définir et développer avant de le vendre |

### Clients existants : conditions historiques (`legacy`)

`legacy` est une **condition de conservation**, pas une formule commerciale. Le site promet « Tout illimité » aux offres actuelles (essai, mensuel, annuel, Fondateurs, à vie) ; les clients existants à la date de la reprise gardent :

- **toutes les fonctions existantes**, comme aujourd'hui ;
- **1 utilisateur**, comme aujourd'hui (le multi-utilisateurs n'a jamais été livré) ;
- leurs prix et leurs licences, **inchangés** (les licences ne sont pas touchées par sql/48).

Garde-fous dans `sql/48` :

- `plan_catalog.offered = false` : jamais affichée dans une grille ni proposée à un nouveau client ;
- seule la reprise (`fp_accounts_backfill`) attribue `legacy`, aux comptes qui existent à ce moment-là ;
- un **nouveau client** reçoit `essentielle` (`account_ensure`) en attendant son choix (T7) ;
- l'administration ne peut pas attribuer `legacy` à un compte qui ne l'a pas (`FORMULE_NON_PROPOSEE`) : un compte qui la quitte ne la retrouve pas.

Les licences **à vie** restent en conditions historiques sans limite de durée. Le passage éventuel d'un client existant vers la nouvelle grille (offre de bascule) est une décision commerciale distincte.

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
| **T1** | `sql/48` : comptes, membres, invitations, formules ; reprise : un compte par utilisateur existant, propriétaire, conditions historiques `legacy` | aucun | faible | DROP des tables et fonctions de sql/48 |
| T2 | `account_id` sur les tables métier, rempli depuis le propriétaire ; rempli automatiquement à l'insertion | aucun | moyen | colonne ignorée puis supprimée |
| T3 | Clients, produits, fournisseurs, fiche entreprise, salariés : tables avec `version` ; l'application lit les deux pendant la transition | aucun si réussi | **élevé** (synchronisation) | ancien `user_data` conservé intact jusqu'à validation |
| T4 | Fonctions serveur par compte et par permission ; numérotation par compte | aucun pour un compte à 1 utilisateur | **élevé** | anciennes fonctions gardées sous un autre nom |
| T5 | RLS par compte, en parallèle des anciennes règles puis seule | aucun | **élevé** (sécurité) | réactivation des anciennes règles |
| T6 | Écrans : page Équipe réelle, invitation, rôles ; ouverture d'un lien d'invitation | **oui** | moyen | masquage de la page |
| T7 | Limites par formule dans les écrans et le serveur ; console admin pour attribuer une formule ; page Tarifs | **oui** (commercial) | moyen | comptes existants en `legacy`, nouveaux en Essentielle |

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
- grille 99/199/349/549, 1/2/3/5 utilisateurs, 10 mois par an ; formules cumulatives ; facturer et TVA sur les ventes présents partout ; « Rapports avancés » vendu nulle part ;
- conditions historiques : non proposées, conservées par les comptes existants, jamais réattribuées ; nouveau client en Essentielle ; `legacy` ne perd rien ;
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

## 8. Coûts et marge par formule (indicatifs)

> **Ces marges ne sont pas définitives.** Trois hypothèses ne sont pas confirmées : le temps de support réel (aucune mesure à ce jour), le mode et le coût d'encaissement (aujourd'hui virement ou espèces, activation manuelle), et le statut fiscal du vendeur (TVA facturée ou non, impôt sur le résultat non compté).

Hypothèses retenues :

- Supabase Pro 25 $/mois (≈ 250 DH) plus e-mails et domaine : **300 DH/mois à 100 comptes, soit 3 DH par compte** ;
- frais d'encaissement : **3 % du prix** (hypothèse prudente ; un virement manuel coûte surtout du temps) ;
- **support** : 15 / 20 / 30 / 60 minutes par mois selon la formule, valorisées à 100 DH de l'heure.

| Formule | Prix HT payé / mois | Coût technique + encaissement | Marge technique | Support estimé | Marge après support | Si le support double |
|---|---|---|---|---|---|---|
| Essentielle mensuel | 99,00 | 5,97 | 94,0 % | 25,00 | 68,7 % | 43,5 % |
| Essentielle annuel | 82,50 | 5,47 | 93,4 % | 25,00 | 63,1 % | 32,8 % |
| Pro mensuel | 199,00 | 8,97 | 95,5 % | 33,33 | 78,7 % | 62,0 % |
| Pro annuel | 165,83 | 7,98 | 95,2 % | 33,33 | 75,1 % | 55,0 % |
| Business mensuel | 349,00 | 13,47 | 96,1 % | 50,00 | 81,8 % | 67,5 % |
| Business annuel | 290,83 | 11,72 | 96,0 % | 50,00 | 78,8 % | 61,6 % |
| Premium mensuel | 549,00 | 19,47 | 96,5 % | 100,00 | 78,2 % | 60,0 % |
| Premium annuel | 457,50 | 16,73 | 96,3 % | 100,00 | 74,5 % | 52,6 % |

- L'infrastructure ne pèse presque rien ; **c'est le temps de support qui fait la marge**, surtout en Essentielle annuelle.
- Le nombre d'utilisateurs n'a pas d'effet mesurable sur Supabase (100 000 utilisateurs actifs par mois inclus dans le plan Pro). Un utilisateur de plus coûte surtout du support.

## 9. Cohérence commerciale de la grille du 12/11

### Positionnement (prix publics relevés le 11/11/2026)

| Besoin | FacturaPro | Concurrents relevés |
|---|---|---|
| 1 utilisateur | Essentielle 99 DH HT | Factura MA 49 DH ; Facturis Starter 99 DH ; Factu iA Pro 199 DH HT |
| 2 à 3 utilisateurs | Pro 199 DH HT (2) ; Business 349 DH HT (3) | Facturis Business 279 DH (3 utilisateurs, achats et trésorerie) ; Factu iA 299 DH HT |
| 5 utilisateurs | Premium 549 DH HT | Facturis Enterprise 479 DH (5 utilisateurs, stock) ; Factu iA 499 DH HT |

- **Essentielle à 99 DH** est au niveau des offres professionnelles à un utilisateur, deux fois l'entrée de gamme (49 DH). Elle se justifie par une facturation complète (avoirs, paiements, TVA, lien client) mais **perd l'argument du prix** face aux offres à 49 DH : l'argument doit être la conformité et la qualité.
- **Business (349) et Premium (549) sont au-dessus de Facturis** à nombre d'utilisateurs égal. Ce qui le justifie et n'est affiché par aucun concurrent relevé : relevé des déductions avec fichier XML SIMPL, clôture mensuelle, CNSS, interface arabe. **À montrer sur la page Tarifs**, sinon le client compare au prix seul.
- Le caractère HT ou TTC des prix concurrents n'est pas toujours indiqué ; la comparaison est donc approximative.

### Mensuel ou annuel

- L'annuel donne **2 mois sur 12 (16,7 %)**, comme la plupart des concurrents.
- Il rapporte 16,7 % de moins par mois, mais **encaisse 12 mois d'avance** et remplace 12 encaissements manuels par un seul : avec des virements vérifiés à la main, c'est le format le moins coûteux à gérer.
- Le support est le même chaque mois : la marge après support de l'annuel est plus basse (−3 à −6 points), compensée par une fidélité d'un an.

### Valeur de 1, 2, 3 et 5 utilisateurs

| Formule | Prix HT / mois | Utilisateurs | Prix par utilisateur | Ce qui s'ajoute à la formule précédente |
|---|---|---|---|---|
| Essentielle | 99 | 1 | 99,00 | — |
| Pro | 199 | 2 | 99,50 | +1 utilisateur, achats, déductions XML, stock, BL, relances, statistiques |
| Business | 349 | 3 | 116,33 | +1 utilisateur, exports comptables, pilotage, trésorerie, récurrences, CNSS, clôture |
| Premium | 549 | 5 | 109,80 | +2 utilisateurs, support prioritaire |

- **Pro double le prix pour doubler les utilisateurs** et ajoute la gestion des achats : le passage est facile à justifier.
- **Business coûte plus cher par utilisateur que Pro et Premium.** Un client Pro qui veut seulement un 3e collaborateur paie +150 DH pour des modules dont il n'a peut-être pas besoin. C'est cohérent si Business se vend sur ses modules (comptabilité, trésorerie, clôture), pas sur le 3e utilisateur.
- **Premium vaut surtout +2 utilisateurs (+200 DH, soit 100 DH par utilisateur) et le support prioritaire.** Sans « Rapports avancés », c'est son seul contenu propre : à présenter comme « formule équipe », pas comme « formule la plus complète ».
- Pas d'utilisateur supplémentaire à l'unité : simple à vendre et à contrôler, au prix de ces sauts. À réexaminer après les premiers clients.

**Conclusion** : la grille reste cohérente avec un SaaS professionnel. Les marges techniques sont très élevées partout ; ce sont le support, l'encaissement et le statut fiscal, non confirmés, qui décideront de la marge réelle.
