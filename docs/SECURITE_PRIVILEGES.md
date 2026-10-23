# sql/24 — moindre privilège sur les tables (PRÉPARÉ, NON EXÉCUTÉ)

Statut : script, retour arrière et tests prêts. **Rien n'a été exécuté sur Supabase** (ni production, ni préproduction) : seules des requêtes de lecture ont servi au diagnostic. Les tests ont tourné sur une base PostgreSQL locale jetable (version 16 ; MAINTAIN n'existe qu'en 17, voir « Reste à vérifier »).

## 1. Diagnostic (relevé en lecture seule, 23/10/2026)

| Élément | Production `mdozjptoecygmpkjlohr` (PG 17.6) | Préproduction `njjaomichdlnoscrnxlz` (PG 17.11) |
|---|---|---|
| Tables avec droits clients | 13 | 17 (en plus : `doc_history`, `doc_payments`, `documents` ; `doc_deleted`, `doc_store_*`, `_fp_*`, `_mig_*` sans aucun droit client) |
| `anon` | `user_data` : 8 privilèges (tous) ; `doc_counters`, `doc_events` : SELECT, REFERENCES, TRIGGER, MAINTAIN | identique |
| `authenticated` | TRUNCATE, REFERENCES, TRIGGER, MAINTAIN sur 9 tables ; REFERENCES, TRIGGER, MAINTAIN sur `doc_counters`/`doc_events` | idem + MAINTAIN sur `doc_history`, `doc_payments`, `documents` |
| `PUBLIC` sur les tables | aucun | aucun |
| Appartenance de rôles | `authenticator`/`postgres` membres de anon/authenticated (normal) ; aucun héritage élargissant | idem (+ `supabase_realtime_admin`) |
| Droits par colonne | aucun | aucun |
| Fonctions SECURITY INVOKER | `update_updated_at`, `license_grace_days` | + `update_admin_updated_at`, `fp_*` (outillage de migration) |

Les deux environnements **ne sont pas identiques** : la production n'a pas les tables de `sql/15` à `17`. Le script teste chaque table avec `to_regclass()` et ignore celles qui n'existent pas.

Droits par défaut : le rôle `postgres` accorde encore tous les droits aux **futures** tables de `public` (réglage Supabase). `sql/24` n'y touche pas (voir risques).

## 2. Ce que fait `sql/24`

- `anon` : retire tout sur `user_data`, `doc_counters`, `doc_events`.
- `authenticated` : retire TRUNCATE, REFERENCES, TRIGGER, MAINTAIN (PG 17) sur les tables listées dans le script.
- Nombre de privilèges retirés attendu (message `NOTICE` en fin d'exécution) : **58 en production, 61 en préproduction** (si une valeur différente apparaît, s'arrêter et comparer).
- Ne touche : ni RLS (aucune politique modifiée, jamais désactivée), ni données, ni fonctions, ni EXECUTE, ni séquences, ni `service_role`, ni SELECT/INSERT/UPDATE/DELETE de `authenticated`.
- Sauvegarde exacte des droits retirés dans `public._fp_acl_backup_24` (RLS active, aucun droit client). Transaction unique, contrôles finaux (aucun droit ciblé restant, droits essentiels inchangés, RLS toujours active) : au moindre écart, tout est annulé.
- Réexécutable : la 2e exécution retire 0 privilège et conserve la sauvegarde d'origine.

### Pourquoi c'est sans effet sur l'application
TRUNCATE, VACUUM/REINDEX/LOCK (MAINTAIN), REFERENCES et TRIGGER ne sont jamais émis par PostgREST ni par le front (`.from()` / `.rpc()` relevés). Les clés étrangères et les triggers s'exécutent avec les droits du propriétaire. Tous les triggers et fonctions métier sont SECURITY DEFINER (propriétaire `postgres`) ; les deux triggers INVOKER ne modifient que `NEW`. Le front n'accède jamais directement à `doc_counters`/`doc_events` (RPC seulement) et `anon` n'a aucun usage de `user_data` (toutes les politiques exigent `auth.uid()`).

## 3. Procédure (à faire par vous, dans le SQL Editor)

1. **Préproduction** : exécuter `tests/sql/privileges_comparaison.sql` → noter les résultats (AVANT).
2. Exécuter `sql/24_moindre_privilege.sql` → relever le `NOTICE` (61 attendu).
3. Ré-exécuter `tests/sql/privileges_comparaison.sql` → APRÈS : requête 2 = 0 ; empreintes des requêtes 5 et 6 et comptes de la requête 7 **identiques** à AVANT ; requête 3 = 0 ; requête 4 = 0.
4. Checklist fonctionnelle ci-dessous en préproduction.
5. Seulement après votre accord écrit : même procédure en **production** (58 attendu).
6. Avant la production : prendre une sauvegarde (Database → Backups) et vérifier qu'elle est disponible.

## 4. Checklist de validation fonctionnelle (préproduction, puis production)

- [ ] Connexion / déconnexion, rafraîchissement de la session.
- [ ] Client : ouvrir l'application, voir ses données, créer / modifier / supprimer un élément.
- [ ] Facture : création, enregistrement, numérotation consécutive (`next_doc_number`), verrouillage d'une facture émise.
- [ ] Paiement enregistré sur une facture (production : flux actuel ; préproduction : `record_payment` si `sql/15+` actif).
- [ ] Licence : affichage de l'état (`my_license`), activation d'un code, essai gratuit.
- [ ] Deux comptes clients : chacun ne voit que ses données ; aucune modification possible de celles de l'autre.
- [ ] Master : Réglages, Équipe, Formules, Journal.
- [ ] Admin : codes (génération, révocation), demandes (contacter, générer), paiements, rapports.
- [ ] Staff / assistant : liste des demandes ouvertes, annulation d'un paiement.
- [ ] Visiteur non connecté : page d'accueil et page de connexion chargent normalement.
- [ ] Console navigateur : aucune erreur `permission denied` (code 42501) hors scénarios d'accès interdit volontaires.

Tests automatiques équivalents : `tests/sql/test_moindre_privilege.sql` (anon refusé, TRUNCATE refusé, isolation A/B, numérotation, trigger `updated_at`, admin, idempotence, aller-retour retour arrière avec empreinte exacte).

## 5. Retour arrière

`sql/rollback/24_retour_arriere.sql` rend **exactement** les privilèges consignés dans `_fp_acl_backup_24`, rien de plus. Limites :
- dépend de la table de sauvegarde (absente ou vide → arrêt net, rien modifié) ;
- ne couvre que les droits de table retirés par `sql/24` ;
- rouvre la surface (TRUNCATE hors RLS, accès `anon` à `user_data`) : à n'utiliser qu'en cas de régression avérée ;
- ne supprime pas la table de sauvegarde (à retirer à la main après validation).

## 6. Risques résiduels et permissions conservées volontairement

- **Conservés** : SELECT/INSERT/UPDATE/DELETE de `authenticated` (protégés par RLS ; utilisés par le front sur `user_data`, `admin_*`, `admins`, `subscription_requests`). SELECT de `authenticated` sur `doc_counters`/`doc_events`/`doc_*` (politiques « propriétaire »).
- **Non traités (utilité à établir, hors périmètre minimal)** : droits d'écriture de `authenticated` sur `licenses` et `staff` (le front n'écrit que par RPC, et les politiques n'ouvrent que la lecture : droits probablement inertes) ; droits `anon`/`authenticated` sur les séquences `code_attempts_id_seq` et `doc_events_id_seq` ; droits par défaut des futures tables. Candidats à un éventuel `sql/25`, après revue des politiques.
- Les 17 (production) / 22 (préproduction) alertes « SECURITY DEFINER exécutable » restent normales : ce sont les RPC de l'application.
- Reste à activer à la main (hors SQL) : protection contre les mots de passe compromis (Authentication).

## 7. Reste à vérifier avant production

- Le privilège **MAINTAIN** n'existe qu'en PostgreSQL 17 : la base locale de test est en 16, donc la branche MAINTAIN n'a **pas** été exécutée réellement ; elle ne l'est qu'en préproduction (PG 17.11). Résultat attendu : `NOTICE` = 61 (dont 17 MAINTAIN ; 14 en production).
- `grantor` des ACL : relevé indirect (ACL par défaut du propriétaire `postgres`). Si un `REVOKE` laissait un privilège accordé par un autre rôle, le contrôle final du script l'annule et le signale.
- Aucun test automatisé ne remplace l'essai manuel de la checklist en préproduction.
