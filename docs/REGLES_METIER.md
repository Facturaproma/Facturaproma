# Règles métier de référence (FacturaProMa)

Document vivant. Chaque règle indique sa source, son degré de certitude, ce qui reste à valider avec un professionnel et les tests qui la protègent.
Aucune règle n'est présentée comme officielle sans source officielle. Dernière mise à jour : 24/10/2026.

## 1. Paiements : encaissé, reste à payer

- **Règle** : le montant encaissé d'une facture est la somme de ses paiements (paiements partiels compris), plafonnée au TTC. Le reste à payer est TTC − encaissé. Une facture « payée » est soldée. Brouillons et avoirs n'ont ni reste ni encaissé.
- **Application** : tableau de bord (encaissé, en attente), module Paiements, centre d'action et relances (montant restant dû), carte Statistiques. Un paiement supérieur au reste, sur une facture soldée, ou rejoué dans les 10 secondes est refusé.
- **Source** : règle de gestion interne (pas une obligation légale). Certitude : élevée.
- **À valider** : traitement comptable des acomptes avant facturation (non géré : un acompte se saisit comme paiement d'une facture existante).
- **Tests** : `tests/paiements.unit.test.js` (17 contrôles), `tests/integration/paiements.browser.test.js` (13 contrôles, simulation locale).

### Facture annulée par un avoir
- **Règle** (gestion interne, usage comptable courant ; pas un texte légal cité) : un avoir réduit la somme due sur la facture d'origine. L'application n'émet qu'un avoir par facture et toujours égal au TTC : la facture est alors « Annulée (avoir) », sans reste à payer, ni retard, ni relance, et n'accepte plus de paiement. Un avoir partiel (non émis par l'application aujourd'hui) réduirait seulement le reste.
- **Non géré** : facture déjà payée (en tout ou partie) puis créditée → un remboursement au client serait dû ; la facture reste « Payée » et aucun remboursement n'est suivi. À traiter dans un lot dédié avec validation comptable (remboursement ou compensation).
- **Tests** : `tests/paiements.unit.test.js` (10 contrôles d'avoir), `tests/integration/avoir-facture.browser.test.js` (8 contrôles, simulation locale).

## 2. Facturation électronique DGI

- **État constaté** (source : Upsilon Consulting, « Facturation électronique au Maroc 2026 », https://upsilon-consulting.com/facturation-electronique-maroc-2026/, page indiquant un état au 28/09/2026, consultée le 24/10/2026 ; source professionnelle, non officielle) : le principe figure à l'article 145-IX du CGI (système informatique de facturation répondant à des critères fixés par l'administration), mais aucun texte d'application n'est publié au Bulletin officiel : ni calendrier, ni seuils, ni format confirmés. Les auto-entrepreneurs sont exclus (art. 145-XI selon cette source).
- **Décision produit** : ne rien développer qui prétende répondre à la facturation électronique DGI. L'application affiche déjà qu'elle n'est pas certifiée DGI.
- **À valider** : relire les textes officiels (Bulletin officiel, site de la DGI) à chaque loi de finances ; ne reprendre aucun seuil circulant dans la presse sans publication officielle.
- **Tests** : garde-fous de `scripts/check-release.js` (mentions de non-certification).

## 3. Mentions de facture, délais de paiement

- **Mentions usuelles** (ICE, IF, RC, CNSS, Patente) : voir README et `docs/PLAN_VALIDATION_FONCTIONNELLE.md`. Pas de re-vérification des textes dans ce lot : à faire avant tout nouveau développement fiscal.
- **Délais de paiement** : loi 69-21 (60 jours par défaut, 120 jours maximum conventionnel pour les entreprises concernées), déjà affichée dans l'éditeur avec la mention « confirmez auprès de la DGI ou de votre comptable ».
- **À valider par un expert-comptable** : TVA, cotisations et seuils affichés comme « indicatifs ».
