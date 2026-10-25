# Design des documents PDF (facture, avoir, devis, reçu de paiement)

Aperçus avec **données fictives** (logo et cachet = rectangles de test) : `docs/apercus-documents/`.

## Principes
- Fond blanc, texte et filets fins (aucun aplat de couleur) : économe en encre, lisible en **noir et blanc**.
- Couleurs = réglages « Style des documents » (principale / accent / modèle sobre) ; abonnés uniquement pour la personnalisation, comme avant.
- Même socle graphique pour les quatre documents (en-tête, parties, totaux, pied de page), mais chaque document se reconnaît à son **titre** et à son **étiquette** : FACTURE (SOLDÉE / PAIEMENT PARTIEL / ANNULÉE PAR AVOIR / BROUILLON), AVOIR (sur facture N°…), DEVIS (PROPOSITION COMMERCIALE, « Destinataire », « Bon pour accord »), REÇU DE PAIEMENT (PAIEMENT PARTIEL / SOLDÉ).
- Multipage : en-tête du tableau répété, lignes jamais coupées en deux, en-tête courant (société + type + numéro) dès la page 2, pied de page « société · ICE · IF · RC » et « Page i / n » sur chaque page. Les totaux ne sont jamais séparés de leur bloc.
- Textes longs : noms de société/client réduits puis passés sur plusieurs lignes ; troncature signalée par « … » seulement en dernier recours.
- Arabe : police Noto Naskh intégrée si le document contient de l'arabe (comportement inchangé).
- Aucun bouton ni menu : le PDF est dessiné directement (pas de capture de l'interface).

## Données utilisées (rien n'est inventé ni recalculé)
Montants : `totalHT`, `totalTVA`, `totalTTC` et lignes du document. Paiements reçus / reste à payer : `paymentSituation()` existant. TVA ventilée par taux **uniquement si** la somme des lignes égale le total. Client : lu **par identifiant** (jamais par nom), donc aucune fuite d'un client vers un autre. Champ absent = ligne absente.

## Reçu de paiement
Numéro dérivé `REÇU <n° facture>-<rang>`. Montant reçu, mode, référence, facture concernée, solde avant, total payé, reste dû après. Solde non affiché si la facture est annulée par un avoir. **Aucun reçu** si le paiement a un statut autre que confirmé/enregistré (garde-fou : les paiements n'ont pas encore de statut dans les données) ou un montant nul. Mention : « atteste uniquement le paiement effectivement enregistré… non fiscal ».

## À faire valider (comptable) : non modifié par ce design
- Mention « TVA non applicable - Article 6 du CGI (Statut Auto-Entrepreneur) » (texte conservé tel quel).
- Mention « Attention : TVA appliquée. Vérifiez votre statut fiscal. » : message d'alerte interne imprimé sur le document client ; à discuter (il serait préférable de ne pas l'imprimer).
- Identifiants affichés si renseignés : ICE, IF, RC, CNSS, Patente ; mentions légales obligatoires selon la forme juridique, pénalités de retard, escompte, indemnité de recouvrement : **non ajoutées**, à valider puis rendre configurables.
- Valeur juridique d'un devis signé (« Bon pour accord ») et d'un reçu.

## Évolutions possibles (champs manquants)
- Statut de paiement (confirmé / refusé / annulé) pour fiabiliser le garde-fou du reçu.
- Remise globale, conditions générales configurables, mentions légales par statut, montant en lettres (PR #67 en attente).
