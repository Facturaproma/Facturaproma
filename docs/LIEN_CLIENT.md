# Lien client : consultation d'une facture sans compte

**État : code prêt ; `sql/30_lien_client_facture.sql` NON appliqué en production** (hors `MANIFEST.json`). Application d'abord en préproduction, puis en production sur autorisation explicite du propriétaire.

## Ce que ça fait
- Dans la liste des factures : **⋯ Plus → 🔗 Lien client** (factures enregistrées seulement, ni brouillon ni avoir).
- L'application envoie au serveur une **copie** (société, client, lignes, totaux, reste à payer, RIB) : la même information que le PDF. Le serveur ne lit jamais les données de la société.
- Le client ouvre `facture.html?t=<jeton>` : consultation, bouton Imprimer / Enregistrer en PDF, RIB et référence de virement. Aucun compte, aucun cookie.
- Le propriétaire voit « Consulté N fois », copie le lien ou l'envoie par WhatsApp, peut le **désactiver** immédiatement.
- Rouvrir la fenêtre **actualise** la copie (même lien) : à faire après un paiement.

## Sécurité (ce qui a été testé, 44 tests SQL + 25 tests navigateur)
- Jeton de 256 bits (64 caractères hexadécimaux) ; jeton inconnu, expiré, révoqué ou mal formé : **même réponse vide** (aucune énumération).
- Table `invoice_shares` **fermée** (RLS active, aucune politique, aucun droit pour `anon`/`authenticated`). Quatre fonctions seulement ; **une seule est publique** : `get_shared_invoice(jeton)`, inscrite en liste blanche de l'audit `tests/sql/test_droits.sql`.
- Isolation stricte entre sociétés ; compte non confirmé refusé ; liste blanche des clés stockées ; 64 Ko maximum ; 500 liens actifs maximum par compte ; validité 60 jours par défaut (1 à 365).
- Page publique : contenu inséré en texte (jamais en HTML), CSP stricte, `noindex`, `no-referrer`, aucun appel vers un autre site que le serveur de données. Test avec un nom de client piégé (`<img onerror>`) : neutralisé.

## Limites connues (à décider)
- La copie n'est **pas** actualisée automatiquement après un paiement : rouvrir la fenêtre « Lien client » (ou renvoyer le lien).
- Pas de paiement en ligne (volontaire : pas de passerelle CMI/Stripe validée).
- Le lien n'est pas bloqué quand la licence est expirée (la création de lien n'est pas une écriture de données de facturation).
- **CNDP / confidentialité** : la copie contient nom, ICE et adresse du client final ; à mentionner dans `legal.html` (non modifié) après validation.
- Un jeton fuité donne accès à UNE facture jusqu'à désactivation ou expiration (comme tout lien partagé).

## Application en préproduction puis production
1. Exécuter `sql/30_lien_client_facture.sql` (réexécutable, aucune donnée existante modifiée).
2. Vérifier en lecture seule : table `invoice_shares` présente avec RLS ; 5 fonctions (`share_uid` non exécutable ; `get_shared_invoice` exécutable par `anon`) ; `anon` sans droit sur la table.
3. Déployer `facture.html` et `facture.js` (Pages) puis tester un lien réel sur téléphone.

## Retour arrière
```sql
DROP FUNCTION IF EXISTS public.get_shared_invoice(TEXT), public.share_invoice(TEXT, JSONB, INT), public.revoke_invoice_share(TEXT), public.my_invoice_shares(), public.share_uid();
DROP TABLE IF EXISTS public.invoice_shares;   -- supprime tous les liens existants
```
