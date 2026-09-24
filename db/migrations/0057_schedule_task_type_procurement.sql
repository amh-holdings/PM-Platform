-- 0057: a third kind of task - procurement.
--
-- 0051 split tasks two ways. Construction is measured in the field and its
-- percent comes from approved daily reports. A deliverable is done when
-- something is received: a design package, a signed contract, a permit.
--
-- Equipment procurement is neither. Nobody files a daily report on a
-- transformer in transit, so it is not construction. And it is not a document
-- arriving in an inbox - it is a lead time running down and a truck showing up
-- on site, tied to a purchase order with a delivery date on it.
--
-- Zarina: "this is not a construction but procurement of equipment. I need to
-- complete as the equipment has been delivered but it is not updating it."
-- Sweet Springs carries 30-odd of these rows (Lead Time and Delivery under
-- Modules, Inverters, Racking, Piles, CAB, Maddox, Recloser and the rest), all
-- of them reading "No report" because the only way to set a percent was a
-- field report that will never exist for them.
--
-- Forecasting treats procurement the same way it treats a deliverable: the
-- planned finish is a commitment while it is still ahead, and overdue once it
-- has passed. Progress on both can now be set by hand, because there is no
-- report to take it from. Construction is untouched and still comes only from
-- approved reports, which is the rule that was always the point.
--
-- Widening a check constraint only. Every existing row keeps its value.
--
-- Apply via Supabase SQL Editor. Safe to re-run.

alter table public.schedule_tasks
  drop constraint if exists schedule_tasks_task_type_chk;

alter table public.schedule_tasks
  add constraint schedule_tasks_task_type_chk
  check (task_type is null or task_type in ('construction', 'deliverable', 'procurement'));

comment on column public.schedule_tasks.task_type is
  'construction = progress measured in the field from approved daily reports. '
  'deliverable = done when something is received (design package, signed '
  'contract, permit, inspection). procurement = equipment on order, done when '
  'it is delivered to site. Null = not classified yet.';

notify pgrst, 'reload schema';
