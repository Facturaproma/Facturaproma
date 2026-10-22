# Procédure manuelle — SQL 14, SQL 18, update_updated_at (production)

Cible : projet **facturapro-prod** (ref `mdozjptoecygmpkjlohr`). Supabase → Dashboard → SQL Editor → New query.
Fichiers sources (identiques à ce qui a été testé) : `sql/14_numerotation_et_verrouillage.sql` (sha256 a5a48df0…), `sql/18_contact_public.sql` (sha256 cf512ada…).
Sauvegarde chiffrée disponible : workflow « Sauvegarde Supabase » du 22/10/2026 16:15 UTC (run 39812383230).

## 0. Avant de commencer (30 s)
Vérifier le nom du projet en haut à gauche = `facturapro-prod`. Exécuter :
```sql
select (select count(*) from public.user_data) as lignes,           -- attendu 47
       (select count(*) from pg_proc where proname='next_doc_number') as sql14,  -- attendu 0
       (select count(*) from pg_proc where proname='get_contact_info') as sql18;  -- attendu 0
```

## 1. SQL 14
Coller **tout** le contenu de `sql/14_numerotation_et_verrouillage.sql` → Run. Si Supabase affiche un avertissement « destructive operations » (il contient des `DROP POLICY/TRIGGER IF EXISTS` sur des objets qui n'existent pas encore), choisir « Run this query ».
Contrôle immédiat :
```sql
select (select count(*) from pg_class where relname in ('doc_counters','doc_events')) as tables,                 -- 2
       (select count(*) from pg_trigger where tgname like 'trg_guard_issued_invoices%' and not tgisinternal) as triggers, -- 3
       has_function_privilege('anon','public.next_doc_number(text,int)','EXECUTE') as anon,                     -- false
       has_function_privilege('authenticated','public.next_doc_number(text,int)','EXECUTE') as auth,            -- true
       (select count(*) from public.user_data) as lignes;                                                       -- 47
```
Si une valeur diffère : **ne pas continuer**, me prévenir. Retour arrière : voir `docs/RAPPORT_MIGRATIONS_PRODUCTION.md`.

## 2. SQL 18
Coller `sql/18_contact_public.sql` → Run. Contrôle :
```sql
select has_function_privilege('anon','public.get_contact_info()','EXECUTE') as anon,          -- false
       has_function_privilege('authenticated','public.get_contact_info()','EXECUTE') as auth;  -- true
```

## 3. Durcissement de update_updated_at
```sql
CREATE OR REPLACE FUNCTION update_updated_at() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql SET search_path = public;
```
Contrôle : `select proconfig from pg_proc where proname='update_updated_at';` → `{search_path=public}`.

## 4. Ensuite
Me dire « migrations appliquées ». Je rejoue les contrôles en lecture seule (`docs/VERIFICATIONS_POST_SQL14.sql`, blocs A et B), puis fusion en avance rapide dans `main`, déploiement GitHub Pages et vérifications post-déploiement.
Ne pas mettre `main` en ligne avant l'étape 1 : le nouveau front a besoin de `next_doc_number`.
