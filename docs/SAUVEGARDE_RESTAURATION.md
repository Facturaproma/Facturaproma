# Sauvegarde et restauration testées — préproduction Supabase

Dernière exécution **réelle** : run GitHub Actions `39689574843` (workflow `preprod-backup`, branche `dev/fondations`).
Rapport brut et horodaté : branche `preprod-reports`, fichier `reports/backup-39689574843.md` (les rapports des runs précédents, dont deux avec écarts détectés puis corrigés, y sont conservés).
Cible : **préproduction uniquement** (projet `njjaomichdlnoscrnxlz`). Aucune écriture en production, aucun merge dans `main`, aucun déploiement.

## Ce qui a été exécuté réellement, simulé, ou reste à faire

| Vérification | Statut |
|---|---|
| `pg_dump` 17.11 du vrai projet Supabase préproduction (pooleur, mode session) | **Exécuté (réel)** — 4 runs |
| Restauration dans PostgreSQL 17 local jetable (conteneur du runner GitHub) | **Exécuté (réel)** — 4 runs, 48/48 contrôles aux 3 derniers |
| Comparaison avant/après (lignes, empreintes, catalogue, droits, compteurs, numéros) | **Exécuté (réel)** |
| Tests fonctionnels sur la copie restaurée (licences, RLS, numérotation, verrouillage, droits) | **Exécuté (réel)** |
| `has_active_license(uuid)` : A ne voit pas la licence de B | **Exécuté (réel)** : `check.js` 24/24 (run `39688297505`) + copie restaurée |
| Répétition de l'outil sur base locale (dont corruption volontaire détectée) | **Simulé** (base locale, pas Supabase) — `tests/preprod/backup.local.test.js` |
| Restauration dans un **second projet Supabase** | **Non fait** (prévu, voir §7) |
| Journaux GitHub Actions relus pour y chercher un identifiant | **Non fait par moi** (téléchargement des journaux refusé depuis mon environnement) ; voir §6 |

## 1. Méthode (aucun secret affiché)

```
pg_dump --format=custom --compress=6 --no-owner --schema=public --schema=auth --file=<fichier temporaire privé>
pg_restore --no-owner --dbname=<base locale jetable> <fichier>
```

Les paramètres de connexion passent par `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE/PGSSLMODE` dans l'environnement du processus enfant ; le secret `PREPROD_DB_URL` n'est jamais passé en argument. `scripts/preprod-backup.js` filtre toute sortie (`redact()` : mot de passe, utilisateur, hôte, toute chaîne `postgres://…`, tout JWT). Le fichier de sauvegarde est créé dans un dossier temporaire `0700`, jamais publié ni envoyé en artefact, supprimé en fin de script. La base source doit porter le marqueur `préproduction / njjaomichdlnoscrnxlz`, sinon rien n'est sauvegardé.

## 2. Preuve du contenu de la sauvegarde (`pg_restore --list`)

Sauvegarde du dernier run : environ 194 Kio. Objets (extrait du rapport) : 41 tables + 41 jeux de données, 20 politiques RLS, 30 tables avec RLS activée, 27 fonctions (23 `public` + 4 `auth`), 8 déclencheurs, 86 index, 55 contraintes + 28 clés étrangères, 73 entrées de droits (ACL) + 9 droits par défaut, 9 types, 3 séquences (valeurs incluses).
Chaque comptage est comparé à celui de la base (ex. « politiques : 20 = 20 », « déclencheurs : 8 = 8 », « tables avec données : 41 = 41 »).

**Exclusions** : schémas Supabase autres que `public` et `auth` (storage, realtime, vault, extensions, graphql, pgsodium, cron…) ; rôles et mots de passe de rôles ; binaires des extensions ; fichiers du Storage ; réglages du tableau de bord (SMTP, fournisseurs, URL de redirection, captcha) ; fonctions Edge et secrets ; propriétaires d'objets (`--no-owner`). **Une restauration complète d'un projet nécessite donc aussi de ressaisir ces réglages.**

## 3–4. Restauration et intégrité

Base locale propre (modèle `template0`, rôles `anon`, `authenticated`, `service_role`… créés à vide). Comparaison avant/après :

- 41 tables : nombre de lignes **et** empreinte MD5 du contenu identiques ;
- RLS, politiques, fonctions (définition, `SECURITY DEFINER`, `search_path`), déclencheurs, contraintes, index, séquences, droits sur tables et droits d'exécution des fonctions : identiques (tri indépendant de la collation) ;
- compteurs de facturation `doc_counters` identiques ;
- **numéros de factures identiques, sans perte ni doublon** — dernier run : 10 factures émises sur 2 comptes (`FAC-2026-002…005` et `FAC-2026-023…028`) + 2 brouillons ; chaque compteur ≥ plus grand numéro émis.

Tests fonctionnels sur la copie restaurée : numérotation continue (dernier 28 → 29 puis 30, sans doublon) ; modification du montant d'une facture émise refusée ; suppression de la liste de factures émises refusée ; écriture directe dans `doc_counters` refusée ; RLS (A ne lit rien de B et inversement) ; `anon` ne peut exécuter ni `has_active_license` ni `next_doc_number`.

Erreur rapportée par `pg_restore` (code de sortie 1) : une seule, **bénigne** — `schema "public" already exists` (la base neuve contient déjà `public`). Aucune autre erreur.

## 5. Durées réelles (jeu de test minuscule : ~110 lignes, 41 tables)

| Run | Sauvegarde | Restauration | Contrôles |
|---|---|---|---|
| `39688410356` | 18,33 s | 0,26 s | 45/48 (écart détecté : tri dépendant de la collation) |
| `39688719587` | 18,33 s | 0,38 s | 45/48 (idem, diagnostic précisé) |
| `39688988156` | 23,50 s | 0,26 s | 48/48 |
| `39689270356` | 25,43 s | 0,40 s | 48/48 |
| `39689574843` | 19,51 s | 0,53 s | 48/48 |

Les 2 premiers « échecs » étaient un défaut de **mon outil de comparaison** (ordre de tri des chaînes différent entre Supabase et PostgreSQL local), pas une perte de données ; corrigé par `COLLATE "C"`. La durée est dominée par la latence réseau vers Supabase, pas par le volume : **ne pas extrapoler à une base de production volumineuse**.

## 6. Contrôle des secrets

- `scripts/scan-secrets.js` (7 tests, dont cas positifs et négatifs) cherche : URL de connexion avec mot de passe, `sb_secret_`, jetons Supabase/GitHub, JWT autres que la clé publique `anon`, et la valeur exacte du secret `PREPROD_DB_URL` ; il n'affiche jamais la valeur trouvée.
- Dans le workflow, le rapport est analysé **avant** publication (publication bloquée en cas de découverte), puis l'arbre Git, l'historique complet (toutes branches) et la branche `preprod-reports` : **0 découverte** aux 3 derniers runs ; le mot de passe et ses variantes sont masqués (`::add-mask::`) dans les journaux.
- Premiers runs : 4 faux positifs (données fictives de mes propres tests) — corrigés ; la branche `preprod-reports` contenait aussi des fichiers de travail (`check.txt`, `run.md`…) sans identifiant, retirés depuis.
- **Limite** : je n'ai pas pu relire les journaux bruts d'exécution GitHub. Le script ne les alimente d'aucune URL (testé), mais vérifiez une fois dans l'onglet Actions qu'aucune chaîne de connexion n'apparaît.

## 7. Tests manuels restant à faire avant TOUTE migration (production ou « table par facture »)

1. **Sauvegarde de production** : export réel de la base de production (jamais fait par moi, interdit) + **restauration réelle** testée dans un projet vierge, avec contrôle des numéros de factures. Le plan Free n'a pas de sauvegardes automatiques d'après la documentation Supabase ; vérifier dans le tableau de bord.
2. Restauration de la sauvegarde préproduction dans un **second projet Supabase** (rôles, extensions, Auth réels) et, séparément, test de reprise des réglages exclus (§2).
3. E-mail de confirmation réel (SMTP), captcha hCaptcha réel, réinitialisation de mot de passe.
4. Émission simultanée dans **deux navigateurs** sur le même compte ; coupure réseau puis reconnexion dans l'application.
5. PDF arabe sur un vrai téléphone (Android) et rendu hors ligne.
6. Suppression d'un compte via le tableau de bord (cascade des factures verrouillées).
7. Relecture des conseillers Supabase (sécurité/performances) après la dernière installation.
8. Relecture des journaux GitHub Actions (§6) et chiffrement/stockage hors dépôt de toute sauvegarde réelle (le fichier contient les hachages de mots de passe de `auth.users`).
9. Validation par vous de la procédure de retour arrière et de la fenêtre de maintenance, puis **autorisation écrite explicite** avant toute migration.
