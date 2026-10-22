# Test de l'abonnement en production, sans encaisser de paiement réel

Principe : le paiement se fait par virement manuel. Tant que **personne ne vire d'argent** et que vous n'enregistrez **aucun paiement dans l'onglet Paiements**, aucun encaissement n'existe. Tout le parcours (demande, code, activation, assistance) peut donc être testé en réel.

## 1. Renseigner Admin → Réglages (une fois)
| Champ affiché | Valeur à saisir | Où il apparaît |
|---|---|---|
| Numéro WhatsApp | numéro réel au format international, ex. `+212 6XX XX XX XX` | support client dans l'application, bouton « WhatsApp » envoyé au client |
| Email support | adresse de support qui existe vraiment (boîte lisible) | coordonnées d'assistance du client |
| Bénéficiaire | nom exact du titulaire du compte bancaire (société) | message de paiement envoyé au client (jamais affiché avant la demande) |
| RIB | RIB bancaire réel, 24 chiffres | idem |
| Banque | nom de la banque | idem |

Puis « Enregistrer ». Le message « Réglages enregistrés » n'apparaît que si l'écriture a réussi. L'envoi du message de paiement est refusé tant que le RIB est vide.
Seuls WhatsApp et e-mail sont lisibles par les clients connectés ; le RIB n'est jamais lu directement par l'application client.

## 2. Parcours de test (≈ 15 min)
Utiliser un compte **client** : une adresse e-mail que vous contrôlez et qui n'est **pas** celle d'un administrateur (les administrateurs reçoivent automatiquement une licence à vie). Astuce : `votrenom+test1@gmail.com` arrive dans la même boîte.

1. **Inscription.** Sur l'application, créer le compte, confirmer l'e-mail reçu, se connecter. Attendu : bandeau « Période d'essai active ».
2. **Création d'une facture.** Créer un client, une facture, l'émettre : le numéro est attribué à l'émission (FAC-2026-0001 pour un compte neuf), le PDF se génère, le verrouillage empêche de modifier la facture émise.
3. **Demande d'abonnement.** Licence → choisir une offre → « Demander ». Attendu : la demande apparaît ; une 2e demande affiche « déjà une demande en cours ». Aucun paiement n'est demandé dans l'application.
4. **Côté Admin.** Onglet Demandes : la demande est « en attente » ; cliquer « Traiter » → un code `FP-XXXX-XXXX-XXXX` est créé, lié à l'e-mail du client, la demande passe à « traitée ».
   Ne pas utiliser l'onglet Paiements (rien n'est encaissé).
5. **Activation.** Se reconnecter avec le compte client, Licence → saisir le code → « Activer ». Attendu : licence active avec la nouvelle date de fin ; le code passe à « utilisé » ; le même code refusé une 2e fois ; le code refusé avec un autre compte (adresse différente).
6. **Assistance.** Vérifier que le WhatsApp et l'e-mail de support s'affichent bien dans l'application client (c'est la lecture réelle de `get_contact_info`).
7. **Nettoyage.** Admin → Comptes → supprimer le compte de test (taper l'e-mail pour confirmer). Compte, données, licence, codes et demandes de ce compte sont effacés. Ne supprimer que ce compte de test.

## 3. Ce que je vérifie ensuite, côté base, dès que vous me dites « test fait »
Licence du compte (type, fin), statut de la demande et du code, compteurs de numéros, journal (une seule ligne par émission après le correctif 19), absence d'erreurs dans les journaux, et que le compte de test est bien supprimé.

## 4. Limites connues
- Aucun virement réel n'est testé : la réception du virement reste un contrôle manuel sur votre relevé bancaire.
- La limite « 30 fondateurs » est comptée côté navigateur seulement : à suivre à la main.
- Légalement, n'encaissez un premier client réel qu'une fois les mentions légales (`legal.html`) et l'adresse e-mail de support définitives.
