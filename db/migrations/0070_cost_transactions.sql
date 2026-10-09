-- 0070_cost_transactions.sql
--
-- THE QUICKBOOKS BILLS BEHIND EVERY COST NUMBER
--
-- The cost codes page shows a monthly total per code (cost_forecasts) and an
-- incurred total per code (cost_codes.actual_cost), both written by the
-- monthly QuickBooks sync (scripts/cashflow/qb-sync.mts). A total cannot be
-- audited on its own: Phil asked to see cost by month per code "so it can be
-- audited", which means being able to open any month of any code and see the
-- bills, checks and card charges that make it up.
--
-- This table holds those transactions, one row per QuickBooks line, exactly as
-- the Controller's export states them. Two bases, because the two totals come
-- from two reports:
--   cash     - Cost Detail CASH BASIS: dated when paid. Sums to the monthly
--              paid figures in cost_forecasts.
--   accrual  - Cost Detail ACCRUAL BASIS: dated when billed. Sums to the
--              incurred figure in cost_codes.actual_cost.
--
-- The sync replaces a project's rows wholesale each month. The QuickBooks pack
-- is cumulative from the start of the job, so the latest pack IS the history;
-- keeping old rows beside it would show a bill twice once QB re-dates it.
--
-- Read-only to the app. Only the sync writes, with the service role.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx). Safe to re-run.

create table if not exists public.cost_transactions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade not null,
  -- Null when QB's item maps to no app code; the row is kept so the totals
  -- still tie and the gap is visible.
  cost_code_id uuid references public.cost_codes(id) on delete set null,
  basis text not null check (basis in ('cash', 'accrual')),
  txn_date date not null,
  qb_type text not null,          -- Bill, Check, Credit Card Charge, ...
  qb_num text,                    -- bill / check number
  vendor text,                    -- QB "Source Name"
  qb_item text,                   -- QB item (the Memo column), e.g. "SSC O-Civil Site Work"
  paid_from text,                 -- QB "Split": the account it came from
  amount numeric(14,2) not null,  -- debit less credit
  qb_cutoff date not null,        -- the pack this row came from
  source_file text,
  synced_at timestamptz default now()
);

create index if not exists cost_transactions_lookup_idx
  on public.cost_transactions(project_id, basis, cost_code_id, txn_date);

alter table public.cost_transactions enable row level security;

drop policy if exists "ahc_read_cost_transactions" on public.cost_transactions;

create policy "ahc_read_cost_transactions" on public.cost_transactions
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));
