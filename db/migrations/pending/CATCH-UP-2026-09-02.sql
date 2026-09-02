-- =========================================================================
-- CATCH-UP BUNDLE - run this once in the Supabase SQL Editor
-- Project: sksfyygufnnbzrmneccx
--
-- Probed live on 2026-09-02 with scripts/verify-migrations-live.mjs. Every
-- other migration through 0044 is already applied. These three are not.
--
-- Every statement below is idempotent. Running the whole file twice is safe.
-- Run it as ONE paste, top to bottom - the order matters only in that 0043
-- must land before anyone saves a photo choice.
-- =========================================================================


-- -------------------------------------------------------------------------
-- 1 of 3   0043_weekly_report_photo_selection
--
-- The urgent one. Its absence is not limited to photos: photo_keys was being
-- selected in the same breath as 0042's columns, so the whole group was
-- dropped and Safety, Project position and the photo note silently would not
-- save. The code fix for that is deploying alongside this; the column still
-- has to exist before a photo choice can be remembered.
-- -------------------------------------------------------------------------
alter table public.weekly_progress_reports
  add column if not exists photo_keys jsonb not null default '[]'::jsonb;

comment on column public.weekly_progress_reports.photo_keys is
  'Photos chosen for the report, as "<source>:<id>" handles. Empty array means no choice was made and the report falls back to an automatic spread across the period.';


-- -------------------------------------------------------------------------
-- 2 of 3   0044_production_no_confirmation_gate
--
-- 5 daily_production rows are sitting unconfirmed right now. Each one is
-- production from a Field Report a CM already approved, and every one of them
-- currently reads as ZERO to billing and to the owner's weekly report. This
-- statement brings them live.
-- -------------------------------------------------------------------------
update public.daily_production
   set confirmed_at = coalesce(updated_at, created_at, now())
 where confirmed_at is null;

-- The partial index existed to answer "what is waiting on Phil". Nothing waits
-- on Phil any more, so it indexes an empty set on every project forever.
drop index if exists public.daily_production_unconfirmed_idx;

-- -------------------------------------------------------------------------
-- 3 of 3   0029_sub_read_schedule_and_subs
--
-- Could not be probed from here - RLS policies leave nothing PostgREST can
-- see - so this may already be live. It drops and recreates its own policies,
-- so running it again changes nothing. Without it a sub opens the Field Report
-- form to two empty dropdowns and cannot file.
-- -------------------------------------------------------------------------
-- Subs can read schedule tasks (the WBS list) for their own project(s).
drop policy if exists "sub_read_schedule" on public.schedule_tasks;
create policy "sub_read_schedule" on public.schedule_tasks
  for select to authenticated
  using (
    public.current_user_role() in ('sub_pm', 'sub_foreman')
    and project_id in (
      select s.project_id
      from public.subcontractors s
      join public.profiles p on p.subcontractor_id = s.id
      where p.id = auth.uid()
    )
  );

-- Subs can read only their OWN subcontractor row (so the "filing this report"
-- dropdown resolves to their company, without exposing other subs on the job).
drop policy if exists "sub_read_own_subcontractor" on public.subcontractors;
create policy "sub_read_own_subcontractor" on public.subcontractors
  for select to authenticated
  using (
    public.current_user_role() in ('sub_pm', 'sub_foreman')
    and id in (
      select subcontractor_id
      from public.profiles
      where id = auth.uid()
    )
  );


-- =========================================================================
-- AFTER RUNNING, expect:
--   select count(*) from public.daily_production where confirmed_at is null;
--     -> 0
--   select photo_keys from public.weekly_progress_reports limit 1;
--     -> no error (the column exists)
-- Or from the repo:  node scripts/verify-migrations-live.mjs
-- =========================================================================
