# Design System v2 (11/11/2026)

Refonte visuelle demandée par le propriétaire. Aucune fonction retirée, aucune donnée touchée : la refonte passe par les jetons, une couche de style ajoutée en fin de feuille, et des icônes vectorielles dans la navigation.

## Identité

- **Encre marine** pour la structure (menu, boutons principaux), **laiton** en accent rare (marque, élément actif), **papier froid** en fond.
- **Signature** : le motif khatam (étoile à huit branches du zellige). Il n'apparaît qu'à trois endroits : écran de connexion, premier lancement, bloc final de la page d'accueil.
- **Une seule police** : IBM Plex Sans, avec IBM Plex Sans Arabic pour l'arabe. Les deux sont servies par le site (`fonts/`, licence OFL) : plus aucune requête vers Google Fonts.
- **Montants** : chiffres tabulaires dans les tableaux et les indicateurs.
- **Libellés** : en casse normale (plus de capitales espacées).

## Jetons (`:root` dans `app.html`, repris dans `index.html` et `admin.html`)

| Jeton | Valeur | Usage |
|---|---|---|
| `--primary` | `#16325C` | Boutons principaux, liens, graphiques |
| `--primary-deep` | `#0C1F3D` | Menu latéral, écran de connexion, pied de page |
| `--accent` | `#C8973A` | Marque, repère de l'élément actif |
| `--accent-bright` | `#E2B55A` | Accent sur fond sombre |
| `--success` | `#0F7B55` | Encaisser, payé |
| `--danger` | `#C0362C` | Retard, suppression |
| `--warning` | `#D98A1F` | À vérifier |
| `--bg` | `#F3F5F8` | Fond de page |
| `--surface` / `--surface-soft` | `#FFFFFF` / `#F7F9FB` | Cartes / en-têtes de tableau |
| `--ink` / `--ink-soft` / `--ink-mute` | `#101828` / `#475467` / `#667085` | Texte, texte secondaire, libellés |
| `--border` / `--border-strong` | `#E1E6ED` / `#CDD5DF` | Cartes / champs |
| `--focus` | `#2563EB` | Contour de focus clavier |
| `--r-sm` `--r-md` `--r-lg` `--r-xl` | 6, 8, 12, 16 px | Petits boutons, champs et boutons, cartes, modales |
| `--elev-1` `--elev-2` `--elev-3` | ombres | Carte, survol, modale |

## Composants

| Composant | Règle |
|---|---|
| Bouton | 38 px de haut, rayon 8, graisse 500. `.btn-sm` : 32 px. Pas de déplacement au survol. |
| Champ | Bordure `--border-strong`, rayon 8, anneau de focus bleu. |
| Carte | Bordure 1 px, rayon 12, ombre `--elev-1`. |
| Indicateur | Libellé précédé d'un carré de couleur, valeur 26 px en chiffres tabulaires. |
| Tableau | En-tête 12,5 px sur fond doux, lignes de 12 px de marge, survol bleuté. |
| Statut | Pastille rectangulaire (rayon 6), casse normale. |
| Avis | Fond ivoire, filet laiton à gauche ; vert pour une confirmation. |
| Modale | Rayon 16, ombre `--elev-3`, titre 19 px. |
| Icône | `<svg class="ic"><use href="#i-nom"/></svg>`, trait 1,7, couleur du texte. Planche dans `app.html` avant `MAIN APP`. |

## Adaptation aux écrans

| Largeur | Comportement |
|---|---|
| ≥ 1001 px | Menu latéral fixe. |
| 641 à 1000 px | Menu en tiroir, barre de navigation en bas ; actions des factures en ligne. |
| ≤ 640 px | Factures, devis et clients en cartes ; libellé devant chaque valeur ; actions sur une ligne. |

L'arabe (droite à gauche) utilise les mêmes règles ; les filets de statut suivent le sens de lecture (`border-inline-start`).

## Contrôle visuel

- `FRAMES_DIR=<dossier> node scripts/audit/tour.js` : compte de démonstration fictif sur base locale, puis capture de chaque page sur ordinateur, tablette et mobile, de trois écrans en arabe et des PDF facture et devis.
- `FRAMES_DIR=<dossier> node scripts/audit/pages.js` : pages publiques (accueil, mentions légales, facture partagée, administration).

## Ce qui n'a pas changé

- Les PDF (facture, devis, avoir, BL, reçu) : mise en page déjà refaite et testée (`documents-design`), laissée telle quelle.
- `facture.html` (lien client) : sa politique de sécurité interdit toute feuille ou police externe ; seule la couleur de marque a été alignée.
- Les émojis restent dans les boutons et les avis des écrans secondaires : les remplacer touche des centaines de libellés traduits et testés.
