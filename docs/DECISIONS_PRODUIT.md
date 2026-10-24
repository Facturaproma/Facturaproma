# Décisions produit

## 24/10/2026 : stock, priorités

**Gestion de stock : pas maintenant.** L'application cible d'abord des auto-entrepreneurs, freelances et petites sociétés de services ; je n'ai aucune preuve chiffrée d'un besoin de stock chez les premiers clients (pas de retours utilisateurs structurés à ce jour). Un stock correct demande une migration de base, des règles sur les avoirs et les annulations et des tests anti-double-décrémentation : coût et risque supérieurs au bénéfice tant que la demande n'est pas démontrée. Les concurrents mettent le stock en avant, mais je n'ai pas pu examiner leurs applications connectées (seulement leur page publique).
Condition de reprise : au moins quelques demandes réelles de clients, ou un retour d'essai. Première version envisagée : produit « suivi en stock » optionnel, quantité, mouvements horodatés, décrément à l'émission de la facture, mouvement inverse par avoir, alerte de seuil. Aucun lot, entrepôt ni code-barres.

**Trois priorités (valeur / risque / effort)**
1. Paiements fiables (fait dans ce lot) : montants encaissés et restants cohérents partout, protection contre doubles enregistrements et trop-perçus.
2. Cohérence des exports et rapports avec les paiements partiels (CSV comptable, Rapports), puis acompte explicite si les retours le demandent.
3. Parcours du premier client : mesurer où l'inscription et la première facture bloquent, avant d'ajouter des fonctions.

**Hors périmètre tant que non justifié** : facturation électronique DGI (aucun texte d'application publié), stock avancé, ERP.
