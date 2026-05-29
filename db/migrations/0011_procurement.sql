-- Procurement section + structured payment terms
--
-- 1. procurement_orders: one row per equipment / materials purchase to a vendor
--    (modules, inverters, transformers, racking, etc.)
-- 2. procurement_payments: per-order milestone schedule (e.g. 10% deposit,
--    80% delivery, 10% commissioning). Pays cash out on its own clock.
-- 3. cost_codes.procurement_order_id: optional link from a cost code to the
--    PO that drives its actuals
-- 4. cost_codes.subcontractor_id: optional link from a cost code to a sub
--    (mirrors the wbs_sov.subcontractor_id concept that was hidden when
--    the WBS tab was removed)
-- 5. subcontractors.payment_terms_days: structured Net X days alongside
--    the existing free-text payment_terms
-- 6. projects.owner_payment_terms_days + retainage_release_event: drives
--    the cash IN side of the projection model
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Safe to re-run.

-- ============ PROCUREMENT ORDERS ============

create table if not exists public.procurement_orders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade not null,
  vendor_name text not null,
  po_number text,
  description text,
  total_value numeric(14,2) default 0,
  ordered_date date,
  expected_delivery_date date,
  actual_delivery_date date,
  status text default 'active',
  payment_terms_summary text,
  document_id uuid references public.project_documents(id) on delete set null,
  notes text,
  created_at timestamptz default now(),
  unique (project_id, po_number)
);

create index if not exists procurement_orders_project_idx
  on public.procurement_orders(project_id);
create index if not exists procurement_orders_status_idx
  on public.procurement_orders(project_id, status);
create index if not exists procurement_orders_vendor_idx
  on public.procurement_orders(project_id, vendor_name);

alter table public.procurement_orders enable row level security;
drop policy if exists "ahc_read_procurement_orders"  on public.procurement_orders;
drop policy if exists "ahc_write_procurement_orders" on public.procurement_orders;
create policy "ahc_read_procurement_orders" on public.procurement_orders
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));
create policy "ahc_write_procurement_orders" on public.procurement_orders
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

-- ============ PROCUREMENT PAYMENTS ============

create table if not exists public.procurement_payments (
  id uuid primary key default gen_random_uuid(),
  procurement_order_id uuid references public.procurement_orders(id) on delete cascade not null,
  milestone_name text not null,
  pct_of_total numeric(5,2),
  trigger_event text,
  expected_date date,
  amount numeric(14,2) default 0,
  paid_at date,
  paid_amount numeric(14,2),
  sort_order integer,
  notes text,
  created_at timestamptz default now()
);

create index if not exists procurement_payments_order_idx
  on public.procurement_payments(procurement_order_id);
create index if not exists procurement_payments_expected_idx
  on public.procurement_payments(expected_date);

alter table public.procurement_payments enable row level security;
drop policy if exists "ahc_read_procurement_payments"  on public.procurement_payments;
drop policy if exists "ahc_write_procurement_payments" on public.procurement_payments;
create policy "ahc_read_procurement_payments" on public.procurement_payments
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));
create policy "ahc_write_procurement_payments" on public.procurement_payments
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

-- ============ COST CODE -> SUB / PROCUREMENT LINKS ============

alter table public.cost_codes
  add column if not exists subcontractor_id uuid references public.subcontractors(id) on delete set null,
  add column if not exists procurement_order_id uuid references public.procurement_orders(id) on delete set null;

create index if not exists cost_codes_subcontractor_idx
  on public.cost_codes(subcontractor_id);
create index if not exists cost_codes_procurement_idx
  on public.cost_codes(procurement_order_id);

-- ============ SUB STRUCTURED PAYMENT TERMS ============

alter table public.subcontractors
  add column if not exists payment_terms_days integer;

-- ============ OWNER PAYMENT TERMS ON PROJECTS ============

alter table public.projects
  add column if not exists owner_payment_terms_days integer,
  add column if not exists retainage_release_event text;

-- retainage_release_event recommended values:
--   'substantial_completion'  (default if not set)
--   'final_completion'
--   'fixed_date'              (use retainage_release_date if added later)
