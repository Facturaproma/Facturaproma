# ICE et TVA — proposition documentée (aucune règle modifiée)

Date de consultation des sources : 24/10/2026. Statut : **proposition à valider par un expert-comptable**. Aucune règle fiscale n'est changée dans l'application par ce document.

## 1. Limite de la recherche (à lire d'abord)
Les PDF officiels de la DGI (CGI 2026 sur tax.gov.ma, note circulaire 737 sur la loi de finances 2026) **n'ont pas pu être lus** par mes outils (le site interdit la lecture automatisée ; je ne contourne pas ce refus). Les points ci-dessous s'appuient donc sur des sources **secondaires**, à confronter au texte officiel :
- Code général des impôts 2026 (officiel, à ouvrir par le comptable) : https://www.tax.gov.ma/wps/wcm/connect/08712531-1e81-4e28-a38b-2bd9edf8e09e/CGI+2026+FR.pdf
- Note circulaire n° 737 (loi de finances 2026, officielle) : https://www.tax.gov.ma/wps/wcm/connect/e48c5c9d-ae80-4b30-a1b3-80af7ec09be1/NC+737+LF+2026.pdf
- Upsilon Consulting, « Fait générateur et exigibilité de la TVA au Maroc » (cabinet privé, revu le 08/09/2026) : https://upsilon-consulting.com/fait-generateur-exigibilite-tva-maroc/
- Médias24, 23/03/2018, note de la DGI sur l'ICE (presse, ancienne) : https://www.medias24.com/MAROC/Quoi-de-neuf/181508-La-DGI-appelle-les-entreprises-a-mentionner-leur-ICE-sur-toutes-les-declarations-fiscales.html

## 2. ICE
| Point | Ce que disent les sources | Certitude |
|---|---|---|
| ICE sur les factures | La DGI rappelle (2018) que les contribuables doivent mentionner l'ICE sur les factures, selon l'art. 145 du CGI, cité « 145-VIII » par Médias24. | Obligation : probable. **Numéro de paragraphe incertain** : nos documents citent « 145-IX » ; la numérotation a pu changer. À vérifier dans le CGI 2026. |
| ICE sur les déclarations | Mention exigée sur les déclarations et documents présentés à l'administration ; condition formelle pour certains avantages (art. 164-I cité). | Source secondaire. |
| Sanction pour absence d'ICE | Médias24 n'en cite pas. Nos documents mentionnent « art. 198 ter, 100 MAD » (source Upsilon du 28/09/2026). | **Non confirmée par un texte officiel lu**. |
| Qui a un ICE | Non établi ici pour les auto-entrepreneurs récents, ni pour les particuliers clients. | **Inconnu.** |

### État de l'application
L'assistant d'inscription rend l'ICE **obligatoire (15 chiffres)** avant d'utiliser l'application ; la vérification de cohérence signale un ICE absent ou invalide.

### Proposition (non appliquée)
- Option A (statu quo) : ICE exigé dès l'inscription. Risque commercial : un nouvel utilisateur sans ICE sous la main abandonne avant sa première facture.
- Option B : ICE demandé à l'inscription mais **non bloquant** ; blocage (ou avertissement fort) **à l'émission** de la première facture non brouillon, avec message clair. Les brouillons et devis restent possibles.
- Dans les deux cas : jamais de promesse de conformité ; l'ICE du client reste facultatif tant que le comptable n'a pas tranché (client particulier).
- Décision attendue de votre part (produit) après l'avis du comptable.

## 3. TVA
| Point | Ce que dit la source (Upsilon, 08/09/2026) | Certitude |
|---|---|---|
| Fait générateur des services | Art. 95 (et non 92 comme supposé dans nos échanges précédents) : encaissement total ou partiel du prix (droit commun) ; **débits sur option** écrite avant le 1er janvier (ou 30 jours après début d'activité). | Source secondaire récente, texte officiel non lu. |
| Paiement partiel / acompte | Encaissement partiel = TVA exigible sur le montant reçu, déclarée dans la période de l'encaissement. | Idem. |
| Auto-entrepreneur | **Non traité** par la source. | Inconnu. |

### État de l'application
- La TVA est calculée **sur la facture** (ligne par ligne) ; elle n'est pas ventilée par encaissement. Les rapports de paiements partiels (lot #62) affichent les sommes encaissées mais **ne calculent pas la TVA exigible par période**.
- Le PDF des auto-entrepreneurs imprime « TVA non applicable - Article 6 du CGI (Statut Auto-Entrepreneur) ». **Je n'ai pas pu confirmer cette référence d'article** : à faire valider (voir question 5).
- Aucune règle n'est modifiée.

### Proposition (non appliquée)
1. Ne rien changer au calcul tant que le comptable n'a pas confirmé le régime (encaissements ou débits) de vos utilisateurs types.
2. Si l'encaissement est confirmé comme cas général : ajouter un **état « TVA encaissée par période »** (somme des lignes de paiement × part de TVA de la facture), en lecture seule, avec la mention « aide de calcul, à valider par votre comptable ». Prérequis : paiements partiels fiables (#58) et rapports (#62).
3. Rendre le régime (encaissement/débits) **configurable** dans le profil, sans valeur par défaut présentée comme certaine.

## 4. Questions pour le comptable
1. Art. 145 du CGI 2026 : quel est le numéro exact du paragraphe qui impose l'ICE sur les factures, et la liste complète des mentions obligatoires pour une facture d'AE, de société et de coopérative ?
2. Existe-t-il une sanction applicable à l'absence d'ICE sur une facture (art. 198 ter ou autre) et quel en est le montant actuel ?
3. Un client particulier (sans ICE) doit-il apparaître sans ICE sur la facture ? Quelle mention ?
4. Pour les prestataires de services, le régime des **encaissements** est-il bien le cas par défaut ? Comment déclarer la TVA sur un paiement partiel (période, base) ?
5. Auto-entrepreneur : la mention « TVA non applicable – Article 6 du CGI » est-elle exacte ? Quelle est la mention légale à imprimer, et dans quels cas un AE devient-il redevable ?
6. Le passage de l'option débits ↔ encaissements concerne-t-il nos utilisateurs, et que faut-il afficher dans l'application ?
7. Avoir et remboursement : traitement de la TVA d'un avoir sur une facture partiellement ou totalement payée (voir `SUJET_COMPTABLE_AVOIR_REMBOURSEMENT.md`, sur la PR #60).
8. Conservation et facturation électronique : confirmer la durée de conservation et le calendrier DGI (aucun texte officiel lu à ce jour ; l'application ne développe rien dans ce sens).

## 5. Ce qui ne change pas
Aucun taux, calcul, mention ou blocage d'ICE n'est modifié par cette proposition. Elle sert de base de discussion avec le comptable et sera mise à jour avec les articles exacts une fois le CGI 2026 relu.
