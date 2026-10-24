# legal.html : informations à fournir (aucune n'est inventée)

Relevé du 24/10/2026 sur `legal.html`. Chaque ligne est un champ surligné « [À compléter] » ou une affirmation à confirmer. Tant que ces points ne sont pas réglés, la page ne doit pas être présentée comme validée et aucun paiement réel ne doit être encaissé (voir `docs/LANCEMENT_COMMERCIAL.md`).

## A. Identité de l'éditeur (section « Mentions légales »)
| # | Champ | Information attendue | Source à fournir |
|---|-------|----------------------|------------------|
| 1 | Dénomination (ligne 42, ligne 92) | Nom exact de la société et forme juridique | Certificat négatif / statuts |
| 2 | Capital social (43) | Montant en DH | Statuts |
| 3 | Siège social (44) | Adresse complète | Statuts / contrat de domiciliation |
| 4 | RC (45) | Numéro et tribunal de commerce | Modèle J / extrait RC |
| 5 | ICE (45) | Numéro à 15 chiffres | Attestation ICE |
| 6 | IF (45) | Identifiant fiscal | Attestation d'identification fiscale |
| 7 | Gérant (déjà indiqué) | Confirmer qu'il reste exact à l'immatriculation | Statuts |

## B. Conditions d'utilisation (section « CGU »)
| # | Champ | Décision / information attendue |
|---|-------|---------------------------------|
| 8 | Prix (71) | Les prix sont-ils TTC ou HT ? TVA applicable selon le régime de la société (validation comptable) |
| 9 | Moyens de paiement (73) | Liste réelle des moyens (virement, CMI, autre) une fois les comptes ouverts ; aucun moyen non disponible ne doit apparaître |
| 10 | Remboursement / rétractation (77) | Politique choisie par la société (délai, conditions) ; à faire relire pour la vente à des consommateurs |
| 11 | Tribunaux compétents (85) | Ville du siège (dépend du point 3) |

## C. Confidentialité (section « Confidentialité »)
| # | Champ | Information attendue |
|---|-------|----------------------|
| 12 | Responsable de traitement (92) | Nom de la société (point 1) |
| 13 | CNDP (92) | Numéro de déclaration ou d'autorisation après dépôt du dossier (dépôt non fait à ce jour) |

## D. Affirmations de la page à confirmer avant publication
- **Adresse hello@facturapro.ma** (3 occurrences) : confirmer qu'elle existe, qu'elle est lue et que le domaine facturapro.ma est bien à la société (ce n'est pas le cas à ma connaissance : le site est sur github.io).
- **« Une sauvegarde chiffrée est conservée sur la plateforme GitHub »** et **« écrasées au plus tard 90 jours après »** : `docs/SAUVEGARDE_RESTAURATION.md` indique que le chiffrement et le stockage hors dépôt d'une sauvegarde réelle restent à faire. À reformuler ou à mettre en œuvre avant publication.
- **Hébergement Supabase « Europe (Stockholm) »** : à confirmer dans la configuration du projet de production.
- **Délai de réponse de 30 jours** aux demandes de droits : à confirmer comme engagement de la société.
- **Section « Cookies et stockage local »** : relecture avec la liste réelle des clés de stockage utilisées.

## E. Hors legal.html mais lié
- `admin.html` ligne 1397 : « Conformité légale obligatoire au Maroc » (texte d'aide, formulation à adoucir en « vérifiez les obligations qui vous concernent »).
- Réglages Admin : WhatsApp, e-mail, RIB réel, bénéficiaire, banque (voir `docs/RAPPORT_MIGRATIONS_PRODUCTION.md`).

Ce document ne contient aucun conseil juridique. Les textes finaux doivent être relus par un juriste ou l'expert-comptable de la société.
