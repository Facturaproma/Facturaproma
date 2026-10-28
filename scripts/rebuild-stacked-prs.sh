#!/usr/bin/env bash
# Reconstruit LOCALEMENT les PR empilées sur #58 à partir de la nouvelle main (après fusion de #58 en squash).
# Ne pousse rien, n'utilise jamais --force. Usage : scripts/rebuild-stacked-prs.sh avoirs|rapports|plafond
# Voir docs/RECONSTRUCTION_PR_EMPILEES.md pour l'ordre (avoirs avant rapports ; jamais mélangés).
set -euo pipefail
BASE_OLD=feat/paiements-solde-fiable
case "${1:-}" in
  avoirs)   OLD=fix/avoir-facture-annulee;        NEW=fix/avoir-facture-annulee-v2;       OPT="" ;;
  rapports) OLD=feat/rapports-exports-paiements;  NEW=feat/rapports-exports-paiements-v2; OPT="" ;;
  plafond)  OLD=feat/preprod-plafond-paiements;   NEW=feat/preprod-plafond-paiements-v2;  OPT="-X theirs" ;;
  *) echo "Usage : $0 avoirs|rapports|plafond"; exit 2 ;;
esac
git fetch -q origin
# Garde-fou : #58 doit déjà être dans main (squash), sinon la reconstruction n'a pas de sens
if git merge-base --is-ancestor "origin/$BASE_OLD" origin/main 2>/dev/null; then :; else
  git diff --quiet "origin/$BASE_OLD" origin/main -- app.html 2>/dev/null && echo "main contient app.html identique à #58 (squash détecté)" || {
    echo "ATTENTION : main ne semble pas contenir #58. Arrêt."; exit 3; }
fi
git show-ref --verify --quiet "refs/heads/$NEW" && { echo "La branche $NEW existe déjà : arrêt (rien n'est écrasé)."; exit 4; }
git checkout -q -b "$NEW" origin/main
COMMITS=$(git rev-list --no-merges --reverse "origin/$BASE_OLD..origin/$OLD")
echo "Commits repris ($(echo "$COMMITS" | wc -l)) :"; git log --oneline --no-walk=unsorted $COMMITS
# shellcheck disable=SC2086
git cherry-pick $OPT $COMMITS || { echo "CONFLIT : résoudre à la main (REGLES_METIER.md, package.json, paiements.unit.test.js : garder les deux séries d'ajouts), puis git cherry-pick --continue"; exit 5; }
echo "Reconstruit en local sur $NEW. Lancer npm test && npm run test:integration, puis pousser et ouvrir la PR vers main (rien n'a été poussé)."
