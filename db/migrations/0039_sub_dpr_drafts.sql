-- Subcontractor Daily Field Report - draft / submit lifecycle
--
-- The sub's Field Report was create-once: the form held everything in browser
-- state and `submitFieldReport` wrote the dprs row already stamped
-- 'submitted'. A sub could not start a report in the morning, add to it
-- through the day, and file it at quitting time - closing the tab lost the
-- work. This brings it in line with the CM Daily Log (migration 0031):
--
--   status = 'draft'      -> editable by the sub who owns it.
--   status = 'submitted'  -> LOCKED to the sub; it is now the CM's to review.
--
-- The dprs.status enum already contains 'draft' (schema.sql) and it is already
-- the column default, so no type change is needed here.
--
-- WHY draft_payload IS JSON AND NOT inspections ROWS
-- A submitted Field Report's work pins are `inspections` rows (origin='sub').
-- Draft pins deliberately do NOT go there. Two reasons:
--   1. `inspections` is read by the CM review board, the pin map, and the
--      approve-progress-to-schedule path. Draft rows in that table would have
--      to be filtered out at every one of those call sites, and any miss is a
--      draft leaking into review or into a pay application.
--   2. A saved draft routinely contains a HALF-FILLED pin - the form's
--      `confirmed: false` state, missing a WBS or a photo. An inspections row
--      cannot represent that; it would fail the same validation the pin editor
--      enforces.
-- So the whole unsubmitted form state (pins, manpower, equipment, deliveries,
-- delays, photo metadata) is parked in draft_payload, and submit materializes
-- the real child rows through the existing single write path. A draft is
-- therefore structurally incapable of reaching review or billing.
--
-- Photo BLOBS are already uploaded to dpr-photos/{projectId}/_drafts/... by
-- the client uploader before save, so draft_payload carries only their storage
-- paths - the same convention submitDpr already uses.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx). Safe to re-run.

alter table public.dprs
  add column if not exists draft_payload jsonb,
  add column if not exists updated_at timestamptz default now();

-- Backfill: every existing row predates the draft concept and is already past
-- the draft stage, so stamp updated_at from created_at rather than now().
update public.dprs
  set updated_at = coalesce(created_at, now())
  where updated_at is null;

-- Finding a sub's open draft is a hot path (the "resume today's report" lookup
-- on /field-reports/new runs on every visit). Index only the drafts.
create index if not exists dprs_draft_lookup_idx
  on public.dprs(project_id, subcontractor_id, report_date)
  where status = 'draft';

-- A submitted/approved report must never keep a draft_payload hanging around:
-- it would be a stale second copy of the record, and the substantiation package
-- has to have exactly one source of truth. submitFieldReport nulls it on
-- promote; this enforces it at the table.
alter table public.dprs
  drop constraint if exists dprs_draft_payload_only_when_draft;
alter table public.dprs
  add constraint dprs_draft_payload_only_when_draft
  check (draft_payload is null or status = 'draft');
