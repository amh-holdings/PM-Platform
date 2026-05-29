-- Phase 4 Sprint A+B - DPR task updates + schedule pct/quantity + billing entry lifecycle
--
-- 1. Adds pct_complete, last_dpr_at, status_source, target_quantity,
--    installed_quantity, unit_of_measure to schedule_tasks so DPRs can
--    report richer progress than just status.
-- 2. Adds dpr_task_updates table: one row per (DPR, schedule_task) capturing
--    the proposed status/pct change that gets applied when the DPR is
--    approved.
-- 3. Adds status, reviewed_at, reviewed_by to billing_entries so the
--    forecast -> reviewed -> on-AFP -> submitted -> paid lifecycle is
--    explicit instead of inferred from period_month vs today.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Safe to re-run.

-- ============ SCHEDULE TASKS RICHER PROGRESS ============

alter table public.schedule_tasks
  add column if not exists pct_complete numeric(5,2),
  add column if not exists last_dpr_at timestamptz,
  add column if not exists status_source text default 'manual',
  add column if not exists target_quantity numeric(14,3),
  add column if not exists installed_quantity numeric(14,3),
  add column if not exists unit_of_measure text;

create index if not exists schedule_tasks_pct_complete_idx
  on public.schedule_tasks(project_id, pct_complete);

-- ============ DPR TASK UPDATES ============

create table if not exists public.dpr_task_updates (
  id uuid primary key default gen_random_uuid(),
  dpr_id uuid references public.dprs(id) on delete cascade not null,
  schedule_task_id uuid references public.schedule_tasks(id) on delete cascade not null,
  previous_status text,
  new_status text,
  previous_pct_complete numeric(5,2),
  new_pct_complete numeric(5,2),
  installed_quantity numeric(14,3),
  notes text,
  created_at timestamptz default now(),
  unique (dpr_id, schedule_task_id)
);

create index if not exists dpr_task_updates_dpr_idx
  on public.dpr_task_updates(dpr_id);
create index if not exists dpr_task_updates_task_idx
  on public.dpr_task_updates(schedule_task_id);

alter table public.dpr_task_updates enable row level security;
drop policy if exists "ahc_read_dpr_task_updates"  on public.dpr_task_updates;
drop policy if exists "ahc_write_dpr_task_updates" on public.dpr_task_updates;
create policy "ahc_read_dpr_task_updates" on public.dpr_task_updates
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super','sub_pm','sub_foreman'));
create policy "ahc_write_dpr_task_updates" on public.dpr_task_updates
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super','sub_pm','sub_foreman'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super','sub_pm','sub_foreman'));

-- ============ BILLING ENTRY LIFECYCLE ============
-- Status values:
--   forecast        - default; from the original cash-flow import
--   suggested       - auto-suggested from schedule (via promote-to-planned)
--   reviewed        - AHC PM has reviewed the proposed amount for this period
--   on_pay_app      - included on a draft pay application (Sprint C)
--   submitted       - pay app submitted to owner
--   approved        - owner approved pay app
--   paid            - owner paid the AFP

alter table public.billing_entries
  add column if not exists status text default 'forecast',
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references public.profiles(id),
  add column if not exists pay_application_id uuid;

create index if not exists billing_entries_status_idx
  on public.billing_entries(status);
create index if not exists billing_entries_pay_app_idx
  on public.billing_entries(pay_application_id);
