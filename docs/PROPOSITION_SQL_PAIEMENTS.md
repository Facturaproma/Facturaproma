# Proposition (NON appliquée) : contrôle du trop-perçu côté serveur

Constat (revue PR #58, 24/10/2026) : la protection contre trop-perçu, montant nul et facture soldée est faite dans le navigateur (`savePaymentOnce`). Côté serveur, `record_payment` (sql/15) est déjà rejouable (même identifiant de paiement = pas de doublon) et refuse montant ≤ 0 et brouillon, mais il ne refuse pas un cumul supérieur au TTC ni un paiement sur un avoir. Ce mode « documents » n'est actif que pour les comptes de test autorisés ; les autres comptes écrivent encore dans `user_data` (aucune protection serveur).

Proposition pour un futur `sql/25`, à tester d'abord en préproduction, jamais appliquée sans validation :

```sql
-- dans record_payment, après la lecture de la facture (FOR UPDATE) et le test de rejeu :
IF r.total_ttc <= 0 THEN RAISE EXCEPTION 'PAIEMENT_SUR_AVOIR'; END IF;
IF COALESCE((SELECT SUM(amount) FROM public.doc_payments WHERE user_id = v_uid AND invoice_id = p_invoice_id), 0)
   + COALESCE(public.fp_num(p_payment->>'amount'), 0) > r.total_ttc + 0.01
THEN RAISE EXCEPTION 'PAIEMENT_SUPERIEUR_AU_RESTE'; END IF;
```

Le verrou de ligne (`FOR UPDATE`) rend le contrôle sûr en cas de deux envois simultanés. Tests à ajouter : cumul exact accepté, dépassement refusé, rejeu avec le même identifiant sans erreur, paiement sur avoir refusé.
