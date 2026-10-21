-- ============================================================
-- 11 - NETTOYAGE DES COMPTES DE TEST (avant l'ouverture des ventes)
-- ============================================================
-- À exécuter dans Supabase > SQL Editor, EN DEUX TEMPS. Ne pas tout lancer d'un coup.
--
-- TEMPS 1 : lance uniquement la requête « APERÇU » (bloc A), repère tes comptes de test.
-- TEMPS 2 : copie le bloc B dans une NOUVELLE requête, remplace la liste d'e-mails
--           par ceux à supprimer, relis-la deux fois, puis lance.
--
-- La suppression est DÉFINITIVE (compte, données, licence, codes, paiements enregistrés,
-- demandes). Elle ne touche jamais les comptes administrateurs.
-- Pense à faire une sauvegarde juste avant (Actions > Sauvegarde Supabase > Run workflow).
-- ============================================================


-- ============ BLOC A : APERÇU (lecture seule) ============
SELECT u.email,
       u.created_at::date              AS cree_le,
       l.type                          AS offre,
       l.expires_at::date              AS expire_le,
       (SELECT count(*) FROM public.admin_codes c WHERE lower(c.client_email) = lower(u.email))     AS codes,
       (SELECT count(*) FROM public.admin_payments p WHERE lower(p.client_email) = lower(u.email))  AS paiements,
       EXISTS (SELECT 1 FROM public.admins a WHERE lower(a.email) = lower(u.email))                 AS est_admin
  FROM auth.users u
  LEFT JOIN public.licenses l ON l.user_id = u.id
 ORDER BY u.created_at DESC;

-- E-mails présents seulement dans les codes / paiements / demandes (sans compte) :
SELECT DISTINCT lower(client_email) AS email_sans_compte, 'code' AS source
  FROM public.admin_codes
 WHERE lower(client_email) NOT IN (SELECT lower(email) FROM auth.users)
UNION
SELECT DISTINCT lower(client_email), 'paiement'
  FROM public.admin_payments
 WHERE lower(client_email) NOT IN (SELECT lower(email) FROM auth.users)
UNION
SELECT DISTINCT lower(client_email), 'demande'
  FROM public.subscription_requests
 WHERE lower(client_email) NOT IN (SELECT lower(email) FROM auth.users);


-- ============ BLOC B : SUPPRESSION (à copier dans une nouvelle requête) ============
-- Remplace la liste ci-dessous par les e-mails de TEST uniquement (minuscules).
/*
WITH cible AS (
    SELECT unnest(ARRAY[
        'exemple1@test.ma',
        'exemple2@test.com'
    ])::text AS email
),
-- Garde-fou : jamais un administrateur
cible_ok AS (
    SELECT lower(email) AS email FROM cible
     WHERE lower(email) NOT IN (SELECT lower(email) FROM public.admins)
),
comptes AS (
    SELECT id FROM auth.users WHERE lower(email) IN (SELECT email FROM cible_ok)
),
d_data  AS (DELETE FROM public.user_data           WHERE user_id IN (SELECT id FROM comptes) RETURNING 1),
d_lic   AS (DELETE FROM public.licenses            WHERE user_id IN (SELECT id FROM comptes) RETURNING 1),
d_att   AS (DELETE FROM public.code_attempts       WHERE user_id IN (SELECT id FROM comptes) RETURNING 1),
d_codes AS (DELETE FROM public.admin_codes         WHERE lower(client_email) IN (SELECT email FROM cible_ok) RETURNING 1),
d_pay   AS (DELETE FROM public.admin_payments      WHERE lower(client_email) IN (SELECT email FROM cible_ok) RETURNING 1),
d_req   AS (DELETE FROM public.subscription_requests WHERE lower(client_email) IN (SELECT email FROM cible_ok) RETURNING 1),
d_aud   AS (DELETE FROM public.admin_audit         WHERE lower(target_email) IN (SELECT email FROM cible_ok) RETURNING 1),
d_users AS (DELETE FROM auth.users                 WHERE id IN (SELECT id FROM comptes) RETURNING 1)
SELECT (SELECT count(*) FROM d_users) AS comptes_supprimes,
       (SELECT count(*) FROM d_data)  AS lignes_donnees,
       (SELECT count(*) FROM d_lic)   AS licences,
       (SELECT count(*) FROM d_codes) AS codes,
       (SELECT count(*) FROM d_pay)   AS paiements,
       (SELECT count(*) FROM d_req)   AS demandes,
       (SELECT count(*) FROM d_aud)   AS lignes_journal;
*/
-- (Retire les marqueurs /* et */ autour du bloc B dans ta nouvelle requête avant de lancer.)
