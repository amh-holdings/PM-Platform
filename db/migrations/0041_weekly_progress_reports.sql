-- 0041_weekly_progress_reports.sql
--
-- The Dimension weekly progress report. Every Monday AHC hands the owner a
-- one-page form: who was on site, what plant, what got built, what is coming,
-- and what is in the way. Every one of those answers already exists in this
-- database - it is sitting in the field reports, the CM log, the equipment
-- rows and the schedule - and it was being re-keyed into a spreadsheet by hand.
--
-- THIS TABLE DOES NOT STORE THE REPORT. It stores the OVERRIDES.
--
-- That is the whole design and it is worth being explicit about. Every field
-- the platform can answer is DERIVED at read time from the underlying rows.
-- A column here is null until a human types something different, and null
-- means "keep using the derived answer". The consequence that matters: a field
-- report that lands on Tuesday for last Thursday silently improves last week's
-- report instead of leaving a stale number frozen in a saved copy. A snapshot
-- table would have frozen the wrong figure the moment Save was pressed.
--
-- Once the report is issued to Dimension it stops moving - `issued_at` freezes
-- the derived values into `issued_payload` so what was sent can always be
-- reproduced exactly, which is the one place a snapshot IS the right answer.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Additive and idempotent - safe to re-run.

create table if not exists public.weekly_progress_reports (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade not null,

  -- The date in Dimension's "Week Ending" box. It is the date on the form,
  -- not necessarily the last day of work - Sweet Springs reports on Monday for
  -- the week that ended the Friday before. So the covered window is stored
  -- separately rather than inferred, because inferring it wrongly silently
  -- reports the wrong seven days.
  week_ending date not null,
  period_start date not null,
  period_end date not null,
  constraint weekly_progress_reports_period_ck check (period_start <= period_end),

  status text not null default 'draft' check (status in ('draft', 'issued')),

  -- ---- Header. Human-entered, carried forward from last week's report. ----
  dimension_cm text,
  epc_reporting_manager text,
  epc_team text,

  -- ---- Narrative overrides. null = use the derived draft. ----
  environment_concerns text,
  security_concerns text,
  weather_summary text,
  work_this_week text,
  lookahead_note text,
  schedule_risks text,
  swppp_inspection_date date,

  -- Expected dates for the four milestones Dimension asks about. Seeded from
  -- schedule milestones where the names match, carried forward otherwise.
  -- Shape: {"mechanicalCompletion": "2026-11-30", ...}. Absent key = derived.
  milestones jsonb not null default '{}'::jsonb,

  -- Per-subcontractor corrections, keyed by subcontractors.id. Shape:
  -- {"<uuid>": {"scope": "Civil", "headcount": 8, "lastOnsite": "2026-08-21",
  --             "endDate": "2026-10-02", "hidden": true}}
  -- `endDate` is the field with no honest derivation - a sub's demob date is a
  -- commercial fact, not something the DPRs know - so it is expected to live
  -- here rather than being guessed.
  contractor_overrides jsonb not null default '{}'::jsonb,
  -- Contractors on site who have no subcontractors row yet (the owner's
  -- surveyor, a testing agency). Shape: [{"name","scope","headcount",...}]
  extra_contractors jsonb not null default '[]'::jsonb,

  -- Same two shapes for plant, keyed by the equipment name as reported.
  equipment_overrides jsonb not null default '{}'::jsonb,
  extra_equipment jsonb not null default '[]'::jsonb,

  -- ---- Issue ----
  -- The frozen copy of everything derived, written once at issue. Null while
  -- the report is a draft.
  issued_payload jsonb,
  issued_at timestamptz,
  issued_by uuid references public.profiles(id),

  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

-- One report per week per project. The page upserts on this, so a second
-- browser tab editing the same week updates the row rather than forking it.
create unique index if not exists weekly_progress_reports_week_uniq
  on public.weekly_progress_reports(project_id, week_ending);

-- "Show me this project's reports, newest first" is the only list query.
create index if not exists weekly_progress_reports_project_idx
  on public.weekly_progress_reports(project_id, week_ending desc);

-- A report that says it is issued must carry the evidence of the issue. Draft
-- rows must not carry a stale frozen payload from an un-issue.
alter table public.weekly_progress_reports
  drop constraint if exists weekly_progress_reports_issued_ck;
alter table public.weekly_progress_reports
  add constraint weekly_progress_reports_issued_ck check (
    (status = 'issued' and issued_at is not null and issued_payload is not null)
    or (status = 'draft' and issued_at is null and issued_payload is null)
  );

alter table public.weekly_progress_reports enable row level security;

drop policy if exists "ahc_read_weekly_reports"  on public.weekly_progress_reports;
drop policy if exists "ahc_write_weekly_reports" on public.weekly_progress_reports;

-- Read is AHC-wide: the CM writes most of what goes in it and has to be able
-- to check what was sent in his name.
create policy "ahc_read_weekly_reports" on public.weekly_progress_reports
  for select to authenticated
  using (public.current_user_role() in ('phil', 'zarina', 'ahc_super'));

-- Write is AHC-wide too, and deliberately NOT extended to subs. This is an
-- outbound document to the owner; a sub contributing to it does so through
-- their field report, which is the record that can be reviewed.
create policy "ahc_write_weekly_reports" on public.weekly_progress_reports
  for all to authenticated
  using (public.current_user_role() in ('phil', 'zarina', 'ahc_super'))
  with check (public.current_user_role() in ('phil', 'zarina', 'ahc_super'));

comment on table public.weekly_progress_reports is
  'Overrides for the Dimension weekly progress report. Everything not stored here is derived live from field reports, the CM log and the schedule.';
comment on column public.weekly_progress_reports.issued_payload is
  'Frozen copy of the derived values at the moment of issue, so a sent report can always be reproduced exactly.';
comment on column public.weekly_progress_reports.week_ending is
  'The date in Dimension''s Week Ending box - the date on the form, which is not always the last day of the covered window. See period_start/period_end.';
