# Analyse d'un concurrent : Facturago (facturago.online)

Source : vidéo de présentation (Facebook, ~2 min, filmée à l'écran) transmise le 24/10/2026, et la page d'accueil publique (métadonnées seulement : « devis, factures, clients, produits, stocks et paiements », mot-clés « maroc », « saas »). **Limites** : vidéo promotionnelle floue, aucun tarif, aucune mention légale d'éditeur ni affirmation de conformité DGI visibles ; je n'ai pas utilisé le produit. Rien n'est copié (nom, couleurs, mise en page restent propres à FacturaPro).

## Ce que la vidéo montre
- Menu mobile : tableau de bord, statistiques, **suivi des paiements**, vente (devis, factures, avoirs, **bons de livraison**), achats, **stock**, clients, **fournisseurs**, produits et services, paramètres ; sélecteur de langue.
- PDF de facture : tableau d'articles, totaux HT/TVA, **montant en toutes lettres** (« Arrêtez la présente facture à la somme de … »), net à payer, reste dû.
- Paramètres : **colonnes du PDF personnalisables** (titres de colonnes), couleur principale, pied de page et conditions par défaut, option « montant en toutes lettres ».
- Devis avec statuts (brouillon, converti…), menu d'actions (modifier, convertir, imprimer, télécharger le PDF, supprimer) ; factures « en attente / payée » ; tableau « analyse financière » avec courbe et top produits.

## Comparaison avec FacturaPro (état de `main`)
| Sujet | Facturago (vu en vidéo) | FacturaPro | Décision |
|---|---|---|---|
| Montant en toutes lettres sur le PDF | oui | **absent avant cette PR** | **Fait** (PR « Montant en lettres », tests inclus) |
| Avoirs, devis → facture, paiements, statistiques | oui | oui | rien |
| Stock, achats / fournisseurs, bons de livraison | oui | achats saisis partiellement (TVA déductible) ; pas de stock ni de BL | stock : décision « pas maintenant » maintenue (docs/DECISIONS_PRODUIT.md) ; BL : à évaluer avec des utilisateurs réels |
| Colonnes du PDF personnalisables | oui | non | idée à noter, faible priorité |
| Paiements partiels fiables, plafond serveur, restauration testée, CSV protégés contre l'injection, registre des références fiscales | non visible | en cours (PR #58 à #66) | différenciateur à documenter **seulement quand validé en préproduction** |

## Réserves
- « Montant en toutes lettres » : usage courant sur les factures marocaines, **mais je n'ai pas confirmé d'obligation légale** ; la ligne est présentée comme une aide, pas comme une conformité. À mentionner au comptable (voir docs/PROPOSITION_ICE_TVA.md).
- Aucune affirmation « plus complet que Facturago » ne doit figurer dans le marketing : elle n'est pas démontrable avec une vidéo.
