-- 0079_billing_entry_po_items.sql
--
-- Which PO line items a staged amount is for, so an item is never billed twice.
--
-- Add to AFP can bill part of a PO by ticking the items that arrived (#149).
-- Nothing remembered the ticks, so next month the same items were offered
-- again with nothing on screen to say they had already gone out. Phil: "build
-- the billed-items ledger so items aren't double billed".
--
-- One row per item per billing entry. The entry carries the period and, once
-- it is on an application, the AFP number - so "billed" is read off the entry,
-- never copied here where it could drift. Deleting the entry (undo, a removed
-- forecast) takes its rows with it.
--
-- Apply via the runner (npm run db:migrate) or the Supabase SQL Editor.
-- REQUIRES 0059 (billing_entry_po_amounts) and 0061 (procurement_order_lines).
-- Safe to re-run.

create table if not exists public.billing_entry_po_items (
  id uuid primary key default gen_random_uuid(),
  billing_entry_id uuid references public.billing_entries(id) on delete cascade not null,
  procurement_order_id uuid references public.procurement_orders(id) on delete cascade not null,
  procurement_order_line_id uuid references public.procurement_order_lines(id) on delete cascade not null,
  created_at timestamptz default now(),
  unique (billing_entry_id, procurement_order_line_id)
);

create index if not exists billing_entry_po_items_po_idx
  on public.billing_entry_po_items(procurement_order_id);
create index if not exists billing_entry_po_items_line_idx
  on public.billing_entry_po_items(procurement_order_line_id);

alter table public.billing_entry_po_items enable row level security;
drop policy if exists "ahc_read_billing_entry_po_items"  on public.billing_entry_po_items;
drop policy if exists "ahc_write_billing_entry_po_items" on public.billing_entry_po_items;
create policy "ahc_read_billing_entry_po_items" on public.billing_entry_po_items
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));
create policy "ahc_write_billing_entry_po_items" on public.billing_entry_po_items
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

notify pgrst, 'reload schema';
