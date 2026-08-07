-- CM Daily Log - draft / finalize lifecycle
--
-- The CM Daily Log (migration 0023) was create-once: a row existed and it was
-- "filed." The CM needs to build it up over the course of the day - save notes
-- and photos as they go - and then FINALIZE it as the official record for the
-- day. This adds the status lifecycle to support that:
--
--   status = 'draft'  -> editable; the CM can add/remove notes and photos.
--   status = 'final'  -> locked; editing is blocked until the log is reopened.
--
-- Any AHC-team member (phil / zarina / ahc_super) can reopen a finalized log
-- back to 'draft' - the same set already has full write access, so no new RLS
-- policy is needed here (the 0023 write policy covers updates).
--
-- Existing rows predate the draft concept: they were filed under the old
-- one-shot flow, so we backfill them to 'final'. New rows default to 'draft'.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx). Safe to re-run.

-- Add the columns (nullable first so we can backfill existing rows).
alter table public.cm_daily_logs
  add column if not exists status text,
  add column if not exists finalized_at timestamptz,
  add column if not exists updated_at timestamptz default now();

-- Existing logs were filed under the old create-once flow -> treat as final.
update public.cm_daily_logs set status = 'final' where status is null;

-- New logs start as editable drafts; enforce not-null now that rows are backfilled.
alter table public.cm_daily_logs alter column status set default 'draft';
alter table public.cm_daily_logs alter column status set not null;

-- Constrain to the two valid states (drop-then-add keeps this re-runnable).
alter table public.cm_daily_logs
  drop constraint if exists cm_daily_logs_status_chk;
alter table public.cm_daily_logs
  add constraint cm_daily_logs_status_chk check (status in ('draft', 'final'));

create index if not exists cm_daily_logs_status_idx
  on public.cm_daily_logs(project_id, status);
