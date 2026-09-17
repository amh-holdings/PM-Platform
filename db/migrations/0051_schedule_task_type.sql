-- 0051_schedule_task_type.sql
--
-- Two kinds of task, and the schedule has been treating them as one.
--
-- A construction activity is measured in the field: the sub files a daily
-- report, the CM approves a pin, and percent complete comes from that. Sweet
-- Springs runs entirely on this.
--
-- A deliverable is an event: a design package arrives, a contract is signed, a
-- permit is issued, an inspection passes. Nobody files a daily report on one.
-- Sussex engineering showed the cost of not knowing the difference - 30%
-- design carried "In Progress" with no percent (there is no report that could
-- ever set one), so once its 9/14 finish passed the live forecast assumed all
-- 16 days were still ahead and pushed it to 10/8.
--
-- This migration adds the field ONLY. Every row stays null, which means "not
-- classified" and behaves exactly as before. Phil approves the classification
-- for Sussex and Sweet Springs level by level before anything is written, and
-- the forecast rules for deliverables come after that.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Additive and idempotent - safe to re-run.

alter table public.schedule_tasks
  add column if not exists task_type text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'schedule_tasks_task_type_chk'
  ) then
    alter table public.schedule_tasks
      add constraint schedule_tasks_task_type_chk
      check (task_type is null or task_type in ('construction', 'deliverable'));
  end if;
end $$;

comment on column public.schedule_tasks.task_type is
  'construction = progress measured in the field from approved daily reports. '
  'deliverable = done when something is received (design package, signed '
  'contract, permit, inspection). Null = not classified yet.';

-- Confirm nothing was filled in.
do $$
declare
  classified int;
begin
  select count(*) into classified from public.schedule_tasks where task_type is not null;
  raise notice 'schedule_tasks.task_type added. Rows classified: % (expected 0).', classified;
end $$;
