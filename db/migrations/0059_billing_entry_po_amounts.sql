-- Two purchase orders billing one SOV line in one period.
--
-- billing_entries carries `unique (billing_line_id, period_month)`, so a line
-- has exactly one row per month. Add to AFP wrote the typed figure straight
-- onto that row along with source_procurement_order_id, which works for one
-- PO and quietly destroys the first figure for the second.
--
-- Zarina: "I added 2 POs for AFP13 but it is not reflecting in the billing it
-- should say a default number of 50% of PO17 and 50% of PO22." PO-017 and
-- PO-022 both hang off SOV 5.05 POI Procurement. Staging the second replaced
-- the first, so the line could never carry both.
--
-- This is the per-PO ledger underneath that one row. The entry's
-- planned_amount stays the number that bills - nothing downstream changes -
-- and is recomputed as the sum of these.
--
-- Apply via Supabase SQL Editor. Safe to re-run.

create table if not exists public.billing_entry_po_amounts (
  id uuid primary key default gen_random_uuid(),
  billing_entry_id uuid references public.billing_entries(id) on delete cascade not null,
  procurement_order_id uuid references public.procurement_orders(id) on delete cascade not null,
  amount numeric(14,2) not null default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (billing_entry_id, procurement_order_id)
);

create index if not exists billing_entry_po_amounts_entry_idx
  on public.billing_entry_po_amounts(billing_entry_id);
create index if not exists billing_entry_po_amounts_po_idx
  on public.billing_entry_po_amounts(procurement_order_id);

alter table public.billing_entry_po_amounts enable row level security;
drop policy if exists "ahc_read_billing_entry_po_amounts"  on public.billing_entry_po_amounts;
drop policy if exists "ahc_write_billing_entry_po_amounts" on public.billing_entry_po_amounts;
create policy "ahc_read_billing_entry_po_amounts" on public.billing_entry_po_amounts
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));
create policy "ahc_write_billing_entry_po_amounts" on public.billing_entry_po_amounts
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

-- Carry across what the single-source column already knows, so an amount
-- typed before this migration is not orphaned the moment it runs.
insert into public.billing_entry_po_amounts (billing_entry_id, procurement_order_id, amount)
select e.id, e.source_procurement_order_id, coalesce(e.planned_amount, 0)
from public.billing_entries e
where e.amount_is_manual = true
  and e.source_procurement_order_id is not null
  and coalesce(e.planned_amount, 0) > 0
on conflict (billing_entry_id, procurement_order_id) do nothing;

notify pgrst, 'reload schema';
