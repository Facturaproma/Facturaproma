# Migration « une ligne par document » — plan révisé après audit (22/10/2026)

> **Statut : scripts PRÉPARÉS et testés EN LOCAL uniquement (base jetable). Rien n'a été exécuté sur Supabase (ni préproduction, ni production) pour cette migration.**
> Aucune donnée de préproduction n'est migrée avant votre accord sur ce plan. La production, `main` et le déploiement ne sont pas concernés.

## A. Ce que l'audit a trouvé dans le plan initial (§0–§9 plus bas) et comment c'est corrigé

| Constat dans le code / le plan | Correction apportée |
|---|---|
| Le plan ne couvrait que la clé `invoices`. Or les **devis** sont dans la clé `quotes`, les **paiements** dans `payments`, le **journal client** dans `docLog` (tronqué à 2000 entrées). | Les 4 clés sont migrées : `documents` (factures, avoirs, devis), `doc_payments`, `doc_history`. `doc_events` (journal serveur) n'est pas touché. |
| Les ids pouvaient se recouper entre factures et devis (clé primaire `(user_id, id)`). | Clé primaire `(user_id, doc_type, id)`. |
| Colonnes `numeric(14,2)` : un montant historique à 3 décimales aurait été **arrondi en silence**. | `numeric` sans échelle ; le corps JSON d'origine est conservé tel quel (`body`) et comparé par empreinte SHA-256. |
| Index unique sur tous les numéros émis : les **devis** peuvent avoir des numéros en double (repli local si le serveur est injoignable). | Unicité imposée aux factures et avoirs seulement ; les doublons de devis sont détectés au dry-run et **bloquent** (décision humaine). |
| Le numéro d'une facture historique peut dépasser le compteur serveur (comptes antérieurs à `sql/14`) → le déclencheur de numérotation aurait refusé la copie. | Pendant la copie seulement (identifiant de run secret, illisible pour les utilisateurs), le contrôle d'attribution est suspendu ; l'unicité reste imposée ; le dry-run avertit si un numéro dépasse le compteur. |
| Rattrapage des écritures faites dans l'ancien format pendant la migration : seulement annoncé. | Implémenté : `legacy_sha` ; rejouer `fp_mig_run` rafraîchit les lignes non modifiées côté nouveau, **note en conflit** (`_mig_conflicts`, version ancienne conservée) les lignes modifiées des deux côtés, sans rien écraser. |
| Journal `docLog` : le rang dans le tableau change quand il est tronqué. | Identité = empreinte de l'entrée + rang parmi les entrées identiques ; les entrées sorties du tableau tronqué restent conservées. |
| Suppressions faites par le nouveau chemin ressuscitées par un rattrapage ou un retour arrière. | Table `doc_deleted` (pierres tombales). |
| Aucune **pièce jointe** n'existe dans l'application (seul le logo, en base64 dans `company`). | Rien à migrer ; le dry-run signale toute pièce jointe / data-URI dans un document ; `company` et `clients` ne sont pas touchés. |
| Retour arrière annoncé (`migrate_back`) mais non défini, sans garantie sur les écritures récentes. | `fp_mig_rollback` : aperçu par défaut, sauvegarde préalable de l'état courant, fusion sans perte, rejouable. |

Limite connue du retour arrière : un **brouillon supprimé sur un ancien appareil** après la copie réapparaît (le nouveau stockage le contient encore). Aucune facture émise ne peut disparaître (verrouillage serveur).

## B. Ce qui est livré (non exécuté sur Supabase)

- `sql/15_documents.sql` : tables `documents`, `doc_payments`, `doc_history`, `doc_deleted`, tables techniques `_mig_*` ; RLS en lecture seule pour le propriétaire, **aucune écriture directe** ; déclencheur de verrouillage et de numéro serveur (mêmes règles que `sql/14`) ; fonctions `upsert_document` (version attendue + identifiant d'opération rejouable), `delete_document`, `record_payment` (atomique et rejouable).
- `sql/16_migration_donnees.sql` : `fp_mig_dry_run`, `fp_mig_run(compte, appliquer)`, `fp_mig_verify`, `fp_mig_rollback(compte, appliquer)`. Aucune n'est exécutable par `anon` ni `authenticated`.
- Ces deux scripts sont dans `sql/MANIFEST.json` sous la clé `migration_table_par_facture` et **pas** dans `ordre` : l'installateur de préproduction ne les applique pas.
- Contrôles bloquants du dry-run : valeur non-tableau, élément non-objet, document ou paiement sans id, id en double, facture/avoir émis sans numéro valide, numéro émis en double (factures, avoirs, devis). Avertissements : paiement orphelin, règlement incohérent, montant/date illisible, pièce jointe, avoir sans facture d'origine, numéro au-delà du compteur, document supprimé depuis.
- Contrôles de la copie (dans une sous-transaction : au moindre écart **toute la copie est annulée**) : présence de chaque élément, empreinte identique élément par élément, colonnes dérivées, sommes HT/TVA/TTC et comptes par compte et par type, paiements (nombre et somme), journal (chaque entrée présente et identique), absence de doublon.
- L'application (`app.html`) **n'est pas modifiée** : elle écrit toujours dans `user_data`. Brancher l'application sur `upsert_document` (phase A du §4) est une étape ultérieure qui demandera votre accord.

## C. Tests (tous en LOCAL, base PostgreSQL jetable ; imitation d'auth Supabase : SIMULATION)

| Test | Fichier | Résultat |
|---|---|---|
| Dry-run, bloquants, arrêt avant copie, arrêt sur écart pendant la copie (sabotage volontaire, copie annulée), migration, idempotence, rattrapage, conflit des deux côtés, non-modification de l'ancien stockage, retour arrière (aperçu, application, rejeu, aller-retour), RLS, droits, verrouillage, numéros, licence, paiements, cascade de suppression | `tests/sql/test_migration.sql` | 79 tests |
| 10 appareils sur le même document ; créations simultanées du même id ; 20 émissions simultanées ; deux appareils sur des documents différents (+ témoin de l'ancien tableau qui perd une écriture) ; coupure avant validation ; réponse perdue après validation ; émission et paiements rejoués ; migration de 200 documents pendant 20 écritures | `tests/integration/migration.test.js` | 18 tests |

Exécutés par `npm run test:all` ; le total des tests SQL du dépôt est passé de 74 à 153.

## D. Prochaines étapes (chacune demande votre accord écrit)

1. Répétition sur la préproduction **avec des comptes de test jetables uniquement** : installer `15` et `16`, créer des données fictives, `fp_mig_run(…, true)`, vérification, retour arrière, restauration de la sauvegarde. La préproduction ne contient aujourd'hui aucun compte hors tests.
2. Adaptation de l'application (double écriture puis lecture depuis `documents`), testée en préproduction.
3. **Production** : uniquement avec une autorisation distincte, une sauvegarde de production dont la restauration a été testée, et un dry-run relu ligne par ligne.

---

# Plan initial (conservé pour référence — voir la section A pour les corrections)

## Proposition initiale de migration : une ligne par facture

> **Statut : proposition soumise à validation.** Aucun script de ce document n'a été exécuté, ni sur la base de production ni ailleurs. Aucune migration ne sera lancée sans accord écrit explicite.

## 0. En bref

| | |
|---|---|
| **Pourquoi** | Supprimer le risque de perte de données quand deux appareils écrivent en même temps ; préparer les rapports, les relances et le partage avec un comptable. |
| **Quoi** | Une ligne par facture dans `documents` (puis clients et paiements), avec version pour la concurrence. |
| **Comment** | Copie sans toucher à l'ancien stockage, double écriture, bascule par version, retour arrière possible à chaque phase. |
| **Quand** | Seulement après votre accord, d'abord en préproduction. |
| **Coût** | 0 MAD de service (plan gratuit) ; ~3 à 5 jours de travail. |

### Avantages
- Plus d'écrasement entre appareils (lignes distinctes) ; conflit explicite sur une même facture.
- Verrouillage, numérotation et journal appliqués ligne par ligne, plus simples à prouver.
- Requêtes serveur possibles (impayés, totaux par mois) sans télécharger tout le tableau ; chargement plus rapide quand le volume augmente.
- Base saine pour les relances WhatsApp mesurables (une relance = une ligne liée à une facture).

### Risques et parades
| Risque | Parade |
|---|---|
| Perte ou altération de données à la copie | Sauvegarde vérifiée par restauration ; copie non destructive (l'ancien stockage n'est jamais modifié) ; rapprochement nombre + sommes par compte, bloquant |
| Anciens appareils qui écrivent encore dans l'ancien format | Double écriture pendant la transition ; conversion serveur ; drapeau de version |
| Régression de l'application | Suites de tests existantes adaptées + tests de concurrence ; essai complet en préproduction |
| Données historiques incohérentes (doublons de numéros, factures émises sans numéro valide) | Dry-run qui les liste avant toute copie ; décision au cas par cas, jamais de correction silencieuse |
| Coupure de service | Aucune coupure prévue : phases A/B sans arrêt ; la coupure C est une simple bascule |
| Dépassement des limites du plan gratuit | Taille actuelle très faible ; à mesurer au dry-run |

## 1. Problème à résoudre

Aujourd'hui, toutes les factures d'un compte sont stockées dans **une seule ligne** `user_data(key='invoices')`, sous forme d'un tableau JSON. Chaque enregistrement renvoie le tableau complet : **le dernier appareil qui écrit gagne**. Deux appareils qui modifient des factures différentes peuvent donc s'écraser (seul un correctif « fusion + réessai » côté application atténue le cas des factures émises). Les brouillons, clients et paiements (autres clés) ont le même défaut.

## 2. Schéma cible

```sql
-- Une ligne = une facture / un avoir / (plus tard) un devis
CREATE TABLE public.documents (
  user_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  id            text        NOT NULL,                 -- id actuel de l'appli (conservé)
  doc_type      text        NOT NULL CHECK (doc_type IN ('invoice','credit','quote')),
  number        text,                                  -- NULL ou BRO-… tant que brouillon
  status        text        NOT NULL,                  -- draft | sent | paid | overdue | cancelled…
  doc_date      date,
  due_date      date,
  client_id     text,
  client_name   text,
  total_ht      numeric(14,2) NOT NULL DEFAULT 0,
  total_tva     numeric(14,2) NOT NULL DEFAULT 0,
  total_ttc     numeric(14,2) NOT NULL DEFAULT 0,
  paid_amount   numeric(14,2) NOT NULL DEFAULT 0,
  related_id    text,                                  -- avoir -> facture d'origine
  body          jsonb       NOT NULL,                  -- document complet (lignes, notes, etc.)
  version       integer     NOT NULL DEFAULT 1,        -- concurrence optimiste
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);
CREATE UNIQUE INDEX documents_number_uq ON public.documents(user_id, doc_type, number)
  WHERE number IS NOT NULL AND status <> 'draft';
CREATE INDEX documents_user_date ON public.documents(user_id, doc_date DESC);
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;      -- politiques « propriétaire » comme user_data
```

Tables suivantes (phase 2, même principe) : `clients`, `payments` (une ligne par encaissement, ce qui supprime aussi le recalcul du « payé » côté client), `settings` (société, préférences).

Règles serveur réutilisées de `sql/14` : déclencheur de verrouillage (une ligne émise n'est plus modifiable hors paiements/statut), numéro attribué uniquement par `next_doc_number`, journal `doc_events` automatique. La concurrence devient une vraie règle de base de données : `UPDATE … WHERE id=… AND version=:vue` ; 0 ligne modifiée = conflit explicite.

## 3. Migration des données existantes (idempotente, en 4 temps)

1. **Sauvegarde préalable (obligatoire)** : export complet `user_data` (CSV ou `pg_dump -t public.user_data`) conservé hors Supabase + copie interne `CREATE TABLE backup.user_data_20XXXXXX AS SELECT * FROM public.user_data;`. Vérifier le nombre de lignes et un hachage du contenu.
2. **Dry-run** (lecture seule) : fonction `migrate_dry_run()` qui, pour chaque compte, éclate `user_data.invoices` en lignes et **ne fait que compter** : nombre de factures par statut, sommes HT/TVA/TTC, doublons de numéros, factures émises sans numéro valide, avoirs orphelins. Le rapport est relu avant de continuer.
3. **Copie** : `INSERT INTO documents … ON CONFLICT (user_id,id) DO NOTHING` (rejouable sans risque). Les anciennes lignes `user_data` **ne sont ni modifiées ni supprimées**.
4. **Contrôle** : pour chaque compte, nombre et sommes de `documents` = nombre et sommes de l'ancien tableau (requête de rapprochement ; toute différence bloque la bascule).

### Comment on vérifie que l'historique est conservé
Pour chaque compte, avant et après : nombre de documents par type et par statut ; somme HT, TVA et TTC ; liste des numéros (ensemble identique, aucun doublon) ; empreinte (hash) de chaque facture émise comparée entre l'ancien tableau et la nouvelle ligne ; relecture visuelle de 3 comptes réels (avec leur accord) ou de comptes de test. Toute différence arrête la migration. Les factures émises ne sont jamais réécrites : leur contenu `body` est copié tel quel.

## 4. Compatibilité temporaire avec l'application actuelle

- **Phase A – double écriture** (nouvelle version de l'appli) : l'appli lit encore `user_data`, écrit dans `user_data` **et** appelle `documents`. Un déclencheur ou la fonction RPC `upsert_document(...)` garde `documents` à jour. Rien ne casse pour les anciens onglets/appareils.
- **Phase B – lecture depuis `documents`** derrière un indicateur de version côté appli (`user_data.key='schema'`), appareil par appareil. Un appareil non mis à jour continue d'écrire dans l'ancien tableau : le déclencheur le convertit en lignes (compat) jusqu'à la date de coupure.
- **Phase C – coupure** : plus d'écriture dans `user_data.invoices` ; verrouillage en lecture seule de l'ancienne clé ; conservation 90 jours puis archivage.

## 5. Gestion des conflits entre appareils (modifications concurrentes)

Mécanisme : chaque ligne porte `version`. Une modification envoie `version` attendue ; le serveur n'accepte que si elle est inchangée, puis l'incrémente.

- Modification d'une même facture brouillon par deux appareils : le second reçoit « conflit de version » et affiche la version serveur + ses modifications pour choix (pas d'écrasement silencieux).
- Modifications de factures différentes : plus aucun conflit (lignes distinctes).
- Facture émise : seules les opérations autorisées (paiement, statut) passent ; verrouillage serveur inchangé.
- Hors-ligne : file locale d'opérations (créer/modifier brouillon) rejouée à la reconnexion avec `version` ; l'émission reste impossible hors ligne (numéro serveur obligatoire).

## 6. Retour arrière

- Phases A et B : retirer le drapeau de version → l'appli relit `user_data` (jamais modifié). `DROP TABLE documents` possible sans perte.
- Après la phase C : ré-éclater `documents` vers `user_data.invoices` par script inverse (`migrate_back()`), testé avant la phase C ; sauvegarde de l'étape 1 conservée.
- Critère d'arrêt : toute différence au contrôle de l'étape 4, ou toute erreur applicative sur les tests ci-dessous, stoppe la migration.

## 7. Tests avant / après

| Moment | Test | Environnement |
|---|---|---|
| Avant | Dry-run sur copie anonymisée de la production (comptes réels, sans les données personnelles) | Projet Supabase de préproduction |
| Avant | Rejeu de la migration deux fois : résultat identique (idempotence) | PostgreSQL local + préprod |
| Après | Rapprochement nombres/sommes par compte (étape 4) | Préprod puis prod |
| Après | Suite existante : verrouillage, numérotation, isolation RLS, concurrence (`npm run test:all`) adaptée à `documents` | Local |
| Après | Deux appareils modifient des factures différentes → aucune perte (aujourd'hui limité par la fusion) | Local + préprod |
| Après | Deux appareils modifient la même facture → conflit explicite | Local |
| Après | Retour arrière `migrate_back()` puis comparaison | Préprod |

## 8. Ordre proposé et effort estimé

1. Valider ce plan (vous). 2. Créer un **projet Supabase de préproduction** (gratuit) — recommandé avant toute exécution. 3. Écrire `sql/15_documents.sql` + `sql/16_migration_donnees.sql` + tests locaux. 4. Phase A en préprod. 5. Décision de vous : passage en production après sauvegarde.

Effort réaliste : ~3 à 5 jours de travail, dont l'essentiel en tests. Coût : 0 MAD (plan gratuit suffisant tant que le volume reste faible).

## 9. Limites connues

- Les tests locaux utilisent PostgreSQL 16 avec une imitation de l'authentification Supabase : ils ne remplacent pas un test sur un vrai projet.
- Une facture dont le numéro a été attribué mais dont l'écriture a échoué laisse un **trou de numérotation** : à documenter (procédure d'annulation/justification) car la séquence serveur ne revient jamais en arrière.
