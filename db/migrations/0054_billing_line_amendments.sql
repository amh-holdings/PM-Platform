-- 0054_billing_line_amendments.sql
--
-- WHICH CONTRACT LINE A CHANGE ORDER'S MONEY BELONGS TO
--
-- A change order does one of three things to the schedule of values, and the
-- app only modelled one of them:
--
--   1. Adds new scope, which gets its own SOV line. CO-05 (Piles, 15.00) and
--      CO-06 (Bond Premium, 16.00) are this. `billing_lines.change_order_id`
--      already says so, and it works.
--   2. Raises the price of scope the sheet ALREADY carries. CO-04 increases
--      POI Procurement; CO-02 adds cost to Mobilization and Fencing. Nothing
--      recorded this, so those contract lines kept their original scheduled
--      value and read as finished the moment that value was billed. POI 5.05
--      is $168,335.32 against a real scope of $235,793.63 once CO-04's
--      $67,458.31 is counted: 100% complete on the page, 71.4% in fact.
--   3. Moves no money at all. CO-03 is a completion-date change. It should
--      read as deliberate, not as a line somebody forgot to add.
--
-- This table records case 2: how much of a change order's SOV line belongs
-- against which contract line.
--
-- WHY AN AMOUNT, NOT JUST A POINTER
-- CO-02 touches Mobilization AND Fencing. A pointer can say which line, not
-- how much, so one row per (change order line, contract line) with the amount
-- on it. The owner's G703 keeps one line per change order while the app still
-- knows each contract line's true scope. Whatever is left unallocated on a
-- change order line is genuinely new scope, which is the right reading for
-- Piles and Bond Premium.
--
-- WHY NOT JUST RAISE THE CONTRACT LINE
-- Because $2,507,500.00 is what Dimension signed. Folding change orders into
-- the contract lines erases the executed SOV, breaks deriveContractValue's
-- agreement-versus-SOV check, and stops the live sheet reconciling with the
-- G703s already issued on AFP 1 through 12. Nothing here alters a scheduled
-- value, a billing entry or a pay application: this table only attributes.
--
-- Purely additive. With no rows, every page behaves exactly as it did before.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx). Safe to re-run.

create table if not exists public.billing_line_amendments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade not null,
  -- The change order's own SOV line - the one carrying the CO money.
  amendment_line_id uuid references public.billing_lines(id) on delete cascade not null,
  -- The contract line whose scope that money increases.
  base_line_id uuid references public.billing_lines(id) on delete cascade not null,
  amount numeric(14,2) not null default 0,
  note text,
  created_at timestamptz default now(),
  -- One allocation per pair. Changing how much goes to a line is an update,
  -- not a second row, so a total can never be assembled from stale halves.
  unique (amendment_line_id, base_line_id),
  constraint billing_line_amendments_not_self
    check (amendment_line_id <> base_line_id)
);

create index if not exists billing_line_amendments_base_idx
  on public.billing_line_amendments(base_line_id);
create index if not exists billing_line_amendments_amendment_idx
  on public.billing_line_amendments(amendment_line_id);
create index if not exists billing_line_amendments_project_idx
  on public.billing_line_amendments(project_id);

alter table public.billing_line_amendments enable row level security;
drop policy if exists "ahc_read_billing_line_amendments"  on public.billing_line_amendments;
drop policy if exists "ahc_write_billing_line_amendments" on public.billing_line_amendments;

-- Same audience as billing_lines. An allocation is billing data.
create policy "ahc_read_billing_line_amendments" on public.billing_line_amendments
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));
create policy "ahc_write_billing_line_amendments" on public.billing_line_amendments
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

-- AFTER RUNNING, on Sweet Springs, allocate CO-04's line 14.00 against the
-- contract's POI Procurement line 5.05 from the change order page. Billing
-- should then read POI as $235,793.63 of current scope rather than
-- $168,335.32, and its percent complete should fall accordingly.
