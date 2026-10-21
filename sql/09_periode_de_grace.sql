-- ============================================================
-- 09 - PÉRIODE DE GRÂCE (3 jours après la fin d'un abonnement payant)
-- ============================================================
-- À exécuter dans Supabase > SQL Editor (nouvelle requête), APRÈS 07 et 08.
-- Idempotent. Pour changer la durée : modifier license_grace_days() ci-dessous.
--
--  * Abonnement payant (mensuel / annuel / fondateur...) : le compte reste
--    pleinement utilisable pendant 3 jours après la date de fin, puis passe
--    en lecture seule.
--  * Essai gratuit : pas de grâce (fin stricte au 14e jour).
--  * Compte suspendu : aucune grâce.
-- ============================================================

CREATE OR REPLACE FUNCTION public.license_grace_days()
RETURNS INT
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$ SELECT 3 $$;

REVOKE ALL ON FUNCTION public.license_grace_days() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.license_grace_days() TO authenticated;

CREATE OR REPLACE FUNCTION public.has_active_license(p_uid UUID DEFAULT auth.uid())
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
    SELECT COALESCE(
        (SELECT l.status = 'active'
                AND (l.expires_at IS NULL
                     OR l.expires_at
                        + CASE WHEN l.type = 'trial' THEN INTERVAL '0'
                               ELSE make_interval(days => public.license_grace_days()) END
                        > NOW())
           FROM public.licenses l
          WHERE l.user_id = p_uid),
        (SELECT u.created_at + INTERVAL '14 days' > NOW()
                OR EXISTS (SELECT 1 FROM public.admins a WHERE lower(a.email) = lower(u.email))
           FROM auth.users u
          WHERE u.id = p_uid),
        FALSE
    );
$$;

REVOKE ALL ON FUNCTION public.has_active_license(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_active_license(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.my_license()
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_row public.licenses%ROWTYPE;
    v_grace TIMESTAMPTZ;
BEGIN
    IF v_uid IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
    END IF;

    INSERT INTO public.licenses (user_id, type, started_at, expires_at)
    SELECT u.id,
           CASE WHEN EXISTS (SELECT 1 FROM public.admins a WHERE lower(a.email) = lower(u.email))
                THEN 'lifetime' ELSE 'trial' END,
           u.created_at,
           CASE WHEN EXISTS (SELECT 1 FROM public.admins a WHERE lower(a.email) = lower(u.email))
                THEN NULL ELSE u.created_at + INTERVAL '14 days' END
      FROM auth.users u
     WHERE u.id = v_uid
    ON CONFLICT (user_id) DO NOTHING;

    SELECT * INTO v_row FROM public.licenses WHERE user_id = v_uid;

    v_grace := CASE WHEN v_row.status = 'active'
                         AND v_row.type <> 'trial'
                         AND v_row.expires_at IS NOT NULL
                    THEN v_row.expires_at + make_interval(days => public.license_grace_days())
               END;

    RETURN jsonb_build_object(
        'ok',          true,
        'type',        v_row.type,
        'status',      v_row.status,
        'started_at',  v_row.started_at,
        'expires_at',  v_row.expires_at,
        'grace_until', v_grace,
        'active',      public.has_active_license(v_uid),
        'server_now',  NOW()
    );
END;
$$;

REVOKE ALL ON FUNCTION public.my_license() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_license() TO authenticated;

SELECT 'grâce (jours)' AS check, public.license_grace_days()::text AS result;
