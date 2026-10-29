# Décisions produit

## 24/10/2026 : stock, priorités

**Gestion de stock : pas maintenant.** L'application cible d'abord des auto-entrepreneurs, freelances et petites sociétés de services ; je n'ai aucune preuve chiffrée d'un besoin de stock chez les premiers clients (pas de retours utilisateurs structurés à ce jour). Un stock correct demande une migration de base, des règles sur les avoirs et les annulations et des tests anti-double-décrémentation : coût et risque supérieurs au bénéfice tant que la demande n'est pas démontrée. Les concurrents mettent le stock en avant, mais je n'ai pas pu examiner leurs applications connectées (seulement leur page publique).
Condition de reprise : au moins quelques demandes réelles de clients, ou un retour d'essai. Première version envisagée : produit « suivi en stock » optionnel, quantité, mouvements horodatés, décrément à l'émission de la facture, mouvement inverse par avoir, alerte de seuil. Aucun lot, entrepôt ni code-barres.

**Trois priorités (valeur / risque / effort)**
1. Paiements fiables (fait dans ce lot) : montants encaissés et restants cohérents partout, protection contre doubles enregistrements et trop-perçus.
2. Cohérence des exports et rapports avec les paiements partiels (CSV comptable, Rapports), puis acompte explicite si les retours le demandent.
3. Parcours du premier client : mesurer où l'inscription et la première facture bloquent, avant d'ajouter des fonctions.

**Hors périmètre tant que non justifié** : facturation électronique DGI (aucun texte d'application publié), stock avancé, ERP.

## 29/10/2026 : veille facturation électronique DGI

**Décision : rien à développer maintenant.** FacturaPro ne produit ni XML structuré, ni signature qualifiée, ni transmission à la DGI et ne doit donc pas se présenter comme « conforme facture électronique » (déjà interdit par `scripts/check-release.js`).

**Processus annoncé (modèle « clearance », sources : blogs d'éditeurs, pas la DGI)**
1. Le fournisseur émet une facture XML structurée (UBL 2.1 ou CII), avec l'ICE du vendeur et de l'acheteur.
2. Signature électronique (loi 43-20 ; Barid eSign cité). L'ordre exact par rapport à la soumission DGI diffère selon les sources : à confirmer.
3. Soumission à la plateforme de la DGI (réalisée par xHub, selon les sources).
4. La DGI valide et délivre un numéro de validation en temps réel.
5. Seule la facture validée est transmise au client ; elle n'a de valeur légale qu'après validation.

**Statut au 29/10/2026 (non vérifié auprès de la DGI)**
- Base légale citée : article 145 IX du CGI. Phase pilote depuis octobre 2025.
- Calendrier annoncé, sans texte publié : grandes entreprises en 2026, moyennes entreprises ensuite, PME et auto-entrepreneurs vers 2027, TPE après 2028.
- Décret d'application : non publié au Bulletin officiel en septembre 2026 (source Hisab). Seuils, dates et sanctions cités par les blogs : non sourcés.

**Condition de reprise** : publication du décret d'application ET de la spécification technique de l'API de la DGI. Avant cela, aucune estimation de coût fiable. À ce moment, évaluer : export XML, prestataire de signature, appel à l'API DGI, statut « validée » sur les factures.

**À vérifier à la source** : `tax.gov.ma` et le Bulletin officiel (ne pas se fier aux blogs d'éditeurs pour les dates).

Sources : https://hisab.ma/fr/docs/mandate-2026 ; https://experio.ma/facturation-electronique-maroc-2026-guide-conformite/
