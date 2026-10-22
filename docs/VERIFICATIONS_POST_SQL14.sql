-- Vérifications immédiates après application du SQL 14 / 18 / update_updated_at en PRODUCTION
-- (lecture seule sauf le bloc C, qui s'exécute dans une transaction annulée).
-- Cible attendue : facturapro-prod (mdozjptoecygmpkjlohr).

-- A. Objets, droits, données (toutes les valeurs attendues sont indiquées)
select
  (select count(*) from pg_class where relname in ('doc_counters','doc_events'))                       as tables_14,        -- 2
  (select count(*) from pg_class where relname in ('doc_counters','doc_events') and relrowsecurity)    as tables_rls,       -- 2
  (select count(*) from pg_trigger where tgname like 'trg_guard_issued_invoices%' and not tgisinternal) as triggers_14,      -- 3
  (select count(*) from pg_proc where proname in ('next_doc_number','guard_issued_invoices','guard_issued_invoices_del','get_contact_info')) as fonctions, -- 4 (après 18)
  has_function_privilege('anon','public.next_doc_number(text,int)','EXECUTE')          as anon_next_doc,     -- false
  has_function_privilege('authenticated','public.next_doc_number(text,int)','EXECUTE') as auth_next_doc,     -- true
  has_function_privilege('anon','public.get_contact_info()','EXECUTE')                 as anon_contact,      -- false (après 18)
  has_function_privilege('authenticated','public.get_contact_info()','EXECUTE')        as auth_contact,      -- true  (après 18)
  has_function_privilege('authenticated','public.guard_issued_invoices()','EXECUTE')   as auth_guard,        -- false
  (select proconfig from pg_proc where proname='update_updated_at')                    as updated_at_cfg,    -- {search_path=public} (après durcissement)
  (select count(*) from public.user_data)                                              as user_data_rows,    -- 47
  (select count(*) from public.user_data d, jsonb_array_elements(case when jsonb_typeof(d.value)='array' then d.value else '[]'::jsonb end) e
     where d.key='invoices' and coalesce(e->>'status','draft')<>'draft')               as factures_emises;   -- 3

-- B. Aucune fonction SECURITY DEFINER exécutable par anon, hors liste connue (admin_payments_stamp: voir rapport)
select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and prosecdef and has_function_privilege('anon', p.oid, 'EXECUTE');

-- C. Test d'émission SOUS ROLLBACK : un compte de test éphémère, rien n'est conservé.
-- À exécuter en UNE requête. Chaque ligne « OK » est attendue ; une ligne « KO » ou une erreur = arrêt.
begin;
  insert into auth.users(id,email,created_at) values ('00000000-0000-4000-8000-0000000000aa','verif-sql14@test.invalid',now());
  set local role authenticated;
  select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000aa',true);
  do $$
  declare n int; ok boolean;
  begin
    n := public.next_doc_number('invoice',0);
    raise notice '% numéro serveur = %', case when n=1 then 'OK' else 'KO' end, n;
    insert into public.user_data(user_id,key,value) values ('00000000-0000-4000-8000-0000000000aa','invoices','[]'::jsonb);
    begin
      update public.user_data set value='[{"id":"x","number":"FAC-2026-0099","status":"sent","type":"invoice","totalTTC":120}]'::jsonb where key='invoices';
      raise notice 'KO numéro non attribué accepté';
    exception when others then raise notice 'OK numéro non attribué refusé (%)', left(sqlerrm,22); end;
    update public.user_data set value='[{"id":"x","number":"FAC-2026-0001","status":"sent","type":"invoice","totalTTC":120,"paidAmount":0}]'::jsonb where key='invoices';
    raise notice 'OK émission avec numéro serveur acceptée';
    begin
      update public.user_data set value=jsonb_set(value,'{0,totalTTC}','999') where key='invoices';
      raise notice 'KO modification acceptée';
    exception when others then raise notice 'OK modification refusée (%)', left(sqlerrm,22); end;
    update public.user_data set value=jsonb_set(value,'{0,paidAmount}','120') where key='invoices';
    raise notice 'OK paiement sur facture émise accepté';
    begin
      delete from public.user_data where key='invoices';
      raise notice 'KO suppression acceptée';
    exception when others then raise notice 'OK suppression refusée (%)', left(sqlerrm,22); end;
    raise notice '% journal serveur : % événement(s)', case when (select count(*) from public.doc_events)>=1 then 'OK' else 'KO' end, (select count(*) from public.doc_events);
  end $$;
rollback;
