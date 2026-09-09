-- 0047_project_equipment.sql
--
-- Fixes the subcontractors' loudest Field Report complaint: the equipment
-- section's name field is free text, so a foreman retypes "40-ton crane" every
-- single morning. It also fixes a quieter problem that only shows up
-- downstream - "40T crane", "40 ton crane" and "Crane (40t)" are three
-- distinct strings, and src/lib/weekly-report-load.ts groups the weekly
-- equipment rollup on exactly that string.
--
-- The fix is a per-subcontractor equipment catalog that backs a dropdown.
--
-- What this deliberately does NOT do: prefill. Each morning's equipment rows
-- still start empty and the sub picks each machine. Carrying yesterday's list
-- forward would make "same as yesterday" the silent default and quietly break
-- what dpr_equipment.active means - an equipment row is supposed to be an
-- affirmative statement that the machine was on site, not an inherited one.
-- The catalog removes the typing, not the daily decision.
--
-- Scoping is per subcontractor, not per project: on a six-sub job a shared
-- pool would hand every foreman a dropdown full of other crews' machines,
-- which is the friction this is meant to remove.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Safe to re-run.

-- ============ CATALOG TABLE ============

create table if not exists public.project_equipment (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade not null,
  subcontractor_id uuid references public.subcontractors(id) on delete cascade not null,
  name text not null,
  category text,
  rental_company text,
  on_rent boolean not null default false,
  -- active=false retires a machine from the dropdown WITHOUT deleting it, so
  -- historical dpr_equipment rows that point at it still resolve.
  active boolean not null default true,
  sort_order integer,
  created_by uuid references public.profiles(id),
  created_at timestamptz default now()
);

create index if not exists project_equipment_project_idx
  on public.project_equipment(project_id);
create index if not exists project_equipment_sub_idx
  on public.project_equipment(subcontractor_id);

-- One entry per name per sub. This is what actually stops the duplicate-name
-- problem: the inline "add new" path cannot create a second "40-ton crane"
-- for the same crew, no matter how it is cased or padded.
create unique index if not exists project_equipment_sub_name_uniq
  on public.project_equipment(subcontractor_id, lower(btrim(name)));

alter table public.project_equipment enable row level security;

drop policy if exists "ahc_read_project_equipment"   on public.project_equipment;
drop policy if exists "ahc_write_project_equipment"  on public.project_equipment;
drop policy if exists "sub_read_project_equipment"   on public.project_equipment;
drop policy if exists "sub_insert_project_equipment" on public.project_equipment;

-- AHC sees and edits everything: renaming and retiring entries is theirs.
create policy "ahc_read_project_equipment" on public.project_equipment
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));

create policy "ahc_write_project_equipment" on public.project_equipment
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

-- A sub sees only their own crew's equipment. Same profiles.subcontractor_id
-- -> subcontractors path that 0029 used to fix the empty WBS/sub dropdowns.
create policy "sub_read_project_equipment" on public.project_equipment
  for select to authenticated
  using (
    public.current_user_role() in ('sub_pm', 'sub_foreman')
    and subcontractor_id in (
      select subcontractor_id
      from public.profiles
      where id = auth.uid()
    )
  );

-- A sub can ADD to their own list (the inline "add new" on the form) but not
-- update or delete: a foreman showing up with an unlisted machine on a
-- Saturday is not blocked, and nobody can rename an entry out from under the
-- rest of their crew.
create policy "sub_insert_project_equipment" on public.project_equipment
  for insert to authenticated
  with check (
    public.current_user_role() in ('sub_pm', 'sub_foreman')
    and subcontractor_id in (
      select subcontractor_id
      from public.profiles
      where id = auth.uid()
    )
  );

-- ============ LINK FROM THE DAILY ROW ============
--
-- equipment_id is nullable and equipment_name keeps being written next to it.
-- That is on purpose: legacy rows predate the catalog and have no id, and a
-- catalog entry that is later renamed must not silently rewrite what last
-- March's report says was on site. The name is the historical record; the id
-- is the join for reporting.

alter table public.dpr_equipment
  add column if not exists equipment_id uuid
    references public.project_equipment(id) on delete set null;

create index if not exists dpr_equipment_catalog_idx
  on public.dpr_equipment(equipment_id);

-- ============ BACKFILL ============
--
-- Seeds each sub's catalog from the equipment they have already reported, so
-- nobody opens an empty dropdown on day one. Names are trimmed and deduped
-- case-insensitively; the earliest spelling of a name wins, which is arbitrary
-- but stable across re-runs. Only Field Report era rows qualify - legacy DPRs
-- left dprs.subcontractor_id null and there is no crew to attribute them to.

insert into public.project_equipment (project_id, subcontractor_id, name)
select distinct on (d.subcontractor_id, lower(btrim(e.equipment_name)))
  d.project_id,
  d.subcontractor_id,
  btrim(e.equipment_name)
from public.dpr_equipment e
join public.dprs d on d.id = e.dpr_id
where d.subcontractor_id is not null
  and d.project_id is not null
  and btrim(coalesce(e.equipment_name, '')) <> ''
order by
  d.subcontractor_id,
  lower(btrim(e.equipment_name)),
  e.created_at asc
on conflict do nothing;

-- Point the existing daily rows at the catalog entries the backfill just made,
-- so the weekly rollup can group on the id for historical weeks too.
update public.dpr_equipment e
set equipment_id = pe.id
from public.dprs d, public.project_equipment pe
where e.dpr_id = d.id
  and e.equipment_id is null
  and d.subcontractor_id = pe.subcontractor_id
  and lower(btrim(e.equipment_name)) = lower(btrim(pe.name));

comment on table public.project_equipment is
  'Per-subcontractor equipment catalog backing the Field Report equipment dropdown. Retire entries with active=false rather than deleting, so historical dpr_equipment rows still resolve.';

comment on column public.dpr_equipment.equipment_id is
  'Catalog entry this row was picked from. Null for legacy rows and for anything added before 0047. equipment_name stays authoritative for what the report SAYS was on site.';
