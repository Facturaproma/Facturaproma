#!/usr/bin/env bash
# Exécute les scripts SQL du dépôt dans une base PostgreSQL JETABLE, puis les tests SQL.
# Usage : PGHOST=/tmp PGPORT=5599 PGUSER=postgres bash tests/sql/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
DB=fp_test_$$
psql -v ON_ERROR_STOP=1 -q -d postgres -c "CREATE DATABASE $DB" >/dev/null
trap 'psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB" >/dev/null' EXIT
P="psql -v ON_ERROR_STOP=1 -q -d $DB"
$P -f tests/sql/stub_supabase.sql >/dev/null
for f in sql/00_setup_complet.sql sql/05_admins.sql sql/06_securite_rls.sql sql/07_licence_serveur.sql \
         sql/08_admin_comptes.sql sql/09_periode_de_grace.sql sql/10_anti_abus.sql sql/12_admin_supprimer_compte.sql \
         sql/13_profil_assistant.sql sql/14_numerotation_et_verrouillage.sql; do
  $P -f "$f" >/dev/null 2>/tmp/fp_sql_err.txt || { echo "ECHEC chargement $f"; cat /tmp/fp_sql_err.txt; exit 1; }
done
echo "Scripts SQL chargés."
rm -f /tmp/fp_sql_results.txt; touch /tmp/fp_sql_results.txt
for t in tests/sql/test_*.sql; do
  echo "== $t"; $P -f "$t" 2>&1 | sed -n "s/^.*NOTICE:  //p;/ERROR/p" | tee -a /tmp/fp_sql_results.txt
done

if grep -qE "^FAIL|ERROR" /tmp/fp_sql_results.txt; then echo "=> ECHEC"; exit 1; fi
echo "=> $(grep -c ^PASS /tmp/fp_sql_results.txt) tests SQL réussis"
