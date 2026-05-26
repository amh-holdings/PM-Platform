-- Phase 2 - Project schedule tasks
-- Hierarchical task structure imported from the Smartsheet schedule.
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Safe to re-run.

create table if not exists public.schedule_tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade not null,
  wbs_code text not null,
  task_name text not null,
  description text,
  phase text,
  assigned_to text,
  status text,
  duration_days integer,
  start_date date,
  end_date date,
  predecessors text,
  is_at_risk boolean default false,
  is_internal boolean default false,
  non_ahc_delay boolean default false,
  level_code integer,
  sort_order integer,
  parent_wbs_code text,
  source_row_id text,
  created_at timestamptz default now(),
  unique (project_id, wbs_code)
);

create index if not exists schedule_tasks_project_id_idx on public.schedule_tasks(project_id);
create index if not exists schedule_tasks_phase_idx on public.schedule_tasks(project_id, phase);
create index if not exists schedule_tasks_status_idx on public.schedule_tasks(project_id, status);
create index if not exists schedule_tasks_sort_idx on public.schedule_tasks(project_id, sort_order);

alter table public.schedule_tasks enable row level security;

drop policy if exists "ahc_read_schedule"  on public.schedule_tasks;
drop policy if exists "ahc_write_schedule" on public.schedule_tasks;

create policy "ahc_read_schedule" on public.schedule_tasks
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));

create policy "ahc_write_schedule" on public.schedule_tasks
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));
