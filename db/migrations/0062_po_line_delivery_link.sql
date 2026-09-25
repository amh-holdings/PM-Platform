-- A purchase order can have more than one delivery.
--
-- Zarina: "there are POs that has multiple deliveries on it. And each item
-- inside a PO can be linked to a line in the schedule."
--
-- Until now the link was one per PO: procurement_orders.linked_delivery_task_
-- wbs_code, added in 0018. That is right for a PO that arrives on one truck
-- and wrong for FTC Solar, where piles and racking land on different dates
-- against different schedule rows. One link meant one date for the whole PO,
-- so the second delivery was either early or late by however far the two
-- shipments are apart.
--
--   procurement_order_lines.linked_delivery_task_wbs_code
--     Which schedule row this item lands on. Text wbs_code matching
--     schedule_tasks, the same shape as the PO-level link and the SOV links,
--     rather than a foreign key: a WBS code is how every other table in this
--     app points at a schedule row, and renumbering is deliberately rare.
--
--   procurement_order_lines.actual_delivery_date
--     When this item really arrived. The PO already carries one for the whole
--     order; per line is what lets half a PO be on site.
--
--   procurement_payments.procurement_order_line_id
--     Which item a payment milestone is for, when the PO pays per delivery.
--     Null means the milestone covers the whole PO, which is every milestone
--     that exists today.
--
-- Nothing here is required. A PO with one delivery keeps its PO-level link and
-- behaves exactly as before.
--
-- REQUIRES 0061, which creates procurement_order_lines.
-- Apply via Supabase SQL Editor. Safe to re-run.

alter table public.procurement_order_lines
  add column if not exists linked_delivery_task_wbs_code text,
  add column if not exists actual_delivery_date date;

comment on column public.procurement_order_lines.linked_delivery_task_wbs_code is
  'schedule_tasks.wbs_code this item is delivered against. Overrides the '
  'PO-level link for payment milestones tied to this line.';

create index if not exists procurement_order_lines_delivery_task_idx
  on public.procurement_order_lines(linked_delivery_task_wbs_code);

alter table public.procurement_payments
  add column if not exists procurement_order_line_id uuid
    references public.procurement_order_lines(id) on delete set null;

comment on column public.procurement_payments.procurement_order_line_id is
  'The PO line this milestone pays for. Null means the whole order, which is '
  'how every milestone written before 0062 behaves.';

create index if not exists procurement_payments_line_idx
  on public.procurement_payments(procurement_order_line_id);
