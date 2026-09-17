-- Purchase order line items.
--
-- A PO carried one free-text description and one total_value. That is enough to
-- cut a cheque against and not enough to check one: a $412,000 transformer PO
-- and a $412,000 typo look identical. Vendors quote by line - quantity, unit,
-- unit price - and that is the level a PM reconciles a packing slip at.
--
-- extended_price is GENERATED, not stored by the app. A line whose extension
-- can disagree with its own quantity times its own unit price is worse than no
-- line at all, and the only way to guarantee it cannot is to refuse to let
-- anyone write it.
--
-- Null quantity or null unit price yields a null extension rather than $0. A
-- line that has not been priced yet and a line priced at zero are different
-- facts, and the sum must not quietly treat the first as the second.
--
-- Lines are OPTIONAL. Every PO in the system today has none, and those POs
-- keep the manual total_value they were entered with. When lines exist, the
-- app sets procurement_orders.total_value from their sum.

create table if not exists public.procurement_order_lines (
  id uuid primary key default gen_random_uuid(),
  procurement_order_id uuid
    references public.procurement_orders(id) on delete cascade not null,
  line_no integer not null,
  description text not null,
  quantity numeric(14,4),
  unit text,
  unit_price numeric(14,4),
  extended_price numeric(14,2) generated always as (
    case
      when quantity is null or unit_price is null then null
      else round(quantity * unit_price, 2)
    end
  ) stored,
  notes text,
  created_at timestamptz default now(),
  unique (procurement_order_id, line_no)
);

create index if not exists procurement_order_lines_po_idx
  on public.procurement_order_lines(procurement_order_id, line_no);

alter table public.procurement_order_lines enable row level security;

-- Same audience as the parent PO. A line item is the PO, split up.
drop policy if exists "ahc_read_procurement_order_lines"
  on public.procurement_order_lines;
drop policy if exists "ahc_write_procurement_order_lines"
  on public.procurement_order_lines;

create policy "ahc_read_procurement_order_lines"
  on public.procurement_order_lines
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));

create policy "ahc_write_procurement_order_lines"
  on public.procurement_order_lines
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));
