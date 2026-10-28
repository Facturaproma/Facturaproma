# Messagerie support (société ↔ équipe FacturaPro)

**État : code prêt, SQL (`sql/29_messagerie_support.sql`) NON appliqué** (hors `MANIFEST.json`). À appliquer d'abord en préproduction, après autorisation.

## Fonctionnement
- Un **fil par compte** (société). Texte seulement (aucune pièce jointe), 1 à 2 000 caractères.
- Société : menu **Messages** (badge de non-lus), envoi, lecture des réponses. Administration : menu **💬 Messages** (liste des fils, non-lus d'abord, nom de société + e-mail, réponse).
- Pas de notification instantanée : les compteurs se rafraîchissent toutes les 90 s et à l'ouverture de la page.
- Les messages sont affichés **comme du texte** (jamais interprétés en HTML).

## Sécurité (vérifiée par les tests locaux)
- La table `support_messages` n'est accessible ni en lecture ni en écriture par les clients (RLS, aucun droit) : tout passe par des fonctions `SECURITY DEFINER` qui exigent un compte à e-mail confirmé.
- Une société ne voit que son fil ; elle ne peut ni se faire passer pour l'admin, ni appeler les fonctions admin (`forbidden`).
- Limites anti-abus : 20 messages / heure et 1 000 messages par fil.
- Les assistants (rôle limité aux paiements) n'ont pas accès à la messagerie.
- Aucune suppression de message (traçabilité) ; le fil disparaît avec le compte (`ON DELETE CASCADE`).

## À valider avant mise en production
- **Politique de confidentialité / CNDP** : les messages sont des données personnelles conservées tant que le compte existe ; durée de conservation et mention à valider (texte de `legal.html` non modifié).
- Qui répond, et sous quel délai : aucune promesse de délai n'est affichée.

## Installation (après autorisation)
1. Préproduction : exécuter `sql/29_messagerie_support.sql` dans l'éditeur SQL ; vérifier en lecture seule que les 9 fonctions existent et que `anon` n'a aucun droit.
2. Fusionner la PR, puis production (même script). Retour arrière en tête du script.
3. Tant que le script n'est pas installé, l'application affiche « La messagerie n'est pas encore activée » et l'admin « Messagerie non installée ».

## Limites connues
Pas de pièces jointes, pas de notification e-mail/téléphone, pas de recherche dans les messages, pas de pagination des fils (200 plus récents).
