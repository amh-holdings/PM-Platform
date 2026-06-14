-- Phase 5: Track which procurement_orders are signed (vs draft).
--
-- A PO has real stages: draft -> submitted to vendor -> signed by both ->
-- delivered. The billing engine should only count SIGNED POs as committed
-- scope - drafts and unsigned-submitted POs are speculative and shouldn't
-- inflate the suggested billing amount for a procurement-scope SOV line.
--
-- signed_at: timestamp when the PO was marked signed. NULL = draft.
-- signed_by: profile id of the AHC user who marked it signed.
--
-- The billing engine filter is: only count POs where signed_at IS NOT NULL
-- AND status <> 'cancelled' as billable commitments.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Safe to re-run.

alter table public.procurement_orders
  add column if not exists signed_at timestamptz,
  add column if not exists signed_by uuid references public.profiles(id);

create index if not exists procurement_orders_signed_idx
  on public.procurement_orders(project_id, signed_at);

-- Backfill heuristic: any PO that already has at least one paid milestone
-- was obviously signed (you don't pay an unsigned PO). Set signed_at to
-- the earliest paid_at among its milestones if signed_at is currently NULL.
update public.procurement_orders po
set signed_at = sub.first_paid_at
from (
  select procurement_order_id, min(paid_at) as first_paid_at
  from public.procurement_payments
  where paid_at is not null
  group by procurement_order_id
) sub
where po.id = sub.procurement_order_id
  and po.signed_at is null;
