# Affirmations publiques : état de vérification (24/10/2026)

Chaque affirmation de `legal.html` / `admin.html` est classée **Vérifié** (preuve dans le dépôt ou dans l'historique GitHub Actions), **Partiel** ou **Non vérifié**. Aucune information juridique n'est ajoutée ici.

| Affirmation | État | Preuve / limite |
|-------------|------|-----------------|
| « Une sauvegarde chiffrée est conservée sur la plateforme GitHub » | **Vérifié** (code et exécutions) | `.github/workflows/backup.yml` : dump hebdomadaire de `facturapro-prod`, chiffrement GPG AES-256 **avant** dépôt, dépôt en artifact `sauvegarde-supabase`. Exécutions réussies par déclenchement manuel les 20, 22 et 23/10/2026 ; artifact du 23/10 conservé jusqu'au 21/01/2027. **Limites** : la phrase secrète n'est connue que de vous (gestionnaire de mots de passe, non vérifiable par moi) ; la **restauration réelle d'une sauvegarde de production n'a jamais été testée** (`docs/SAUVEGARDE_RESTAURATION.md` §7.1) ; le dépôt est public, donc seul le chiffrement protège le fichier. |
| « Les sauvegardes chiffrées sont écrasées au plus tard 90 jours après » | **Vérifié** (réglage) | `retention-days: 90` dans `backup.yml`. Vaut pour les sauvegardes planifiées ; une sauvegarde faite avant une migration (artifact `sauvegarde-avant-migration`) a la même durée. |
| « Base de données hébergée chez Supabase, région Europe (Stockholm) » | **Vérifié** | Hôte `aws-1-eu-north-1.pooler.supabase.com` dans `backup.yml` et `prod-migration.yml` (eu-north-1 = Stockholm). |
| « Fichiers du site servis par GitHub Pages » | **Vérifié** | Workflow « pages build and deployment ». |
| Adresse `hello@facturapro.ma` | **Non vérifié** | Rien ne prouve que le domaine ou la boîte existent (le site est sur github.io, domaine à acheter). **Retirée de `legal.html` et remplacée par un champ « à créer et confirmer »**, et le contrôle `check-release` la traite comme blocage. |
| « Réponse sous 30 jours » aux demandes de droits | **Non vérifié** | Engagement à confirmer par la société ; texte laissé tel quel. |
| « Aucune revente de données, aucune publicité ciblée » | **Partiel** | Aucun code de publicité ni de revente trouvé dans le dépôt, mais je ne peux pas garantir l'absence future ; engagement de la société. |
| `admin.html` : « Conformité légale obligatoire au Maroc » | **Remplacé** | Formulation reformulée en conseil prudent (vérifier avec un comptable les mentions applicables). |
| `manifest.json` : « Conformité ICE, IF, CNSS » | **Remplacé** (PR #57) | Description factuelle des fonctions. |

Reste à faire par la société : adresse e-mail réelle, confirmation de l'engagement de 30 jours, test de restauration d'une sauvegarde de production, documents d'immatriculation (voir `docs/LEGAL_INFORMATIONS_MANQUANTES.md`).

## Registre des références fiscales et mécanisme de validation (24/10/2026)
`docs/validations-fiscales.json` liste chaque affirmation fiscale ou légale présente dans le produit (mention TVA des auto-entrepreneurs, conservation 10 ans, délais loi 69-21, ICE obligatoire). Toutes sont **« non_verifie »** : aucune source officielle n'a pu être lue (les PDF de la DGI interdisent la lecture automatisée).
- `npm run check:release` **échoue** tant qu'une de ces affirmations est présente dans `app.html`, `index.html`, `legal.html` ou `admin.html` sans validation complète.
- Pour valider : un comptable ou un juriste confirme ; on renseigne `status:"valide"`, `validated_by`, `validated_on` (AAAA-MM-JJ), `reference` (texte officiel) et `evidence` (pièce conservée). Une validation incomplète reste bloquante. **Ne jamais remplir ces champs sans source réelle.**
- Alternative à la validation : retirer l'affirmation du produit (le blocage disparaît).
- Garde-fou : toute **nouvelle** référence à un article du CGI ou à une loi dans le produit doit être ajoutée au registre, sinon `npm test` échoue.
- Le contrôle n'est pas câblé dans un workflow de déploiement automatique : il faut le lancer avant toute ouverture aux paiements réels (`npm run check:release`).
- Testé par `tests/check-release.unit.test.js` (7 contrôles, copie du dépôt).
