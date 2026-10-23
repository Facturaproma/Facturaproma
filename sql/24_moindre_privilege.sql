-- ============================================================
-- FacturaPro — sql/24 : moindre privilège sur les tables (durcissement)
-- ============================================================
-- STATUT : PRÉPARÉ, NON EXÉCUTÉ. À lancer À LA MAIN dans le SQL Editor, d'abord en
--          PRÉPRODUCTION, puis en production seulement après accord écrit du propriétaire.
--
-- OBJET
--   Retirer des privilèges de TABLE qui ne servent à rien, par défense en profondeur.
--   (La RLS bloque déjà l'accès aux lignes ; TRUNCATE, lui, n'est PAS soumis à la RLS.)
--
--   A. rôle anon (visiteur non connecté) :
--        - user_data              : retire TOUS les privilèges
--        - doc_counters, doc_events : retire TOUS les privilèges
--   B. rôle authenticated (utilisateur connecté), sur chaque table existante de la liste :
--        retire TRUNCATE, REFERENCES, TRIGGER et MAINTAIN (PostgreSQL 17 seulement).
--
-- POURQUOI C'EST SANS RISQUE POUR L'APPLICATION (vérifié dans le code et le schéma)
--   - PostgREST (API Supabase) n'émet jamais TRUNCATE, ni de VACUUM/ANALYZE/REINDEX/LOCK.
--   - REFERENCES n'est requis que pour CRÉER une clé étrangère ; les vérifications de clés
--     étrangères à l'exécution s'effectuent avec les droits du propriétaire de la table.
--   - TRIGGER n'est requis que pour CRÉER un trigger ; l'exécution d'un trigger ne demande
--     aucun droit à l'utilisateur qui écrit. Les 2 triggers « INVOKER » (update_updated_at,
--     update_admin_updated_at) ne touchent que NEW : aucun privilège de table nécessaire.
--   - Toutes les autres fonctions du schéma sont SECURITY DEFINER (propriétaire postgres) :
--     elles n'utilisent pas les droits de anon/authenticated.
--   - Le front n'appelle jamais directement doc_counters/doc_events (RPC uniquement) ;
--     anon n'a aucune raison de lire user_data (les politiques exigent auth.uid()).
--
-- CE QUE CE SCRIPT NE FAIT PAS
--   - ne touche à AUCUNE politique RLS, ne désactive jamais la RLS ;
--   - ne modifie aucune donnée, ne supprime aucune table/fonction/colonne ;
--   - ne change aucun droit EXECUTE de fonction ; ne touche pas à service_role ;
--   - ne touche pas aux séquences ni aux droits SELECT/INSERT/UPDATE/DELETE de authenticated ;
--   - ne change pas les droits par défaut des futures tables (voir docs/SECURITE_PRIVILEGES.md).
--
-- NE SUPPOSE PAS QUE LES DEUX PROJETS SONT IDENTIQUES : chaque table est testée avec
-- to_regclass() ; une table absente (ex. doc_history en production) est ignorée.
--
-- RÉEXÉCUTABLE (idempotent) : une 2e exécution ne trouve plus rien à retirer et
-- conserve la sauvegarde initiale. Tout est dans une transaction : au moindre doute
-- (contrôle final en échec) tout est annulé.
--
-- SAUVEGARDE / RETOUR ARRIÈRE
--   Les privilèges réellement retirés sont d'abord copiés dans public._fp_acl_backup_24
--   (RLS activée, aucun droit client). Retour arrière : sql/rollback/24_retour_arriere.sql.
-- ============================================================

BEGIN;

-- 1. Table de sauvegarde (aucun accès client : RLS sans politique + REVOKE explicite)
CREATE TABLE IF NOT EXISTS public._fp_acl_backup_24 (
    table_name text        NOT NULL,
    grantee    text        NOT NULL,
    privilege  text        NOT NULL,
    taken_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (table_name, grantee, privilege)
);
ALTER TABLE public._fp_acl_backup_24 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public._fp_acl_backup_24 FROM PUBLIC, anon, authenticated;

DO $mig$
DECLARE
    v_all_privs    text[]  := ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']
                              || CASE WHEN current_setting('server_version_num')::int >= 170000
                                      THEN ARRAY['MAINTAIN'] ELSE ARRAY[]::text[] END;
    v_auth_privs   text[]  := ARRAY['TRUNCATE','REFERENCES','TRIGGER']
                              || CASE WHEN current_setting('server_version_num')::int >= 170000
                                      THEN ARRAY['MAINTAIN'] ELSE ARRAY[]::text[] END;
    v_anon_tables  text[]  := ARRAY['user_data','doc_counters','doc_events'];
    v_auth_tables  text[]  := ARRAY['admin_audit','admin_codes','admin_payments','admin_settings','admins',
                                    'doc_counters','doc_events','doc_history','doc_payments','documents',
                                    'licenses','staff','subscription_requests','user_data'];
    -- privilèges ESSENTIELS qui doivent rester intacts (contrôle avant/après)
    v_essential    text[]  := ARRAY[
        'user_data:SELECT','user_data:INSERT','user_data:UPDATE','user_data:DELETE',
        'admin_codes:SELECT','admin_codes:INSERT','admin_codes:UPDATE','admin_codes:DELETE',
        'admin_payments:SELECT','admin_payments:INSERT','admin_payments:UPDATE','admin_payments:DELETE',
        'admin_settings:SELECT','admin_settings:INSERT','admin_settings:UPDATE',
        'admins:SELECT','admins:INSERT','admins:UPDATE','admins:DELETE',
        'subscription_requests:SELECT','subscription_requests:INSERT','subscription_requests:UPDATE',
        'staff:SELECT','plans:SELECT','admin_audit:SELECT','licenses:SELECT',
        'doc_counters:SELECT','doc_events:SELECT',
        'doc_history:SELECT','doc_payments:SELECT','documents:SELECT'];
    v_ess_before   boolean[] := ARRAY[]::boolean[];
    v_ess_after    boolean[] := ARRAY[]::boolean[];
    v_t text; v_p text; v_e text; v_n int;
    v_removed int := 0;
BEGIN
    -- Garde-fous : les rôles doivent exister
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
       OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        RAISE EXCEPTION 'sql/24 : rôles anon/authenticated introuvables — script annulé';
    END IF;

    -- Photo « avant » des privilèges essentiels
    FOREACH v_e IN ARRAY v_essential LOOP
        v_t := split_part(v_e, ':', 1); v_p := split_part(v_e, ':', 2);
        v_ess_before := v_ess_before ||
            CASE WHEN to_regclass('public.'||quote_ident(v_t)) IS NULL THEN NULL
                 ELSE has_table_privilege('authenticated', 'public.'||quote_ident(v_t), v_p) END;
    END LOOP;

    -- A. anon : tout retirer sur user_data, doc_counters, doc_events
    FOREACH v_t IN ARRAY v_anon_tables LOOP
        CONTINUE WHEN to_regclass('public.'||quote_ident(v_t)) IS NULL;
        FOREACH v_p IN ARRAY v_all_privs LOOP
            -- uniquement les privilèges ACCORDÉS DIRECTEMENT à anon (pas via PUBLIC)
            IF EXISTS (
                SELECT 1 FROM pg_class c
                CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                WHERE c.oid = ('public.'||quote_ident(v_t))::regclass
                  AND a.grantee = 'anon'::regrole AND a.privilege_type = v_p) THEN
                INSERT INTO public._fp_acl_backup_24(table_name, grantee, privilege)
                VALUES (v_t, 'anon', v_p) ON CONFLICT DO NOTHING;
                EXECUTE format('REVOKE %s ON TABLE public.%I FROM anon', v_p, v_t);
                v_removed := v_removed + 1;
            END IF;
        END LOOP;
    END LOOP;

    -- B. authenticated : TRUNCATE / REFERENCES / TRIGGER / MAINTAIN
    FOREACH v_t IN ARRAY v_auth_tables LOOP
        CONTINUE WHEN to_regclass('public.'||quote_ident(v_t)) IS NULL;
        FOREACH v_p IN ARRAY v_auth_privs LOOP
            IF EXISTS (
                SELECT 1 FROM pg_class c
                CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                WHERE c.oid = ('public.'||quote_ident(v_t))::regclass
                  AND a.grantee = 'authenticated'::regrole AND a.privilege_type = v_p) THEN
                INSERT INTO public._fp_acl_backup_24(table_name, grantee, privilege)
                VALUES (v_t, 'authenticated', v_p) ON CONFLICT DO NOTHING;
                EXECUTE format('REVOKE %s ON TABLE public.%I FROM authenticated', v_p, v_t);
                v_removed := v_removed + 1;
            END IF;
        END LOOP;
    END LOOP;

    -- Contrôle 1 : plus aucun privilège ciblé
    SELECT count(*) INTO v_n
    FROM pg_class c
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
      AND ( (a.grantee = 'anon'::regrole AND c.relname = ANY (v_anon_tables))
         OR (a.grantee = 'authenticated'::regrole AND c.relname = ANY (v_auth_tables)
             AND a.privilege_type = ANY (v_auth_privs)) );
    IF v_n <> 0 THEN
        RAISE EXCEPTION 'sql/24 : % privilège(s) ciblé(s) subsistent — tout est annulé', v_n;
    END IF;

    -- Contrôle 2 : privilèges essentiels inchangés
    FOREACH v_e IN ARRAY v_essential LOOP
        v_t := split_part(v_e, ':', 1); v_p := split_part(v_e, ':', 2);
        v_ess_after := v_ess_after ||
            CASE WHEN to_regclass('public.'||quote_ident(v_t)) IS NULL THEN NULL
                 ELSE has_table_privilege('authenticated', 'public.'||quote_ident(v_t), v_p) END;
    END LOOP;
    IF v_ess_before IS DISTINCT FROM v_ess_after THEN
        RAISE EXCEPTION 'sql/24 : un privilège essentiel a changé — tout est annulé';
    END IF;

    -- Contrôle 3 : la RLS est toujours active sur les tables concernées
    IF EXISTS (SELECT 1 FROM pg_class
               WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
                 AND relname = ANY (v_auth_tables) AND NOT relrowsecurity) THEN
        RAISE EXCEPTION 'sql/24 : RLS désactivée sur une table concernée — tout est annulé';
    END IF;

    RAISE NOTICE 'sql/24 : % privilège(s) retiré(s) (0 = déjà appliqué)', v_removed;
END
$mig$;

COMMIT;

-- Vérification rapide (lecture seule) : doit renvoyer 0 ligne
-- SELECT * FROM public._fp_acl_backup_24 b WHERE has_table_privilege(b.grantee, 'public.'||quote_ident(b.table_name), b.privilege);
