-- DPR field-capture expansion (Phase 5 Sprint A)
--
-- Adds the structured child tables that let foremen capture what actually
-- happened on site beyond crew+hours+narrative:
--   1. dpr_manpower  - per-sub / per-trade headcount + hours breakdown
--   2. dpr_equipment - equipment present (with on/off-rent flag)
--   3. dpr_deliveries - materials delivered, optional procurement_order link
--   4. dpr_delays    - structured delay rows with cause code + hours lost
--
-- Also activates RLS on photos so the in-DPR uploader can write rows, and
-- adds storage.objects policies for the new dpr-photos bucket.
--
-- The existing dprs.equipment_on_site / deliveries / delays jsonb columns
-- stay in place for backward compat. New UI writes to the child tables.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Safe to re-run.

-- ============ DPR MANPOWER ============

create table if not exists public.dpr_manpower (
  id uuid primary key default gen_random_uuid(),
  dpr_id uuid references public.dprs(id) on delete cascade not null,
  subcontractor_id uuid references public.subcontractors(id) on delete set null,
  trade text,
  headcount integer not null default 0,
  regular_hours numeric(8,2) not null default 0,
  ot_hours numeric(8,2) not null default 0,
  notes text,
  created_at timestamptz default now()
);

create index if not exists dpr_manpower_dpr_idx on public.dpr_manpower(dpr_id);
create index if not exists dpr_manpower_sub_idx on public.dpr_manpower(subcontractor_id);

alter table public.dpr_manpower enable row level security;
drop policy if exists "ahc_read_dpr_manpower"  on public.dpr_manpower;
drop policy if exists "ahc_write_dpr_manpower" on public.dpr_manpower;
create policy "ahc_read_dpr_manpower" on public.dpr_manpower
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super','sub_pm','sub_foreman'));
create policy "ahc_write_dpr_manpower" on public.dpr_manpower
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super','sub_pm','sub_foreman'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super','sub_pm','sub_foreman'));

-- ============ DPR EQUIPMENT ============

create table if not exists public.dpr_equipment (
  id uuid primary key default gen_random_uuid(),
  dpr_id uuid references public.dprs(id) on delete cascade not null,
  equipment_name text not null,
  quantity integer default 1,
  on_rent boolean default false,
  rental_company text,
  notes text,
  created_at timestamptz default now()
);

create index if not exists dpr_equipment_dpr_idx on public.dpr_equipment(dpr_id);

alter table public.dpr_equipment enable row level security;
drop policy if exists "ahc_read_dpr_equipment"  on public.dpr_equipment;
drop policy if exists "ahc_write_dpr_equipment" on public.dpr_equipment;
create policy "ahc_read_dpr_equipment" on public.dpr_equipment
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super','sub_pm','sub_foreman'));
create policy "ahc_write_dpr_equipment" on public.dpr_equipment
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super','sub_pm','sub_foreman'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super','sub_pm','sub_foreman'));

-- ============ DPR DELIVERIES ============

create table if not exists public.dpr_deliveries (
  id uuid primary key default gen_random_uuid(),
  dpr_id uuid references public.dprs(id) on delete cascade not null,
  vendor_name text,
  materials text not null,
  quantity numeric(14,2),
  unit_of_measure text,
  po_number text,
  procurement_order_id uuid references public.procurement_orders(id) on delete set null,
  notes text,
  created_at timestamptz default now()
);

create index if not exists dpr_deliveries_dpr_idx on public.dpr_deliveries(dpr_id);
create index if not exists dpr_deliveries_po_idx on public.dpr_deliveries(procurement_order_id);

alter table public.dpr_deliveries enable row level security;
drop policy if exists "ahc_read_dpr_deliveries"  on public.dpr_deliveries;
drop policy if exists "ahc_write_dpr_deliveries" on public.dpr_deliveries;
create policy "ahc_read_dpr_deliveries" on public.dpr_deliveries
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super','sub_pm','sub_foreman'));
create policy "ahc_write_dpr_deliveries" on public.dpr_deliveries
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super','sub_pm','sub_foreman'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super','sub_pm','sub_foreman'));

-- ============ DPR DELAYS ============
-- cause_code values are free text for now but the UI offers a fixed list:
--   weather, manpower, materials, equipment, design, owner, inspection,
--   permitting, utility, safety, other

create table if not exists public.dpr_delays (
  id uuid primary key default gen_random_uuid(),
  dpr_id uuid references public.dprs(id) on delete cascade not null,
  cause_code text not null,
  hours_lost numeric(6,2),
  impacted_schedule_task_id uuid references public.schedule_tasks(id) on delete set null,
  narrative text,
  created_at timestamptz default now()
);

create index if not exists dpr_delays_dpr_idx on public.dpr_delays(dpr_id);
create index if not exists dpr_delays_cause_idx on public.dpr_delays(cause_code);
create index if not exists dpr_delays_task_idx on public.dpr_delays(impacted_schedule_task_id);

alter table public.dpr_delays enable row level security;
drop policy if exists "ahc_read_dpr_delays"  on public.dpr_delays;
drop policy if exists "ahc_write_dpr_delays" on public.dpr_delays;
create policy "ahc_read_dpr_delays" on public.dpr_delays
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super','sub_pm','sub_foreman'));
create policy "ahc_write_dpr_delays" on public.dpr_delays
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super','sub_pm','sub_foreman'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super','sub_pm','sub_foreman'));

-- ============ DPRS TABLE: RLS policies ============
-- dprs has RLS enabled in schema.sql but no policies, so all access is denied
-- today. Add the same role-gated policies as the child tables.

drop policy if exists "ahc_read_dprs"  on public.dprs;
drop policy if exists "ahc_write_dprs" on public.dprs;
create policy "ahc_read_dprs" on public.dprs
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super','sub_pm','sub_foreman'));
create policy "ahc_write_dprs" on public.dprs
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super','sub_pm','sub_foreman'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super','sub_pm','sub_foreman'));

-- ============ PHOTOS: RLS policies ============

drop policy if exists "ahc_read_photos"  on public.photos;
drop policy if exists "ahc_write_photos" on public.photos;
create policy "ahc_read_photos" on public.photos
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super','sub_pm','sub_foreman'));
create policy "ahc_write_photos" on public.photos
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super','sub_pm','sub_foreman'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super','sub_pm','sub_foreman'));

-- ============ RFIS / SUBMITTALS: read policies for daily dashboard widget ============
-- The daily dashboard needs to count open RFIs / pending submittals, so
-- enable read access for the same role tier. Writes stay closed until the
-- RFI / submittal UI ships.

drop policy if exists "ahc_read_rfis"  on public.rfis;
drop policy if exists "ahc_write_rfis" on public.rfis;
create policy "ahc_read_rfis" on public.rfis
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super','sub_pm','sub_foreman'));
create policy "ahc_write_rfis" on public.rfis
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

drop policy if exists "ahc_read_submittals"  on public.submittals;
drop policy if exists "ahc_write_submittals" on public.submittals;
create policy "ahc_read_submittals" on public.submittals
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super','sub_pm','sub_foreman'));
create policy "ahc_write_submittals" on public.submittals
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

-- ============ STORAGE: dpr-photos bucket ============
-- Create the bucket via the Supabase dashboard (Storage -> New bucket ->
-- name 'dpr-photos', PRIVATE). File path convention:
--   {project_id}/{dpr_id}/{photo_id}-{filename}
-- All reads go through signed URLs from the server.

drop policy if exists "ahc_read_dpr_photo_objects"   on storage.objects;
drop policy if exists "ahc_write_dpr_photo_objects"  on storage.objects;
drop policy if exists "ahc_update_dpr_photo_objects" on storage.objects;
drop policy if exists "ahc_delete_dpr_photo_objects" on storage.objects;

create policy "ahc_read_dpr_photo_objects" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'dpr-photos'
    and public.current_user_role() in ('phil','zarina','ahc_super','sub_pm','sub_foreman')
  );

create policy "ahc_write_dpr_photo_objects" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'dpr-photos'
    and public.current_user_role() in ('phil','zarina','ahc_super','sub_pm','sub_foreman')
  );

create policy "ahc_update_dpr_photo_objects" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'dpr-photos'
    and public.current_user_role() in ('phil','zarina','ahc_super','sub_pm','sub_foreman')
  )
  with check (
    bucket_id = 'dpr-photos'
    and public.current_user_role() in ('phil','zarina','ahc_super','sub_pm','sub_foreman')
  );

create policy "ahc_delete_dpr_photo_objects" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'dpr-photos'
    and public.current_user_role() in ('phil','zarina','ahc_super')
  );
