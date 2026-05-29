-- Phase 4 Sprint C - Pay applications as a first-class object
--
-- Each pay_application is a monthly billing cycle to the owner (typical
-- AIA G702/G703 form). Billing entries get grouped onto a pay_application
-- via billing_entries.pay_application_id (added in migration 0009).
--
-- A separate pay_application_lines table snapshots the exact line items
-- and amounts at the moment the pay app is generated, so historical pay
-- apps stay frozen even if billing_lines or billing_entries change later.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Safe to re-run.

create table if not exists public.pay_applications (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade not null,
  app_number text not null,
  period_start date not null,
  period_end date not null,
  status text default 'draft',
  total_completed numeric(14,2) default 0,
  total_retainage numeric(14,2) default 0,
  previous_billings numeric(14,2) default 0,
  amount_due numeric(14,2) default 0,
  submitted_at timestamptz,
  submitted_by uuid references public.profiles(id),
  approved_at timestamptz,
  approved_by_owner text,
  paid_at timestamptz,
  pdf_storage_path text,
  notes text,
  created_at timestamptz default now(),
  unique (project_id, app_number)
);

create index if not exists pay_applications_project_idx
  on public.pay_applications(project_id);
create index if not exists pay_applications_status_idx
  on public.pay_applications(project_id, status);

alter table public.pay_applications enable row level security;
drop policy if exists "ahc_read_pay_applications"  on public.pay_applications;
drop policy if exists "ahc_write_pay_applications" on public.pay_applications;
create policy "ahc_read_pay_applications" on public.pay_applications
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));
create policy "ahc_write_pay_applications" on public.pay_applications
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

-- ============ PAY APPLICATION LINES ============
-- A snapshot of billing line dollars at the time the pay app is finalized.
-- This is what gets printed on the G703 detail sheet.

create table if not exists public.pay_application_lines (
  id uuid primary key default gen_random_uuid(),
  pay_application_id uuid references public.pay_applications(id) on delete cascade not null,
  billing_line_id uuid references public.billing_lines(id),
  item_number text not null,
  description text not null,
  scheduled_value numeric(14,2) default 0,
  work_completed_previous numeric(14,2) default 0,
  work_completed_this_period numeric(14,2) default 0,
  materials_stored numeric(14,2) default 0,
  total_completed_and_stored numeric(14,2) default 0,
  pct_complete numeric(5,2) default 0,
  balance_to_finish numeric(14,2) default 0,
  retainage_amount numeric(14,2) default 0,
  sort_order integer,
  created_at timestamptz default now()
);

create index if not exists pay_application_lines_app_idx
  on public.pay_application_lines(pay_application_id);

alter table public.pay_application_lines enable row level security;
drop policy if exists "ahc_read_pay_application_lines"  on public.pay_application_lines;
drop policy if exists "ahc_write_pay_application_lines" on public.pay_application_lines;
create policy "ahc_read_pay_application_lines" on public.pay_application_lines
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));
create policy "ahc_write_pay_application_lines" on public.pay_application_lines
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

-- Add the missing FK on billing_entries.pay_application_id now that the
-- referenced table exists.
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'billing_entries_pay_application_id_fkey'
  ) then
    alter table public.billing_entries
      add constraint billing_entries_pay_application_id_fkey
      foreign key (pay_application_id)
      references public.pay_applications(id) on delete set null;
  end if;
end$$;
