# Plan de validation fonctionnelle — FacturaPro (préproduction)

Document de préparation. **Rien de ce qui suit n'est lancé sans autorisation explicite** (création de comptes, écritures en préproduction, push, fusion, déploiement).
Cible unique : Supabase de **préproduction** `njjaomichdlnoscrnxlz`. Comptes jetables `ui-*@facturapro-test.invalid` uniquement. Jamais la production.

## Légende « simulé / réel »

| Mot | Signification |
|---|---|
| **RÉEL** | exécuté contre le vrai Supabase de préproduction (GoTrue, PostgREST, fonctions SQL, RLS) par le workflow `preprod-ui` |
| **RÉEL (client coupé)** | le serveur est réel ; la coupure ou la perte de réponse est simulée côté client |
| **SIMULÉ** | faux client Supabase et/ou PostgreSQL **local** : vérifie la logique, **pas** Supabase |
| **NON EXÉCUTÉ** | écrit mais jamais lancé en réel |

État au moment de la rédaction : les contrôles `N1`–`N10` ont été exécutés en RÉEL (run 39774301049, 47/48 ; l'unique échec était la connexion du navigateur). Les contrôles `F1`–`F5` (section F) et les tests navigateur `B`/`U` sont **NON EXÉCUTÉS en réel** ; `F1`–`F4` ont été joués en SIMULÉ (67/67 en répétition locale).

> Mise à jour : la campagne réelle du run 39779883156 a exécuté `N1`–`N10`, `F1`–`F5` et les tests navigateur `B`/`U` en RÉEL (94/94), puis le nettoyage du run 39781605171 (9/9).

## Exceptions documentées : les lignes `_mig_runs` cff4cac4 et fe82bee1

Deux lignes globales de `_mig_runs` ont été **conservées** aux nettoyages, car leur rattachement à une campagne de test est **incomplet** (classe C : proximité d'horodatage et séquence de transactions, aucune preuve A « compte cité » ni B « même transaction qu'une ligne de la campagne ») :

| Ligne | Instant (UTC) | Campagne | Traits exigés |
|---|---|---|---|
| `cff4cac4…` | 2026-10-22 11:58:03.125 | run 39774301049 | mode `apply`, statut `applied`, instant à la milliseconde, rapport sans compte (`accounts: []`) |
| `fe82bee1…` | 2026-10-22 12:39:23.842 | run 39779883156 | mode `apply`, statut `applied`, instant à la milliseconde, rapport sans compte (`accounts: []`) |

Elles ne sont ni supprimées ni modifiées. Le contrôle de départ `P1` les **tolère, elles seules**, et seulement si **tous** leurs traits correspondent. Chaque exception ne couvre qu'**une** ligne (un doublon exact reste « inattendu »). Toute autre ligne, une troisième ligne, ou une ligne qui leur ressemble avec un trait différent (instant, mode, statut, rapport, préfixe) fait **échouer** `P1` (tests `K1`–`K7b`, SIMULÉ). Le nettoyage et l'inspection ignorent ces deux lignes.

## Diagnostic du blocage « Connexion... » (navigateur, run 39774301049)

`Auth.login()` appelle d'abord `getCaptchaToken()` (hCaptcha invisible, clé de site de production). Un navigateur automatisé ne résout pas un défi hCaptcha : si `hcaptcha.execute()` n'aboutit jamais, `signInWithPassword` n'est **jamais appelé** et le bouton reste sur « Connexion... ». Reproduit en SIMULÉ : `tests/integration/login-captcha.test.js` (captcha qui ne répond pas → bouton bloqué, **aucun** appel `signIn` ; script hCaptcha bloqué → connexion OK ; captcha qui répond → connexion OK).

* **Statut : cause très probable, NON confirmée en réel.** Le test local reproduit le mécanisme, pas l'observation réelle. Au run réel, les requêtes émises vers Supabase, les erreurs de console et le texte du bouton sont désormais consignés en cas d'échec ; ils trancheront (si la cause est bien celle-ci : *aucune* requête `auth/v1/token`).
* **Correctif du harnais** : le script hCaptcha (`hcaptcha.com`) est bloqué dans le navigateur de test, comme dans tous les tests locaux. Prémisse : la préproduction **accepte les connexions sans jeton captcha** — déjà établi en RÉEL par les connexions du protocole (N, F5), qui n'envoient aucun jeton. Ce n'est pas un contournement du produit : l'application continue simplement sans jeton, et la production reste inchangée.
* Si la connexion échoue encore, l'échec reste un **échec** (jamais un avertissement) avec le diagnostic.

## Correspondance domaines → tests

| # | Domaine | Tests | Nature | Prérequis | Résultat attendu |
|---|---|---|---|---|---|
| 1 | Connexion, session, expiration | F5a–F5e ; B3a/B3b ; B-login (diagnostic) | F5 : RÉEL ; B3 : RÉEL navigateur | comptes jetables, mots de passe aléatoires | session ouverte ; refresh valide ; ancien refresh token refusé après déconnexion ; mauvais mot de passe refusé ; jeton falsifié = 401 ; navigateur : 401 réel → écriture conservée puis envoyée |
| 2 | Isolation, contrôle d'accès | N1, N1b, N4a–N4f | RÉEL | 2 comptes avec données distinctes | 0 ligne d'un autre compte ; écritures directes 42501 ; anonyme refusé ; compte ordinaire refusé (MODE_ANCIEN_STOCKAGE) |
| 3 | Factures : création, modification, émission, verrouillage | F1a–F1f ; U1, U2 | F1 : RÉEL ; U : RÉEL navigateur | compte en mode documents | brouillon modifiable ; émission = numéro serveur + événement ; émise : modification, retour brouillon et suppression refusés (FACTURE_VERROUILLEE) ; brouillon supprimable |
| 4 | Devis, conversion en facture | F2a–F2e | RÉEL (deux écritures, comme `convertQuoteToInvoice`) | idem | devis modifiable/supprimable ; conversion = brouillon + devis `convertedTo` ; rejeu = pas de doublon ; émission avec numéro serveur |
| 5 | Paiements, doublons, refus | F3a–F3f ; N7c ; N4e | RÉEL ; N7c RÉEL (client coupé) | facture émise | brouillon refusé ; partiel non soldé ; rejeu = 1 ligne ; solde = `paid` ; montant nul / sans id / facture inconnue refusés ; modification directe refusée |
| 6 | Numérotation concurrente | N9a–N9e | RÉEL | 2 sessions, 2 comptes | numéros distincts et consécutifs ; séquences indépendantes ; NUMERO_EN_DOUBLE ; NUMERO_NON_ATTRIBUE |
| 7 | Bascule historique ↔ nouveau stockage | P5, P6, N10a–N10g ; U0, U4a–U4d | RÉEL ; U RÉEL navigateur | comptes `d,e,f,g` listés testeurs, `l,o` non | retour au legacy : données reprises, file orpheline signalée et jamais rejouée, export complet, rejeu forcé refusé |
| 8 | Synchronisation hors ligne, opérations en attente | B1a/B1b ; U3a/U3b ; N8a/N8b ; N10a | B/U : RÉEL navigateur (réseau coupé côté client) ; N8 : RÉEL (client coupé) | navigateur Chromium | rien n'est retiré de la file avant confirmation du serveur ; envoi à la reconnexion |
| 9 | Erreurs réseau, licence, conflits | N5a–N5c ; F4a–F4c ; B2a–B2c ; N6a–N6e ; N7a–N7b ; B4a/B4b | RÉEL / RÉEL (client coupé) | licence suspendue puis rétablie | LICENCE_INACTIVE sur toutes les écritures, lecture conservée, aucune boucle ; conflits : les deux versions conservées ; réponse perdue : rejeu sans doublon |
| 10 | Sauvegarde, restauration, régression | sauvegarde + restauration locale vérifiées avant chaque campagne ; empreinte avant/après ; `npm run test:all` | RÉEL (sauvegarde) ; SIMULÉ (régression) | client PostgreSQL 17 | empreinte inchangée ; structure (tables, RLS, politiques, fonctions, déclencheurs, contraintes) identique |

## Plan exact de la prochaine campagne réelle (sur autorisation)

Préalable : cette campagne **ne peut démarrer** que sur une préproduction sans compte `ui-*` (le harnais refuse sinon) et avec, pour seules lignes `_mig_runs`, les deux exceptions documentées (cff4cac4, fe82bee1).

1. **Autorisation explicite** de lancer la phase `test` (ce qui crée 6 comptes jetables, en bascule 4 vers `documents`, écrit des documents fictifs).
2. Le workflow `preprod-ui` (branche `validation/integration-documents`, environnement `preprod`, Node 22) : contrôle de cible et anti-production → sauvegarde restaurée et vérifiée → `P1`–`P6` (état initial, empreinte `6393652c285d`) → `N1`–`N10` → **`F1`–`F5`** → navigateur `B`/`U` → `F1` (empreinte finale).
3. Arrêt immédiat, sans nettoyage, si : empreinte différente, donnée préexistante modifiée, perte de données ou erreur inattendue.
4. Rapport publié sur `preprod-reports` (analyse de secrets avant publication). **Aucun nettoyage automatique.**
5. Inspection en lecture seule si besoin (phase `inspect`), puis **nettoyage sur autorisation distincte** (phase `cleanup`, périmètre par UUID + adresse, lignes `_mig_runs` prouvées seulement, comparaison de structure avant/après).

## Limites connues (à ne pas masquer)

* Les tests navigateur ont tourné en réel une seule fois (run 39779883156, 94/94) avec le script hCaptcha **bloqué dans le navigateur de test** : le chemin avec jeton hCaptcha réel n'est donc pas couvert, et la cause du blocage « Connexion... » du run précédent reste une hypothèse non observée directement.
* `F1`–`F5` ont tourné en réel une fois (94/94) ; les messages d'erreur ne sont validés que pour les cas couverts.
* Le changement D1 (envoi réel de la file hors ligne du mode historique) concerne **tous** les comptes une fois fusionné. Il a été validé en conditions réelles sur un compte ORDINAIRE en ancien stockage (ui-l, sections B1–B4 du run 39779883156 : écriture hors ligne → reconnexion → envoi vérifié côté serveur, licence inactive, jeton refusé, réponse perdue).
* `backup.yml:80` masque une erreur par `|| echo ::warning::` (non modifié, à corriger plus tard).
