-- 0035_commodity_tracking.sql
--
-- Commodity production tracking. Backs the daily Commodity Tracker production
-- report that Sweet Spring Solar (DE) requires AHC to submit: 18 commodity
-- quantities per day across Civil / Electrical / Mechanical, entered as DAILY
-- values, not cumulative.
--
-- Why this is new rather than an extension of what exists: the platform has no
-- commodity dimension at all. schedule_tasks.installed_quantity is a single
-- scalar per WBS task that applyPinProgressToSchedule OVERWRITES on each
-- approval, target_quantity is null on every row, and dpr_quantities has been
-- orphaned since the original schema. None of that can produce a daily time
-- series per commodity.
--
-- Three tables:
--   commodities          - the 18 tracked commodities per project: label, unit,
--                          target total, and the Smartsheet roll-up row it maps
--                          to. total_verified defaults FALSE because the totals
--                          currently on the client's sheet are Jan-2025 template
--                          placeholders (250 ft road install, 500 ft trenching,
--                          1,000 ft fencing, 12,000 modules) that do not trace
--                          to the Sweet Springs contract.
--   daily_production     - one row per (project, date, commodity). Zeros are
--                          stored explicitly so "reported zero" is
--                          distinguishable from "never reported", and so the
--                          Smartsheet export is a straight pivot.
--   commodity_task_links - maps schedule tasks to commodities so a field-report
--                          pin can pre-fill the right commodity.
--
-- Inherits the seven-role RLS spine (public.current_user_role()). Subs are
-- scoped to projects where their company is engaged, matching 0029/0030.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx), then run
-- `npm run db:types`. Idempotent - safe to re-run.

-- ============ ENUMS ============

do $$
begin
  if not exists (select 1 from pg_type where typname = 'commodity_category') then
    create type commodity_category as enum ('civil', 'electrical', 'mechanical');
  end if;
end$$;

-- Where a daily_production row came from.
--   field_report - captured on the sub's Field Report at submission time
--   backfill     - reconstructed from historical narratives, reviewed by the CM
--   manual       - typed directly by AHC (correction, or a day with no report)
do $$
begin
  if not exists (select 1 from pg_type where typname = 'production_source') then
    create type production_source as enum ('field_report', 'backfill', 'manual');
  end if;
end$$;

-- ============ COMMODITIES ============

create table if not exists public.commodities (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade not null,
  -- Stable slug used in code and export payloads (e.g. 'site_prep'). The label
  -- is what the client's sheet displays and may drift; the key must not.
  key text not null,
  label text not null,
  category commodity_category not null,
  -- 'ft' | 'ea' | 'rows' | '%'. Percent commodities take a DAILY percent.
  uom text not null,
  -- Target quantity for the whole scope. Null until someone supplies it.
  total_quantity numeric(14,3),
  -- FALSE means total_quantity is an unverified placeholder inherited from the
  -- client's template. Any % complete computed against it is not defensible.
  total_verified boolean not null default false,
  sov_item text,
  -- Row id of this commodity on the client's "Commodity Tracker Roll-up" sheet,
  -- so the later automated push can target it without re-matching on label.
  smartsheet_rollup_row_id bigint,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint commodities_project_key_uniq unique (project_id, key)
);

create index if not exists commodities_project_idx
  on public.commodities(project_id, sort_order);

-- ============ DAILY PRODUCTION ============

create table if not exists public.daily_production (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade not null,
  commodity_id uuid references public.commodities(id) on delete cascade not null,
  production_date date not null,
  -- The DAILY value, not cumulative. Percent commodities carry 0-100.
  quantity numeric(14,3) not null default 0,
  source production_source not null default 'manual',
  -- The Field Report this came from, when it came from one.
  dpr_id uuid references public.dprs(id) on delete set null,
  entered_by uuid references public.profiles(id),
  notes text,
  -- Smartsheet sync bookkeeping. Unused until the push is automated; present
  -- now so turning it on needs no schema change.
  smartsheet_row_id bigint,
  synced_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint daily_production_quantity_nonneg check (quantity >= 0),
  constraint daily_production_uniq unique (project_id, production_date, commodity_id)
);

create index if not exists daily_production_project_date_idx
  on public.daily_production(project_id, production_date);
create index if not exists daily_production_commodity_idx
  on public.daily_production(commodity_id, production_date);
create index if not exists daily_production_dpr_idx
  on public.daily_production(dpr_id);
-- Supports "what has not been pushed to the client yet".
create index if not exists daily_production_unsynced_idx
  on public.daily_production(project_id, production_date)
  where synced_at is null;

-- ============ COMMODITY / SCHEDULE TASK LINKS ============
-- A field-report pin carries a schedule_task_id. This maps that task to the
-- commodity it produces, so the pin quantity can pre-fill the right column.
-- Many-to-many on purpose: several WBS tasks roll into one commodity (e.g.
-- Pile Unloading / Staging / Driving all feed Piles).

create table if not exists public.commodity_task_links (
  id uuid primary key default gen_random_uuid(),
  commodity_id uuid references public.commodities(id) on delete cascade not null,
  schedule_task_id uuid references public.schedule_tasks(id) on delete cascade not null,
  created_at timestamptz default now(),
  constraint commodity_task_links_uniq unique (commodity_id, schedule_task_id)
);

create index if not exists commodity_task_links_task_idx
  on public.commodity_task_links(schedule_task_id);

-- ============ ROW LEVEL SECURITY ============

alter table public.commodities          enable row level security;
alter table public.daily_production     enable row level security;
alter table public.commodity_task_links enable row level security;

-- ---- commodities ----
drop policy if exists "ahc_read_commodities"          on public.commodities;
drop policy if exists "ahc_write_commodities"         on public.commodities;
drop policy if exists "owner_counsel_read_commodities" on public.commodities;
drop policy if exists "sub_read_commodities"          on public.commodities;

create policy "ahc_read_commodities" on public.commodities
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));

create policy "ahc_write_commodities" on public.commodities
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

create policy "owner_counsel_read_commodities" on public.commodities
  for select to authenticated
  using (public.current_user_role() in ('owner','counsel'));

-- Subs need the commodity list to fill the production section of their Field
-- Report, scoped to projects where their company is engaged (same join as 0029).
create policy "sub_read_commodities" on public.commodities
  for select to authenticated
  using (
    public.current_user_role() in ('sub_pm','sub_foreman')
    and project_id in (
      select s.project_id
      from public.subcontractors s
      join public.profiles p on p.subcontractor_id = s.id
      where p.id = auth.uid()
    )
  );

-- ---- daily_production ----
drop policy if exists "ahc_read_daily_production"           on public.daily_production;
drop policy if exists "ahc_write_daily_production"          on public.daily_production;
drop policy if exists "owner_counsel_read_daily_production" on public.daily_production;
drop policy if exists "sub_read_daily_production"           on public.daily_production;
drop policy if exists "sub_insert_daily_production"         on public.daily_production;
drop policy if exists "sub_update_daily_production"         on public.daily_production;

create policy "ahc_read_daily_production" on public.daily_production
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));

create policy "ahc_write_daily_production" on public.daily_production
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

create policy "owner_counsel_read_daily_production" on public.daily_production
  for select to authenticated
  using (public.current_user_role() in ('owner','counsel'));

-- Subs read and write production for their own project(s) only. Insert and
-- update are granted separately (not `for all`) so a sub can never DELETE a
-- production record once filed - the daily numbers are a client deliverable and
-- corrections go through AHC.
create policy "sub_read_daily_production" on public.daily_production
  for select to authenticated
  using (
    public.current_user_role() in ('sub_pm','sub_foreman')
    and project_id in (
      select s.project_id
      from public.subcontractors s
      join public.profiles p on p.subcontractor_id = s.id
      where p.id = auth.uid()
    )
  );

create policy "sub_insert_daily_production" on public.daily_production
  for insert to authenticated
  with check (
    public.current_user_role() in ('sub_pm','sub_foreman')
    and project_id in (
      select s.project_id
      from public.subcontractors s
      join public.profiles p on p.subcontractor_id = s.id
      where p.id = auth.uid()
    )
  );

create policy "sub_update_daily_production" on public.daily_production
  for update to authenticated
  using (
    public.current_user_role() in ('sub_pm','sub_foreman')
    and project_id in (
      select s.project_id
      from public.subcontractors s
      join public.profiles p on p.subcontractor_id = s.id
      where p.id = auth.uid()
    )
  )
  with check (
    public.current_user_role() in ('sub_pm','sub_foreman')
    and project_id in (
      select s.project_id
      from public.subcontractors s
      join public.profiles p on p.subcontractor_id = s.id
      where p.id = auth.uid()
    )
  );

-- ---- commodity_task_links ----
drop policy if exists "ahc_write_commodity_task_links" on public.commodity_task_links;
drop policy if exists "read_commodity_task_links"      on public.commodity_task_links;

create policy "ahc_write_commodity_task_links" on public.commodity_task_links
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

-- The mapping itself is not sensitive - it is WBS code to commodity name - and
-- the sub's Field Report form needs it to pre-fill. Read is scoped through the
-- commodity, which is already project-scoped for subs above.
create policy "read_commodity_task_links" on public.commodity_task_links
  for select to authenticated
  using (
    exists (
      select 1 from public.commodities c where c.id = commodity_id
    )
  );

-- ============ updated_at ============

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists commodities_touch_updated_at on public.commodities;
create trigger commodities_touch_updated_at
  before update on public.commodities
  for each row execute function public.touch_updated_at();

drop trigger if exists daily_production_touch_updated_at on public.daily_production;
create trigger daily_production_touch_updated_at
  before update on public.daily_production
  for each row execute function public.touch_updated_at();
