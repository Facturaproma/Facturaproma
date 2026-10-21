# Environnement de préproduction Supabase — guide et checklist

**Principe :** un projet Supabase **séparé** de la production (autre URL, autres clés, autre base, autres comptes). Rien de ce guide ne touche la production (`mdozjptoecygmpkjlohr`). Les scripts du dépôt refusent de s'exécuter si l'URL est celle de la production.

**Règle secrets :** aucune clé ni mot de passe n'est écrit dans un fichier du dépôt ni envoyé dans un chat. Tout passe par des variables d'environnement de votre terminal, ou par les « Secrets » GitHub. La clé `service_role` n'est **jamais** nécessaire pour ces tests : ne la copiez nulle part.

## A. Création du projet (≈ 15 min, 0 MAD)

1. Supabase → *New project* → nom `facturapro-preprod`, même région que la production, plan **Free**. Choisissez un mot de passe de base long, généré par un gestionnaire de mots de passe ; ne le communiquez à personne.
2. *Project Settings → API* : notez l'**URL** et la clé **anon / publishable** (publique par conception, mais gardez-la en variable d'environnement). Ne copiez pas `service_role`.
3. *Authentication → URL Configuration* : Site URL = `http://localhost:8180` ; Redirect URLs = `http://localhost:8180/**`.
4. *Authentication → Providers → Email* : laissez la confirmation d'e-mail **activée** (c'est ce qu'il faut tester). Pour les essais d'inscription, utilisez deux adresses à vous (ex. alias `+preprod-a`, `+preprod-b` de votre Gmail).
5. *Authentication → Attack protection / Captcha* : en préproduction, désactivez hCaptcha **ou** utilisez les clés de test publiques documentées par hCaptcha (à vérifier dans la documentation hCaptcha). Le captcha réel se teste ensuite une fois, à la main, en production… après votre accord.
6. *Authentication → SMTP* : laissez le SMTP intégré de Supabase pour la préproduction (limité, suffisant pour quelques comptes de test).

## B. Installer le schéma (SQL Editor, une requête NEUVE par script, dans cet ordre)

`sql/00_setup_complet.sql` → `05_admins.sql` → `06_securite_rls.sql` → `07_licence_serveur.sql` → `08_admin_comptes.sql` → `09_periode_de_grace.sql` → `10_anti_abus.sql` → `12_admin_supprimer_compte.sql` → `13_profil_assistant.sql` → `14_numerotation_et_verrouillage.sql`.

C'est exactement l'ordre utilisé par les tests locaux (`tests/integration/backend.js`). Ne lancez pas `11_nettoyage_comptes_test.sql` (réservé à la production, après aperçu). Chaque script doit se terminer sans erreur ; notez toute erreur telle quelle.

Contrôle rapide après installation (SQL Editor) :
```sql
select to_regprocedure('public.next_doc_number(text,int)') is not null as numerotation_ok,
       (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
         where n.nspname='public' and c.relkind='r' and not c.relrowsecurity) as tables_sans_rls;
```
Attendu : `numerotation_ok = true`, `tables_sans_rls = 0`. Lancez aussi *Database → Advisors → Security* et notez les alertes.

## C. Lancer l'application contre la préproduction

```bash
export PREPROD_URL='https://<ref-preprod>.supabase.co'
export PREPROD_ANON_KEY='<clé anon de la préproduction>'
node scripts/serve-preprod.js        # http://localhost:8180/app.html
```
Les fichiers `app.html` / `admin.html` du dépôt ne sont pas modifiés (remplacement en mémoire). Le service worker est servi sur `localhost` : en cas de comportement bizarre, DevTools → Application → *Unregister*.

Vérifications automatiques (deux comptes de test déjà inscrits et confirmés dans la préproduction) :
```bash
export TEST_A_EMAIL='…' TEST_A_PASSWORD='…' TEST_B_EMAIL='…' TEST_B_PASSWORD='…'
node tests/preprod/check.js
```
Saisissez ces variables dans **votre** terminal ; ne les collez pas dans un chat. `check.js` n'a jamais été exécuté contre un vrai Supabase à ce jour : la première exécution est elle-même un test (un échec peut venir du script, pas seulement de l'application).

## D. Checklist de vérification (cochez, notez la date et le résultat réel)

| # | Vérification | Comment | Auto |
|---|---|---|---|
| 1 | Inscription avec e-mail de confirmation réel | Créer le compte A dans l'appli, ouvrir le lien reçu | manuel |
| 2 | Connexion / mauvais mot de passe refusé | Appli + `check.js` | auto |
| 3 | SQL 14 appliqué sans erreur ; `next_doc_number` répond | Section B + `check.js` | auto |
| 4 | Un compte non connecté ne peut ni numéroter ni lire | `check.js` (rôle anon) | auto |
| 5 | Émission d'une facture : numéro `FAC-AAAA-001` attribué par le serveur | Appli, compte A, émettre ; vérifier `select * from doc_counters` | manuel |
| 6 | Unicité : 20 émissions simultanées = 20 numéros distincts | `check.js` | auto |
| 7 | Deux appareils (2 navigateurs) émettent en même temps : numéros distincts, aucune facture perdue | Manuel : A dans Chrome, A dans fenêtre privée | manuel |
| 8 | Isolation : B ne voit ni n'écrit rien chez A | `check.js` + appli (se connecter en B) | auto + manuel |
| 9 | Verrouillage : montant, suppression, effacement, faux numéro refusés | `check.js` | auto |
| 10 | Verrouillage dans l'interface : édition/suppression impossibles, avoir proposé | Appli | manuel |
| 11 | Journal serveur `doc_events` alimenté | `check.js` + `select * from doc_events` | auto |
| 12 | Panne réseau pendant l'émission : la facture reste brouillon, message clair, pas de numéro consommé | DevTools → Network → *Offline*, émettre ; retour en ligne, réémettre : numéro suivant sans trou | manuel |
| 13 | Brouillon créé hors ligne synchronisé au retour du réseau | Idem avec un brouillon | manuel |
| 14 | Script SQL 14 absent → message « mise à jour du serveur » | Projet vierge sans le script 14 (ou `drop function`, en préproduction uniquement) | manuel |
| 15 | Licence : essai actif puis expiré/suspendu bloque l'émission | `admin.html` en préproduction | manuel |
| 16 | PDF arabe sur un vrai navigateur et sur mobile | Facture avec client arabe, ouvrir le PDF sur téléphone | manuel |
| 17 | Sauvegarde puis restauration (section E) | Voir ci-dessous | manuel |
| 18 | Suppression d'un compte de test avec factures émises (cascade) | Dashboard → Users → Delete ; vérifier que `user_data`, `doc_counters`, `doc_events` sont vides pour cet utilisateur | manuel |
| 19 | Advisors sécurité sans alerte critique | Dashboard → Advisors | manuel |

## E. Sauvegarde et restauration (à répéter en préproduction AVANT de le faire en production)

**Fait important (vérifié dans la documentation Supabase, page « Backups ») :** les sauvegardes quotidiennes automatiques sont incluses pour les plans Pro et supérieurs ; la documentation ne les mentionne pas pour le plan Free et recommande d'**exporter régulièrement ses données** avec `supabase db dump`. Sur un projet Free, il faut donc compter sur **vos propres exports**. Le dépôt contient déjà le workflow GitHub `backup.yml` (export chiffré ; secrets `SUPABASE_DB_PASSWORD` et `BACKUP_PASSPHRASE` à définir dans GitHub, jamais ailleurs).

Procédure de test de restauration (préproduction) :
1. Créer 2 comptes, émettre quelques factures. Noter les comptes : `select count(*) from user_data; select count(*) from doc_counters;`.
2. Exporter : `supabase db dump --db-url "$PREPROD_DB_URL" -f preprod.sql` (la chaîne de connexion est dans *Project Settings → Database* ; mettez-la dans une variable d'environnement, ne la collez nulle part). Chiffrer le fichier, le stocker hors du dépôt.
3. Restaurer dans un **second** projet vide `facturapro-restore-test` (ou une base PostgreSQL locale) : `psql "$RESTORE_DB_URL" -f preprod.sql`.
4. Comparer les comptes et les sommes (`sum(total_ttc)` des factures émises). Se connecter avec le compte A sur le projet restauré. Noter la durée totale.
5. Critère de réussite : mêmes comptes, mêmes numéros, compteurs égaux, connexion possible. Un compteur restauré plus bas que le dernier numéro émis serait grave : le déclencheur refuserait ensuite les émissions (numéro > compteur).

**Avant toute exécution du SQL 14 en production :** export complet de la base (étape 2), vérifié par une restauration réussie sur le projet de test, puis seulement ensuite le script — **uniquement avec votre accord écrit**.

## F. Critères de passage vers la production (tous obligatoires)

- Les 19 lignes de la checklist sont cochées, avec résultats réels (pas « supposé »).
- `check.js` passe entièrement sur la préproduction, deux fois de suite sur deux comptes neufs.
- Une restauration a été réussie, avec durée mesurée.
- Les points « à faire de votre côté » sont faits : captcha réel, domaine/SMTP, mentions légales sans espace réservé, comptes de test supprimés.
- Ordre de déploiement : sauvegarde → SQL 14 → vérification → application correspondante (jamais l'inverse).
- Votre accord explicite, par écrit, pour chaque étape (fusion, SQL, déploiement).
