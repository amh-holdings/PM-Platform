-- 0032_schedule_baseline.sql
--
-- Baseline dates for schedule tasks.
--
-- Without a baseline the schedule can say where a task is but not whether it
-- is late, because the original committed dates are overwritten every time the
-- schedule is re-baselined. That makes schedule variance uncomputable and
-- leaves a delay claim undefendable. On 2026-08-17 the civil re-baseline
-- destroyed the July dates outright; the only surviving copy is a JSON
-- snapshot under db/snapshots.
--
-- baseline_start / baseline_end are the committed dates. start_date / end_date
-- stay the live working dates. Variance is (end_date - baseline_end) in working
-- days, computed in the app rather than stored so it cannot drift.
--
-- baseline_label distinguishes the original contract baseline from later
-- re-baselines agreed with the owner. baseline_set_at records when it was
-- taken, which matters when a claim asks which schedule was in force.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Additive and idempotent - safe to re-run.

alter table public.schedule_tasks
  add column if not exists baseline_start date;

alter table public.schedule_tasks
  add column if not exists baseline_end date;

alter table public.schedule_tasks
  add column if not exists baseline_duration_days integer;

alter table public.schedule_tasks
  add column if not exists baseline_set_at timestamptz;

alter table public.schedule_tasks
  add column if not exists baseline_label text;

-- Finding the unbaselined tasks on a project is the common query - a task
-- added after the baseline was taken has no committed dates and must not be
-- counted as either ahead or behind.
create index if not exists schedule_tasks_baseline_idx
  on public.schedule_tasks(project_id, baseline_end);

comment on column public.schedule_tasks.baseline_start is
  'Committed start. Null means the task was added after the baseline was taken.';
comment on column public.schedule_tasks.baseline_end is
  'Committed finish. Variance is measured against this in working days.';
comment on column public.schedule_tasks.baseline_label is
  'Which baseline these dates came from, e.g. "Contract" or "Re-baseline 2026-08".';
