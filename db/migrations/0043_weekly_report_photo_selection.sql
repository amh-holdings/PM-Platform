-- 0043_weekly_report_photo_selection.sql
--
-- Which photos go on the weekly report.
--
-- The photo page shipped reading `public.photos`, the table migration 0014
-- created for an in-DPR uploader. That table has never held a row on any
-- project. The photos that exist are in two other places, written by the two
-- features people actually use:
--
--   inspection_photos    -> bucket `inspection-photos`, keyed to an inspection
--   cm_daily_log_photos  -> bucket `dpr-photos`, keyed to a CM daily log
--
-- On Sweet Springs one week holds 64 of them (47 CM log, 17 inspection). That
-- is far too many to put in front of the owner, and picking the first eight by
-- timestamp is not a selection - it is whatever got uploaded on Monday. So the
-- report needs to remember a choice.
--
-- Shape: ["<table>:<id>", ...] e.g. ["insp:0a1d...","cmlog:2e3f..."].
-- An EMPTY array means "no choice made yet", and the report falls back to an
-- automatic spread across the days that have photos - so a week nobody curated
-- still prints something representative rather than nothing.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Additive and idempotent - safe to re-run.

alter table public.weekly_progress_reports
  add column if not exists photo_keys jsonb not null default '[]'::jsonb;

comment on column public.weekly_progress_reports.photo_keys is
  'Photos chosen for the report, as "<source>:<id>" handles. Empty array means no choice was made and the report falls back to an automatic spread across the period.';
