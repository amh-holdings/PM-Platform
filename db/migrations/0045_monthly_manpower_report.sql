-- 0045_monthly_manpower_report.sql
--
-- The Monthly Manpower and Incident Report. Every month the owner's Smartsheet
-- form asks two questions about the site: how many man-hours were worked in the
-- period, and what safety incidents happened. One submission carries the hours;
-- one further submission is filed per incident, classified as Near Miss, First
-- Aid, Asset Damage, Recordable or Lost Time.
--
-- Both answers are already in this database and neither was reachable.
--
-- HOURS were reachable but incomplete. Field reports carry `total_man_hours`
-- and `dpr_manpower` carries the per-trade breakdown, so the SUBS' hours have
-- always been there. AHC's own hours - the CM, the supers, anyone on site under
-- our own badge - were recorded nowhere at all, so any total built from field
-- reports alone under-reports the site by every hour our own people worked.
-- That is what the two new columns on `cm_daily_logs` fix: the CM already
-- writes one log per day, so the day's AHC headcount and hours belong on it
-- rather than in a table of their own.
--
-- INCIDENTS were not reachable. A field report carries two booleans -
-- `safety_incident` and `near_miss` - and the owner's form wants five
-- categories. Asset Damage and Lost Time had no representation whatsoever, and
-- "safety_incident = true" cannot tell you whether somebody took a band-aid or
-- went to hospital. So the classification is the thing a human supplies, and
-- this table is where it lands.
--
-- THIS TABLE DOES NOT STORE THE REPORT. It stores the OVERRIDES - the same
-- design as `weekly_progress_reports`, for the same reason. Every figure the
-- platform can answer is DERIVED at read time from the underlying rows, and a
-- column here is null until a human types something different. A field report
-- approved late, or corrected after the fact, silently improves the month it
-- belongs to instead of leaving a stale number frozen in a saved copy.
--
-- The one exception is the same one: `submitted_payload` freezes the derived
-- values at the moment the report is filed with the owner, because what was
-- sent has to be reproducible exactly even after the field record moves.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Additive and idempotent - safe to re-run.

-- ============ AHC STAFF HOURS ON THE CM DAILY LOG ============
--
-- Deliberately headcount + hours rather than a per-person child table. The CM
-- log is already one row per project per day and AHC's own presence on site is
-- a handful of people; a child table would buy a breakdown nobody has asked to
-- report and cost a form nobody would fill in. If per-person ever matters,
-- promote it then - these two columns keep their meaning as the roll-up.
--
-- Both stay nullable, and null means "not recorded", NOT "zero". The report
-- has to be able to tell the difference: a month with no AHC hours entered is
-- an incomplete report, and a month where AHC genuinely was not on site is a
-- complete one. Defaulting these to 0 would silently turn the first into the
-- second.

alter table public.cm_daily_logs
  add column if not exists ahc_headcount integer,
  add column if not exists ahc_man_hours numeric(8,2);

alter table public.cm_daily_logs
  drop constraint if exists cm_daily_logs_ahc_manpower_ck;
alter table public.cm_daily_logs
  add constraint cm_daily_logs_ahc_manpower_ck check (
    (ahc_headcount is null or ahc_headcount >= 0)
    and (ahc_man_hours is null or ahc_man_hours >= 0)
  );

comment on column public.cm_daily_logs.ahc_headcount is
  'AHC staff on site that day (CM, supers, QC). Null means not recorded, not zero - the monthly manpower report reports the difference.';
comment on column public.cm_daily_logs.ahc_man_hours is
  'AHC staff man-hours that day. Feeds the Monthly Manpower report, which under-reports the site without it.';

-- ============ MONTHLY MANPOWER AND INCIDENT REPORT ============

create table if not exists public.monthly_manpower_reports (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade not null,

  -- The month the report is filed for, as YYYY-MM-01. The owner's form asks
  -- for an explicit start and finish date rather than a month, and those are
  -- stored separately: they default to the calendar month but a period that
  -- runs to a cutoff date instead of month-end has to be reportable as what it
  -- actually was, not as what the calendar would have guessed.
  period_month date not null,
  period_start date not null,
  period_end date not null,
  constraint monthly_manpower_reports_period_ck check (period_start <= period_end),

  status text not null default 'draft' check (status in ('draft', 'submitted')),

  -- ---- Man-hours. null = use the derived figure. ----
  --
  -- An override here is the number that goes on the form. It is expected to be
  -- rare and it is shown next to the derived figure with the difference called
  -- out, because a hand-typed total that silently disagrees with the field
  -- record is exactly the thing that gets quoted back at us later.
  manhours_override numeric(10,2),
  constraint monthly_manpower_reports_manhours_ck check (
    manhours_override is null or manhours_override >= 0
  ),
  -- Why the override differs. Required by the form, not by the constraint -
  -- a bare number with no reason is worse than no override.
  manhours_note text,

  -- ---- Incidents ----
  --
  -- Corrections to the incidents the platform found, keyed by candidate key:
  -- `dpr:<uuid>` for one raised by a field report's safety flags, `cm:<date>`
  -- for one raised by the CM log's safety notes. Shape:
  --   {"dpr:<uuid>": {"types": ["first_aid"], "description": "...",
  --                   "occurredOn": "2026-09-14", "hidden": false}}
  --
  -- `types` is the answer to the form's Incident Type checkboxes and is the
  -- whole reason this table exists - nothing in the field record distinguishes
  -- a first aid case from a recordable one.
  --
  -- `hidden` retires a candidate that turned out not to be an incident. The
  -- platform raises candidates from free text, so it will over-raise; a false
  -- positive has to be dismissable or the report cannot be trusted to be
  -- complete.
  incidents jsonb not null default '{}'::jsonb,

  -- Incidents with no trace in the field record at all - reported verbally, or
  -- happening to somebody who files no DPR (a delivery driver, a visitor).
  -- Shape: [{"key","occurredOn","types","description","reportedBy"}]
  extra_incidents jsonb not null default '[]'::jsonb,

  -- Free note carried onto the printed backup sheet, not onto the form.
  note text,

  -- ---- Submission ----
  submitted_payload jsonb,
  submitted_at timestamptz,
  submitted_by uuid references public.profiles(id),

  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

-- One report per month per project. The page upserts on this, so a second
-- browser tab editing the same month updates the row rather than forking it.
create unique index if not exists monthly_manpower_reports_month_uniq
  on public.monthly_manpower_reports(project_id, period_month);

-- "Show me this project's reports, newest first" is the only list query.
create index if not exists monthly_manpower_reports_project_idx
  on public.monthly_manpower_reports(project_id, period_month desc);

-- A report that says it was submitted must carry the evidence. Draft rows must
-- not carry a stale frozen payload from a reopen.
alter table public.monthly_manpower_reports
  drop constraint if exists monthly_manpower_reports_submitted_ck;
alter table public.monthly_manpower_reports
  add constraint monthly_manpower_reports_submitted_ck check (
    (status = 'submitted' and submitted_at is not null and submitted_payload is not null)
    or (status = 'draft' and submitted_at is null and submitted_payload is null)
  );

alter table public.monthly_manpower_reports enable row level security;

drop policy if exists "ahc_read_monthly_manpower"  on public.monthly_manpower_reports;
drop policy if exists "ahc_write_monthly_manpower" on public.monthly_manpower_reports;

-- Read is AHC-wide: the CM supplies most of what goes in it and has to be able
-- to check what was filed in his name.
create policy "ahc_read_monthly_manpower" on public.monthly_manpower_reports
  for select to authenticated
  using (public.current_user_role() in ('phil', 'zarina', 'ahc_super'));

-- Write is AHC-wide and deliberately NOT extended to subs. This is an outbound
-- document to the owner, and the classification of a sub's own injury is not
-- the sub's call to make on our submission. A sub contributes through their
-- field report, which is the record that gets reviewed.
create policy "ahc_write_monthly_manpower" on public.monthly_manpower_reports
  for all to authenticated
  using (public.current_user_role() in ('phil', 'zarina', 'ahc_super'))
  with check (public.current_user_role() in ('phil', 'zarina', 'ahc_super'));

comment on table public.monthly_manpower_reports is
  'Overrides and incident classifications for the owner''s Monthly Manpower and Incident Report. Hours and incident candidates are derived live from field reports and the CM log; only what a human decided is stored here.';
comment on column public.monthly_manpower_reports.incidents is
  'Human classification of each incident candidate, keyed dpr:<uuid> or cm:<date>. The five form categories live here because nothing in the field record distinguishes them.';
comment on column public.monthly_manpower_reports.submitted_payload is
  'Frozen copy of the derived figures at the moment of submission, so a filed report can always be reproduced exactly.';
