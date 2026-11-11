-- ============================================================================================================
-- 48 — Comptes partagés : 1 compte = 1 entreprise = 1 espace de travail, plusieurs utilisateurs (étape T1)
-- ============================================================================================================
-- Dépend de : sql/06 (is_admin), sql/07 + sql/09 (licences, license_grace_days). À coller APRÈS sql/47.
--
-- STATUT : PRÉPARÉ, NON APPLIQUÉ EN PRODUCTION. Application soumise à l'accord du propriétaire (migration structurante).
--
-- CE QUE FAIT CE SCRIPT (ajout pur, aucune donnée existante modifiée, aucun écran changé)
--  * plan_catalog : grille de référence validée le 11/11/2026 (79 / 179 / 299 / 499 DH HT, 1 / 2 / 3 / 5 utilisateurs)
--    et formule « legacy » pour les clients actuels (droits actuels conservés, 1 utilisateur). L'application ne lit pas
--    encore cette table : les prix affichés et les licences en production ne changent pas.
--  * accounts, account_members, account_invitations, account_audit : le compte (l'entreprise), ses membres
--    (owner / admin / member, profil, actif ou désactivé), les invitations (jeton à usage unique, haché, 7 jours) et le journal.
--  * Fonctions : fp_my_account, fp_account_role, fp_account_can (rôles et permissions), account_ensure, account_info,
--    account_invite, account_invitation_revoke, account_accept_invitation, account_member_update, account_set_plan (admin
--    FacturaPro), fp_accounts_backfill (reprise : un compte par utilisateur existant, propriétaire, formule legacy).
--
-- CE QUE CE SCRIPT NE FAIT PAS (étapes suivantes, voir docs/COMPTES_ET_ABONNEMENTS.md)
--  * T2 : colonne account_id sur les tables métier ; T3 : clients/produits en tables (modifications simultanées) ;
--    T4 : fonctions serveur par compte + permissions ; T5 : RLS par compte ; T6 : écrans ; T7 : limites par formule.
--
-- RÈGLES
--  * Un utilisateur appartient à UN seul compte (index unique). Un compte a UN seul propriétaire (index unique partiel).
--  * Places utilisées = membres actifs + invitations en attente non expirées. Jamais plus que max_users de la formule.
--  * Tables FERMÉES (RLS sans politique, aucun droit direct) : lecture et écriture uniquement par les fonctions ci-dessous.
-- Réexécutable. RETOUR ARRIÈRE (après accord) : DROP des fonctions de ce script, puis des tables account_audit,
--   account_invitations, account_members, accounts, plan_catalog (aucune autre table n'en dépend à l'étape T1).
-- ============================================================================================================

DO $$ BEGIN
    IF to_regprocedure('public.is_admin()') IS NULL OR to_regclass('public.licenses') IS NULL
       OR to_regprocedure('public.license_grace_days()') IS NULL THEN
        RAISE EXCEPTION 'PREREQUIS_MANQUANT: sql/06, sql/07 et sql/09 doivent être appliqués avant sql/48';
    END IF;
END $$;

-- ---------- Grille de référence ----------
CREATE TABLE IF NOT EXISTS public.plan_catalog (
    key                  TEXT PRIMARY KEY CHECK (key IN ('essentielle', 'pro', 'business', 'premium', 'legacy')),
    label                TEXT NOT NULL,
    price_ht_month       NUMERIC(10,2),                       -- NULL : formule historique, prix inchangé
    months_paid_per_year INT NOT NULL DEFAULT 10 CHECK (months_paid_per_year BETWEEN 1 AND 12),
    max_users            INT NOT NULL CHECK (max_users BETWEEN 1 AND 50),
    features             TEXT[] NOT NULL,
    sort_order           INT NOT NULL DEFAULT 0
);
ALTER TABLE public.plan_catalog ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.plan_catalog FROM PUBLIC, anon, authenticated;

-- Fonctions par formule (cumulatives). Libellés et écrans correspondants : docs/COMPTES_ET_ABONNEMENTS.md
INSERT INTO public.plan_catalog (key, label, price_ht_month, max_users, sort_order, features) VALUES
 ('essentielle', 'Essentielle', 79, 1, 1, ARRAY['ventes', 'avoirs', 'clients_produits', 'paiements', 'pdf_partage', 'tableau_bord', 'tva_ventes', 'export_donnees']),
 ('pro',         'Pro',        179, 2, 2, ARRAY['ventes', 'avoirs', 'clients_produits', 'paiements', 'pdf_partage', 'tableau_bord', 'tva_ventes', 'export_donnees',
                                              'achats', 'tva_deductions', 'livraisons', 'stock', 'relances', 'statistiques']),
 ('business',    'Business',   299, 3, 3, ARRAY['ventes', 'avoirs', 'clients_produits', 'paiements', 'pdf_partage', 'tableau_bord', 'tva_ventes', 'export_donnees',
                                              'achats', 'tva_deductions', 'livraisons', 'stock', 'relances', 'statistiques',
                                              'exports_avances', 'pilotage', 'tresorerie', 'automatisations', 'cnss', 'cloture']),
 ('premium',     'Premium',    499, 5, 4, ARRAY['ventes', 'avoirs', 'clients_produits', 'paiements', 'pdf_partage', 'tableau_bord', 'tva_ventes', 'export_donnees',
                                              'achats', 'tva_deductions', 'livraisons', 'stock', 'relances', 'statistiques',
                                              'exports_avances', 'pilotage', 'tresorerie', 'automatisations', 'cnss', 'cloture',
                                              'rapports_avances', 'support_prioritaire']),
 -- Clients actuels (essai, mensuel, annuel, à vie, Fondateurs) : on leur a promis « tout illimité ». Rien n'est retiré.
 ('legacy',      'Formule actuelle', NULL, 1, 9, ARRAY['ventes', 'avoirs', 'clients_produits', 'paiements', 'pdf_partage', 'tableau_bord', 'tva_ventes', 'export_donnees',
                                              'achats', 'tva_deductions', 'livraisons', 'stock', 'relances', 'statistiques',
                                              'exports_avances', 'pilotage', 'tresorerie', 'automatisations', 'cnss', 'cloture'])
ON CONFLICT (key) DO NOTHING;      -- une grille déjà en place n'est jamais écrasée par une réexécution

-- ---------- Compte, membres, invitations, journal ----------
CREATE TABLE IF NOT EXISTS public.accounts (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,   -- T1 : aucune donnée métier rattachée encore
    name       TEXT NOT NULL DEFAULT '' CHECK (length(name) <= 200),
    plan_key   TEXT NOT NULL DEFAULT 'legacy' REFERENCES public.plan_catalog(key),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.account_members (
    account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    profile    TEXT NOT NULL DEFAULT 'complet' CHECK (profile IN ('complet', 'ventes', 'lecture')),
    status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    invited_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, user_id),
    CHECK (role <> 'owner' OR (status = 'active' AND profile = 'complet'))
);
CREATE UNIQUE INDEX IF NOT EXISTS account_members_one_account ON public.account_members (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS account_members_one_owner ON public.account_members (account_id) WHERE role = 'owner';
CREATE TABLE IF NOT EXISTS public.account_invitations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id  UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    email       TEXT NOT NULL CHECK (email = lower(btrim(email)) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    role        TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    profile     TEXT NOT NULL DEFAULT 'complet' CHECK (profile IN ('complet', 'ventes', 'lecture')),
    token_hash  TEXT NOT NULL UNIQUE,                     -- sha256 du jeton ; le jeton lui-même n'est jamais stocké
    created_by  UUID NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '7 days',
    accepted_at TIMESTAMPTZ, accepted_by UUID,
    revoked_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS account_invitations_account_idx ON public.account_invitations (account_id);
CREATE TABLE IF NOT EXISTS public.account_audit (
    id         BIGSERIAL PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    actor_id   UUID,
    action     TEXT NOT NULL,
    target     TEXT,
    detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
    at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_audit_account_idx ON public.account_audit (account_id, at DESC);

ALTER TABLE public.accounts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_members     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_audit       ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounts, public.account_members, public.account_invitations, public.account_audit FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.account_audit_id_seq FROM PUBLIC, anon, authenticated;

-- ---------- Identité et permissions ----------
-- Utilisateur connecté, e-mail confirmé (même règle que fin_uid)
CREATE OR REPLACE FUNCTION public.fp_acc_uid() RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
    SELECT u.id FROM auth.users u WHERE u.id = auth.uid() AND u.email_confirmed_at IS NOT NULL
$$;
-- Compte de l'utilisateur connecté (membre ACTIF uniquement). Base des futures politiques RLS : account_id = (SELECT fp_my_account())
CREATE OR REPLACE FUNCTION public.fp_my_account() RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
    SELECT m.account_id FROM public.account_members m WHERE m.user_id = public.fp_acc_uid() AND m.status = 'active'
$$;
CREATE OR REPLACE FUNCTION public.fp_account_role() RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
    SELECT m.role FROM public.account_members m WHERE m.user_id = public.fp_acc_uid() AND m.status = 'active'
$$;
-- Permissions : owner et admin font tout, sauf la gestion de l'abonnement et du propriétaire (owner seul).
-- member : profil « complet » (toute la gestion, sans réglages ni utilisateurs), « ventes » (devis, factures, clients,
-- encaissements, sans avoirs ni annulations), « lecture » (consultation et exports). La formule doit aussi inclure la fonction.
CREATE OR REPLACE FUNCTION public.fp_account_can(p_perm TEXT) RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE m public.account_members%ROWTYPE; v_plan TEXT[];
BEGIN
    SELECT * INTO m FROM public.account_members WHERE user_id = public.fp_acc_uid() AND status = 'active';
    IF NOT FOUND THEN RETURN FALSE; END IF;
    -- Fonction de la formule (les permissions de gestion du compte ne dépendent pas de la formule)
    IF p_perm NOT IN ('lire', 'ecrire_ventes', 'avoirs_annulations', 'parametres', 'utilisateurs', 'abonnement') THEN
        SELECT c.features INTO v_plan FROM public.accounts a JOIN public.plan_catalog c ON c.key = a.plan_key WHERE a.id = m.account_id;
        RETURN p_perm = ANY (COALESCE(v_plan, '{}'));
    END IF;
    IF p_perm = 'abonnement' THEN RETURN m.role = 'owner'; END IF;
    IF m.role IN ('owner', 'admin') THEN RETURN TRUE; END IF;
    RETURN CASE p_perm
        WHEN 'lire'               THEN TRUE
        WHEN 'ecrire_ventes'      THEN m.profile IN ('complet', 'ventes')
        WHEN 'avoirs_annulations' THEN m.profile = 'complet'
        ELSE FALSE END;          -- parametres, utilisateurs : owner et admin seulement
END; $$;

-- Licence d'un utilisateur, pour un contrôle interne (has_active_license ne répond qu'à propos de l'appelant)
CREATE OR REPLACE FUNCTION public.fp_license_ok(p_uid UUID) RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
    SELECT COALESCE(
        (SELECT l.status = 'active' AND (l.expires_at IS NULL OR l.expires_at
                 + CASE WHEN l.type = 'trial' THEN INTERVAL '0' ELSE make_interval(days => public.license_grace_days()) END > now())
           FROM public.licenses l WHERE l.user_id = p_uid),
        (SELECT u.created_at + INTERVAL '14 days' > now() OR EXISTS (SELECT 1 FROM public.admins a WHERE lower(a.email) = lower(u.email))
           FROM auth.users u WHERE u.id = p_uid),
        FALSE)
$$;

-- Places : membres actifs + invitations en attente (non acceptées, non révoquées, non expirées), sauf p_except
CREATE OR REPLACE FUNCTION public.fp_account_seats(p_account UUID, p_except UUID DEFAULT NULL)
RETURNS TABLE (used INT, max_users INT) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
    SELECT ((SELECT count(*) FROM public.account_members WHERE account_id = p_account AND status = 'active')
          + (SELECT count(*) FROM public.account_invitations WHERE account_id = p_account AND accepted_at IS NULL AND revoked_at IS NULL
                AND expires_at > now() AND id IS DISTINCT FROM p_except))::int,
           (SELECT c.max_users FROM public.accounts a JOIN public.plan_catalog c ON c.key = a.plan_key WHERE a.id = p_account)
$$;

CREATE OR REPLACE FUNCTION public.fp_account_log(p_account UUID, p_action TEXT, p_target TEXT, p_detail JSONB DEFAULT '{}'::jsonb)
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = public, auth AS $$
    INSERT INTO public.account_audit (account_id, actor_id, action, target, detail) VALUES (p_account, auth.uid(), p_action, p_target, COALESCE(p_detail, '{}'::jsonb))
$$;

-- ---------- Création et lecture ----------
-- Premier accès : crée le compte de l'utilisateur s'il n'appartient à aucun compte (propriétaire, formule legacy).
-- Un invité doit accepter son invitation AVANT ce premier appel (l'écran le garantit en T6).
CREATE OR REPLACE FUNCTION public.account_ensure(p_name TEXT DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fp_acc_uid(); v_acc UUID;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('fp_account:' || v::text, 0));
    SELECT account_id INTO v_acc FROM public.account_members WHERE user_id = v;
    IF FOUND THEN RETURN jsonb_build_object('account_id', v_acc, 'created', false); END IF;
    INSERT INTO public.accounts (owner_id, name) VALUES (v, left(COALESCE(btrim(p_name), ''), 200)) RETURNING id INTO v_acc;
    INSERT INTO public.account_members (account_id, user_id, role) VALUES (v_acc, v, 'owner');
    PERFORM public.fp_account_log(v_acc, 'compte_cree', v::text);
    RETURN jsonb_build_object('account_id', v_acc, 'created', true);
END; $$;

-- Mon compte : formule, places, mon rôle ; la liste des membres et des invitations pour owner et admin
CREATE OR REPLACE FUNCTION public.account_info() RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fp_acc_uid(); m public.account_members%ROWTYPE; a public.accounts%ROWTYPE; s RECORD; v_mgr BOOLEAN;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    SELECT * INTO m FROM public.account_members WHERE user_id = v AND status = 'active';
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT * INTO a FROM public.accounts WHERE id = m.account_id;
    SELECT * INTO s FROM public.fp_account_seats(a.id);
    v_mgr := m.role IN ('owner', 'admin');
    RETURN jsonb_build_object(
        'account_id', a.id, 'name', a.name, 'plan', a.plan_key, 'role', m.role, 'profile', m.profile,
        'seats_used', s.used, 'seats_max', s.max_users,
        'members', (SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id', x.user_id, 'email', u.email, 'role', x.role, 'profile', x.profile, 'status', x.status)
                                    ORDER BY (x.role = 'owner') DESC, x.created_at), '[]'::jsonb)
                      FROM public.account_members x JOIN auth.users u ON u.id = x.user_id
                     WHERE x.account_id = a.id AND (v_mgr OR x.status = 'active')),
        'invitations', CASE WHEN v_mgr THEN (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', i.id, 'email', i.email, 'role', i.role, 'profile', i.profile, 'expires_at', i.expires_at)
                                    ORDER BY i.created_at), '[]'::jsonb)
                      FROM public.account_invitations i WHERE i.account_id = a.id AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now())
                      ELSE '[]'::jsonb END);
END; $$;

-- ---------- Invitations ----------
-- Renvoie le jeton UNE seule fois (à transmettre par lien) ; seul son sha256 est conservé.
CREATE OR REPLACE FUNCTION public.account_invite(p_email TEXT, p_role TEXT DEFAULT 'member', p_profile TEXT DEFAULT 'complet') RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fp_acc_uid(); m public.account_members%ROWTYPE; a public.accounts%ROWTYPE; s RECORD;
        v_email TEXT := lower(btrim(COALESCE(p_email, ''))); v_token TEXT; v_id UUID; v_exp TIMESTAMPTZ;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    SELECT * INTO m FROM public.account_members WHERE user_id = v AND status = 'active';
    IF NOT FOUND OR m.role NOT IN ('owner', 'admin') THEN RAISE EXCEPTION 'DROIT_INSUFFISANT' USING ERRCODE = '42501'; END IF;
    IF p_role NOT IN ('admin', 'member') THEN RAISE EXCEPTION 'ROLE_INVALIDE'; END IF;
    IF p_role = 'admin' AND m.role <> 'owner' THEN RAISE EXCEPTION 'DROIT_INSUFFISANT' USING ERRCODE = '42501'; END IF;
    IF p_profile NOT IN ('complet', 'ventes', 'lecture') THEN RAISE EXCEPTION 'PROFIL_INVALIDE'; END IF;
    IF v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' OR length(v_email) > 254 THEN RAISE EXCEPTION 'EMAIL_INVALIDE'; END IF;
    SELECT * INTO a FROM public.accounts WHERE id = m.account_id FOR UPDATE;      -- sérialise les invitations d'un même compte
    IF NOT public.fp_license_ok(a.owner_id) THEN RAISE EXCEPTION 'LICENCE_INACTIVE'; END IF;
    IF EXISTS (SELECT 1 FROM public.account_members x JOIN auth.users u ON u.id = x.user_id WHERE x.account_id = a.id AND lower(u.email) = v_email) THEN
        RAISE EXCEPTION 'DEJA_MEMBRE'; END IF;
    IF EXISTS (SELECT 1 FROM public.account_invitations WHERE account_id = a.id AND email = v_email AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()) THEN
        RAISE EXCEPTION 'INVITATION_EN_COURS'; END IF;
    SELECT * INTO s FROM public.fp_account_seats(a.id);
    IF s.used >= s.max_users THEN RAISE EXCEPTION 'LIMITE_UTILISATEURS: % sur %', s.used, s.max_users; END IF;
    v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
    INSERT INTO public.account_invitations (account_id, email, role, profile, token_hash, created_by)
    VALUES (a.id, v_email, p_role, p_profile, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), v)
    RETURNING id, expires_at INTO v_id, v_exp;
    PERFORM public.fp_account_log(a.id, 'invitation', v_email, jsonb_build_object('role', p_role, 'profil', p_profile));
    RETURN jsonb_build_object('id', v_id, 'token', v_token, 'expires_at', v_exp);
END; $$;

CREATE OR REPLACE FUNCTION public.account_invitation_revoke(p_id UUID) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fp_acc_uid(); m public.account_members%ROWTYPE; i public.account_invitations%ROWTYPE;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    SELECT * INTO m FROM public.account_members WHERE user_id = v AND status = 'active';
    IF NOT FOUND OR m.role NOT IN ('owner', 'admin') THEN RAISE EXCEPTION 'DROIT_INSUFFISANT' USING ERRCODE = '42501'; END IF;
    SELECT * INTO i FROM public.account_invitations WHERE id = p_id AND account_id = m.account_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVITATION_INTROUVABLE'; END IF;
    IF i.accepted_at IS NOT NULL THEN RAISE EXCEPTION 'INVITATION_DEJA_ACCEPTEE'; END IF;
    UPDATE public.account_invitations SET revoked_at = COALESCE(revoked_at, now()) WHERE id = i.id;
    PERFORM public.fp_account_log(m.account_id, 'invitation_annulee', i.email);
    RETURN jsonb_build_object('id', i.id, 'revoked', true);
END; $$;

-- L'invité, connecté avec l'adresse invitée (e-mail confirmé), accepte. Il ne doit appartenir à aucun compte.
CREATE OR REPLACE FUNCTION public.account_accept_invitation(p_token TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fp_acc_uid(); v_email TEXT; i public.account_invitations%ROWTYPE; s RECORD;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    SELECT lower(email) INTO v_email FROM auth.users WHERE id = v;
    SELECT * INTO i FROM public.account_invitations
     WHERE token_hash = encode(sha256(convert_to(COALESCE(p_token, ''), 'UTF8')), 'hex') FOR UPDATE;
    -- Même message pour un jeton inconnu, expiré, annulé, déjà utilisé ou destiné à une autre adresse : rien n'est révélé
    IF NOT FOUND OR i.accepted_at IS NOT NULL OR i.revoked_at IS NOT NULL OR i.expires_at <= now() OR i.email <> v_email THEN
        RAISE EXCEPTION 'INVITATION_INVALIDE'; END IF;
    PERFORM 1 FROM public.accounts WHERE id = i.account_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM public.account_members WHERE user_id = v) THEN RAISE EXCEPTION 'DEJA_MEMBRE_D_UN_COMPTE'; END IF;
    SELECT * INTO s FROM public.fp_account_seats(i.account_id, i.id);
    IF s.used >= s.max_users THEN RAISE EXCEPTION 'LIMITE_UTILISATEURS: % sur %', s.used, s.max_users; END IF;
    INSERT INTO public.account_members (account_id, user_id, role, profile, invited_by) VALUES (i.account_id, v, i.role, i.profile, i.created_by);
    UPDATE public.account_invitations SET accepted_at = now(), accepted_by = v WHERE id = i.id;
    PERFORM public.fp_account_log(i.account_id, 'invitation_acceptee', v_email, jsonb_build_object('role', i.role, 'profil', i.profile));
    RETURN jsonb_build_object('account_id', i.account_id, 'role', i.role, 'profile', i.profile);
END; $$;

-- ---------- Gestion des membres ----------
-- Rôle, profil, désactivation / réactivation. Le propriétaire n'est jamais modifié ici ; un admin ne gère pas les autres admins.
CREATE OR REPLACE FUNCTION public.account_member_update(p_user UUID, p_role TEXT DEFAULT NULL, p_profile TEXT DEFAULT NULL, p_status TEXT DEFAULT NULL) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v UUID := public.fp_acc_uid(); me public.account_members%ROWTYPE; t public.account_members%ROWTYPE; s RECORD;
        n_role TEXT; n_profile TEXT; n_status TEXT;
BEGIN
    IF v IS NULL THEN RAISE EXCEPTION 'NON_AUTHENTIFIE' USING ERRCODE = '42501'; END IF;
    SELECT * INTO me FROM public.account_members WHERE user_id = v AND status = 'active';
    IF NOT FOUND OR me.role NOT IN ('owner', 'admin') THEN RAISE EXCEPTION 'DROIT_INSUFFISANT' USING ERRCODE = '42501'; END IF;
    PERFORM 1 FROM public.accounts WHERE id = me.account_id FOR UPDATE;
    SELECT * INTO t FROM public.account_members WHERE account_id = me.account_id AND user_id = p_user FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'MEMBRE_INTROUVABLE'; END IF;
    IF t.role = 'owner' THEN RAISE EXCEPTION 'PROPRIETAIRE_NON_MODIFIABLE'; END IF;
    IF me.role = 'admin' AND (t.role = 'admin' OR p_role = 'admin') THEN RAISE EXCEPTION 'DROIT_INSUFFISANT' USING ERRCODE = '42501'; END IF;
    n_role := COALESCE(p_role, t.role); n_profile := COALESCE(p_profile, t.profile); n_status := COALESCE(p_status, t.status);
    IF n_role NOT IN ('admin', 'member') THEN RAISE EXCEPTION 'ROLE_INVALIDE'; END IF;
    IF n_profile NOT IN ('complet', 'ventes', 'lecture') THEN RAISE EXCEPTION 'PROFIL_INVALIDE'; END IF;
    IF n_status NOT IN ('active', 'disabled') THEN RAISE EXCEPTION 'STATUT_INVALIDE'; END IF;
    IF t.status = 'disabled' AND n_status = 'active' THEN               -- réactiver reprend une place
        SELECT * INTO s FROM public.fp_account_seats(me.account_id);
        IF s.used >= s.max_users THEN RAISE EXCEPTION 'LIMITE_UTILISATEURS: % sur %', s.used, s.max_users; END IF;
    END IF;
    UPDATE public.account_members SET role = n_role, profile = n_profile, status = n_status, updated_at = now()
     WHERE account_id = t.account_id AND user_id = t.user_id;
    PERFORM public.fp_account_log(me.account_id, 'membre_modifie', p_user::text,
        jsonb_build_object('avant', jsonb_build_object('role', t.role, 'profil', t.profile, 'statut', t.status),
                           'apres', jsonb_build_object('role', n_role, 'profil', n_profile, 'statut', n_status)));
    RETURN jsonb_build_object('user_id', p_user, 'role', n_role, 'profile', n_profile, 'status', n_status);
END; $$;

-- ---------- Formule (administration FacturaPro) ----------
-- Passer à une formule plus petite est refusé tant que le compte a plus de places occupées que la nouvelle limite :
-- le propriétaire désactive d'abord des membres (aucune exclusion automatique, aucune donnée supprimée).
CREATE OR REPLACE FUNCTION public.account_set_plan(p_account UUID, p_plan TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE s RECORD; v_max INT; v_old TEXT;
BEGIN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'DROIT_INSUFFISANT' USING ERRCODE = '42501'; END IF;
    SELECT max_users INTO v_max FROM public.plan_catalog WHERE key = p_plan;
    IF NOT FOUND THEN RAISE EXCEPTION 'FORMULE_INCONNUE'; END IF;
    SELECT plan_key INTO v_old FROM public.accounts WHERE id = p_account FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'COMPTE_INTROUVABLE'; END IF;
    SELECT * INTO s FROM public.fp_account_seats(p_account);
    IF s.used > v_max THEN RAISE EXCEPTION 'TROP_D_UTILISATEURS_POUR_CETTE_FORMULE: % sur %', s.used, v_max; END IF;
    UPDATE public.accounts SET plan_key = p_plan, updated_at = now() WHERE id = p_account;
    PERFORM public.fp_account_log(p_account, 'formule', p_plan, jsonb_build_object('avant', v_old));
    RETURN jsonb_build_object('account_id', p_account, 'plan', p_plan);
END; $$;

-- ---------- Reprise des comptes existants ----------
-- Un compte par utilisateur existant qui n'en a pas : propriétaire, formule legacy, nom repris de la fiche société.
-- Réservé à l'exécution par le propriétaire du projet (éditeur SQL, workflow) : aucun droit pour anon / authenticated.
CREATE OR REPLACE FUNCTION public.fp_accounts_backfill() RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE u RECORD; v_acc UUID; n INT := 0; v_name TEXT;
BEGIN
    FOR u IN SELECT x.id FROM auth.users x WHERE NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.user_id = x.id) ORDER BY x.created_at LOOP
        v_name := NULL;
        IF to_regclass('public.user_data') IS NOT NULL THEN
            EXECUTE 'SELECT left(btrim(value->>''name''), 200) FROM public.user_data WHERE user_id = $1 AND key = ''company'' LIMIT 1' INTO v_name USING u.id;
        END IF;
        INSERT INTO public.accounts (owner_id, name) VALUES (u.id, COALESCE(v_name, '')) RETURNING id INTO v_acc;
        INSERT INTO public.account_members (account_id, user_id, role) VALUES (v_acc, u.id, 'owner');
        INSERT INTO public.account_audit (account_id, actor_id, action, target) VALUES (v_acc, NULL, 'reprise', u.id::text);
        n := n + 1;
    END LOOP;
    RETURN n;
END; $$;

-- ---------- Droits ----------
REVOKE ALL ON FUNCTION public.fp_acc_uid(), public.fp_license_ok(UUID), public.fp_account_seats(UUID, UUID),
                       public.fp_account_log(UUID, TEXT, TEXT, JSONB), public.fp_accounts_backfill() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fp_my_account(), public.fp_account_role(), public.fp_account_can(TEXT), public.account_ensure(TEXT),
                       public.account_info(), public.account_invite(TEXT, TEXT, TEXT), public.account_invitation_revoke(UUID),
                       public.account_accept_invitation(TEXT), public.account_member_update(UUID, TEXT, TEXT, TEXT),
                       public.account_set_plan(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fp_my_account(), public.fp_account_role(), public.fp_account_can(TEXT), public.account_ensure(TEXT),
                          public.account_info(), public.account_invite(TEXT, TEXT, TEXT), public.account_invitation_revoke(UUID),
                          public.account_accept_invitation(TEXT), public.account_member_update(UUID, TEXT, TEXT, TEXT),
                          public.account_set_plan(UUID, TEXT) TO authenticated;
