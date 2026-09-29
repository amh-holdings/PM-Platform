-- APPLY THIS ONE FILE. Assembled 2026-09-29, evening.
--
-- Two migrations are outstanding. The earlier bundle
-- (_apply_outstanding_2026-09-29.sql) covered 0052, 0054, 0063, 0064, 0065 and
-- 0066 and those are all live; it never carried 0055, which is why that one is
-- still waiting. 0067 is new this evening.
--
--   0055  procurement_payments.side
--         One purchase order, two payment schedules: what we pay the vendor
--         and what we bill the owner are two agreements with two parties and
--         no reason to match. Existing rows are vendor rows, which is what
--         they have always been, so nothing moves on the day this runs.
--
--   0067  projects.billing_cutoff_day
--         A billing period closes on the contract's cutoff day. Sweet Springs
--         bills to the 20th, and the app assumed month end - which is why
--         September's Civil Work read 48.04% instead of 41.90%, and why
--         GroundWork's weather station, delivered on the 24th, read as earned
--         on an application that closed on the 20th.
--
-- Both are additive and safe to re-run. Nothing here drops a column, drops a
-- table, or deletes a row. Wrapped in one transaction, so either both land or
-- neither does.
--
-- HOW TO RUN
--   Supabase SQL Editor: open the project, paste this whole file, Run.
--
-- The verification queries at the bottom run after the commit. Read them.

begin;

-- ===========================================================================
-- 0055_payment_milestone_side.sql
-- ===========================================================================
alter table public.procurement_payments
  add column if not exists side text not null default 'vendor';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'procurement_payments_side_check'
  ) then
    alter table public.procurement_payments
      add constraint procurement_payments_side_check
      check (side in ('vendor', 'owner'));
  end if;
end $$;

comment on column public.procurement_payments.side is
  'vendor = what we pay the supplier, drives cash out. owner = what we bill the owner through the AFP. Independent of each other.';

-- Both sides are read per PO and filtered by side on every page that touches
-- them, so the index carries the column.
create index if not exists procurement_payments_order_side_idx
  on public.procurement_payments(procurement_order_id, side);

-- ===========================================================================
-- 0067_project_billing_cutoff_day.sql
-- ===========================================================================
alter table public.projects
  add column if not exists billing_cutoff_day smallint;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'projects_billing_cutoff_day_check'
  ) then
    alter table public.projects
      add constraint projects_billing_cutoff_day_check
      check (billing_cutoff_day is null or (billing_cutoff_day between 1 and 28));
  end if;
end $$;

comment on column public.projects.billing_cutoff_day is
  'Day of the month a billing period closes for EVIDENCE purposes. Null means '
  'the calendar month end. Does not change which month a billing entry sits in.';

-- Sweet Springs Solar bills to the 20th.
update public.projects
   set billing_cutoff_day = 20
 where id = '53cff193-21e4-45ff-833d-43813e8578a0'
   and billing_cutoff_day is distinct from 20;

commit;

-- PostgREST answers from a cached copy of the schema, so a new column stays
-- invisible to the app until that cache reloads. Supabase usually does it
-- within a minute; asking here means re-running this file is the fix.
notify pgrst, 'reload schema';

-- ===========================================================================
-- Verification. Both rows should come back filled in.
-- ===========================================================================
select name, billing_cutoff_day
  from public.projects
 where id = '53cff193-21e4-45ff-833d-43813e8578a0';
--   expect: Sweet Springs Solar | 20

select side, count(*) as milestones
  from public.procurement_payments
 group by side;
--   expect: vendor | (every existing row)
