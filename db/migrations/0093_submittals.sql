-- Submittals with a unique submittal number and a cover sheet, 2026-11-24.
--
-- Every document goes to the owner with the AHC submittal cover. The
-- submittal number on it is unique on the project, and a resubmittal gets a
-- new number: "when we revised something we just have to assign a different
-- submittal number." One submittal can carry several documents (the six IFP
-- disciplines on one cover), so it is its own row and each revision points
-- at the submittal it went out on.
--
-- This replaces the control number on recurring reports: a weekly report
-- goes out on a submittal like anything else and carries that number.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx). Safe to re-run.

create table if not exists public.project_submittals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  -- 1, 2, 3 on each project, printed with the prefix as SUS - 0001. Never reused.
  submittal_no integer not null check (submittal_no > 0),
  submitted_on date not null,
  transmitted_for text not null default 'approval'
    check (transmitted_for in ('approval', 'record', 'signature', 'other')),
  transmitted_other text,
  -- The cover's header lines, as printed.
  project_label text,
  to_name text,
  from_name text,
  cc text,
  subject text,
  notes text,
  requested_response_date date,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (project_id, submittal_no)
);

create index if not exists project_submittals_project_idx on public.project_submittals(project_id);

alter table public.project_submittals enable row level security;

drop policy if exists "ahc_read_submittals" on public.project_submittals;
drop policy if exists "ahc_write_submittals" on public.project_submittals;

create policy "ahc_read_submittals" on public.project_submittals
  for select to authenticated
  using (public.current_user_role() in ('phil', 'zarina', 'ahc_super'));

create policy "ahc_write_submittals" on public.project_submittals
  for all to authenticated
  using (public.current_user_role() in ('phil', 'zarina', 'ahc_super'))
  with check (public.current_user_role() in ('phil', 'zarina', 'ahc_super'));

-- Each revision went out on one submittal. Revisions logged before this
-- migration have none.
alter table public.project_deliverable_revisions
  add column if not exists submittal_id uuid references public.project_submittals(id) on delete set null;

create index if not exists project_deliverable_revisions_submittal_idx
  on public.project_deliverable_revisions(submittal_id);

-- The letters in front of the number: Sweet Springs uses "SSS - 0001".
-- Set per project on the Exhibit S page.
alter table public.projects add column if not exists submittal_prefix text;
update public.projects set submittal_prefix = 'SUS'
 where id = '39154377-bd1a-48ea-acdc-5d9b568863c9' and submittal_prefix is null;
update public.projects set submittal_prefix = 'SSS'
 where id = '53cff193-21e4-45ff-833d-43813e8578a0' and submittal_prefix is null;
