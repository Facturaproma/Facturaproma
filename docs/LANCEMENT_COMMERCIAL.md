# Lancement commercial — premier client payant (état au 22/10/2026)

## 1. Ce qui bloque quoi
**Déploiement technique** (à lever en priorité)
- Appliquer en production SQL 14, SQL 18 et `update_updated_at` durcie, puis fusionner la branche dans `main`. Les appels `apply_migration` du script 14 ont été annulés 3 fois par l'outil Supabase avant d'atteindre la base (confirmation d'écriture « destructive » non validée). Procédure : `docs/RAPPORT_MIGRATIONS_PRODUCTION.md` et `docs/VERIFICATIONS_POST_SQL14.sql`.

**Ouverture aux paiements réels** (n'empêche pas la mise en ligne technique)
| Élément | État | Action |
|---|---|---|
| Mentions légales | `legal.html` : « [Nom de la SARL] » (2×), « [N° CNDP] », « [À compléter] » ; contact `hello@facturapro.ma` (3×) | Renseigner la SARL (dénomination, RC, ICE, siège, directeur de publication, hébergeur) |
| Domaine et e-mail de support | `facturapro.ma` / `hello@` non confirmés comme existants | Réserver le domaine, créer la boîte, ou remplacer l'adresse |
| Coordonnées commerciales | Aucune ligne dans `admin_settings` en production | Admin → Réglages : WhatsApp, e-mail de contact |
| Coordonnées bancaires | idem | Admin → Réglages : bénéficiaire, banque, RIB réel (affichés seulement après une demande d'abonnement) |
| TVA | mention « Article 6 du CGI » à faire valider (91-II-3° probable) | Validation par un comptable |
| CNDP | déclaration non faite | Déposer la déclaration |
| Inscription réelle | non testée de bout en bout (e-mail de confirmation + hCaptcha) | S'inscrire avec une vraie boîte, voir ci-dessous |
| Plafond « 30 fondateurs » | contrôlé côté navigateur seulement | Suivre à la main dans l'Admin pour les 30 premiers |

**DGI** : l'application indique déjà « Facture électronique DGI : non prise en charge pour le moment ». Ne rien affirmer de plus sans preuve officielle.

## 2. Parcours du premier client (validé en préproduction, 27/27)
1. Le client s'inscrit, confirme son e-mail, se connecte : essai de 14 jours.
2. Il demande un abonnement (49 DH/mois, 449 DH/an, 299 DH/an fondateur) ; le RIB s'affiche et un message WhatsApp pré-rempli part vers vous.
3. Il vire ; vous contrôlez la réception sur votre relevé.
4. Admin → demande → génération du code de licence lié à son e-mail → envoi par WhatsApp.
5. Il saisit le code : licence active (durée prolongée en cas de renouvellement).
6. Support : WhatsApp / e-mail affichés dans l'application une fois les réglages saisis.

## 3. Test d'inscription réel (à faire une fois, 10 min)
Créer un compte avec une adresse que vous contrôlez, vérifier la réception du mail de confirmation, la connexion, la création d'une facture, son numéro, son PDF ; puis supprimer ce compte depuis l'Admin.

## 4. Acquisition des premiers clients
Cible : auto-entrepreneurs, freelances et petites SARL qui facturent à la main ou sur Excel.
- Offre : essai gratuit de 14 jours, puis 299 DH/an pour les 30 premiers (fondateurs), 49 DH/mois ensuite.
- Message type (WhatsApp / LinkedIn) : « Bonjour [prénom], je développe FacturaPro, un outil marocain pour faire vos factures et devis (ICE, TVA, numérotation automatique). 14 jours gratuits, sans carte. Je cherche 30 premiers utilisateurs pour un tarif fondateur à 299 DH/an. Voulez-vous essayer ? »
- Canaux : votre réseau direct, groupes Facebook et WhatsApp d'auto-entrepreneurs, comptables indépendants (commission ou accès gratuit contre recommandation).
- Objectif réaliste : 5 essais, 1 à 2 paiements dans les 14 premiers jours.
