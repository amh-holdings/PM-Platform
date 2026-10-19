-- 0078_sub_pay_app_number_reuse.sql
--
-- A rejected subcontractor application does not consume its number.
--
-- Pyramid billed application 3, AHC rejected it, Pyramid revised and sent it
-- back. The app recorded the resubmission as application 4, because 0038 put
-- a plain unique key on (subcontractor_id, app_number) and the code numbered
-- off the highest row on file. Our records then said 4 while Pyramid's G702,
-- their lien waiver and their ledger all said 3.
--
-- Zarina: "I rejected the previous pay app 3, the new approved should still
-- be pay app 3."
--
-- Two changes, both additive in effect. Nothing is deleted and no amount
-- moves.
--
--   1. The unique key becomes partial: one LIVE application per number, any
--      number of rejected ones alongside it. Rejected rows stay on file, keep
--      their number, and the bill list marks them superseded.
--
--   2. v_sub_billing_summary stops reading billed-to-date off a rejected
--      application. max(billed_to_date) had no status filter, so Pyramid's
--      rejected app 3 was reporting 326,390.50 billed to date against the
--      310,236.89 actually on record. apps_received likewise counted a
--      refused bill as an application received; with numbers now reused, the
--      count has to match the application numbers or it reads as one too
--      many.
--
-- Safe to re-run. Run this BEFORE db/queries/pyramid_renumber_app4_to_3.sql,
-- which cannot renumber 4 back to 3 while the old unique key is in place.
--
-- HOW TO RUN
--   Supabase SQL Editor: open the project, paste this whole file, Run.

begin;

-- ---------------------------------------------------------------------------
-- 1. One LIVE application per number
-- ---------------------------------------------------------------------------
-- The constraint name is whatever Postgres generated for the inline unique in
-- 0038, so it is looked up by its columns rather than assumed.
do $$
declare
  c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'sub_pay_apps'
      and con.contype = 'u'
      and (
        select array_agg(att.attname::text order by att.attname)
        from unnest(con.conkey) k
        join pg_attribute att
          on att.attrelid = con.conrelid and att.attnum = k
      ) = array['app_number','subcontractor_id']
  loop
    execute format('alter table public.sub_pay_apps drop constraint %I', c.conname);
  end loop;
end $$;

create unique index if not exists sub_pay_apps_live_app_number_key
  on public.sub_pay_apps (subcontractor_id, app_number)
  where status <> 'rejected';

comment on index public.sub_pay_apps_live_app_number_key is
  'One live application per number per sub. A rejected application keeps its '
  'number and the resubmission reuses it, which is how a G702 resubmission '
  'works everywhere except in our old unique key.';

-- ---------------------------------------------------------------------------
-- 2. Rejected bills stop counting in the rollup
-- ---------------------------------------------------------------------------
create or replace view public.v_sub_billing_summary as
select
  s.id                      as subcontractor_id,
  s.project_id,
  s.company_name,
  s.contract_value,
  s.retainage_pct,
  coalesce(sov.sov_total, 0)        as sov_total,
  coalesce(sov.line_count, 0)       as sov_line_count,
  coalesce(sov.unmapped_lines, 0)   as unmapped_lines,
  coalesce(a.apps_received, 0)      as apps_received,
  coalesce(a.billed_to_date, 0)     as billed_to_date,
  coalesce(a.approved_to_date, 0)   as approved_to_date,
  coalesce(a.paid_to_date, 0)       as paid_to_date,
  coalesce(a.retainage_held, 0)     as retainage_held,
  case when coalesce(s.contract_value, 0) > 0
       then round(coalesce(a.approved_to_date, 0) / s.contract_value, 4)
       else null end                as pct_approved
from public.subcontractors s
left join (
  select subcontractor_id,
         sum(scheduled_value) as sov_total,
         count(*)             as line_count,
         count(*) filter (where verification_method = 'unmapped') as unmapped_lines
  from public.sub_sov_lines
  where active
  group by subcontractor_id
) sov on sov.subcontractor_id = s.id
left join (
  select subcontractor_id,
         -- Both of these now exclude rejected applications. The two sums
         -- below already did, through their own filters.
         count(*) filter (where status <> 'rejected')      as apps_received,
         max(billed_to_date) filter (where status <> 'rejected') as billed_to_date,
         sum(coalesce(approved_this_period, 0))
           filter (where status in ('approved','paid')) as approved_to_date,
         sum(coalesce(approved_amount_due, amount_due))
           filter (where status = 'paid') as paid_to_date,
         sum(coalesce(approved_retainage, retainage_this_period))
           filter (where status in ('approved','paid')) as retainage_held
  from public.sub_pay_apps
  group by subcontractor_id
) a on a.subcontractor_id = s.id;

commit;

-- ---------------------------------------------------------------------------
-- VERIFY (runs after the commit - read these)
-- ---------------------------------------------------------------------------

-- The new index exists and the old constraint is gone.
select
  (select count(*) from pg_indexes
    where schemaname = 'public' and indexname = 'sub_pay_apps_live_app_number_key') as partial_index,
  (select count(*) from pg_constraint con
     join pg_class rel on rel.oid = con.conrelid
    where rel.relname = 'sub_pay_apps' and con.contype = 'u') as unique_constraints_left;

-- Any sub whose numbers now have a gap, which is where a rejected
-- application is still waiting to be replaced.
select s.company_name,
       a.app_number,
       a.status,
       a.invoice_number,
       a.period_end
from public.sub_pay_apps a
join public.subcontractors s on s.id = a.subcontractor_id
where a.status = 'rejected'
order by s.company_name, a.app_number;
