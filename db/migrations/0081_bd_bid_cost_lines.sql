-- Cost history, first pass: every priced line of a bid form, sorted into six
-- categories. Planned with Phil 2026-11-02; more detail comes after he has seen
-- this one.
--
-- These are SELL prices from the bid forms. Profit and overhead sit inside the
-- lines on most forms, so this is what AHC quoted, not what the work cost.
--
-- Source lines are kept, not just category totals, so a category can be checked
-- against the form and re-sorted later without going back to the spreadsheets.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx). Safe to re-run.

create table if not exists public.bd_bid_cost_lines (
  id uuid primary key default gen_random_uuid(),
  bid_id uuid not null references public.bd_bids(id) on delete cascade,
  category text not null
    check (category in ('gc', 'civil', 'mechanical', 'electrical', 'ohp', 'bonds_insurance')),
  label text not null,
  amount numeric(14,2) not null,
  source_file text not null,
  source_row integer not null,
  created_at timestamptz not null default now()
);

create index if not exists bd_bid_cost_lines_bid_idx on public.bd_bid_cost_lines (bid_id);

alter table public.bd_bid_cost_lines enable row level security;

drop policy if exists "bd_all_cost_lines" on public.bd_bid_cost_lines;
create policy "bd_all_cost_lines" on public.bd_bid_cost_lines
  for all to authenticated
  using (public.current_user_role() in ('phil', 'bd'))
  with check (public.current_user_role() in ('phil', 'bd'));
