-- APPLY THIS ONE FILE. Assembled 2026-10-19.
--
-- Zarina: "I rejected the previous pay app 3, the new approved should still
-- be pay app 3." Then: "Run migration."
--
-- This is migration 0078 and the Pyramid renumber in one paste, so there is
-- nothing to uncomment and nothing to run in the right order by hand. It is
-- ONE transaction: either all of it lands or none of it does.
--
--   1. The unique key on (subcontractor_id, app_number) becomes partial, so a
--      rejected application keeps its number and the resubmission reuses it.
--      A second LIVE application on one number is still refused.
--
--   2. v_sub_billing_summary stops reading billed-to-date and apps-received
--      off a rejected application. Pyramid was reporting 326,390.50 billed to
--      date against the 310,236.89 on record. approved_to_date and
--      paid_to_date already had their own filters and do not move.
--
--   3. Pyramid's approved September application, invoice 1407, is renumbered
--      from 4 to 3. app_number is a label: no amount, date, period, invoice
--      number or approval moves, and the rejected application stays on file
--      under its own 3, marked superseded in the bill list.
--
-- Step 3 is guarded. If the row it expects is not there exactly once, the
-- whole thing raises and rolls back, including steps 1 and 2, and nothing has
-- changed. Running it twice is safe: the second run finds no application 4,
-- reports that it has already been done, and leaves everything alone.
--
-- Nothing here drops a column, drops a table, or deletes a row.
--
-- HOW TO RUN
--   Supabase SQL Editor: open the project, paste this whole file, Run.
--   Or on the Mac Mini, with SUPABASE_DB_URL in .env.local:
--     psql "$SUPABASE_DB_URL" -f db/migrations/_apply_2026-10-19_pay_app_number.sql
--
-- The verification queries at the bottom run after the commit. Read them.
--
-- This file is not itself a migration. It is a convenience wrapper, which is
-- why it carries no number. 0078_sub_pay_app_number_reuse.sql and
-- db/queries/pyramid_renumber_app4_to_3.sql remain the record.

begin;

-- ===========================================================================
-- 1. One LIVE application per number
-- ===========================================================================
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

-- ===========================================================================
-- 2. Rejected bills stop counting in the rollup
-- ===========================================================================
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

-- ===========================================================================
-- 3. Pyramid's approved September application becomes 3
-- ===========================================================================
do $$
declare
  target uuid;
  n integer;
begin
  -- Counted first, then fetched. Postgres has no min() for uuid, so the two
  -- cannot be one statement, and counting first is what makes "exactly one"
  -- a precondition rather than something discovered halfway through.
  select count(*) into n
  from public.sub_pay_apps a
  join public.subcontractors s on s.id = a.subcontractor_id
  where s.company_name ilike '%pyramid%'
    and a.app_number = 4
    and a.status = 'approved'
    and a.invoice_number = '1407';

  if n = 0 then
    -- Already renumbered, or the row is not what we expected. Either way
    -- nothing is touched and steps 1 and 2 still stand.
    raise notice 'No Pyramid application 4 on invoice 1407 found. Nothing renumbered.';
    return;
  end if;

  if n > 1 then
    raise exception
      'Expected exactly 1 Pyramid application numbered 4 on invoice 1407, found %. Nothing changed.', n;
  end if;

  -- Refuse to collide with a live application already sitting on 3.
  if exists (
    select 1
    from public.sub_pay_apps a2
    join public.subcontractors s2 on s2.id = a2.subcontractor_id
    where s2.company_name ilike '%pyramid%'
      and a2.app_number = 3
      and a2.status <> 'rejected'
  ) then
    raise exception
      'Pyramid already has a live application 3. Nothing changed - send me what step 1 of the report shows.';
  end if;

  select a.id into target
  from public.sub_pay_apps a
  join public.subcontractors s on s.id = a.subcontractor_id
  where s.company_name ilike '%pyramid%'
    and a.app_number = 4
    and a.status = 'approved'
    and a.invoice_number = '1407';

  update public.sub_pay_apps set app_number = 3 where id = target;
  raise notice 'Pyramid invoice 1407 renumbered from application 4 to application 3.';
end $$;

commit;

-- ===========================================================================
-- VERIFY (runs after the commit - read these)
-- ===========================================================================

-- A. The partial index is in and the old constraint is gone.
select
  (select count(*) from pg_indexes
    where schemaname = 'public' and indexname = 'sub_pay_apps_live_app_number_key') as partial_index_present,
  (select count(*) from pg_constraint con
     join pg_class rel on rel.oid = con.conrelid
    where rel.relname = 'sub_pay_apps' and con.contype = 'u') as old_unique_constraints_left;
-- Expect 1 and 0.

-- B. Pyramid's applications. Two rows numbered 3, nothing numbered 4.
select a.app_number, a.status, a.invoice_number, a.period_start, a.period_end,
       a.billed_this_period, a.approved_this_period, a.approved_amount_due
from public.sub_pay_apps a
join public.subcontractors s on s.id = a.subcontractor_id
where s.company_name ilike '%pyramid%'
order by a.app_number, (a.status = 'rejected'), a.created_at;
-- Expect:
--   1  paid      1383   through 13 Aug   133,845.09
--   2  approved  1394   14 - 31 Aug      113,460.04
--   3  approved  1407    1 - 28 Sep       62,931.76
--   3  rejected  -       1 - 25 Sep       79,085.37

-- C. The rollup. Billed to date must now read 310,236.89, not 326,390.50,
--    and approved to date must be unchanged at 310,236.89.
select company_name, apps_received, billed_to_date, approved_to_date,
       paid_to_date, retainage_held
from public.v_sub_billing_summary
where company_name ilike '%pyramid%';

-- D. Any other sub carrying a rejected application nobody has replaced yet.
select s.company_name, a.app_number, a.status, a.period_end
from public.sub_pay_apps a
join public.subcontractors s on s.id = a.subcontractor_id
where a.status = 'rejected'
order by s.company_name, a.app_number;
