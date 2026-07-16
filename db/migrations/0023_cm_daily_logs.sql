-- CM Daily Log (Phase 6)
--
-- A lightweight daily log authored by the Construction Manager, distinct from
-- the subcontractor Field Reports (dprs + work pins). It has no work pins and
-- no sub review cycle - the CM writes it and it stands as his own record of
-- overall site conditions, progress, and safety for the day.
--
-- Access is restricted to the AHC team (phil / zarina / ahc_super) - the
-- effective "CM" and "full" roles. Subcontractors never see it.
--
-- Photos reuse the existing PRIVATE 'dpr-photos' bucket (created in migration
-- 0014). Its storage.objects policies already grant the AHC team read/write
-- across the whole bucket, so the 'cm-logs/' path prefix needs no new policy.
-- File path convention: {project_id}/cm-logs/{log_id}/{photo_id}-{filename}
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx). Safe to re-run.

-- ============ CM DAILY LOGS ============

create table if not exists public.cm_daily_logs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade not null,
  author_id uuid references public.profiles(id),
  log_date date not null,
  weather_conditions text,
  temp_high numeric,
  temp_low numeric,
  site_conditions text,   -- overall site / access conditions
  progress_summary text,  -- overall progress narrative
  safety_notes text,
  created_at timestamptz default now(),
  unique (project_id, log_date)  -- one CM log per project per day
);

create index if not exists cm_daily_logs_project_idx
  on public.cm_daily_logs(project_id);

alter table public.cm_daily_logs enable row level security;
drop policy if exists "cm_read_cm_daily_logs"  on public.cm_daily_logs;
drop policy if exists "cm_write_cm_daily_logs" on public.cm_daily_logs;
create policy "cm_read_cm_daily_logs" on public.cm_daily_logs
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));
create policy "cm_write_cm_daily_logs" on public.cm_daily_logs
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

-- ============ CM DAILY LOG PHOTOS ============

create table if not exists public.cm_daily_log_photos (
  id uuid primary key default gen_random_uuid(),
  cm_daily_log_id uuid references public.cm_daily_logs(id) on delete cascade not null,
  storage_path text not null,
  caption text,
  uploaded_by uuid references public.profiles(id),
  created_at timestamptz default now()
);

create index if not exists cm_daily_log_photos_log_idx
  on public.cm_daily_log_photos(cm_daily_log_id);

alter table public.cm_daily_log_photos enable row level security;
drop policy if exists "cm_read_cm_daily_log_photos"  on public.cm_daily_log_photos;
drop policy if exists "cm_write_cm_daily_log_photos" on public.cm_daily_log_photos;
create policy "cm_read_cm_daily_log_photos" on public.cm_daily_log_photos
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));
create policy "cm_write_cm_daily_log_photos" on public.cm_daily_log_photos
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));
