-- Phase 5: Split a single PO across multiple SOV (billing_line) entries.
--
-- Real-world POs often bundle multiple equipment items that bill against
-- different SOV lines (e.g. Grid Power PO covers Recloser + Primary
-- Metering, which roll up to separate line items in the contract). The
-- existing billing_lines.linked_procurement_order_ids array can flag the
-- many-to-many, but doesn't say HOW MUCH of the PO belongs to each line.
-- This table holds the explicit dollar split so the AFP can compute
-- per-line stored-materials totals cleanly.
--
-- A PO is fully allocated when sum(amount) = procurement_orders.total_value.
-- The UI shows drift if the sums don't match, but doesn't enforce - some
-- POs intentionally hold reserves (taxes, freight) that aren't billed.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Safe to re-run.

create table if not exists public.procurement_order_billing_allocations (
  id uuid primary key default gen_random_uuid(),
  procurement_order_id uuid references public.procurement_orders(id) on delete cascade not null,
  billing_line_id uuid references public.billing_lines(id) on delete cascade not null,
  description text,
  amount numeric(14,2) not null default 0,
  sort_order integer,
  created_at timestamptz default now()
);

create index if not exists po_billing_allocations_po_idx
  on public.procurement_order_billing_allocations(procurement_order_id);
create index if not exists po_billing_allocations_line_idx
  on public.procurement_order_billing_allocations(billing_line_id);

alter table public.procurement_order_billing_allocations enable row level security;
drop policy if exists "ahc_read_po_billing_allocations"  on public.procurement_order_billing_allocations;
drop policy if exists "ahc_write_po_billing_allocations" on public.procurement_order_billing_allocations;
create policy "ahc_read_po_billing_allocations" on public.procurement_order_billing_allocations
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));
create policy "ahc_write_po_billing_allocations" on public.procurement_order_billing_allocations
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));
