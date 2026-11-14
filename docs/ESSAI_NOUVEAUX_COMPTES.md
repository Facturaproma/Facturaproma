# Essai des nouveaux comptes : spécification (12/11/2026, durée fixée à 30 jours)

> **Statut : spécification seulement. Rien n'est développé ni activé.** Règle validée par le propriétaire le 12/11/2026 ; son activation (migration, écrans, valeurs des réglages) demande une autorisation distincte. Étape T7 du plan de `docs/COMPTES_ET_ABONNEMENTS.md`.

## 1. Règle validée

**Nouveau compte → essai de 30 jours → Essentielle comme formule de référence → à la fin de l'essai, application normale des limites et de la formule choisie.**

Fin des 30 jours (décision du 12/11/2026) :

- formule payante choisie et active : ses limites s'appliquent ;
- sans paiement : lecture seule ;
- aucune donnée supprimée, aucun compte exclu, aucun utilisateur supprimé.

- Ne concerne **que les nouveaux comptes**. Les comptes existants gardent leurs conditions historiques (`legacy`) ; ils n'entrent jamais dans ce parcours.
- Le comportement exact de l'essai reste **configurable avant activation** (section 3).

## 2. Ce qui existe aujourd'hui (production, inchangée)

| Élément | État | Où |
|---|---|---|
| Essai | licence `trial` créée au premier accès, **14 jours** depuis l'inscription, toutes les fonctions | `sql/07`, reprise dans `sql/08`, `sql/09`, `sql/20`, `sql/23` |
| Durée | **écrite en dur** (`INTERVAL '14 days'`) dans la version en production des scripts | — |
| Fin d'essai | licence expirée : **lecture seule** (pas de période de grâce pour l'essai ; 3 jours pour les licences payantes) | `has_active_license`, `license_grace_days()` |
| Formule pendant l'essai | aucune notion de formule : tout est ouvert | — |
| Site | annonce « 14 jours d'essai gratuit, sans carte bancaire » | `index.html` |

### Durée de 30 jours : préparée dans les scripts, non activée

Décision du 12/11/2026 : **30 jours pour les nouveaux clients.** Les 10 occurrences de `INTERVAL '14 days'` réparties dans 7 scripts (`sql/07`, `08`, `09`, `20`, `23`, `45`, `48` ; le 7e, `sql/45`, n'avait pas été compté le 12/11 au matin) appellent désormais `public.fp_trial_end(created_at)` (défini dans `sql/07`) :

- **30 jours** pour un compte créé à partir de la date d'activation `trial_config.trial30_from` ;
- **14 jours** pour un compte créé avant : ses conditions d'origine, inchangées (sinon, des comptes de 15 à 30 jours retrouveraient un essai actif) ;
- tant que `trial30_from` est vide (état à l'installation), **le comportement est exactement celui d'avant** ;
- une licence d'essai déjà enregistrée n'est jamais prolongée (sa date de fin est écrite dans la table `licenses`).

Activation, **sur autorisation** : appliquer les scripts modifiés, puis `UPDATE public.trial_config SET trial30_from = now();`. Les textes publics (accueil, conditions, application) annoncent déjà 30 jours dans la même PR : **ils doivent être mis en ligne en même temps que l'activation**, sinon le site promettrait 30 jours alors que le serveur en accorde 14. Tests : `tests/sql/test_essai.sql`.

## 3. Réglages (configurables, valeurs par défaut proposées)

Une seule ligne de réglages, modifiable par l'administration FacturaPro (2FA), chaque changement tracé.

| Réglage | Défaut proposé | Rôle |
|---|---|---|
| `trial_enabled` | `true` | Un nouveau compte reçoit-il un essai ? Si `false`, il démarre directement en Essentielle, en lecture seule tant qu'il n'a pas payé |
| `trial_days` | **`30` (décidé le 12/11/2026)** | Durée de l'essai, comptée depuis la création du compte |
| `trial_plan_key` | `essentielle` | Formule dont l'essai ouvre les fonctions. Peut être réglée sur une formule supérieure (ex. `business`) pour faire découvrir davantage ; jamais `legacy` (refusé par le serveur, comme `account_set_plan`) |
| `trial_max_users` | `1` | Nombre d'utilisateurs pendant l'essai, quelle que soit la formule d'essai |
| `trial_end_mode` | `lecture_seule` | À la fin sans abonnement payé : `lecture_seule` (règle actuelle) ; pas de suppression, pas d'exclusion |
| `trial_grace_days` | `0` | Jours de tolérance après la fin de l'essai (aujourd'hui 0 pour l'essai) |
| `trial_reminder_days` | `{7, 3, 1}` | Rappels à l'écran avant la fin (aucun e-mail automatique à cette étape) |

**Les réglages s'appliquent aux essais qui commencent après leur modification.** Chaque compte garde une copie des valeurs au moment de sa création : modifier un réglage ne raccourcit ni n'allonge un essai en cours.

## 4. Modèle de données cible (non écrit)

Ajouts prévus, sans toucher aux données existantes :

| Objet | Ajout | Valeur pour les comptes existants |
|---|---|---|
| `trial_settings` (nouvelle table, une ligne) | réglages de la section 3 | — |
| `accounts` | `trial_started_at`, `trial_ends_at`, `trial_plan_key`, `trial_max_users` (copie des réglages) | `NULL` : pas d'essai, conditions historiques |
| `accounts.plan_key` | formule choisie ; `essentielle` par défaut (déjà le cas dans `sql/48`) | `legacy` (inchangé) |

Fonction centrale prévue, utilisée par toutes les vérifications serveur (`fp_account_can`, limites d'utilisateurs) :

```
fp_account_effective(account) → (formule, utilisateurs max, accès)
  1. plan_key = 'legacy'                         → legacy, 1 utilisateur, accès selon la licence actuelle
  2. maintenant < trial_ends_at                  → trial_plan_key, trial_max_users, accès complet à cette formule
  3. abonnement payé actif sur plan_key          → plan_key, ses utilisateurs max, accès complet
  4. sinon (essai fini, rien payé)               → plan_key, ses utilisateurs max, LECTURE SEULE (trial_end_mode)
```

## 5. Fin de l'essai

1. **Aucune action automatique destructrice** : pas de suppression de données, pas d'exclusion de membre.
2. **Formule choisie et payée** : ses fonctions et sa limite d'utilisateurs s'appliquent immédiatement.
3. **Rien de payé** : lecture seule ; l'utilisateur consulte et exporte ses données, n'émet plus de document.
4. **Plus de membres que la formule choisie** (possible seulement si `trial_max_users` a été réglé au-dessus de 1) : les membres au-delà de la limite passent en lecture seule jusqu'à ce que le propriétaire désactive des membres ou change de formule. Le propriétaire n'est jamais concerné.
5. **Fonction utilisée pendant l'essai mais absente de la formule choisie** (ex. essai réglé en Business, choix Essentielle) : les données restent consultables et exportables ; seule la création ou la modification est refusée par le serveur.

## 6. Ce que l'activation demandera

| Étape | Contenu | Autorisation |
|---|---|---|
| Migration | `trial_settings`, colonnes d'essai sur `accounts`, `fp_account_effective` ; lecture des réglages (la durée passe déjà par `fp_trial_end`, voir § 2) | **oui** (structurante) |
| Écrans | bandeau d'essai (jours restants, formule d'essai), choix de la formule, rappels | **oui** (activation commerciale) |
| Site | texte de l'essai aligné sur `trial_days` | **oui** (déploiement) |
| Licences | rapprochement licence `trial` ↔ `accounts.trial_ends_at` (une seule source de vérité, prévue en T4) | **oui** |

Prérequis : T1 (`sql/48`) appliquée et T4 (fonctions serveur par compte) faite, sinon les limites ne seraient pas vérifiées par le serveur.

## 7. Tests à écrire avant activation

- nouveau compte : essai créé avec les réglages du moment ; `legacy` jamais attribué ;
- réglage modifié : les essais en cours ne changent pas, les suivants prennent la nouvelle valeur ;
- `trial_plan_key = 'legacy'` refusé ;
- pendant l'essai : fonctions de la formule d'essai seulement ; utilisateurs limités à `trial_max_users` ;
- fin d'essai sans paiement : lecture seule, export possible, émission refusée par le serveur ;
- fin d'essai avec formule payée : limites de la formule, sans interruption ;
- membres au-delà de la limite après l'essai : lecture seule, rien de supprimé ;
- comptes existants (`legacy`) : aucun changement de comportement ;
- `trial_enabled = false` : compte en Essentielle, lecture seule jusqu'au paiement.

## 8. Décisions à prendre avant activation

1. ~~Durée~~ : **30 jours, décidé le 12/11/2026.**
2. Formule d'essai : Essentielle (règle validée) ou une formule supérieure pour faire découvrir.
3. Utilisateurs pendant l'essai : 1 (proposé) ou plus.
4. Rappels de fin d'essai : à l'écran seulement, ou aussi par e-mail (demande un service d'envoi).
