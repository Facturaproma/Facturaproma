# Offre Fondateur : limite de 30 codes et interrupteur (état au 24/10/2026)

## Constat
La limite de 30 codes fondateurs n'était contrôlée que par le navigateur de l'administration (`admin.html`, `FOUNDER_LIMIT`). Un second onglet, une ancienne version de la page ou un appel direct à l'API la contournait. Le propriétaire ne pouvait ni fermer l'offre, ni la désactiver.

## Ce qui est préparé (cette PR)
- **Interrupteur** dans Admin → Tarifs & Plans (« 🎁 Offre Fondateur ») : état ouverte / fermée, nombre de codes émis, bouton « Fermer / Rouvrir l'offre » visible du **Master seulement**. Offre fermée ou complète : les options « Fondateur » des formulaires sont désactivées.
- **Base de données** (`sql/27_offre_fondateur.sql`, **BROUILLON NON APPLIQUÉ**, hors `MANIFEST.json`) :
  - un déclencheur sur `admin_codes` refuse le 31e code fondateur (codes révoqués non comptés), avec verrou contre les émissions simultanées ;
  - il refuse aussi tout nouveau code fondateur quand `admin_settings.founder_open = 'false'` ;
  - un déclencheur sur `admin_settings` réserve l'écriture de `founder_open` au Master ; les autres réglages ne changent pas ;
  - les codes déjà émis restent valables, offre fermée ou non ; une révocation libère une place.
- Pas de suppression de l'offre : elle est liée à des codes, demandes et encaissements ; fermer suffit.

## Tests exécutés (PostgreSQL local jetable, simulation)
- `tests/sql/test_fondateur.sql` : 13 contrôles (plafond, révocation, réactivation, interrupteur Master, administrateur simple refusé, autres réglages intacts).
- Émission simultanée : 8 insertions en parallèle à partir de 26 codes → exactement 4 acceptées, total 30 (contrôle ponctuel, non intégré à la suite).
- `tests/admin-fondateur.unit.test.js` : 16 contrôles de la logique du navigateur et de sa cohérence avec le SQL.
- Non testé : affichage de la page Admin sur un vrai navigateur ; effet sur la production.

## Pour appliquer (propriétaire, après autorisation écrite)
1. Préproduction d'abord, avec les contrôles de `tests/sql/test_fondateur.sql`.
2. Production : coller `sql/27_offre_fondateur.sql` dans l'éditeur SQL Supabase (script réexécutable, aucune donnée modifiée).
3. Vérifier en lecture seule : les deux déclencheurs (`trg_founder_codes`, `trg_founder_setting`) existent.
4. Retour arrière : voir l'en-tête du script.
Tant que le script n'est pas appliqué, l'interrupteur échoue proprement (message « script sql/27 appliqué ? ») et la limite reste contrôlée par le navigateur seulement.
