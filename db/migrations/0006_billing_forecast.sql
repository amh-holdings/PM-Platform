-- Phase 3 - Billing forecast & cash flow
--
-- Models AHC's monthly cash-flow spreadsheet directly so the dashboard can
-- mirror what the project team already maintains in Excel.
--
-- Per project:
--   change_orders         one row per CO (CO-01, CO-02, CO-04, ...)
--   billing_lines         the SOV used for owner billing (one row per item
--                         number like 1.01, 9.00, CO-01); replaces the
--                         billing role of wbs_sov going forward but does
--                         not delete wbs_sov - PM data lives there
--   billing_entries       per billing_line, per month: planned + actual
--                         dollars billed, AFP reference, paid date
--   cost_forecasts        per cost_code, per month: planned + actual spend
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Safe to re-run.

-- ============ PROJECT-LEVEL FIELDS ============

alter table public.projects
  add column if not exists retainage_pct_default numeric(5,2) default 10.00;

-- ============ CHANGE ORDERS ============

create table if not exists public.change_orders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade not null,
  co_number text not null,
  description text,
  co_value numeric(14,2) default 0,
  schedule_impact_days integer,
  status text default 'approved',
  submitted_at date,
  approved_at date,
  notes text,
  created_at timestamptz default now(),
  unique (project_id, co_number)
);

create index if not exists change_orders_project_id_idx
  on public.change_orders(project_id);

alter table public.change_orders enable row level security;
drop policy if exists "ahc_read_change_orders"  on public.change_orders;
drop policy if exists "ahc_write_change_orders" on public.change_orders;
create policy "ahc_read_change_orders" on public.change_orders
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));
create policy "ahc_write_change_orders" on public.change_orders
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

-- ============ BILLING LINES ============

create table if not exists public.billing_lines (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade not null,
  item_number text not null,
  type text,
  description text not null,
  scheduled_value numeric(14,2) default 0,
  change_order_id uuid references public.change_orders(id) on delete set null,
  sort_order integer,
  linked_task_wbs_codes text[],
  notes text,
  created_at timestamptz default now(),
  unique (project_id, item_number)
);

create index if not exists billing_lines_project_id_idx
  on public.billing_lines(project_id);
create index if not exists billing_lines_sort_idx
  on public.billing_lines(project_id, sort_order);
create index if not exists billing_lines_change_order_idx
  on public.billing_lines(change_order_id);

alter table public.billing_lines enable row level security;
drop policy if exists "ahc_read_billing_lines"  on public.billing_lines;
drop policy if exists "ahc_write_billing_lines" on public.billing_lines;
create policy "ahc_read_billing_lines" on public.billing_lines
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));
create policy "ahc_write_billing_lines" on public.billing_lines
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

-- ============ BILLING ENTRIES ============
-- One row per billing_line per month. planned_amount is the forecast
-- (what we expect to bill this month); actual_amount is what was actually
-- billed once an AFP is submitted. afp_number, submitted_at, paid_at
-- track the pay-application lifecycle once it happens.

create table if not exists public.billing_entries (
  id uuid primary key default gen_random_uuid(),
  billing_line_id uuid references public.billing_lines(id) on delete cascade not null,
  period_month date not null,
  planned_amount numeric(14,2) default 0,
  actual_amount numeric(14,2) default 0,
  retainage_amount numeric(14,2) default 0,
  afp_number text,
  submitted_at date,
  paid_at date,
  notes text,
  created_at timestamptz default now(),
  unique (billing_line_id, period_month)
);

create index if not exists billing_entries_line_idx
  on public.billing_entries(billing_line_id);
create index if not exists billing_entries_period_idx
  on public.billing_entries(period_month);
create index if not exists billing_entries_afp_idx
  on public.billing_entries(afp_number);

alter table public.billing_entries enable row level security;
drop policy if exists "ahc_read_billing_entries"  on public.billing_entries;
drop policy if exists "ahc_write_billing_entries" on public.billing_entries;
create policy "ahc_read_billing_entries" on public.billing_entries
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));
create policy "ahc_write_billing_entries" on public.billing_entries
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

-- ============ COST FORECASTS ============
-- Per cost_code per month: planned vs actual spend. Mirrors the Cash-Out
-- sheet from AHC's cash flow spreadsheet.

create table if not exists public.cost_forecasts (
  id uuid primary key default gen_random_uuid(),
  cost_code_id uuid references public.cost_codes(id) on delete cascade not null,
  period_month date not null,
  planned_amount numeric(14,2) default 0,
  actual_amount numeric(14,2) default 0,
  notes text,
  created_at timestamptz default now(),
  unique (cost_code_id, period_month)
);

create index if not exists cost_forecasts_cost_code_idx
  on public.cost_forecasts(cost_code_id);
create index if not exists cost_forecasts_period_idx
  on public.cost_forecasts(period_month);

alter table public.cost_forecasts enable row level security;
drop policy if exists "ahc_read_cost_forecasts"  on public.cost_forecasts;
drop policy if exists "ahc_write_cost_forecasts" on public.cost_forecasts;
create policy "ahc_read_cost_forecasts" on public.cost_forecasts
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));
create policy "ahc_write_cost_forecasts" on public.cost_forecasts
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

-- ============ ROLLUP VIEWS ============
-- Convenience views for the dashboard. These do NOT include retainage
-- recomputation; we trust the values stored on billing_entries.

create or replace view public.v_billing_line_totals as
select
  bl.id as billing_line_id,
  bl.project_id,
  bl.item_number,
  bl.scheduled_value,
  coalesce(sum(be.planned_amount), 0) as total_planned,
  coalesce(sum(be.actual_amount), 0) as total_billed,
  coalesce(sum(be.retainage_amount), 0) as total_retainage,
  bl.scheduled_value - coalesce(sum(be.actual_amount), 0) as remaining_to_bill
from public.billing_lines bl
left join public.billing_entries be on be.billing_line_id = bl.id
group by bl.id;

create or replace view public.v_project_billing_summary as
select
  bl.project_id,
  coalesce(sum(bl.scheduled_value), 0) as total_scheduled,
  coalesce(sum(be.actual_amount), 0) as total_billed,
  coalesce(sum(be.retainage_amount), 0) as total_retainage,
  coalesce(sum(case when be.period_month > current_date then be.planned_amount else 0 end), 0) as future_planned
from public.billing_lines bl
left join public.billing_entries be on be.billing_line_id = bl.id
group by bl.project_id;

create or replace view public.v_cost_code_totals as
select
  cc.id as cost_code_id,
  cc.project_id,
  cc.code,
  cc.estimated_cost,
  coalesce(sum(cf.planned_amount), 0) as total_planned,
  coalesce(sum(cf.actual_amount), 0) as total_actual,
  cc.estimated_cost - coalesce(sum(cf.actual_amount), 0) as remaining_budget
from public.cost_codes cc
left join public.cost_forecasts cf on cf.cost_code_id = cc.id
group by cc.id;
