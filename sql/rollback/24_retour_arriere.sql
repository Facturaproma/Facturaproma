-- ============================================================
-- FacturaPro — RETOUR ARRIÈRE de sql/24 (moindre privilège)
-- ============================================================
-- STATUT : PRÉPARÉ, NON EXÉCUTÉ. Ne sert qu'à annuler sql/24 si un effet indésirable est constaté.
--
-- CE QU'IL FAIT
--   Rend à anon/authenticated EXACTEMENT les privilèges que sql/24 a retirés, ni plus ni moins,
--   en relisant public._fp_acl_backup_24 (photo prise par sql/24 juste avant chaque REVOKE).
--
-- LIMITES — À LIRE AVANT USAGE
--   1. Il dépend de public._fp_acl_backup_24. Si cette table est absente ou vide, le script
--      s'arrête sans rien changer (il ne devine jamais une liste de droits).
--   2. Il restaure des droits de TABLE uniquement. Il ne couvre pas ce qui aurait été modifié
--      par d'autres scripts après sql/24.
--   3. Les GRANT sont ré-émis par l'utilisateur qui exécute (postgres dans le SQL Editor) ;
--      le « grantor » inscrit dans l'ACL est donc postgres, comme à l'origine.
--   4. N'efface pas la table de sauvegarde (supprimer à la main, seulement après validation).
--   5. Rétablir ces droits RÉOUVRE la surface (TRUNCATE hors RLS, accès anon à user_data) :
--      à n'utiliser que si une régression est démontrée et corrigée dès que possible.
--   6. Après exécution, sql/24 peut être relancé : il reprendra la photo initiale conservée
--      (ON CONFLICT DO NOTHING) puisque la table de sauvegarde n'est pas vidée.
--
-- VÉRIFICATIONS AVANT USAGE
--   a) SELECT count(*) FROM public._fp_acl_backup_24;   -- > 0
--   b) Comparer avec tests/sql/privileges_comparaison.sql (état actuel).
--   c) Prendre un export/sauvegarde si des droits ont changé depuis.
-- ============================================================
BEGIN;
DO $rb$
DECLARE r record; v_n int := 0;
BEGIN
    IF to_regclass('public._fp_acl_backup_24') IS NULL THEN
        RAISE EXCEPTION 'retour arrière : table de sauvegarde absente — rien n''a été changé';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public._fp_acl_backup_24) THEN
        RAISE EXCEPTION 'retour arrière : sauvegarde vide — rien à restaurer, rien n''a été changé';
    END IF;
    FOR r IN SELECT table_name, grantee, privilege FROM public._fp_acl_backup_24
             WHERE grantee IN ('anon','authenticated') ORDER BY 1,2,3 LOOP
        CONTINUE WHEN to_regclass('public.'||quote_ident(r.table_name)) IS NULL;
        EXECUTE format('GRANT %s ON TABLE public.%I TO %I', r.privilege, r.table_name, r.grantee);
        v_n := v_n + 1;
    END LOOP;
    RAISE NOTICE 'retour arrière : % privilège(s) restauré(s)', v_n;
END
$rb$;
COMMIT;
