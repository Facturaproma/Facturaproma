# Plan de validation en préproduction : plafond des paiements (record_payment)

**Statut : PLAN. Rien n'est exécuté.** Aucune action sur Supabase sans l'autorisation écrite de Noureddine. Production (`mdozjptoecygmpkjlohr`) hors périmètre. Préproduction : `njjaomichdlnoscrnxlz`.
Fonction à valider : `tests/sql/proposition_record_payment.sql` (revue : `docs/PROPOSITION_SQL_PAIEMENTS.md`). Les résultats locaux (base PostgreSQL jetable) ne valent pas validation Supabase.

## 0. Prérequis (lecture seule)
1. Confirmer que sql/15, 16 et 17 sont appliqués en préproduction (`list_migrations`, présence de `documents`, `doc_payments`, `record_payment`, `doc_store_mode`).
2. Enregistrer la définition actuelle : `SELECT pg_get_functiondef('public.record_payment(text,jsonb,text)'::regprocedure)` et les droits (`has_function_privilege` pour anon/authenticated/public). Elle sert de **retour arrière** (ré-exécuter ce texte).
3. Ne jamais toucher les lignes de préproduction `cff4cac4` et `fe82bee1`.

## 1. Données jetables
- 2 comptes `ui-pay-a@…invalid` et `ui-pay-b@…invalid` (préfixe `ui-`, comme les comptes de test déjà nettoyés), licence active, mode `documents` via le circuit habituel (`fp_doc_mode_set`).
- Aucun vrai RIB, aucune vraie donnée client.
- Factures émises (numéros attribués par le serveur) : F1 1 000 DH, F2 1 000 DH, F3 600 DH, F4 0 DH, plus un avoir total sur F2 pour le test 9.

## 2. Application de la fonction (après autorisation, préproduction seulement)
- Créer `sql/25_plafond_paiements.sql` à partir de la fonction proposée (CREATE OR REPLACE, idempotent, commentaire de retour arrière), l'appliquer via le circuit habituel de préproduction, puis relire `pg_get_functiondef` et les droits.
- Critère : droits identiques à l'étape 0 (anon non, authenticated oui).

## 3. Tests (reprise des 15 contrôles locaux avec le vrai Supabase)
| # | Test | Résultat attendu |
|---|------|------------------|
| 1 | 10 appels simultanés de 400 sur F1 (clients parallèles, vrai PostgREST) | 2 acceptés, 8 `PAIEMENT_SUPERIEUR_AU_RESTE`, cumul 800 |
| 2 | 5 appels de 200 sur le reste de F1 | 1 accepté, F1 « paid », cumul 1 000 |
| 3 | Paiement de 0,02 sur F1 soldée | Refusé |
| 4 | Même identifiant de paiement rejoué 8 fois en parallèle sur F3 | 8 réponses ok, 1 ligne, 300 |
| 5 | Rejeu d'un ancien paiement sur facture soldée | Réponse `replay`, rien ajouté |
| 6 | Montant 0, négatif, texte ; facture F4 à 0 ; brouillon | Tous refusés |
| 7 | 600,01 sur 600 (tolérance 0,01) | Accepté |
| 8 | Compte B : même id de paiement que A ; lecture des paiements de A | Aucun lien, 0 ligne visible (RLS) |
| 9 | Paiement sur F2 annulée par avoir (application) | Refusé par l'application ; noter le comportement serveur (non bloqué tant que le serveur ne connaît pas l'avoir : à décider) |
| 10 | Écriture directe dans `doc_payments` par le client | Refusée |
| 11 | Message d'erreur : l'application (préproduction déployée, mode documents) affiche-t-elle un texte lisible quand le serveur refuse ? | À constater, corriger si message technique |
| 12 | Anciens paiements supérieurs au TTC déjà présents (données jetables préparées) | Aucun effet rétroactif, nouveaux paiements refusés |
| 13 | `mode.test.js` adapté au plafond | Passe |

## 4. Nettoyage et clôture
- Supprimer uniquement les comptes `ui-pay-*` créés pendant le run (identité par UUID relevée avant), avec l'accord explicite requis pour toute suppression.
- Conserver le rapport de run (sans clé ni mot de passe).
- **Go** si 13/13 ; **No-go** à la moindre divergence avec la simulation locale : on documente la cause, on ne contourne pas.

## 5. Après préproduction (décisions séparées)
Migration de production : présentation du script, du retour arrière et de l'impact (comptes en mode `documents` seulement), autorisation explicite, application par l'utilisateur dans le SQL Editor ou via le circuit validé.

## Validations manuelles sur téléphone (hors SQL)
1. Paiement partiel puis solde d'une facture : montant prérempli, reste affiché, tableau de bord cohérent.
2. Double appui rapide sur « Enregistrer » : un seul paiement.
3. Tentative de trop-perçu : message clair, rien enregistré.
4. Facture avec avoir : « Annulée (avoir) », absente des relances et des montants en attente.
5. Fenêtre de paiement lisible en largeur 360–400 px.
