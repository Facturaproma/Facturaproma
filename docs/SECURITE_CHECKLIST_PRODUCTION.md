# Checklist sécurité avant d'accueillir des clients payants

Mise à jour : 26/10/2026 (audit). Chaque ligne indique l'**état vérifié** : ✅ vérifié (preuve citée) · ⚠️ à faire ou à confirmer · ❓ non vérifiable depuis le code (réglage d'un tableau de bord).
*Une case non cochée n'est pas « un problème découvert » : c'est un point qui n'a pas pu être prouvé.*

## 1. Données et isolation entre sociétés
- ✅ Toutes les tables de `public` ont la sécurité par ligne (RLS) activée ; `anon` n'a aucun droit sur aucune table (catalogue production, 26/10/2026).
- ✅ Isolation A / B testée : B ne lit, n'écrit ni ne supprime rien chez A (`tests/sql/test_securite.sql`, `test_partage.sql`, `test_messagerie.sql`).
- ✅ Chaque fonction ouverte aux utilisateurs connectés contrôle l'identité ou le rôle ; seules `get_contact_info` et `get_shared_invoice` sont publiques par conception.
- ✅ Les fonctions SECURITY DEFINER fixent leur `search_path`.
- ⚠️ Supprimer la table résiduelle `_fp_acl_backup_24` après avoir vérifié son contenu (copie des droits d'accès ; le suffixe 24 évoque l'opération du 24/10, origine non confirmée).
- ✅ Pas de stockage de fichiers (aucun bucket) : pas de risque de téléversement de fichiers malveillants.

## 2. Comptes et authentification
- ✅ hCaptcha à l'inscription, à la connexion et à la réinitialisation.
- ✅ Mot de passe : 8 caractères minimum à la création et au changement (application).
- ⚠️ **Supabase → Authentication → Policies** : longueur minimale 10, lettres + chiffres ; activer la **protection contre les mots de passe compromis** (option signalée désactivée par l'outil de contrôle Supabase ; peut exiger l'offre Pro).
- ❓ Confirmation d'e-mail obligatoire ; durée de validité des liens de réinitialisation ; durée des sessions ; limites de débit d'authentification : à vérifier dans Supabase → Authentication → Settings / Rate limits.
- ✅/⏳ Authentification à deux facteurs (TOTP) : écran dans `admin.html` — **obligatoire pour le propriétaire (compte master)** (activation par QR code à la première connexion, puis code à 6 chiffres), **facultative pour les autres administrateurs et assistants** (s'ils l'activent, le code leur est demandé) + règle serveur `sql/31_admin_2fa.sql` (`is_admin()`, `is_master()`, `is_staff()` exigent une session aal2 dès qu'un facteur est vérifié). **Le script `sql/31` doit être appliqué en production après que chaque administrateur a activé son code** (sinon seul l'écran protège). Prérequis : Supabase → Authentication → Multi-factor : TOTP activé (par défaut). Perte du téléphone : supprimer le facteur du compte dans Supabase → Authentication → Users, puis se reconnecter (nouvelle activation) ; garder les clés de secours (la clé texte affichée sous le QR) dans le gestionnaire de mots de passe.
- ⚠️ Activer l'authentification à deux facteurs sur les comptes GitHub et Supabase du propriétaire.

## 3. Application web
- ✅ Échappement des données dans le texte, les attributs et les gestionnaires `onclick` (`escapeHtml`, `jsArg`, `esc`), vérifié par `tests/integration/securite-xss.browser.test.js`, `securite-admin-xss.browser.test.js` et le garde-fou `tests/securite-garde.unit.test.js`.
- ✅ Intégrité (SRI) du script Supabase ; jsPDF hébergé dans `vendor/` (plus de script externe sans empreinte).
- ✅ Anti-clickjacking (la page se masque si elle est affichée dans un cadre tiers).
- ✅ Page publique `facture.html` : CSP stricte, `textContent` uniquement, `noindex`, `no-referrer`.
- ⚠️ Politique CSP (Content-Security-Policy) pour `app.html` / `admin.html` : à tester d'abord en préproduction (voir rapport d'audit).
- ⚠️ jsPDF 2.5.1 est ancien (PR Dependabot #38 vers 4.x) : mise à jour à planifier avec test des PDF.
- ✅ Aucun secret dans l'arborescence ni dans l'historique (scanner du dépôt, 208 commits, 26/10/2026) ; seule la clé publique `anon` est présente.

## 4. Sauvegardes et reprise
- ✅ Sauvegarde hebdomadaire chiffrée (AES-256) ; première restauration réelle réussie le 24/10/2026.
- ⚠️ **Le dépôt est public : les sauvegardes sont des artefacts GitHub téléchargeables par tout compte GitHub pendant 90 jours.** La seule protection est la phrase de chiffrement. Voir le rapport d'audit pour la correction recommandée (chiffrement à clé publique, ou stockage privé).
- ⚠️ Phrase de chiffrement : au moins 6 mots tirés au hasard ou 24 caractères aléatoires, conservée dans un gestionnaire de mots de passe.
- ⚠️ Réduire la durée de conservation des artefacts (90 jours → 14) une fois une copie privée en place.

## 5. Surveillance et réponse
- ⚠️ Alerte e-mail sur : échecs de connexion en masse, nouveau compte administrateur, nouvelle licence accordée (à créer).
- ✅ Procédure d'incident rédigée : `docs/PROCEDURE_INCIDENT.md`.
- ⚠️ Faire un exercice à blanc (compte suspendu, restauration) tous les 6 mois.

## 6. Conformité (loi marocaine 09-08)
- ✅ Hébergement des données : Supabase, région Europe (Stockholm), indiqué dans `legal.html`.
- ⚠️ `legal.html` contient encore des champs à remplir : nom de la société et **numéro de déclaration / autorisation CNDP**.
- ⚠️ **À confirmer avec la CNDP ou un juriste** (non vérifié ici) : déclaration préalable du traitement, encadrement du transfert vers l'Europe, durée de conservation des factures, procédure de suppression sur demande.
- ⚠️ Mention du lien client public à ajouter dans `legal.html` (nom et ICE du client final figurent dans l'instantané partagé).
