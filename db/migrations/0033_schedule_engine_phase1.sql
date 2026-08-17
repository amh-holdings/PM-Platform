-- 0033_schedule_engine_phase1.sql
--
-- Phase 1 of the schedule engine work: the pieces that make a forecast
-- defensible rather than merely plausible.
--
--   1. Date constraints. Until now a task's start_date acted as an implicit
--      "no earlier than" and there was no way to say a date is HARD. An
--      interconnection window and a preferred start look identical to the
--      engine, so the critical path cannot distinguish a real gate from a
--      guess.
--
--   2. Milestones. durationOf() floors every task at one day, so Permit
--      Closeout occupies a working day it does not actually consume and every
--      milestone finish reads a day late.
--
--   3. Data date. Every calculation currently keys off today(), so re-opening
--      last month's update recalculates it against today and no two people
--      ever see the same numbers. A schedule update has to be reproducible or
--      it cannot support a delay claim.
--
--   4. Project calendar. The work week and the holiday list are compiled into
--      the source. Civil solar work is weather-driven and rain days are the
--      single most common reason a week is lost, with no way to record one.
--
--   5. Schedule updates. Migration 0032's own note records that the civil
--      re-baseline destroyed the July dates and the only surviving copy was a
--      JSON file on disk. An update snapshot is immutable and keyed to a data
--      date, so that cannot happen again and so update-over-update variance
--      becomes computable.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Additive and idempotent - safe to re-run.

-- ============================================================================
-- 1. Date constraints and milestones on schedule_tasks
-- ============================================================================

-- Named date_constraint_* rather than constraint_* so it is never confused
-- with the constraint LOG added in 0034, which is a different idea entirely:
-- this is a date bound the engine honours, that is a blocker a human clears.
alter table public.schedule_tasks
  add column if not exists date_constraint_type text;

alter table public.schedule_tasks
  add column if not exists date_constraint_date date;

alter table public.schedule_tasks
  add column if not exists is_milestone boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'schedule_tasks_date_constraint_type_chk'
  ) then
    alter table public.schedule_tasks
      add constraint schedule_tasks_date_constraint_type_chk
      check (date_constraint_type is null or date_constraint_type in (
        'SNET',  -- Start No Earlier Than
        'SNLT',  -- Start No Later Than
        'FNET',  -- Finish No Earlier Than
        'FNLT',  -- Finish No Later Than
        'MSO',   -- Must Start On
        'MFO'    -- Must Finish On
      ));
  end if;
end $$;

-- A constraint type without a date is meaningless and a date without a type is
-- ambiguous. Enforced together so half-entered constraints cannot reach the
-- engine, where they would silently do nothing.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'schedule_tasks_date_constraint_pair_chk'
  ) then
    alter table public.schedule_tasks
      add constraint schedule_tasks_date_constraint_pair_chk
      check (
        (date_constraint_type is null and date_constraint_date is null)
        or (date_constraint_type is not null and date_constraint_date is not null)
      );
  end if;
end $$;

create index if not exists schedule_tasks_constraint_idx
  on public.schedule_tasks(project_id, date_constraint_type)
  where date_constraint_type is not null;

comment on column public.schedule_tasks.date_constraint_type is
  'Hard date bound honoured by CPM. SNET/SNLT/FNET/FNLT/MSO/MFO. Null means the task floats on its logic.';
comment on column public.schedule_tasks.is_milestone is
  'Zero-duration event. A milestone consumes no working days and its start equals its finish.';

-- ============================================================================
-- 2. Data date and work week on projects
-- ============================================================================

-- The data date is the "as of" line: everything left of it is actual, right of
-- it is forecast. Null falls back to today, which is the behaviour before this
-- migration, so nothing breaks on a project that has not set one.
alter table public.projects
  add column if not exists schedule_data_date date;

alter table public.projects
  add column if not exists work_week smallint not null default 5;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'projects_work_week_chk'
  ) then
    alter table public.projects
      add constraint projects_work_week_chk check (work_week in (5, 6));
  end if;
end $$;

comment on column public.projects.schedule_data_date is
  'As-of date for schedule calculations. Null means today. Set it to make an update reproducible.';

-- ============================================================================
-- 3. Project calendar exceptions
-- ============================================================================

-- Two kinds, and the direction matters:
--   nonworking - a day that would otherwise be worked and was not (rain,
--                shutdown, a holiday the crew takes that the built-in list
--                does not carry)
--   working    - a day that would otherwise be skipped and was worked
--                (a Saturday recovery push, working through Labor Day)
create table if not exists public.project_calendar_exceptions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade not null,
  exception_date date not null,
  kind text not null check (kind in ('nonworking', 'working')),
  reason text,
  created_at timestamptz default now(),
  created_by uuid references public.profiles(id),
  unique (project_id, exception_date)
);

create index if not exists project_calendar_exceptions_project_idx
  on public.project_calendar_exceptions(project_id, exception_date);

alter table public.project_calendar_exceptions enable row level security;

drop policy if exists "ahc_read_calendar"  on public.project_calendar_exceptions;
drop policy if exists "ahc_write_calendar" on public.project_calendar_exceptions;
drop policy if exists "sub_read_calendar"  on public.project_calendar_exceptions;

create policy "ahc_read_calendar" on public.project_calendar_exceptions
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));

create policy "ahc_write_calendar" on public.project_calendar_exceptions
  for all to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'))
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

-- Subs read the calendar for their own projects. A look-ahead that shows work
-- on a day the job is shut down is worse than no look-ahead, and the sub is
-- the person who acts on it.
create policy "sub_read_calendar" on public.project_calendar_exceptions
  for select to authenticated
  using (
    public.current_user_role() in ('sub_pm', 'sub_foreman')
    and project_id in (
      select s.project_id
      from public.subcontractors s
      join public.profiles p on p.subcontractor_id = s.id
      where p.id = auth.uid()
    )
  );

-- ============================================================================
-- 4. Schedule updates - immutable snapshots
-- ============================================================================

-- One row per schedule update, holding the full task set as it stood at that
-- data date. Deliberately denormalised into jsonb: the point is a frozen copy
-- that later edits, re-baselines and task deletions cannot reach. A snapshot
-- that follows the live rows is not evidence of anything.
create table if not exists public.schedule_updates (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade not null,
  data_date date not null,
  label text,
  notes text,

  -- Headline numbers, denormalised so the update history renders without
  -- re-running CPM over every snapshot.
  planned_finish date,
  projected_finish date,
  finish_slip_days integer,
  task_count integer,
  critical_count integer,
  health_score integer,

  -- Full frozen copy of every schedule_tasks row at this data date.
  tasks jsonb not null,

  taken_at timestamptz default now(),
  taken_by uuid references public.profiles(id),

  unique (project_id, data_date)
);

create index if not exists schedule_updates_project_idx
  on public.schedule_updates(project_id, data_date desc);

alter table public.schedule_updates enable row level security;

drop policy if exists "ahc_read_updates"   on public.schedule_updates;
drop policy if exists "ahc_insert_updates" on public.schedule_updates;
drop policy if exists "phil_delete_updates" on public.schedule_updates;

create policy "ahc_read_updates" on public.schedule_updates
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super','owner','counsel'));

-- Insert only. No update policy, by design: an update snapshot that can be
-- edited after the fact is not a snapshot. Correcting one means taking a new
-- one at a new data date, which leaves both on the record.
create policy "ahc_insert_updates" on public.schedule_updates
  for insert to authenticated
  with check (public.current_user_role() in ('phil','zarina','ahc_super'));

-- Deleting is Phil's alone, for backing out a snapshot taken by mistake.
create policy "phil_delete_updates" on public.schedule_updates
  for delete to authenticated
  using (public.current_user_role() = 'phil');

comment on table public.schedule_updates is
  'Immutable schedule snapshots, one per data date. Insert-only by policy - the record of what the schedule said when.';
