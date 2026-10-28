# Procédure d'incident de sécurité — FacturaPro

À garder sous la main (hors du dépôt aussi : imprimée ou dans le gestionnaire de mots de passe). Elle est volontairement courte : en cas d'incident, on suit les étapes dans l'ordre.

**Principe : d'abord arrêter l'hémorragie, ensuite comprendre, ensuite prévenir.** Ne rien supprimer avant d'avoir une copie : les preuves servent à comprendre et, si nécessaire, à prévenir la CNDP.

## 0. Les 10 premières minutes (tous les cas)
1. Noter l'heure, qui a signalé quoi, comment. Ouvrir un fichier de notes daté (ce qui est fait, à quelle heure).
2. Ne pas répondre à l'éventuel auteur d'un chantage / d'une demande de rançon.
3. Ne pas redémarrer ni « nettoyer » : on garde l'état pour l'enquête.
4. Décider du niveau : **A** = un compte client compromis · **B** = fuite ou accès non autorisé à des données · **C** = compte administrateur ou secret technique compromis · **D** = rançongiciel / poste du propriétaire infecté.

## A. Compte client compromis (mot de passe volé, fraude)
1. Console admin → **Suspendre** le compte (lecture seule immédiate, données conservées).
2. Supabase → Authentication → Users → forcer la déconnexion (révoquer les sessions) du compte.
3. Faire réinitialiser le mot de passe par le client (lien e-mail), après avoir vérifié son identité par un autre canal (appel).
4. Vérifier le journal d'administration et les dernières factures / paiements du compte ; prévenir le client de ce qui a été fait avec son compte.
5. Réactiver seulement quand le client a confirmé avoir changé son mot de passe.

## B. Fuite ou accès non autorisé à des données de clients
1. **Contenir** : suspendre les comptes concernés ; si la cause est une faille dans l'application, publier le correctif (ou retirer temporairement la page concernée) avant tout le reste.
2. **Évaluer** : quelles sociétés, quelles données (factures, ICE, RIB, e-mails), depuis quand, jusqu'à quand. Supabase → Logs (API / Postgres / Auth) ; GitHub → Actions (qui a lancé quoi) ; journal d'administration.
3. **Conserver les preuves** : exporter les journaux utiles avant leur expiration.
4. **Prévenir** les clients concernés sans délai excessif, en français clair : ce qui s'est passé, quelles données, ce qui est fait, ce qu'ils doivent faire (changer leur mot de passe, surveiller leurs virements).
5. **CNDP** : vérifier avec un juriste ou la CNDP si une notification est exigée pour ce type de fuite (loi 09-08) et dans quel délai. *Ce point n'est pas vérifié dans ce document : à confirmer avant l'incident.*
6. Corriger la cause, ajouter un test qui aurait détecté le problème, puis rédiger un court compte rendu (cause, impact, correction, ce qui change).

## C. Compte administrateur ou secret technique compromis
1. **Changer tout de suite** le mot de passe du compte administrateur concerné (Supabase Auth) et révoquer ses sessions.
2. Console admin → vérifier la liste des administrateurs / équipe ; retirer toute personne inconnue (`admins`, `staff`).
3. **Faire pivoter les secrets** concernés, dans cet ordre :
   - mot de passe de la base (Supabase → Database → Settings), puis le secret `SUPABASE_DB_PASSWORD` de GitHub ;
   - phrase de chiffrement des sauvegardes (`BACKUP_PASSPHRASE`) ; **les sauvegardes déjà publiées restent lisibles avec l'ancienne phrase** : les supprimer (GitHub → Actions → artefacts) et refaire une sauvegarde ;
   - clé `service_role` si elle a pu fuiter (Supabase → Settings → API) ; la clé `anon` est publique par conception, inutile de la changer ;
   - jeton GitHub personnel, clés d'API tierces.
4. Relire le journal d'administration (`admin_audit`) : toute licence, tout code, toute suppression suspecte doit être annulé.
5. Si une donnée client a pu être lue : passer à la procédure B.

## D. Rançongiciel / poste du propriétaire compromis
1. Déconnecter le poste du réseau (sans l'éteindre si possible). Utiliser un autre appareil sain.
2. Depuis l'appareil sain : changer le mot de passe du compte GitHub, de Supabase, de la messagerie et du gestionnaire de mots de passe ; révoquer toutes les sessions et les jetons ; activer / vérifier l'authentification à deux facteurs.
3. Faire pivoter les secrets comme en C.3.
4. Ne pas payer de rançon sans avis ; la base de production est dans Supabase et les sauvegardes dans GitHub : **vérifier qu'elles n'ont pas été touchées** avant toute restauration.
5. Restaurer depuis une sauvegarde saine : procédure dans `docs/SAUVEGARDE_RESTAURATION.md` et `docs/RESTAURATION_ISOLEE.md`.

## Où regarder (liste de contrôle)
| Besoin | Où |
|---|---|
| Qui s'est connecté, quand | Supabase → Authentication → Users / Logs |
| Requêtes API et erreurs | Supabase → Logs (API Gateway, Postgres) |
| Actions des administrateurs | console admin → Journal ; table `admin_audit` |
| Qui a lancé une sauvegarde / un workflow | GitHub → Actions |
| Alertes de sécurité du code | GitHub → Security (Dependabot, CodeQL, secrets) |
| Restauration | `docs/SAUVEGARDE_RESTAURATION.md` |

## Après l'incident
- Compte rendu écrit (cause, impact, correction, durée) conservé dans un document privé.
- Un test automatisé ajouté pour la cause (dossier `tests/`).
- Relire `docs/SECURITE_CHECKLIST_PRODUCTION.md` et cocher ce qui manquait.
- Informer les clients concernés de la clôture.
