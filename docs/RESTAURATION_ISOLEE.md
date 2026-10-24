# Test de restauration isolé d'une sauvegarde chiffrée

Objectif : prouver qu'une sauvegarde réelle (artifact `sauvegarde-supabase`, produit chaque lundi par `backup.yml`) peut être déchiffrée et restaurée, **sans toucher à la production ni à la préproduction**.

## Ce qui est préparé
| Élément | Rôle |
|---|---|
| `scripts/restore-test-isolated.js` | Déchiffre (gpg), extrait, crée une base **jetable** (nom aléatoire), restaure les comptes puis le schéma public, contrôle, supprime la base. |
| `.github/workflows/restore-test.yml` | Lancement **manuel** : télécharge la dernière sauvegarde, la restaure dans un PostgreSQL 17 éphémère du serveur GitHub. Aucun accès à Supabase. |
| `tests/integration/restauration-isolee.test.js` | Répétition locale avec **fausses données** : 10 contrôles (sauvegarde saine, refus d'hôte distant, du projet de production, de mauvaise phrase secrète, détection d'un compteur de numérotation incohérent, nettoyage). |

## Garde-fous du script
- Refuse tout hôte non local et toute chaîne contenant l'identifiant du projet de production ou « supabase » (code 2, rien n'est exécuté).
- La phrase secrète n'est lue que dans l'environnement, écrite dans un fichier temporaire 0600 supprimé aussitôt (jamais en argument de commande).
- Le rapport ne contient que des comptages et des résultats de contrôles.

## Contrôles effectués
Déchiffrement ; présence des dumps `public` et `auth` ; restauration sans erreur ; nombre de tables ; RLS active sur toutes les tables publiques ; présence de `has_active_license`, `next_doc_number`, `record_payment` ; aucun compteur `doc_counters` inférieur au plus grand numéro de facture émis.

## Constat de la répétition (utile pour une vraie restauration)
- Le dump `-n public` recrée le schéma `public` : la base cible doit d'abord l'abandonner (fait dans le script, base jetable seulement).
- Les données publiques référencent `auth.users` : **les comptes doivent être restaurés avant** les données publiques.

## Limites (à ne pas masquer)
- Le schéma `auth` du test est un **substitut minimal** ; si le dump `auth` réel ne s'y charge pas, le script le signale en avertissement et restaure le public sans vérifier les clés étrangères vers `auth.users`. Les comptes réels (mots de passe hachés, identités) ne sont validés que par une restauration dans un **projet Supabase vierge** (voir `SAUVEGARDE_RESTAURATION.md` §7).
- Exclus de la sauvegarde (rappel) : Storage, réglages du tableau de bord, fonctions Edge, secrets, rôles.
- Rien n'a encore été exécuté sur la sauvegarde réelle : le workflow n'existe sur `main` qu'après fusion de cette PR (un `workflow_dispatch` exige le fichier sur la branche par défaut).

## Pour l'exécuter (après fusion, depuis le téléphone)
GitHub → Actions → « Test de restauration isolé » → Run workflow. Lire ensuite le résumé : tous les contrôles doivent être « OK ». Aucun secret nouveau n'est nécessaire (`BACKUP_PASSPHRASE` existe déjà).

## Analyse des risques d'exposition (workflow `restore-test.yml`)
| Risque | Mesure |
|---|---|
| Une branche modifiée lance le test et exfiltre la phrase secrète ou les données déchiffrées | Le travail ne démarre que sur `refs/heads/main` (condition `if`). Recommandé en plus : un *Environment* GitHub « restauration » avec relecteur obligatoire, à créer par le propriétaire du dépôt (je n'ai pas ce droit). |
| Données dans le journal public (dépôt public) | Le script n'imprime que des noms de tables et des comptages ; les messages d'erreur PostgreSQL sont **expurgés** (valeurs entre quotes, e-mails, UUID, `(clé)=(valeur)`), test à l'appui. La phrase secrète est un secret masqué par GitHub. |
| Copie déchiffrée qui subsiste | Le déchiffrement se fait dans un dossier temporaire supprimé en `finally` ; étape finale `if: always()` supprime tout ; le serveur d'exécution est détruit à la fin du job. Aucun `upload-artifact` dans ce workflow : rien de déchiffré n'est publié. |
| Base jetable joignable de l'extérieur | Conteneur PostgreSQL du job, mot de passe fictif, port lié à la machine d'exécution éphémère ; aucune donnée de production n'en sort. |
| Jeton persistant | `persist-credentials: false`, permissions `contents: read` et `actions: read` seulement. |
| Connexion accidentelle à Supabase | Aucun secret de base ; le script refuse tout hôte non local et toute chaîne contenant l'identifiant de production ou « supabase » (testé). |
**Risque résiduel** : les données (réelles) de production sont déchiffrées en clair sur un serveur GitHub pendant quelques minutes. C'est le niveau d'exposition de `backup.yml` lui-même, mais il doit être accepté en connaissance de cause avant le premier lancement.

## Renforcements supplémentaires (24/10/2026)
- **Contributions non fiables** : le workflow n'a que `workflow_dispatch` (aucun `pull_request`, `pull_request_target` ni `push`) : une PR de fork ne le déclenche pas et n'accède à aucun secret.
- **Artefact de confiance** : la sauvegarde est cherchée uniquement dans une exécution **réussie de `backup.yml` sur `main`** (`--branch main`) ; un artefact de même nom produit par une autre branche est ignoré.
- **Permissions** : `contents: read`, `actions: read`, rien d'autre ; le jeton n'est pas conservé dans le dépôt cloné.
- **Environnement protégé (à créer par le propriétaire, je n'ai pas ce droit)** : Réglages du dépôt → Environments → New environment « restauration » → *Required reviewers* = vous → *Deployment branches* = `main` seulement → y déplacer le secret `BACKUP_PASSPHRASE` (secret d'environnement). Ensuite ajouter `environment: restauration` au job. **Ne pas ajouter cette ligne avant d'avoir créé l'environnement** : GitHub en crée un automatiquement **sans protection**, ce qui donnerait une fausse impression de sécurité. L'approbation est alors demandée avant chaque lancement et le secret n'est plus lisible par une autre branche.
- **Actions tierces** : seules `actions/checkout@v4` et `actions/setup-node@v4` (GitHub) sont utilisées, référencées par étiquette comme les autres workflows du dépôt. Épinglage par SHA recommandé (je n'ai pas pu résoudre les SHA : accès aux dépôts `actions/*` non ouvert à cette session).
- **Données fictives d'abord** : la répétition (13+ contrôles) prouve le mécanisme sans aucune donnée réelle. La restauration de la sauvegarde **réelle** déchiffre des données clients (e-mails, factures, hachages de mots de passe) sur un serveur GitHub pendant quelques minutes ; à n'autoriser qu'avec l'environnement protégé ci-dessus. Alternative sans exposition : restaurer sur votre propre machine (procédure manuelle de `SAUVEGARDE_RESTAURATION.md`).
