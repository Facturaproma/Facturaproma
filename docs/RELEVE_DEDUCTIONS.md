# Relevé des déductions de TVA (09/11/2026)

Demandé par le propriétaire, sur le modèle du logiciel et du fichier Excel utilisés par Marwan.

## Règle appliquée

- La TVA d'une facture d'achat se déduit **le mois de son paiement**, total ou partiel. Avant, FacturaPro utilisait la date de la facture.
  - Source : Attijari Entreprises, *La taxe sur la valeur ajoutée*, « le mois de paiement total ou partiel ».
  - Source : Upsilon Consulting, article 101-3° du CGI.
- **Chaque règlement fournisseur de la période donne une ligne.** Une pièce à plusieurs taux est ventilée au prorata du TTC payé.
- **Annulation d'un règlement :** ligne négative, au mois de l'annulation.
- **Avoir fournisseur reçu après paiement :** la TVA déjà déduite sur la part remboursée est régularisée, en négatif, au mois de l'avoir.
  - Si l'avoir arrive avant le paiement, il n'y a rien à régulariser : on paie le net.
- **Achats à TVA non déductible et achats annulés :** exclus.
- **Factures saisies à la main dans l'écran TVA :** comptées au mois de leur date de paiement.

## Colonnes

Le tableau, l'export Excel et l'impression ont les mêmes colonnes :

| Colonne | Contenu |
|---|---|
| N° | Numéro d'ordre de la ligne |
| Facture | N° de facture du fournisseur, à défaut le n° ACH |
| Date facture | Date de la pièce |
| Désignation | Selon la nature : charges + catégorie, achats de marchandises, achats immobilisés |
| Fournisseur | Nom |
| IF, ICE | Repris de la fiche du fournisseur |
| HT, Taux, TVA, TTC | Montants de la ligne |
| Mode de paiement | Voir la liste ci-dessous |
| Date de paiement | Date du règlement |

Modes de paiement :

| Code | Mode |
|---|---|
| 1 | Espèces |
| 2 | Chèque |
| 3 | Prélèvement |
| 4 | Virement |
| 5 | Effet |
| 6 | Compensation |
| 7 | Autres |

- Les 7 codes et leur ordre sont confirmés par la liste du logiciel de déclaration de Marwan (09/11/2026). C'est ce code qui va dans la balise `<mp><id>` du fichier XML.

## Contrôles

- **Alertes à l'écran** (la ligne est signalée et la cellule passe en rouge) :
  - IF manquant ;
  - ICE différent de 15 chiffres ;
  - mode de paiement à compléter ;
  - paiement en espèces, dont la déduction est plafonnée : à vérifier.
- **Le fichier XML n'est pas créé** tant qu'il reste une erreur bloquante :
  - IF de la société ;
  - IF ou ICE d'un fournisseur ;
  - mode de paiement ;
  - date de paiement ou de facture ;
  - n° de facture ;
  - relevé vide.

## Fichier XML (zip)

La structure est reprise du fichier produit par le logiciel de Marwan :

```
DeclarationReleveDeduction
  identifiantFiscal, annee, periode, regime
  releveDeductions
    rd
      ord, num, des, mht, tva, ttc
      refF : if, nom, ice
      tx
      mp : id
      dpai, dfac
```

- **regime :** 1 = mensuel, 2 = trimestriel.
- **periode :** le mois (1 à 12) ou le trimestre (1 à 4).
- **Montants :** 2 décimales, avec un point.
- **Dates :** au format AAAA-MM-JJ.
- **Livraison :** un seul fichier XML dans un zip, nommé `releve_deductions_<IF>_<année>_<période>`.

Aucun schéma officiel (XSD) n'a été relu. **Avant le premier vrai dépôt**, il faut :
1. faire valider un fichier par un comptable, ou par un dépôt de test sur SIMPL ;
2. vérifier la valeur « 2 » pour le régime trimestriel (le régime mensuel « 1 » est confirmé par le fichier de Marwan).

## Serveur (sql/47)

- **Table `payment_modes` :** une ligne par règlement fournisseur.
  - Table fermée (RLS sans politique).
  - Les mouvements de trésorerie restent non modifiables : `trg_cash_guard` est inchangé.
- **`supplier_settle` :** accepte un champ `mode` facultatif.
  - Un mode inconnu est refusé avant toute écriture.
- **`payment_mode_set(règlement, mode)` :** complète ou corrige le mode d'un règlement.
  - Le montant et la date ne changent pas.
  - Chaque changement est tracé dans `fin_audit`.
  - Les annulations sont refusées.
- **`vat_deduction_payments(du, au)` :** liste les règlements fournisseurs et leurs annulations (en négatif), avec le mode d'origine.

**Retour arrière**, après accord et en retirant d'abord l'application :
1. recoller `supplier_settle` de sql/39 ;
2. supprimer les deux fonctions et la table `payment_modes`.

## Déploiement

- **Script SQL :** lancé par le propriétaire (GitHub › Actions › **releve-deductions-deploy** › Run workflow, cible `prod`, mot `APPLIQUER`). Une seule transaction, contrôles avant et après.
- **Application :** elle peut être en ligne avant le script.
  - Sans sql/47, le relevé affiche « mise à jour du serveur en attente » et la TVA déductible reste calculée à la date des factures.
  - Le champ « mode » est ignoré par l'ancien `supplier_settle`.

## Tests

| Test | Résultat |
|---|---|
| `tests/sql/test_releve_deductions.sql` | 18 contrôles |
| `tests/fiscal.unit.test.js` | 23 nouveaux contrôles : ventilation, arrondis, annulations, avoirs, saisie manuelle, XML, Excel |
| `tests/integration/releve-deductions.browser.test.js` | 20 contrôles : écran, mode proposé selon le compte, mode complété, erreurs bloquantes, zip et .xlsx relus, impression |
