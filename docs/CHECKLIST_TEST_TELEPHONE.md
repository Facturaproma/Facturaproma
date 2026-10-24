# Checklist de test sur téléphone Android : Paiements et Factures

À faire par le propriétaire sur son vrai téléphone (Chrome), connecté à `https://facturaproma.github.io/Facturaproma/`. Les tests automatisés (`factures.liste.browser.test.js`, `paiements.ecran.browser.test.js`, 16 contrôles chacun) simulent un écran de 390 px dans un navigateur de test : ils ne remplacent PAS ce contrôle sur un vrai appareil.

Préparation : actualiser la page (tirer vers le bas, ou menu ⋮ → Actualiser) et se déconnecter / reconnecter si l'ancienne version reste affichée. Utiliser un compte de test, jamais des factures de clients réels.

## Liste des factures
- [ ] Trois colonnes seulement (Facture, Montant, Actions) : aucune colonne coupée, pas de défilement horizontal de la page.
- [ ] Les brouillons sont regroupés sous « Brouillons — non enregistrés, modifiables », avec une bordure pointillée et le libellé « Brouillon · non enregistré » (pas de numéro BRO-).
- [ ] Les factures enregistrées sont sous « Factures enregistrées — verrouillées », avec « 🔒 Enregistrée ».
- [ ] Une facture enregistrée n'a AUCUN bouton « Supprimer » ; un brouillon a « Modifier » et « Supprimer ».
- [ ] Menu « ⋯ Plus » sur une facture enregistrée : WhatsApp, Dupliquer, Créer un avoir.
- [ ] Filtre « Brouillons (non enregistrés) » : seuls les brouillons.
- [ ] Filtre « Non payées » : seules les factures sans aucun paiement.
- [ ] Filtre « Payées partiellement » : « Payé X · reste Y » affiché sur la même ligne.
- [ ] Filtre « Soldées » : seules les factures entièrement payées, sans bouton Encaisser.

## Écran Paiements
- [ ] Les factures ouvertes sans paiement sont visibles (filtre « sans paiement »).
- [ ] Un paiement partiel affiche le payé ET le reste dû sur la même ligne.
- [ ] « Encaisser le reste » préremplit le montant restant.
- [ ] Saisir un montant supérieur au reste : message d'erreur clair, aucun paiement créé.
- [ ] Le numéro de facture dans l'historique est un lien vers la facture.

## Cas à signaler (capture d'écran)
Tout texte coupé, bouton hors écran, ancienne version affichée après actualisation, message d'erreur technique, montant incohérent (payé + reste différent du total).

## Non testable automatiquement (donc seulement par vous)
Rejeu hors ligne d'un paiement refusé par le serveur ; comportement réel du clavier Android ; lenteur sur réseau mobile.
