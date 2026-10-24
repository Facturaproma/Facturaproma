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
