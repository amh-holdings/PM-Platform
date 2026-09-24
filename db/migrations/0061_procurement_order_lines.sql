-- Line items on a purchase order.
--
-- Zarina: "I need to have option to add line items for PO forms. See PO form
-- we used."
--
-- The real PO carries a table: line number, quantity, description, units, unit
-- price, extended price, then Subtotal / Sales Tax / Freight / Total. The app
-- held one total_value and a free-text description, so the detail that makes a
-- PO checkable against an invoice lived only in the PDF.
--
-- Extended price is stored, not derived, because the source document does not
-- always derive it. On PO-023 line 6 is freight at $22,444.50 a unit with no
-- extended price, because the freight is carried in the Freight field below
-- the subtotal instead. A computed column would put that money in twice.
--
-- Apply via Supabase SQL Editor. Safe to re-run.

create table if not exists public.procurement_order_lines (
  id uuid primary key default gen_random_uuid(),
  procurement_order_id uuid references public.procurement_orders(id) on delete cascade not null,
  line_no integer,
  quantity numeric(14,4),
  description text,
  units text,
  unit_price numeric(14,4),
  -- Null means this line carries no extended price, which is different from
  -- zero. See the freight line above.
  extended_price numeric(14,2),
  sort_order integer,
  created_at timestamptz default now()
);

create index if not exists procurement_order_lines_po_idx
  on public.procurement_order_lines(procurement_order_id);

alter table public.procurement_order_lines enable row level security;
drop policy if exists "ahc_read_procurement_order_lines"  on public.procurement_order_lines;
drop policy if exists "ahc_write_procurement_order_lines" on public.procurement_order_lines;
create policy "ahc_read_procurement_order_lines" on public.procurement_order_lines
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));
create policy "ahc_write_procurement_order_lines" on public.procurement_order_lines
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

-- The two figures that sit between the subtotal and the total on the paper
-- form. Freight is its own line on the PO precisely because it is not part of
-- the material subtotal.
alter table public.procurement_orders
  add column if not exists sales_tax numeric(14,2);
alter table public.procurement_orders
  add column if not exists freight numeric(14,2);

comment on column public.procurement_orders.sales_tax is
  'Sales tax below the line-item subtotal. Null on a tax-exempt project.';
comment on column public.procurement_orders.freight is
  'Freight below the line-item subtotal, kept out of the material subtotal.';

notify pgrst, 'reload schema';
