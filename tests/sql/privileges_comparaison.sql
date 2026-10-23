-- LECTURE SEULE. À exécuter dans le SQL Editor AVANT puis APRÈS sql/24 (préproduction puis production),
-- et à comparer. Aucune écriture. Sans secret ni donnée client.

-- 1) Inventaire normalisé des privilèges de table pour anon / authenticated / PUBLIC (schéma public)
SELECT c.relname AS "table",
       CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS role,
       string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type) AS privileges
FROM pg_class c
CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
  AND (a.grantee = 0 OR a.grantee::regrole::text IN ('anon','authenticated'))
GROUP BY 1, 2 ORDER BY 1, 2;

-- 2) Synthèse : nombre de privilèges ciblés restants. ATTENDU APRÈS sql/24 : 0 partout.
SELECT 'anon sur user_data/doc_counters/doc_events' AS cible, count(*) AS restant
FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
WHERE c.relnamespace='public'::regnamespace AND c.relname IN ('user_data','doc_counters','doc_events')
  AND a.grantee = 'anon'::regrole
UNION ALL
SELECT 'authenticated : TRUNCATE/REFERENCES/TRIGGER/MAINTAIN', count(*)
FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'
  AND a.grantee = 'authenticated'::regrole
  AND a.privilege_type IN ('TRUNCATE','REFERENCES','TRIGGER','MAINTAIN');

-- 3) Rien ne doit être accordé à PUBLIC sur les tables. ATTENDU : 0
SELECT 'PUBLIC sur tables' AS controle, count(*) AS n
FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND a.grantee = 0;

-- 4) RLS toujours active partout. ATTENDU : 0 table sans RLS
SELECT 'tables sans RLS' AS controle, count(*) AS n
FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND NOT relrowsecurity;

-- 5) Politiques RLS : empreinte à comparer avant/après (doit être IDENTIQUE)
SELECT count(*) AS nb_politiques,
       md5(string_agg(tablename||'.'||policyname||'.'||cmd||'.'||coalesce(qual,'')||'.'||coalesce(with_check,''), '|' ORDER BY tablename, policyname)) AS empreinte
FROM pg_policies WHERE schemaname='public';

-- 6) Droits EXECUTE des fonctions : empreinte à comparer avant/après (doit être IDENTIQUE)
SELECT count(*) AS nb_fonctions,
       md5(string_agg(p.proname||pg_get_function_identity_arguments(p.oid)||':'||coalesce(p.proacl::text,'defaut'), '|' ORDER BY p.proname, pg_get_function_identity_arguments(p.oid))) AS empreinte
FROM pg_proc p WHERE p.pronamespace='public'::regnamespace;

-- 7) Nombre de lignes des tables sensibles : doit être IDENTIQUE avant/après (aucune donnée touchée)
SELECT 'user_data' t, count(*) FROM public.user_data UNION ALL SELECT 'licenses', count(*) FROM public.licenses
UNION ALL SELECT 'admin_codes', count(*) FROM public.admin_codes UNION ALL SELECT 'admins', count(*) FROM public.admins;
