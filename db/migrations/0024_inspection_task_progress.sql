-- Fold the DPR "schedule task update" fields onto the Field Report pin itself.
-- Each work pin carries the intended progress for its WBS task; approving the
-- pin applies it to the schedule (installed quantity reuses inspections.quantity
-- / unit_of_measure). Additive and idempotent.

alter table public.inspections
  add column if not exists task_new_status text;

alter table public.inspections
  add column if not exists task_new_pct numeric(5, 2);
