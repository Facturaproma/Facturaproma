# Intégrité de la bibliothèque Supabase (SRI) — état réel

**Appliqué :** `app.html` et `admin.html` chargent désormais une version **figée** `@supabase/supabase-js@2.118.0/dist/umd/supabase.js` (au lieu de `@2` qui change sans prévenir) ; `sw.js` la précharge à l'identique.

**Non appliqué (et pourquoi) :** l'attribut `integrity="sha384-…"`. Le CDN jsdelivr est inaccessible depuis l'environnement de développement : l'empreinte du fichier réellement servi n'a pas pu être vérifiée. Mettre une empreinte non vérifiée risquerait de **bloquer toute l'application** si elle diffère.

**Procédure à suivre en préproduction :**
1. `curl -s https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js | openssl dgst -sha384 -binary | openssl base64 -A`
2. Comparer avec le même calcul sur le fichier du paquet npm `@supabase/supabase-js@2.118.0` (`dist/umd/supabase.js`).
3. Si identiques : ajouter `integrity="sha384-<empreinte>" crossorigin="anonymous"` aux deux balises, tester le chargement, puis déployer.
4. À chaque changement de version, recalculer.

Mesure d'intégrité réellement en place aujourd'hui : version figée + règles serveur (RLS, verrouillage) qui ne dépendent pas du navigateur.
