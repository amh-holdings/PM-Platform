-- 0042_weekly_report_safety_and_photos.sql
--
-- Three more override columns on the weekly progress report.
--
-- SAFETY is being split out of Security. The no-concerns sentence the report
-- generated claimed "no security concerns, unauthorized access issues, or
-- safety incidents" - one sentence answering three different questions, and a
-- recordable injury reported inside the Security box is filed where nobody
-- looks for it. Security and safety are now derived separately and print as
-- separate rows, so this is the override box for the safety one.
--
-- PHOTOS: Dimension's form asks for them in its own footer ("Include clear
-- photos attached to this report in 8.5x11 format") and the platform has been
-- holding them in `photos` against each field report the whole time. They now
-- print on their own page; this is the note that heads that page.
--
-- POSITION: the report said what happened last week and what is coming in the
-- next three, and never where the project actually stands. That is the first
-- thing an owner asks. Percent complete, projected finish and quantities to
-- date are all derived; this is the box for the sentence explaining them.
--
-- Every column follows the same rule as the rest of the table: null means
-- "keep using the derived answer".
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Additive and idempotent - safe to re-run.

alter table public.weekly_progress_reports
  add column if not exists safety_summary text,
  add column if not exists photo_note text,
  add column if not exists position_note text;

comment on column public.weekly_progress_reports.safety_summary is
  'Override for the Safety box. Split out of security_concerns in 0042 - a recordable injury reported inside the Security box is filed where nobody looks for it.';
comment on column public.weekly_progress_reports.photo_note is
  'Note heading the photo page. Photos themselves are read live from the period''s approved field reports.';
comment on column public.weekly_progress_reports.position_note is
  'Override for the Project Position box (percent complete, projected finish, quantities to date).';
