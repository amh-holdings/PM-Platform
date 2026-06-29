-- QA/QC Inspection Engine - spatial, two-sided field inspection tied to the
-- site plan. Build Spec "QA/QC Inspection Engine - Approved 2026-06-29".
--
-- Adds three tables:
--   inspections           - the inspection record (pin on the C2.01 basemap,
--                           quantities, inspector, timestamp, GPS, status)
--   inspection_photos      - two photo sets per record: sub submission + AHC
--                           verification (side = 'sub' | 'ahc'); GPS rides on
--                           every photo as a coordinate backup
--   inspection_secure_links - scoped secure-link tokens so a subcontractor can
--                           submit against their own scope with no login
--
-- State machine: submitted -> under_review -> approved | rejected.
--   - Subcontractor submits           => submitted
--   - AHC opens review, attaches verif => under_review
--   - Mark Wooley approves (locks) or rejects (returns to sub for resubmit)
--   - rejected -> submitted on resubmission. approved is terminal/locked.
--
-- Approver: Mark Wooley, single internal gate (role ahc_super). Phil is digest
-- only and is intentionally NOT permitted to decide.
--
-- Inherits the seven-role RLS spine. No table ships without RLS.
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx). Safe to re-run.

-- ============ STATUS ENUM ============
-- Created idempotently (create type has no "if not exists").

do $$
begin
  if not exists (select 1 from pg_type where typname = 'inspection_status') then
    create type inspection_status as enum (
      'submitted',
      'under_review',
      'approved',
      'rejected'
    );
  end if;
end$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'inspection_photo_side') then
    create type inspection_photo_side as enum ('sub', 'ahc');
  end if;
end$$;

-- ============ INSPECTIONS ============

create table if not exists public.inspections (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade not null,
  subcontractor_id uuid references public.subcontractors(id),
  -- Classification (civil inspection types load once Phil signs off content;
  -- the engine is content-independent, so this is a free-text key for now).
  inspection_type text,
  title text not null,
  notes text,
  quantity numeric(14,3),
  unit_of_measure text,
  -- Spatial pin on the basemap. Coordinates are normalised 0..1 of the image
  -- box so they survive any display size. basemap_key selects which sheet
  -- (C2-01 site plan default; C4-51 reserved for E&S overlay).
  basemap_key text not null default 'C2-01',
  pin_x numeric(6,5),
  pin_y numeric(6,5),
  -- Record-level GPS backup (phone GPS rides on every photo too).
  gps_lat numeric(9,6),
  gps_lng numeric(9,6),
  -- Who submitted. submitted_by is null for secure-link (no-login) subs; the
  -- name they typed is captured in inspector_name for the accountability trail.
  inspector_name text,
  submitted_by uuid references public.profiles(id),
  submitted_via_link uuid, -- references inspection_secure_links(id), set below
  status inspection_status not null default 'submitted',
  submitted_at timestamptz default now(),
  -- AHC review side.
  review_started_at timestamptz,
  reviewed_by uuid references public.profiles(id),
  ahc_notes text,
  -- Final decision (Mark Wooley).
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,
  decision_notes text, -- rejection reason / approval note
  -- Sub's acknowledgement of the verified record = dispute-protection trail.
  sub_acknowledged_at timestamptz,
  resubmission_count integer not null default 0,
  created_at timestamptz default now(),
  constraint inspections_pin_x_range check (pin_x is null or (pin_x >= 0 and pin_x <= 1)),
  constraint inspections_pin_y_range check (pin_y is null or (pin_y >= 0 and pin_y <= 1))
);

create index if not exists inspections_project_idx on public.inspections(project_id);
create index if not exists inspections_status_idx on public.inspections(project_id, status);
create index if not exists inspections_sub_idx on public.inspections(subcontractor_id);

-- ============ INSPECTION PHOTOS ============
-- Two sets on one record, distinguished by side. The blob lives in the
-- 'inspection-photos' storage bucket; this row is the metadata + GPS backup.

create table if not exists public.inspection_photos (
  id uuid primary key default gen_random_uuid(),
  inspection_id uuid references public.inspections(id) on delete cascade not null,
  side inspection_photo_side not null,
  storage_path text not null,
  caption text,
  gps_lat numeric(9,6),
  gps_lng numeric(9,6),
  taken_at timestamptz,
  uploaded_by uuid references public.profiles(id),
  created_at timestamptz default now()
);

create index if not exists inspection_photos_inspection_idx
  on public.inspection_photos(inspection_id);
create index if not exists inspection_photos_side_idx
  on public.inspection_photos(inspection_id, side);

-- ============ INSPECTION SECURE LINKS ============
-- One scoped token per subcontractor per project. The token holder sees and
-- submits ONLY their own scope. Validated server-side; no portal, no login.

create table if not exists public.inspection_secure_links (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade not null,
  subcontractor_id uuid references public.subcontractors(id) on delete cascade not null,
  token text not null unique,
  label text,
  active boolean not null default true,
  expires_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz default now(),
  last_used_at timestamptz
);

create index if not exists inspection_secure_links_token_idx
  on public.inspection_secure_links(token);
create index if not exists inspection_secure_links_sub_idx
  on public.inspection_secure_links(project_id, subcontractor_id);

-- Wire the deferred FK now that the table exists (idempotent).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'inspections_submitted_via_link_fkey'
  ) then
    alter table public.inspections
      add constraint inspections_submitted_via_link_fkey
      foreign key (submitted_via_link)
      references public.inspection_secure_links(id) on delete set null;
  end if;
end$$;

-- ============ ROW LEVEL SECURITY ============

alter table public.inspections            enable row level security;
alter table public.inspection_photos      enable row level security;
alter table public.inspection_secure_links enable row level security;

-- Helper: does the calling profile own this subcontractor scope?
-- profiles.subcontractor_id ties a sub_pm/sub_foreman to one subcontractor.
create or replace function public.current_user_subcontractor()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select subcontractor_id from public.profiles where id = auth.uid();
$$;

-- ---- inspections ----
drop policy if exists "ahc_read_inspections"   on public.inspections;
drop policy if exists "ahc_write_inspections"  on public.inspections;
drop policy if exists "sub_read_inspections"   on public.inspections;
drop policy if exists "sub_insert_inspections" on public.inspections;

-- AHC team: full read + write (review, verify, decide).
create policy "ahc_read_inspections" on public.inspections
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));

create policy "ahc_write_inspections" on public.inspections
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

-- Owner / counsel: read-only (dispute + owner-portal visibility).
drop policy if exists "owner_counsel_read_inspections" on public.inspections;
create policy "owner_counsel_read_inspections" on public.inspections
  for select to authenticated
  using (public.current_user_role() in ('owner','counsel'));

-- Subs (signed-in variant): read + insert ONLY their own subcontractor scope.
-- The no-login secure-link path runs server-side via the service role instead,
-- constrained in code to the token's subcontractor_id.
create policy "sub_read_inspections" on public.inspections
  for select to authenticated
  using (
    public.current_user_role() in ('sub_pm','sub_foreman')
    and subcontractor_id = public.current_user_subcontractor()
  );

create policy "sub_insert_inspections" on public.inspections
  for insert to authenticated
  with check (
    public.current_user_role() in ('sub_pm','sub_foreman')
    and subcontractor_id = public.current_user_subcontractor()
  );

-- ---- inspection_photos ----
drop policy if exists "ahc_rw_inspection_photos"  on public.inspection_photos;
drop policy if exists "sub_read_inspection_photos" on public.inspection_photos;
drop policy if exists "sub_insert_inspection_photos" on public.inspection_photos;
drop policy if exists "owner_counsel_read_inspection_photos" on public.inspection_photos;

create policy "ahc_rw_inspection_photos" on public.inspection_photos
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

create policy "owner_counsel_read_inspection_photos" on public.inspection_photos
  for select to authenticated
  using (public.current_user_role() in ('owner','counsel'));

-- Subs read photos on their own inspections, and may add their own ('sub' side)
-- photos only.
create policy "sub_read_inspection_photos" on public.inspection_photos
  for select to authenticated
  using (
    public.current_user_role() in ('sub_pm','sub_foreman')
    and exists (
      select 1 from public.inspections i
      where i.id = inspection_id
        and i.subcontractor_id = public.current_user_subcontractor()
    )
  );

create policy "sub_insert_inspection_photos" on public.inspection_photos
  for insert to authenticated
  with check (
    public.current_user_role() in ('sub_pm','sub_foreman')
    and side = 'sub'
    and exists (
      select 1 from public.inspections i
      where i.id = inspection_id
        and i.subcontractor_id = public.current_user_subcontractor()
    )
  );

-- ---- inspection_secure_links ----
-- Only AHC manages tokens. Token validation for the no-login path happens
-- server-side via the service role, never through an authenticated session.
drop policy if exists "ahc_rw_secure_links" on public.inspection_secure_links;
create policy "ahc_rw_secure_links" on public.inspection_secure_links
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

-- ============ STORAGE: inspection-photos bucket ============
-- Create the bucket via the Supabase dashboard (private). File path convention:
--   {project_id}/{inspection_id}/{side}/{file_name}
-- AHC team manages all objects; signed-in subs may read/insert objects under
-- their own inspections is enforced at the app layer for the secure-link path.

drop policy if exists "ahc_read_inspection_objects"   on storage.objects;
drop policy if exists "ahc_write_inspection_objects"  on storage.objects;
drop policy if exists "ahc_update_inspection_objects" on storage.objects;
drop policy if exists "ahc_delete_inspection_objects" on storage.objects;

create policy "ahc_read_inspection_objects" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'inspection-photos'
    and public.current_user_role() in ('phil','zarina','ahc_super','owner','counsel')
  );

create policy "ahc_write_inspection_objects" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'inspection-photos'
    and public.current_user_role() in ('phil','zarina','ahc_super','sub_pm','sub_foreman')
  );

create policy "ahc_update_inspection_objects" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'inspection-photos'
    and public.current_user_role() in ('phil','zarina','ahc_super')
  )
  with check (
    bucket_id = 'inspection-photos'
    and public.current_user_role() in ('phil','zarina','ahc_super')
  );

create policy "ahc_delete_inspection_objects" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'inspection-photos'
    and public.current_user_role() in ('phil','zarina','ahc_super')
  );
