# Secrets de sauvegarde : état, procédure, limites (24/10/2026)

Ce document ne contient AUCUN secret. Il décrit où ils vivent et comment les remplacer proprement.

## Les trois secrets
| Secret | Où | Sert à | Règle |
|---|---|---|---|
| `BACKUP_PASSPHRASE` | GitHub : secret du dépôt (utilisé par `backup.yml`) ET secret de l'environnement `restauration` (utilisé par `restore-test.yml`) | Chiffrer (AES-256) puis déchiffrer la sauvegarde | Les DEUX valeurs doivent être strictement identiques. 16 caractères minimum (contrôlé par `backup.yml`) |
| `SUPABASE_DB_PASSWORD` | GitHub : secret du dépôt | Connexion de `pg_dump` à la base de production | Le mot de passe SEUL. Une URL complète est tolérée (extraction automatique, avertissement « info ») mais à éviter |
| Mot de passe du compte GitHub / Supabase | Gestionnaire de mots de passe du propriétaire | — | Hors périmètre de ce dépôt |

## Ce qui est vérifié (sans jamais lire un secret)
- Le 24/10/2026, la sauvegarde #20 (chiffrée avec la phrase du dépôt) a été déchiffrée et restaurée en base jetable par le test de restauration #13 (phrase de l'environnement `restauration`) : **les deux phrases sont donc identiques** et la nouvelle phrase déchiffre bien une sauvegarde réelle.
- Le test de restauration affiche seulement la longueur de la phrase et des alertes d'espaces / sauts de ligne, jamais sa valeur.

## Limites assumées
- Un secret GitHub ne peut pas être relu (même par son propriétaire) ni lu par l'assistant : seuls la date de mise à jour et, via le diagnostic, la longueur sont observables.
- L'assistant n'a pas accès au gestionnaire de mots de passe du propriétaire et ne peut pas créer ou modifier des secrets GitHub (API bloquée) : tout remplacement de secret est une opération MANUELLE du propriétaire, dans l'interface GitHub.
- **Sauvegardes chiffrées avec l'ancienne phrase (oubliée) : irrécupérables.** AES-256 sans la phrase n'a aucune porte dérobée. À moins qu'une copie de l'ancienne phrase existe dans un emplacement autorisé (gestionnaire de mots de passe, note papier), ces fichiers ne servent plus à rien. Seules les sauvegardes produites à partir du 24/10/2026 (sauvegarde #20 et suivantes) sont déchiffrables.

## Remplacer proprement un secret (propriétaire, depuis le téléphone)
1. Générer la valeur avec le générateur du gestionnaire de mots de passe (30 caractères ou plus, lettres et chiffres, sans espace) et L'ENREGISTRER AVANT TOUTE AUTRE ÉTAPE.
2. GitHub → Settings → Secrets and variables → Actions → secret → Update ; coller depuis le gestionnaire (jamais retaper).
3. Pour `BACKUP_PASSPHRASE` : refaire la même chose dans Settings → Environments → `restauration`.
4. Relancer « Sauvegarde Supabase (chiffrée) » puis « Test de restauration isolé » : les deux doivent être verts.
5. Ne jamais coller un secret dans une conversation, une PR, un commit, un ticket ou un journal. Un secret montré dans un de ces endroits est considéré comme compromis : le remplacer.

## À corriger quand le propriétaire a un moment
- `SUPABASE_DB_PASSWORD` contient encore une URL complète (avertissement « info » dans les sauvegardes) : le remplacer par le mot de passe seul, en suivant la procédure ci-dessus.
- Noter dans le gestionnaire : la phrase de sauvegarde, le mot de passe de la base, leur date de création.
