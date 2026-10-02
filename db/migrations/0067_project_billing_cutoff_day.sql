-- The day of the month a billing period closes.
--
-- Phil, on Sweet Springs: "The 20th is always the cut off date for billing."
--
-- The app assumed a period ran to the last day of its month, so opening the
-- Billing page on the 29th measured nine days of work that belong to the NEXT
-- application. On September's AFP that was the difference between Civil Work
-- at 41.90% and 48.04%, and it is what let GroundWork's weather station - typed
-- onto the application on the 20th, delivered on the 24th - read as earned when
-- the period it was billed in had already closed. Dimension asked why the POI
-- line said 66%; this is a large part of the answer.
--
-- EVIDENCE ONLY. This does not move money between applications. A billing entry
-- still sits in a whole month, keyed by period_month, and the G703 still names a
-- month. All this decides is the date progress is measured at: what had actually
-- happened by the time the period closed.
--
-- Null means the calendar month end, which is every project that has not been
-- told otherwise and is exactly the behaviour before this column existed.
--
-- Capped at 28 so the same day exists in February. A contract that genuinely
-- closes on the last day of the month wants null, not 31.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx). Safe to re-run.

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

-- PostgREST answers from a cached copy of the schema, so a new column is
-- invisible to the app until that cache reloads. Re-running this file is the fix.
notify pgrst, 'reload schema';

-- To check by hand:
--   select name, billing_cutoff_day from public.projects;
