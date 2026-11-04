-- The bid analyzer, 2026-11-04. Reworks the RFP workspace (0088).
--
-- Phil, after seeing 0088: the runbook already lives in Notion, so the app
-- copy of it goes. What the app needs is a bid analyzer for three cases:
--   - a new bid on a BD opportunity
--   - a rebid on one
--   - updated pricing on a live project before construction
-- Bids come in as files. Claude reads each one through the Mac Mini relay
-- (/extract-bid), Phil checks the lines, and the round levels them by
-- package. On a project the baseline is the cost code budget.
--
-- WHAT CHANGES FROM 0088
--   - rfp_step_checks goes. The runbook checklist was a copy of Notion.
--   - rfp_rounds is new. A round belongs to an opportunity OR a project,
--     never both, so the same analyzer serves bidding and pre-construction.
--   - rfp_bidders now belong to a round. Any bidders already entered against
--     an opportunity are moved into an "R1" round for it.
--   - rfp_bid_lines holds what Claude read off each bid, line by line.
--   - rfp_round_packages holds the per-package estimate (for a new bid) and
--     which bidder we carry.
--   - rfp_round_cost_codes maps a package to the project's cost codes.
--
-- ACCESS: Phil only, on every table here (Phil 2026-11-04: "Phil only").
-- Zarina's read access to bd_opportunities and bd_companies from 0088 is
-- removed, so BD access is back to what 0074 set.
--
-- Requires 0088. Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Idempotent - safe to re-run.

-- ============ THE RUNBOOK CHECKLIST GOES ============

drop table if exists public.rfp_step_checks;

-- ============ ROUNDS ============

create table if not exists public.rfp_rounds (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid references public.bd_opportunities(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  kind text not null default 'new_bid' check (kind in ('new_bid', 'rebid', 'preconstruction')),
  label text not null,
  -- Projects carry no state column, so the round holds it for both kinds.
  state text check (state is null or state ~ '^[A-Z]{2}$'),
  due_date date,
  status text not null default 'open' check (status in ('open', 'closed')),
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rfp_round_one_target check (num_nonnulls(opportunity_id, project_id) = 1)
);

create index if not exists rfp_rounds_opportunity_idx on public.rfp_rounds (opportunity_id);
create index if not exists rfp_rounds_project_idx on public.rfp_rounds (project_id);

drop trigger if exists rfp_rounds_updated_at on public.rfp_rounds;
create trigger rfp_rounds_updated_at before update on public.rfp_rounds
  for each row execute function public.bd_touch_updated_at();

-- ============ BIDDERS BELONG TO A ROUND ============

alter table public.rfp_bidders add column if not exists round_id uuid references public.rfp_rounds(id) on delete cascade;
alter table public.rfp_bidders alter column opportunity_id drop not null;

-- Move bidders entered under 0088 into an R1 round per opportunity.
insert into public.rfp_rounds (opportunity_id, kind, label, state, due_date)
select o.id, 'new_bid', 'R1', case when upper(trim(o.state)) ~ '^[A-Z]{2}$' then upper(trim(o.state)) end, o.bid_due_date
from public.bd_opportunities o
where exists (select 1 from public.rfp_bidders b where b.opportunity_id = o.id and b.round_id is null)
  and not exists (select 1 from public.rfp_rounds r where r.opportunity_id = o.id and r.label = 'R1');

update public.rfp_bidders b
set round_id = r.id
from public.rfp_rounds r
where b.round_id is null and r.opportunity_id = b.opportunity_id and r.label = 'R1';

alter table public.rfp_bidders alter column round_id set not null;
create index if not exists rfp_bidders_round_idx on public.rfp_bidders (round_id);

-- What the last extraction found. Lines count in the leveling only once
-- lines_confirmed_at is set: Claude reads, Phil confirms.
alter table public.rfp_bidders
  add column if not exists source_file_name text,
  add column if not exists printed_total numeric(14,2),
  add column if not exists extracted_at timestamptz,
  add column if not exists extraction_notes text,
  add column if not exists defects text[] not null default '{}',
  add column if not exists lines_confirmed_at timestamptz;

-- ============ BID LINES ============

create table if not exists public.rfp_bid_lines (
  id uuid primary key default gen_random_uuid(),
  bidder_id uuid not null references public.rfp_bidders(id) on delete cascade,
  package text not null
    check (package in ('civil', 'mechanical', 'electrical', 'medium_voltage', 'commissioning',
                       'tracker_piles', 'electrical_equipment', 'scada', 'met_station',
                       'engineering', 'other')),
  description text not null,
  quantity numeric(14,3),
  unit text,
  -- Null = the line was left blank on the bid sheet, which means excluded.
  amount numeric(14,2),
  source_ref text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists rfp_bid_lines_bidder_idx on public.rfp_bid_lines (bidder_id, sort_order);

-- ============ PER-PACKAGE ESTIMATE AND CARRY ============

create table if not exists public.rfp_round_packages (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rfp_rounds(id) on delete cascade,
  package text not null,
  estimate numeric(14,2),
  carried_bidder_id uuid references public.rfp_bidders(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists rfp_round_packages_once on public.rfp_round_packages (round_id, package);

-- ============ PACKAGE TO COST CODE (project rounds) ============

create table if not exists public.rfp_round_cost_codes (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rfp_rounds(id) on delete cascade,
  package text not null,
  cost_code_id uuid not null references public.cost_codes(id) on delete cascade,
  created_at timestamptz not null default now()
);

create unique index if not exists rfp_round_cost_codes_once on public.rfp_round_cost_codes (round_id, package, cost_code_id);

-- ============ RLS: PHIL ONLY ============

alter table public.rfp_rounds           enable row level security;
alter table public.rfp_bid_lines        enable row level security;
alter table public.rfp_round_packages   enable row level security;
alter table public.rfp_round_cost_codes enable row level security;

drop policy if exists "rfp_all_state_profiles" on public.bd_state_profiles;
drop policy if exists "rfp_all_bidders" on public.rfp_bidders;
drop policy if exists "rfp_all_bidder_docs" on public.rfp_bidder_docs;
drop policy if exists "rfp_phil_state_profiles" on public.bd_state_profiles;
drop policy if exists "rfp_phil_bidders" on public.rfp_bidders;
drop policy if exists "rfp_phil_bidder_docs" on public.rfp_bidder_docs;
drop policy if exists "rfp_phil_rounds" on public.rfp_rounds;
drop policy if exists "rfp_phil_bid_lines" on public.rfp_bid_lines;
drop policy if exists "rfp_phil_round_packages" on public.rfp_round_packages;
drop policy if exists "rfp_phil_round_cost_codes" on public.rfp_round_cost_codes;

create policy "rfp_phil_state_profiles" on public.bd_state_profiles
  for all to authenticated
  using (public.current_user_role() = 'phil') with check (public.current_user_role() = 'phil');
create policy "rfp_phil_bidders" on public.rfp_bidders
  for all to authenticated
  using (public.current_user_role() = 'phil') with check (public.current_user_role() = 'phil');
create policy "rfp_phil_bidder_docs" on public.rfp_bidder_docs
  for all to authenticated
  using (public.current_user_role() = 'phil') with check (public.current_user_role() = 'phil');
create policy "rfp_phil_rounds" on public.rfp_rounds
  for all to authenticated
  using (public.current_user_role() = 'phil') with check (public.current_user_role() = 'phil');
create policy "rfp_phil_bid_lines" on public.rfp_bid_lines
  for all to authenticated
  using (public.current_user_role() = 'phil') with check (public.current_user_role() = 'phil');
create policy "rfp_phil_round_packages" on public.rfp_round_packages
  for all to authenticated
  using (public.current_user_role() = 'phil') with check (public.current_user_role() = 'phil');
create policy "rfp_phil_round_cost_codes" on public.rfp_round_cost_codes
  for all to authenticated
  using (public.current_user_role() = 'phil') with check (public.current_user_role() = 'phil');

-- Zarina's read access to BD from 0088 goes.
drop policy if exists "zarina_read_opportunities" on public.bd_opportunities;
drop policy if exists "zarina_read_companies" on public.bd_companies;
