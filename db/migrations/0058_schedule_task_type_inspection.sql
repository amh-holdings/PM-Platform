-- 0058: a fourth kind of task - inspection.
--
-- The schedule knows construction (measured in the field), deliverable (a
-- document or approval arriving) and procurement (equipment on order). An
-- inspection has been landing under deliverable because that is the nearest
-- fit, which is true enough mechanically and wrong on the page: a third-party
-- inspection is not a design package, and a schedule you read at a glance
-- should say which is which.
--
-- Zarina: "Can you add inspection option for the type section in the schedule."
--
-- It behaves exactly as a deliverable does in the engine, deliberately. Its
-- planned finish is a commitment, so it holds while the date is ahead and goes
-- overdue once it has passed rather than assuming the whole duration is still
-- to run. Its progress is typed rather than taken from a daily report, because
-- no daily report will ever cover an inspection: it passed or it did not.
--
-- Widening a check constraint only. Every existing row keeps its value, and a
-- task already classified as deliverable stays deliverable until somebody
-- changes it.
--
-- Apply via Supabase SQL Editor. Safe to re-run.

alter table public.schedule_tasks
  drop constraint if exists schedule_tasks_task_type_chk;

alter table public.schedule_tasks
  add constraint schedule_tasks_task_type_chk
  check (
    task_type is null
    or task_type in ('construction', 'deliverable', 'procurement', 'inspection')
  );

comment on column public.schedule_tasks.task_type is
  'construction = progress measured in the field from approved daily reports. '
  'deliverable = done when something is received (design package, signed '
  'contract, permit). procurement = equipment on order, done when it is '
  'delivered to site. inspection = a third-party or owner inspection, done '
  'when it passes. Null = not classified yet.';

notify pgrst, 'reload schema';
