-- Exhibit S deliverable revisions, 2026-11-03.
--
-- Phil: "sometimes we changed the design of the equipment so we need to submit
-- new cut sheet for approval." One row per deliverable says where it stands
-- today; it cannot say that Rev 0 went in on 10/2, came back "revise and
-- resubmit", and Rev 1 went in on 11/3 for the new equipment. This table
-- keeps every submission and the owner's answer to it.
--
-- The deliverable's own state follows its latest revision (set by the app):
-- approved or approved as noted is Accepted, submitted is Uploaded, revise
-- and resubmit or rejected is back to In progress.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx). Safe to re-run.

create table if not exists public.project_deliverable_revisions (
  id uuid primary key default gen_random_uuid(),
  deliverable_id uuid not null references public.project_deliverables(id) on delete cascade,
  rev_no integer not null check (rev_no >= 0),
  -- The vYYYY-MM-DD in this revision's file name.
  version_date date not null,
  submitted_on date,
  decision text not null default 'submitted'
    check (decision in ('submitted', 'approved', 'approved_as_noted', 'revise_resubmit', 'rejected')),
  decided_on date,
  -- Why it was resubmitted ("inverter changed to ...") or what the reviewer said.
  notes text,
  file_url text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (deliverable_id, rev_no)
);

create index if not exists project_deliverable_revisions_deliverable_idx
  on public.project_deliverable_revisions(deliverable_id);

alter table public.project_deliverable_revisions enable row level security;

drop policy if exists "ahc_read_deliverable_revisions" on public.project_deliverable_revisions;
drop policy if exists "ahc_write_deliverable_revisions" on public.project_deliverable_revisions;

create policy "ahc_read_deliverable_revisions" on public.project_deliverable_revisions
  for select to authenticated
  using (public.current_user_role() in ('phil', 'zarina', 'ahc_super'));

create policy "ahc_write_deliverable_revisions" on public.project_deliverable_revisions
  for all to authenticated
  using (public.current_user_role() in ('phil', 'zarina', 'ahc_super'))
  with check (public.current_user_role() in ('phil', 'zarina', 'ahc_super'));

-- Recurring reports are numbered: Weekly Progress Report No. 001, 002...
-- The number is assigned once, when the report is added, and never
-- recomputed, so a late report slotted in between does not renumber the
-- ones already sent. A week recorded as missed gets no number.
alter table public.project_deliverables add column if not exists control_no integer;

-- A missed week is a state of its own, with the reason in notes, so the
-- checklist can show the gap and why rather than an unexplained hole.
alter table public.project_deliverables drop constraint if exists project_deliverables_state_check;
alter table public.project_deliverables add constraint project_deliverables_state_check
  check (state in ('not_started', 'in_progress', 'submitted', 'accepted', 'missed', 'not_applicable'));

-- Recurring reports (weekly progress report, weekly minutes, monthly
-- schedule) are now one row per report date. The single undated row the
-- first load put on each project is replaced by them, so it comes off while
-- nothing has been recorded against it.
delete from public.project_deliverables
 where device_id = ''
   and state = 'not_started'
   and file_url is null
   and catalog_key in (
     'I:2-2-weekly-progress-reports-based-on-exhibit-x:weekly-progress-report',
     'I:2-3-weekly-progress-meeting-minutes:weekly-meeting-minutes',
     'I:2-4-monthly-progress-schedules:monthly-progress-schedule'
   );
