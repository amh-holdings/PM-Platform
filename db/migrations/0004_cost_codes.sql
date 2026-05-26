-- Phase 2 - Internal cost codes per project
-- AHC tracks actual costs by code (e.g. SSC A-AHC Labor, SSC B-General Conditions).
-- Each project has its own set of cost codes.
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Safe to re-run.

create table if not exists public.cost_codes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade not null,
  code text not null,
  name text not null,
  description text,
  estimated_cost numeric(14,2),
  actual_cost numeric(14,2) default 0,
  is_change_order boolean default false,
  sort_order integer,
  created_at timestamptz default now(),
  unique (project_id, code)
);

create index if not exists cost_codes_project_id_idx on public.cost_codes(project_id);
create index if not exists cost_codes_sort_order_idx on public.cost_codes(project_id, sort_order);

alter table public.cost_codes enable row level security;

drop policy if exists "ahc_read_cost_codes"  on public.cost_codes;
drop policy if exists "ahc_write_cost_codes" on public.cost_codes;

create policy "ahc_read_cost_codes" on public.cost_codes
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));

create policy "ahc_write_cost_codes" on public.cost_codes
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));
