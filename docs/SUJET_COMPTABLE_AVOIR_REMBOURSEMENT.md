# Sujet comptable séparé : avoir sur une facture déjà (partiellement) payée

**Statut : à valider avant toute implémentation. Rien n'est développé.**

## Situation actuelle (code de la PR #59)
- Avoir total émis sur facture **non payée** : facture « Annulée (avoir) », plus de reste, de relance ni de paiement.
- Avoir sur facture **payée** : la facture reste « Payée ». Le remboursement éventuel au client n'est pas suivi.
- Avoir sur facture **partiellement payée** : elle est affichée « Annulée (avoir) » alors qu'une partie a été encaissée, donc un remboursement serait dû sans être visible.

## Questions pour l'expert-comptable (je n'y réponds pas à sa place)
1. Un avoir total sur une facture encaissée génère-t-il une créance du client (remboursement) ou peut-il être imputé sur une facture future ?
2. Faut-il distinguer remboursement (sortie d'argent), imputation sur une autre facture et avoir conservé au crédit du client ?
3. Traitement de la TVA et date d'effet dans les trois cas.
4. Mentions obligatoires de l'avoir et lien avec la facture d'origine à conserver.
5. Avoir partiel : l'application doit-elle le proposer (aujourd'hui, un seul avoir total par facture) ?
6. Effet sur le chiffre d'affaires des auto-entrepreneurs (calculé à l'encaissement).

## Règle proposée à valider (hypothèse, non officielle)
Solde de la facture = TTC − encaissé − avoirs. Solde négatif = « à rembourser / à imputer », visible dans un écran dédié, avec enregistrement d'un remboursement comme paiement négatif tracé, jamais en modifiant la facture.

## Mise en œuvre après validation (lot séparé)
Modèle de données (remboursement lié à l'avoir), affichage, relances exclues, tests de non-double remboursement (même protection d'idempotence que les paiements), export comptable. Probable besoin d'une migration : préparation et tests en environnement isolé uniquement.
