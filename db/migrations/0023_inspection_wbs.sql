-- Link a Field Report work pin (and CM check) to a schedule/WBS task, so each
-- pin on the site plan ties to a real WBS item. Additive and idempotent;
-- existing inspections keep schedule_task_id = null.

alter table public.inspections
  add column if not exists schedule_task_id uuid
    references public.schedule_tasks(id) on delete set null;

create index if not exists inspections_schedule_task_idx
  on public.inspections(schedule_task_id);
