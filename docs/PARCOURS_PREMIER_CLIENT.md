# Parcours du premier client — validation en préproduction

Parcours : inscription → contact de support → demande d'abonnement → virement → création du code → activation → assistance.
Script : `scripts/preprod-journey.js` (+ `scripts/preprod-journey-browser.js`), phases `journey` / `journey-cleanup` du workflow `preprod-ui`. Cible unique : préproduction `njjaomichdlnoscrnxlz`.

## Résultat réel (run 39811488927, commit dbb61ba) : 27/27
Sauvegarde restaurée et vérifiée (34/34), empreinte des données préexistantes identique au départ (6393652c285d), SQL 18 appliqué, puis :
* anon refusé sur `get_contact_info` (42501) ; un client ne peut ni créer de code, ni lire les réglages, ni demander au nom d'un autre, ni se déclarer « traité », ni modifier sa licence (RLS réelle) ;
* contact NON configuré : aucun faux numéro (« Demandez votre abonnement ») ; configuré via Admin → Réglages : WhatsApp et e-mail visibles, RIB jamais affiché au client ;
* demande annuelle (449 DH) en base ; seconde demande refusée avec un message clair ; message admin de virement avec RIB/bénéficiaire lus dans les Réglages ;
* « Générer le code » : format `FP-XXXX-XXXX-XXXX`, lié à l'e-mail du client ; autre compte refusé (`wrong_email`) ; activation : licence annuelle (~365 j) en base et dans l'interface ; réutilisation refusée (`used`) ; aucune erreur JavaScript.

Nettoyage (run 39812169813) : 5/5 — 3 comptes supprimés par UUID ET adresse, réglages/demandes/codes de test retirés, empreinte finale identique (6393652c285d). La fonction `get_contact_info()` reste installée en préproduction (artefact SQL 18).

## Ce que ce test ne prouve pas
* **L'inscription par e-mail** (confirmation, captcha hCaptcha réel) : GoTrue refuse les adresses `.invalid` et un script ne peut pas lire une boîte réelle. À vérifier à la main avec une vraie adresse avant l'ouverture.
* Le chemin hCaptcha avec jeton réel (le script hCaptcha est bloqué dans le navigateur de test).
* L'envoi réel des messages WhatsApp (le test lit le message préparé ; `window.open` est intercepté).
* Aucun paiement réel n'a lieu : le virement est manuel, hors application.
