-- Phase 5: Link each procurement_order to its delivery schedule_task.
--
-- The Sweet Springs schedule has rich procurement structure: per-vendor
-- "Lead Time" and "Delivery" tasks under each equipment item (4.4.3.2
-- Maddox 1500kVA Delivery, 4.4.4.2 Recloser Delivery, etc.). Linking
-- each PO to its delivery task lets the AI extraction (and any cash
-- projection) read the scheduled delivery date instead of guessing
-- from PDF shipping boilerplate.
--
-- linked_delivery_task_wbs_code: text wbs_code matching schedule_tasks.
-- We don't FK to schedule_tasks.id directly because:
--   - schedule_tasks rows get re-imported regularly (the id changes,
--     but wbs_code is stable)
--   - we want this to gracefully no-op if the linked task is deleted
--     from a later schedule import
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Safe to re-run.

alter table public.procurement_orders
  add column if not exists linked_delivery_task_wbs_code text;

create index if not exists procurement_orders_delivery_task_idx
  on public.procurement_orders(project_id, linked_delivery_task_wbs_code);
