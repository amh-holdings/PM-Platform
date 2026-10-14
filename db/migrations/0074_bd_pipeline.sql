-- Business development pipeline: clients, contacts, opportunities, bids,
-- follow-up activity. AHC only, full EPC bids. Planned with Phil 2026-10-09.
--
-- Who sees it: phil and bd (Luke, Shannon). bd sees every BD row, bid margin
-- included, and NOTHING on the construction side - this migration also takes
-- projects away from bd, because the projects read policy (0030) otherwise
-- falls through to "everyone else reads all", contract_value included. Every
-- other construction table is already an allowlist that bd is not on.
--
-- Rules the database holds, so a bulk import cannot skip them either:
--   - an open opportunity always carries a next follow-up date
--   - a lost opportunity always carries a loss reason
--
-- Requires 0073 (the 'bd' enum value) to be applied first.
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Safe to re-run.

-- ============ CLIENTS ============

create table if not exists public.bd_companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  company_type text not null default 'Developer'
    check (company_type in ('Developer', 'IPP', 'Utility', 'EPC', 'Other')),
  state text,
  website text,
  owner_id uuid references public.profiles(id) on delete set null,
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists bd_companies_name_key
  on public.bd_companies (lower(name));

create table if not exists public.bd_contacts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.bd_companies(id) on delete cascade,
  name text not null,
  title text,
  email text,
  phone text,
  is_decision_maker boolean not null default false,
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists bd_contacts_company_idx on public.bd_contacts (company_id);

-- ============ OPPORTUNITIES ============
-- One row per project we chase. Stage is the pipeline position; the outcome
-- fields fill in when it closes. Price of record is the latest bid revision
-- (bd_bids), not a column here.

create table if not exists public.bd_opportunities (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.bd_companies(id) on delete restrict,
  contact_id uuid references public.bd_contacts(id) on delete set null,
  name text not null,
  state text,
  county text,
  size_mw_dc numeric(10,3),
  size_mwh numeric(10,3),
  stage text not null default 'lead'
    check (stage in ('lead', 'bidding', 'submitted', 'shortlist', 'won', 'lost', 'no_bid', 'dead')),
  owner_id uuid references public.profiles(id) on delete set null,
  source text,
  est_value numeric(14,2),
  probability_pct integer check (probability_pct between 0 and 100),
  bid_due_date date,
  expected_decision_date date,
  next_follow_up_date date,
  outcome_date date,
  loss_reason text
    check (loss_reason in ('price', 'schedule', 'scope', 'relationship', 'in_house', 'unknown')),
  winner text,
  winning_price numeric(14,2),
  outcome_notes text,
  project_id uuid references public.projects(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bd_open_needs_follow_up
    check (stage in ('won', 'lost', 'no_bid', 'dead') or next_follow_up_date is not null),
  constraint bd_lost_needs_reason
    check (stage <> 'lost' or loss_reason is not null)
);

create index if not exists bd_opportunities_company_idx on public.bd_opportunities (company_id);
create index if not exists bd_opportunities_stage_idx on public.bd_opportunities (stage);
create index if not exists bd_opportunities_follow_up_idx on public.bd_opportunities (next_follow_up_date);

-- ============ BIDS ============
-- Every priced revision. Indicative -> Final -> BAFO on one opportunity.

create table if not exists public.bd_bids (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.bd_opportunities(id) on delete cascade,
  revision_type text not null default 'final'
    check (revision_type in ('indicative', 'final', 'bafo')),
  submitted_on date not null,
  price numeric(14,2) not null check (price >= 0),
  margin_pct numeric(6,2),
  equipment_basis text not null default 'epc_furnished'
    check (equipment_basis in ('epc_furnished', 'owner_furnished', 'partial')),
  exclusions text,
  proposal_url text,
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists bd_bids_opportunity_idx on public.bd_bids (opportunity_id);

-- ============ FOLLOW-UP ACTIVITY ============
-- Every touch with a client. Company is required; the opportunity is optional
-- so relationship calls with no open bid still count toward "last touch".

create table if not exists public.bd_activities (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.bd_companies(id) on delete cascade,
  opportunity_id uuid references public.bd_opportunities(id) on delete cascade,
  contact_id uuid references public.bd_contacts(id) on delete set null,
  activity_type text not null default 'call'
    check (activity_type in ('call', 'email', 'meeting', 'site_visit', 'text', 'other')),
  occurred_on date not null default current_date,
  notes text,
  logged_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists bd_activities_company_idx on public.bd_activities (company_id, occurred_on desc);
create index if not exists bd_activities_opportunity_idx on public.bd_activities (opportunity_id);

-- ============ updated_at ============

create or replace function public.bd_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists bd_companies_updated_at on public.bd_companies;
create trigger bd_companies_updated_at before update on public.bd_companies
  for each row execute function public.bd_touch_updated_at();

drop trigger if exists bd_opportunities_updated_at on public.bd_opportunities;
create trigger bd_opportunities_updated_at before update on public.bd_opportunities
  for each row execute function public.bd_touch_updated_at();

-- ============ RLS ============

alter table public.bd_companies     enable row level security;
alter table public.bd_contacts      enable row level security;
alter table public.bd_opportunities enable row level security;
alter table public.bd_bids          enable row level security;
alter table public.bd_activities    enable row level security;

drop policy if exists "bd_all_companies" on public.bd_companies;
create policy "bd_all_companies" on public.bd_companies
  for all to authenticated
  using (public.current_user_role() in ('phil', 'bd'))
  with check (public.current_user_role() in ('phil', 'bd'));

drop policy if exists "bd_all_contacts" on public.bd_contacts;
create policy "bd_all_contacts" on public.bd_contacts
  for all to authenticated
  using (public.current_user_role() in ('phil', 'bd'))
  with check (public.current_user_role() in ('phil', 'bd'));

drop policy if exists "bd_all_opportunities" on public.bd_opportunities;
create policy "bd_all_opportunities" on public.bd_opportunities
  for all to authenticated
  using (public.current_user_role() in ('phil', 'bd'))
  with check (public.current_user_role() in ('phil', 'bd'));

drop policy if exists "bd_all_bids" on public.bd_bids;
create policy "bd_all_bids" on public.bd_bids
  for all to authenticated
  using (public.current_user_role() in ('phil', 'bd'))
  with check (public.current_user_role() in ('phil', 'bd'));

drop policy if exists "bd_all_activities" on public.bd_activities;
create policy "bd_all_activities" on public.bd_activities
  for all to authenticated
  using (public.current_user_role() in ('phil', 'bd'))
  with check (public.current_user_role() in ('phil', 'bd'));

-- bd picks an owner for each opportunity, so it needs the names of the people
-- who can own one: Phil and the other bd user. Nobody else's profile.
drop policy if exists "bd_read_bd_profiles" on public.profiles;
create policy "bd_read_bd_profiles" on public.profiles
  for select to authenticated
  using (
    public.current_user_role() = 'bd'
    and role in ('phil', 'bd')
  );

-- ============ PROJECTS: keep bd out ============
-- Same policy as 0030 with one added branch. bd never reads a project row, so
-- a won opportunity shows "transferred" from its project_id alone.

drop policy if exists "authenticated_read_projects" on public.projects;

create policy "authenticated_read_projects" on public.projects
  for select to authenticated
  using (
    case
      when public.current_user_role() in ('sub_pm', 'sub_foreman') then
        id in (
          select s.project_id
          from public.subcontractors s
          join public.profiles p on p.subcontractor_id = s.id
          where p.id = auth.uid()
        )
      when public.current_user_role() = 'bd' then false
      else true
    end
  );
