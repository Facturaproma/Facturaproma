# Intégrité des scripts externes — état réel (26/10/2026)

## En place
- **Supabase** : `app.html` et `admin.html` chargent la version figée `@supabase/supabase-js@2.118.0/dist/umd/supabase.js` avec `integrity="sha256-7jvo3hkrl8sdc9HpXWuCux9rZYwPl8TvdX/DMZlu09M="` et `crossorigin="anonymous"`. Si le fichier servi par le CDN change d'un seul octet, le navigateur refuse de l'exécuter (la page ne se charge plus, plutôt que d'exécuter un code modifié).
- **Vérification de l'empreinte (26/10/2026)** : l'empreinte annoncée par l'API officielle de jsDelivr pour ce fichier (`/dist/umd/supabase.js`, 218 252 octets) est **identique** à celle du fichier du paquet npm `@supabase/supabase-js@2.118.0` (même SHA-256, même taille). Deux sources indépendantes concordent. Le chargement réel depuis le CDN n'a pas pu être testé depuis l'environnement de développement : **à tester en préproduction sur téléphone avant de fusionner**.
- **jsPDF 2.5.1 et jsPDF-AutoTable 3.5.31** : hébergés dans `vendor/` (copies identiques des paquets npm de ces versions ; `tests/securite-garde.unit.test.js` compare leur empreinte à celle des paquets du dépôt). Plus aucun script chargé depuis cdnjs. L'API de cdnjs n'était pas consultable pour vérifier une empreinte : plutôt que de deviner une empreinte (qui pourrait bloquer la génération des PDF), les fichiers sont servis par le site lui-même.
- `sw.js` (cache `facturapro-v18-netfirst`) précharge les fichiers de `vendor/`.

## Procédure à chaque changement de version
1. Récupérer l'empreinte officielle : `https://data.jsdelivr.com/v1/packages/npm/@supabase/supabase-js@<version>?structure=flat` (champ `hash` du fichier `/dist/umd/supabase.js`, base64 SHA-256).
2. La recouper avec le paquet npm : `npm pack @supabase/supabase-js@<version>`, puis `openssl dgst -sha256 -binary dist/umd/supabase.js | openssl base64 -A`.
3. Si identiques : mettre à jour `integrity` dans `app.html`, `admin.html`, `sw.js`, `tests/securite-garde.unit.test.js`, tester en préproduction, puis déployer.
4. Pour jsPDF : copier le fichier du paquet npm dans `vendor/` et mettre à jour la version dans ce document.

## Limites
- La fonte Google (feuille de style) et le script hCaptcha sont chargés sans empreinte (services tiers dont le contenu évolue) : risque accepté, à réévaluer avec une politique CSP (voir `docs/SECURITE_CHECKLIST_PRODUCTION.md`).
- Les tests automatisés retirent l'attribut `integrity` du serveur de test (ils remplacent volontairement le script Supabase par un faux) ; le garde-fou `securite-garde.unit.test.js` vérifie sa présence dans les vrais fichiers.
