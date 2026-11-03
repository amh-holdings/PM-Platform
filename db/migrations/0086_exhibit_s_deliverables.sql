-- Exhibit S deliverables checklist, 2026-11-03.
--
-- Phil: "build a submittal checklist according to exhibit S, it should
-- suggest as well file name". Exhibit S lists every document the owner's data
-- room must hold before Mechanical, Substantial and Final Completion, each
-- under a fixed name: Project SPV_Item description_Status_vYYYY-MM-DD.
--
-- The catalog itself lives in code (src/lib/exhibit-s.ts), not here. A row
-- is one deliverable on one project, matched to the catalog by catalog_key,
-- so a wording fix in the catalog reaches every project without a migration.
-- Per-device items (inverter photos, switchgear labels) get one row per
-- device, the device named per Exhibit GG.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx). Safe to re-run.

-- The Project SPV name every file starts with. Not the project's display
-- name: Sussex is "Sussexx CSG 1 LLC" in the app and "Sussex CSG 1 LLC" on
-- the owner's paper, and the data room wants the paper.
alter table public.projects add column if not exists spv_name text;

create table if not exists public.project_deliverables (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  catalog_key text not null,
  -- Exhibit GG device ID, or the equipment / road for the free-text kinds.
  -- Empty string, not null, so the unique key below holds.
  device_id text not null default '',
  state text not null default 'not_started'
    check (state in ('not_started', 'in_progress', 'submitted', 'accepted', 'not_applicable')),
  -- The document's own date: the vYYYY-MM-DD in its file name.
  version_date date,
  submitted_on date,
  -- Where it lives once uploaded: the data room link, or a Drive/Egnyte path.
  file_url text,
  notes text,
  updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists project_deliverables_once
  on public.project_deliverables(project_id, catalog_key, device_id);

create index if not exists project_deliverables_project_idx
  on public.project_deliverables(project_id);

alter table public.project_deliverables enable row level security;

drop policy if exists "ahc_read_deliverables" on public.project_deliverables;
drop policy if exists "ahc_write_deliverables" on public.project_deliverables;

create policy "ahc_read_deliverables" on public.project_deliverables
  for select to authenticated
  using (public.current_user_role() in ('phil', 'zarina', 'ahc_super'));

create policy "ahc_write_deliverables" on public.project_deliverables
  for all to authenticated
  using (public.current_user_role() in ('phil', 'zarina', 'ahc_super'))
  with check (public.current_user_role() in ('phil', 'zarina', 'ahc_super'));

comment on table public.project_deliverables is
  'Exhibit S deliverables per project. Catalog and file naming in src/lib/exhibit-s.ts.';
