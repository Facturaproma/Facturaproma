# Sécurité

## Signaler une vulnérabilité
Merci de **ne pas** ouvrir de ticket public. Écris à l'adresse de contact indiquée sur le site (ou utilise « Report a vulnerability » dans l'onglet Security du dépôt).

## Ce qui est public, ce qui ne l'est pas
- La clé Supabase **anon** présente dans `app.html` est publique par conception : la protection des données repose sur les règles RLS (`sql/06`, `sql/07`).
- Ne jamais committer : clé `service_role`, mot de passe de base de données, sauvegardes, fichiers `.env`.
- Les secrets (mot de passe de la base, phrase de chiffrement des sauvegardes) vivent uniquement dans GitHub > Settings > Secrets and variables > Actions.
