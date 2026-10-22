# Tests de FacturaPro

Lancer tout : `npm install && npm run test:all` (nécessite Chromium — variable `CHROMIUM_PATH` si besoin — et PostgreSQL local : `PGHOST`, `PGPORT`, `PGUSER`).

| Commande | Ce qui est vérifié | Réalisme |
|---|---|---|
| `npm test` | Application dans un navigateur réel en **mode local** : calculs, numérotation locale, verrouillage, avoirs, paiements, devis→facture, PDF, mobile (`app.test.js`) ; cas limites de calcul, exports CSV/FEC, PDF arabe (`regression.test.js`) | Local |
| `npm run test:sql` | Scripts SQL du dépôt sur PostgreSQL 16 jetable (RLS, droits EXECUTE, verrouillage, numérotation, isolation entre comptes, suppression de compte) | Local, **imitation** de l'auth Supabase |
| `npm run test:integration` | Application réelle + **faux** client Supabase relié à la vraie base locale : émission via le serveur, panne réseau, SQL 14 absent, deux appareils, reconnexion, isolation, contournements directs (`cloud.test.js`) ; 60 émissions parallèles (`concurrence.test.js`) | Local |

## Ce qui ne peut PAS être testé depuis cet environnement (à faire en préproduction)

- Le vrai Supabase (Auth, e-mail de confirmation, hCaptcha, limites de requêtes, PostgREST réel, version de PostgreSQL de la plateforme).
- Le chargement réel du CDN (empreinte SRI, panne du CDN), le service worker en conditions réelles (le test le désactive).
- Coupures réseau physiques, mobiles réels (iOS/Android), synchronisation réelle de deux téléphones.
- Les plateformes DGI (facturation électronique) : aucun accès, aucune conformité revendiquée.
- La production : aucun test n'y est fait (règle du projet).
