# Reconstruire les PR empilées après la fusion de #58 (sans force-push)

Contexte : #59 (avoirs), #62 (rapports et exports) et #64 (plafond SQL, brouillon) sont empilées sur la branche de #58. Une fusion de #58 **en squash** réécrit l'historique : retargeter ces PR sur `main` produirait des conflits (vérifié par simulation locale le 24/10/2026). Un force-push est refusé par les garde-fous. La procédure ci-dessous crée des branches neuves à partir de la nouvelle `main` et reprend les commits propres de chaque lot, sans réécrire une branche déjà publiée.

## Règles
- Un lot = une branche = une PR ; les lots ne sont jamais mélangés.
- Aucune fusion sans votre phrase d'autorisation explicite ; aucune branche existante n'est réécrite.
- Les anciennes PR sont fermées avec un renvoi vers la nouvelle (jamais supprimées avant fusion de la nouvelle).

## Procédure par lot (après la fusion de #58)
```
git fetch origin
git checkout -b <lot>-v2 origin/main
git cherry-pick $(git rev-list --no-merges --reverse <ancienne-base-#58>..<ancienne-branche-du-lot>)
npm test && npm run test:integration          # PostgreSQL local requis pour la seconde commande
git push -u origin <lot>-v2
# nouvelle PR vers main ; fermer l'ancienne avec un lien
```
`<ancienne-base-#58>` = `feat/paiements-solde-fiable`, qui reste publiée.

| Lot | Ancienne branche | Commits à reprendre | Résultat de la simulation (squash de #58 simulé en local) |
|-----|------------------|---------------------|-----------------------------------------------------------|
| Avoirs (#59) | `fix/avoir-facture-annulee` | 2 | cherry-pick propre |
| Rapports et exports (#62) | `feat/rapports-exports-paiements` | 1 | propre seul ; **conflit si repris après #59** (`docs/REGLES_METIER.md`, `package.json`, `tests/paiements.unit.test.js` : ajouts de part et d'autre) |
| Plafond SQL (#64) | `feat/preprod-plafond-paiements` | 1 | conflit sur `tests/integration/paiements.sql-concurrence.test.js` ; résolu proprement avec `git cherry-pick -X theirs` (la version du lot remplace celle de #58) |

## Ordre recommandé
1. #58 fusionnée en squash (votre autorisation).
2. #59 reconstruite et fusionnée (autorisation distincte).
3. #62 reconstruite **depuis la main qui contient #59** : le conflit des 3 fichiers de la ligne ci-dessus se résout en conservant les deux séries d'ajouts (aucun chevauchement de code dans `app.html`). Les tests sont rejoués après résolution.
4. #64 en dernier, uniquement si vous décidez de poursuivre le plafond serveur ; rien n'y est exécuté sur Supabase tant que vous n'avez pas autorisé la préproduction.
5. Alternative sans reconstruction : fusionner #58 avec un **merge commit** (et non un squash) ; #59, #62 et #64 se retargetent alors sur `main` sans conflit. À décider par vous, car cela va à l'encontre du squash demandé.

## Après chaque fusion
- Vérifier le workflow « pages build and deployment » du commit de fusion, puis tester sur téléphone.
- Ne rien annoncer comme déployé tant que ce workflow n'est pas vert.
