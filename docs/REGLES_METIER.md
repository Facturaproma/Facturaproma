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

### Rapports et exports
- **Règle** : « encaissé » = somme des paiements enregistrés, à la **date du paiement** (graphique 12 mois, encaissé du jour, délai de paiement = date du dernier paiement). Les anciennes factures « payées » sans ligne de paiement sont datées de `paidAt`. Avant ce lot, ces écrans lisaient un champ `paymentDate` jamais renseigné : graphique d'encaissement vide, délai « — jours », colonne « Date Paiement » vide.
- **Exports CSV** : tous les champs texte sont protégés contre l'exécution de formules dans Excel (`=`, `+`, `-`, `@`). Rapport factures : colonnes Encaissé, Reste à payer, Date dernier paiement ajoutées (les colonnes suivantes sont décalées : à prévenir si un tableur externe les lit par position). Export comptable : colonnes et statuts techniques inchangés, date et mode de paiement désormais renseignés. Nouveau : export des paiements (une ligne par encaissement).
- **Non modifié** : le rapport TVA (base encaissements) ne prend en compte que les factures entièrement payées ; le traitement de la TVA sur paiements partiels est une question fiscale à faire valider par un comptable. Le CA hors taxes des auto-entrepreneurs suit la même limite.
- **Tests** : `tests/integration/rapports-exports.browser.test.js` (13 contrôles, simulation locale), `tests/paiements.unit.test.js` (8 contrôles d'encaissements et de CSV).

## 2. Facturation électronique DGI

- **État constaté** (source : Upsilon Consulting, « Facturation électronique au Maroc 2026 », https://upsilon-consulting.com/facturation-electronique-maroc-2026/, page indiquant un état au 28/09/2026, consultée le 24/10/2026 ; source professionnelle, non officielle) : le principe figure à l'article 145-IX du CGI (système informatique de facturation répondant à des critères fixés par l'administration), mais aucun texte d'application n'est publié au Bulletin officiel : ni calendrier, ni seuils, ni format confirmés. Les auto-entrepreneurs sont exclus (art. 145-XI selon cette source).
- **Décision produit** : ne rien développer qui prétende répondre à la facturation électronique DGI. L'application affiche déjà qu'elle n'est pas certifiée DGI.
- **À valider** : relire les textes officiels (Bulletin officiel, site de la DGI) à chaque loi de finances ; ne reprendre aucun seuil circulant dans la presse sans publication officielle.
- **Tests** : garde-fous de `scripts/check-release.js` (mentions de non-certification).

## 3. Mentions de facture, délais de paiement

- **Mentions usuelles** (ICE, IF, RC, CNSS, Patente) : voir README et `docs/PLAN_VALIDATION_FONCTIONNELLE.md`. Pas de re-vérification des textes dans ce lot : à faire avant tout nouveau développement fiscal.
- **Délais de paiement** : loi 69-21 (60 jours par défaut, 120 jours maximum conventionnel pour les entreprises concernées), déjà affichée dans l'éditeur avec la mention « confirmez auprès de la DGI ou de votre comptable ».
- **À valider par un expert-comptable** : TVA, cotisations et seuils affichés comme « indicatifs ».


## Cachet, signature et reçu de paiement (24/10/2026)
- **Cachet et signature** : image (PNG, JPG ou WebP, 300 Ko maximum) envoyée dans « Mon Entreprise », réservée aux comptes avec licence active (comme le logo) ; stockée avec les données de l'entreprise (donc synchronisée). Imprimée en bas à droite des PDF de factures, de devis et de reçus, au-dessus du pied de page ; une nouvelle page est ajoutée si la place manque. Sans licence : jamais imprimée, même si une image est présente dans les données.
- **Reçu de paiement** : PDF par paiement, depuis le bouton « 🧾 Reçu » de l'historique des paiements. Même en-tête, logo et cachet que les factures. Contenu : montant reçu, date, mode, référence, facture concernée, total de la facture, total payé à ce jour (ce versement inclus), reste dû ou « Facture soldée ». Numéro dérivé sans compteur : `REÇU <n° de facture>-<rang du paiement>` (rang = ordre des dates, puis de création).
- Le reçu est un **justificatif d'encaissement, non fiscal** : il ne remplace pas la facture. Je n'ai pas vérifié si la loi marocaine impose des mentions ou une numérotation particulières ; à faire valider par un comptable avant de le présenter comme conforme.
- Le cachet du client n'est pas géré (circuit de signature hors périmètre) : une ligne « Bon pour accord » peut être envisagée sur les devis.

## Numérotation de départ (souscription en cours d'année)

- Mon Entreprise > « Numérotation de départ » : l'utilisateur indique le **dernier numéro déjà utilisé** (factures, devis, avoirs ; entier de 0 à 1 000 000). La prochaine pièce portera le numéro suivant (42 → `FAC-<année>-043`).
- Mécanisme : ce réglage alimente le compteur local, utilisé comme plancher de la **première** attribution serveur (`next_doc_number`, sql/14). Ensuite le serveur tient la suite (`doc_counters`, non modifiable par le client) : le champ est donc **verrouillé** dès qu'un document de ce type a été émis ici.
- Limite connue : le format affiche l'année en cours (`PRÉFIXE-AAAA-NNN`). Si l'ancien système numérotait autrement, la continuité de la suite est à valider avec le comptable. Aucune conformité n'est promise.
- Non testé sur un vrai Supabase ni sur téléphone : simulation locale uniquement.

## Exemples et sauvegarde technique

- « Facture d'exemple » / « Reçu d'exemple » (Mon Entreprise) : PDF fictifs portant le filigrane EXEMPLE, avec les réglages réels de l'entreprise (en-tête, logo, cachet, préfixe, prochain numéro). Rien n'est enregistré, aucun numéro n'est consommé. Ils ne permettent pas de tester l'enregistrement d'un vrai paiement.
- « Sauvegarde technique (JSON) » : fichier de dépannage (format `facturapro-sauvegarde-technique`, version 1), pas un document comptable ni la sauvegarde officielle (celle du serveur). L'import est additif : il ajoute clients, produits, brouillons de facture et devis absents, n'écrase rien, ignore factures émises, paiements, compteur et entreprise (verrouillés ou sensibles côté serveur). Confirmation obligatoire avant écriture.

## Pagination des listes

- Toutes les grandes listes affichent **10 lignes par page**, avec onglets ‹ 1 2 3 › et l'indication « 1–10 sur N » : application (factures, devis, clients, produits, paiements à encaisser, historique des paiements) et administration (comptes, demandes, licences, codes, paiements, trésorerie, documents, journal).
- Un changement de recherche ou de filtre ramène à la page 1. Les exports (CSV) et les totaux portent toujours sur **toute** la liste filtrée, pas seulement sur la page affichée.
- Les anciennes coupures silencieuses (50 codes, 10 derniers paiements) disparaissent : tout est consultable page par page.
- Non paginés : les rapports et tableaux récapitulatifs (TVA, CNSS, top clients…), qui sont des synthèses.

## CNSS des auto-entrepreneurs (écran CNSS)

- **Règle appliquée** : cotisation CNSS (AMO + retraite TNS) = **montant fixe par trimestre**, selon une tranche T1 à T8 déterminée par l'impôt libératoire du trimestre (0,5 % commerce/industrie/artisanat, 1 % services, sur le CA encaissé HT). Due **même sans chiffre d'affaires** (minimum T1).
- **Grille** (impôt trimestriel → cotisation par trimestre) : ≤ 125 → 300 DH ; ≤ 250 → 390 ; ≤ 625 → 570 ; ≤ 1 250 → 720 ; ≤ 2 500 → 1 050 ; ≤ 6 250 → 1 500 ; ≤ 12 500 → 2 250 ; au-delà → 3 600. (Équivalent annuel : 500 / 1 000 / 2 500 / 5 000 / 10 000 / 25 000 / 50 000.)
- **Échéances** : 30 avril (T1), 31 juillet (T2), 31 octobre (T3), 31 janvier de l'année suivante (T4) ; paiement avec l'impôt sur ae.gov.ma.
- **Ancienne erreur corrigée** : l'écran appliquait 1 % / 0,5 % du CA comme « cotisation CNSS » ; ce sont les taux de l'impôt, pas de la CNSS.
- **Sources** : guides publiés en 2026 (Fatoura Plus, LMoukawil, ClicPaie), concordants sur la grille ; décrets cités par ces guides : 2.21.477, 2.21.928, 2.22.208 ; lois 114-13, 98-15, 99-15. **Les pages officielles (cnss.ma, rn.ae.gov.ma) n'ont pas pu être lues automatiquement** : à confirmer par le propriétaire ou un comptable (montants, bornes exactes ≤ / <, éventuelle révision par décret). Les valeurs sont dans `FISCAL_RULES.aeCnss` (app.html), modifiables en un seul endroit.
- **Non vérifié** : plafonds de chiffre d'affaires AE affichés (500 000 DH services / 200 000 DH commerce), et taux salariés/employeur (inchangés).
