# Proposition (NON appliquée) : plafond des paiements côté serveur

Rapport de revue, 24/10/2026. Aucune migration appliquée, aucune donnée touchée. Tout ce qui est décrit ci-dessous a été exécuté uniquement dans une base PostgreSQL **locale jetable** (scripts `sql/` du dépôt) : c'est une simulation, **pas** une validation sur Supabase.

## Constat sur l'existant (`record_payment`, sql/15)
- Déjà en place : authentification, licence active, identifiant de paiement rejouable (`EXISTS` → réponse `replay`, pas de doublon), montant ≤ 0 et brouillon refusés, verrou de ligne `FOR UPDATE` sur la facture, mise à jour atomique du paiement et de la facture, droits d'exécution limités à `authenticated`, écriture directe dans `doc_payments` impossible.
- Absent : aucun plafond. Six paiements simultanés de 400 sur une facture de 1 000 sont tous acceptés (total 2 400). Le test le démontre.
- Portée : le mode « documents » n'est actif que pour les comptes de test autorisés (sql/17). Les autres comptes écrivent encore dans `user_data` : le plafond n'y existe que dans le navigateur.

## Correction de ma première version
La clause « paiement sur avoir » était inutile : `record_payment` ne cherche que `doc_type = 'invoice'`, un avoir (`'credit'`) donne déjà `FACTURE_INTROUVABLE`. Elle est remplacée par un refus des factures de total ≤ 0.

## Fonction proposée
Fichier complet : `tests/sql/proposition_record_payment.sql` (jamais dans `sql/`, donc jamais déployé par erreur). Différences avec sql/15 :
1. Le montant est lu et validé une fois (`v_amt`).
2. Facture de total ≤ 0 : `PAIEMENT_FACTURE_NULLE`.
3. Après le verrou de ligne et le test de rejeu : si cumul existant + montant > TTC + 0,01 → `PAIEMENT_SUPERIEUR_AU_RESTE`.

## Concurrence
Le `SELECT … FOR UPDATE` fait attendre le second paiement jusqu'à la fin du premier ; en READ COMMITTED, le `SUM` suivant est une nouvelle requête et voit donc le paiement validé. Le rejeu est testé avant le plafond : rejouer un paiement déjà enregistré sur une facture désormais soldée répond `ok`, sans rien ajouter. Limite connue : un rejeu avec le même identifiant de paiement mais une autre facture répond `replay` sans rien enregistrer (cas non réaliste, identifiants uuid).

## Tests réalisés (`tests/integration/paiements.sql-concurrence.test.js`, 15 contrôles, base locale)
Actuel : 6 × 400 simultanés → 2 400 acceptés. Proposé : 10 × 400 simultanés → exactement 2 acceptés ; 5 × 200 sur un reste de 200 → 1 accepté, soldé à 1 000 ; facture soldée refusée ; 8 rejeux simultanés → une ligne ; montant nul, négatif, non numérique, facture à 0 refusés ; tolérance 0,01 ; droits `anon`/`authenticated` conservés ; isolation entre comptes et RLS ; aucune écriture directe.

## À réaliser en préproduction avant toute décision
1. Ré-exécuter ces contrôles sur `facturapro-preprod` avec des comptes jetables, via le circuit habituel (SQL Editor, script `sql/25` à créer à partir de la fonction proposée, avec retour arrière = ré-application de sql/15 pour `record_payment`).
2. Vérifier avec le vrai client Supabase (PostgREST) que le message d'erreur arrive à l'application et est affiché lisiblement (aujourd'hui l'application affiche un message générique en cas de rejet serveur : à tester).
3. Adapter `tests/integration/mode.test.js` : il enregistre 7 + 8 × 1 sur une facture de 12 et dépasserait le plafond.
4. Vérifier le comportement avec des paiements anciens déjà supérieurs au TTC (le plafond ne s'applique qu'aux nouveaux paiements).
5. Décider séparément du mode « legacy » (comptes hors test) : le plafond serveur n'y protège rien tant que le nouveau stockage n'est pas généralisé.
