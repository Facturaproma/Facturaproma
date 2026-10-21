# Plan de lancement — premier groupe de professionnels marocains

**Statut :** proposition à valider. Aucune action commerciale ni technique n'est engagée. Tous les chiffres d'objectif ci-dessous sont des **hypothèses à calibrer**, pas des prévisions.

## 1. Conditions avant d'ouvrir à des clients payants (non négociables)

- Dépôt `main` inchangé tant que vous n'avez pas donné l'accord ; mise en production dans l'ordre : sauvegarde → SQL 14 → vérification en préproduction (voir `PREPRODUCTION_SUPABASE.md`) → application.
- Mentions légales et conditions sans espace réservé ; adresse de support réelle ; e-mail d'envoi sous votre domaine ; captcha actif ; comptes de test supprimés.
- Aucune mention « certifié DGI », « conforme facturation électronique » ou équivalent. Formulation à utiliser : « Factures avec les mentions usuelles, numérotation séquentielle non modifiable. La facturation électronique DGI n'est pas prise en charge pour le moment ; vérifiez le calendrier qui vous concerne auprès de la DGI ou de votre comptable. » Je n'ai trouvé aucune source officielle accessible (le site de la DGI était inaccessible aux outils) : seules des sources secondaires (éditeurs, presse) indiquent un calendrier non définitif.
- Un parcours support clair : où écrire, délai de réponse promis (ex. 24 h ouvrées).

## 2. Segment prioritaire

**Auto-entrepreneurs et petits prestataires de services** (formateurs, consultants, artisans-prestataires, développeurs, photographes, coachs) **qui facturent depuis leur téléphone**, 5 à 30 factures par mois, en français avec une partie de clients en arabe.

Pourquoi eux d'abord : besoins fiscaux simples ; décision d'achat immédiate sans comité ; le prix de 49 DH/mois se compare à 124 DH/mois (Hisab Starter) et 199 DH/mois (Mafactu Starter), relevés sur leurs pages publiques le 21 octobre 2026 ; leurs concurrents ciblent plutôt les PME. À réévaluer : ce sont des constats de prix publics, pas une étude de marché ; la préférence réelle des clients reste à mesurer.

Hors cible pour l'instant : PME avec retenue à la source ou acomptes complexes, fiduciaires multi-clients, entreprises soumises dès 2026 à la facturation électronique (si le calendrier officiel les concerne).

## 3. Les trois fonctions à mettre en avant (par ordre de valeur)

1. **Facture correcte en moins de 2 minutes sur téléphone** : mentions légales, ICE, TVA, numérotation séquentielle attribuée par le serveur, facture émise non modifiable (correction par avoir). C'est la promesse de fiabilité, et elle est désormais testée.
2. **Envoi immédiat en PDF et par WhatsApp, documents en français et en arabe** : le PDF arabe est implémenté et vérifié visuellement ; à valider sur de vrais téléphones.
3. **Suivi des impayés et relances WhatsApp en français et en darija** : fonction de l'Étape 3 (non encore développée). Valeur la plus mesurable : « combien de factures ai-je récupérées après relance ».

À ne pas promettre : facturation électronique DGI, signature électronique, comptabilité complète.

## 4. Prix à tester (en MAD, TTC non précisé : à fixer avec votre statut fiscal)

| Offre | Prix | Rôle dans le test |
|---|---|---|
| Essai | 14 jours, sans carte | Mesurer l'activation (déjà 14 jours d'essai actif dans l'appli) |
| Mensuel | 49 DH/mois | Prix d'entrée ; référence actuelle |
| Annuel | 449 DH/an (≈ 37 DH/mois) | Réduit le désabonnement |
| Fondateur (30 premiers clients) | 299 DH/an | Premiers clients, retours détaillés en échange |

Test proposé : proposer le Fondateur aux 30 premiers essayeurs ; à partir du 31e, tester Mensuel 49 vs 69 DH sur deux groupes aléatoires de 30 pour mesurer la sensibilité au prix. Ne rien déduire avant ~30 essayeurs par variante. Moyens de paiement : via le mécanisme actuel d'activation par code après paiement (virement, etc.) — **à confirmer** sur les moyens réellement acceptés légalement par votre statut ; ne pas annoncer un paiement par carte tant qu'il n'existe pas.

## 5. Plan sur 30 jours

| Semaine | Objectif | Actions |
|---|---|---|
| 0 (préalable) | Production prête et sûre | Préproduction validée ; accord écrit ; sauvegarde ; SQL 14 puis appli |
| 1 | 10 premiers utilisateurs en essai | Votre réseau personnel et professionnel (collègues, anciens stagiaires, freelances connus) ; 1 appel de 15 min chacun |
| 2 | 20 essayeurs | Groupes Facebook/WhatsApp de freelances et auto-entrepreneurs (en respectant leurs règles), démonstration vidéo courte de 60 s |
| 3 | Premiers paiements | Relance des essayeurs actifs ; offre Fondateur limitée dans le temps |
| 4 | Décision | Bilan chiffré ; on garde, on change le prix ou la cible |

Canaux à ne pas surévaluer : publicité payante (budget 300 MAD/mois, peu de marge d'apprentissage), annuaires. Priorité au bouche-à-oreille et aux démonstrations.

## 6. Indicateurs de succès (hypothèses initiales, à ajuster après 30 utilisateurs)

| Indicateur | Définition | Seuil « vert » initial |
|---|---|---|
| Activation | Essayeur ayant émis ≥ 1 facture dans les 24 h | ≥ 50 % |
| Usage réel | ≥ 3 factures émises sur 14 jours | ≥ 30 % des essayeurs |
| Conversion essai → payant | Paiement avant la fin des 14 jours | ≥ 10 % |
| Rétention à 30 jours | Payants encore actifs 30 jours après | ≥ 80 % |
| Fiabilité | Incidents de numérotation / perte de données | 0 |
| Support | Délai médian de première réponse | ≤ 24 h |
| Objectif de revenu (hypothèse) | 20 payants × 49 DH | ≈ 980 DH/mois |

Ces seuils sont des points de départ de bon sens, pas des références de marché vérifiées.

## 7. Mesure sans surveiller les personnes

Compter uniquement des événements agrégés (factures émises, relances envoyées, abonnements) côté serveur ; déclarer cette mesure dans la politique de confidentialité ; pas d'outil tiers de suivi sans accord de l'utilisateur.

## 8. Décisions à prendre ensemble

- Fondateur 299 DH/an : on le garde tel quel ou on le limite à 30 ?
- Statut fiscal pour encaisser (déclaration des revenus de FacturaPro) : à vérifier avec votre comptable.
- Premier groupe pilote : 10 personnes de votre entourage professionnel prêtes à donner un retour écrit.
