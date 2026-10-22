# Rapport ciblé — migrations de production (22/10/2026)

Cible vérifiée : projet Supabase `facturapro-prod` (`mdozjptoecygmpkjlohr`), 9 comptes, 47 lignes `user_data`, 4 lignes `invoices` dont 3 factures émises (numéros tous au format `...-NNNN`), 10 codes, 9 demandes, 0 réglage admin.
Contrôles en lecture seule uniquement ; aucune donnée lue n'a été modifiée.

## État réel constaté
| Script | État en production | Preuve |
|---|---|---|
| 07 | déjà en place | table `licenses`, policies `user_data` (4), 0 ligne `licenseInfo` |
| 09 | **appliqué le 22/10 (migration `09_periode_de_grace`)** | empreintes de `license_grace_days`, `my_license` identiques au dépôt ; `has_active_license` identique hors commentaires |
| 10 | **déjà en vigueur, rien à appliquer** | `activate_license`, `limit_subscription_requests`, `limit_user_data` : empreintes normalisées (sans commentaires ni espaces) identiques au dépôt ; déclencheurs `trg_limit_*` présents ; `code_attempts` sous RLS sans droit client. La tentative annulée n'a donc rien laissé de partiel. |
| 14 | **absent** | pas de `next_doc_number`, `doc_counters`, `doc_events`, `guard_issued_invoices*` |
| 18 | **absent** | pas de `get_contact_info` |
| `update_updated_at` durcie | **absente** | `proconfig` nul (pas de `search_path` figé) ; corps identique |

## À appliquer : 3 opérations
### 14 — numérotation serveur + verrouillage des factures émises
- Crée : tables `doc_counters`, `doc_events` (vides, RLS, lecture seule pour le propriétaire), fonctions `next_doc_number`, `guard_issued_invoices`, `guard_issued_invoices_del`, 3 déclencheurs sur `user_data` (clé `invoices`), index `doc_events_user_ts`. Retire l'EXECUTE des fonctions de déclencheur à `PUBLIC/anon/authenticated` (les déclencheurs continuent de fonctionner).
- Données supprimées/modifiées : **aucune**. Les 3 factures émises ne sont pas touchées ; elles deviennent simplement non modifiables ensuite (sauf le suivi de paiement, testé).
- Effet sur les licences : aucun. `next_doc_number` exige une licence active.
- Compatibilité : l'ancien front ne peut plus ÉMETTRE de facture après 14 (« NUMERO_NON_ATTRIBUE ») ; le nouveau front exige 14. Les deux doivent donc être mis en ligne à quelques minutes d'écart : SQL 14 puis fusion dans `main`. Risque limité : aucun client réel.
- Idempotent : oui (`IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP ... IF EXISTS` puis création).
- Retour arrière : `DROP TRIGGER IF EXISTS trg_guard_issued_invoices_ins, trg_guard_issued_invoices, trg_guard_issued_invoices_del ON public.user_data; DROP FUNCTION IF EXISTS public.guard_issued_invoices(), public.guard_issued_invoices_del(), public.next_doc_number(text,int); DROP TABLE IF EXISTS public.doc_events, public.doc_counters;` (ne supprime que des objets créés par 14 ; les compteurs/journaux émis entre-temps seraient perdus, d'où l'intérêt de ne pas attendre).
- Vérifications avant/après : `user_data` = 47 lignes, 3 factures émises identiques ; 3 déclencheurs présents ; `next_doc_number` non exécutable par `anon`.

### 18 — `get_contact_info()`
- Crée une fonction en lecture seule (WhatsApp + e-mail uniquement, jamais le RIB), exécutable par `authenticated` seulement. Aucune donnée touchée. Idempotent. Retour arrière : `DROP FUNCTION IF EXISTS public.get_contact_info();`

### `update_updated_at` durcie
- `CREATE OR REPLACE ... SET search_path = public` : même corps, aucun effet sur les données. Retour arrière : recréer sans `SET search_path`.

## Déploiement applicatif
Après 14/18 : fusion de `validation/integration-documents` dans `main` (GitHub Pages). `ops/preprod-ui.json` est à `idle`. Retour arrière applicatif : `git revert` du merge.
Le nouveau stockage (sql 15–17) reste verrouillé hors préprod : la production reste en mode historique.

## Reste à votre charge (ouverture commerciale, pas déploiement technique)
Réglages Admin (WhatsApp, e-mail, RIB réel, bénéficiaire, banque), 13 « [À compléter] » dans `legal.html`, validation comptable de la mention de TVA, CNDP, test d'inscription avec un vrai e-mail (hCaptcha + confirmation), plafond des 30 fondateurs encore côté client.
