-- Field Reports - merge the DPR and QA/QC inspection engines into one daily
-- workflow. The subcontractor files ONE report per day: the DPR fields plus the
-- work they did marked as pins on the site map. The Construction Manager reviews
-- those pins the next day (approve/reject) and adds his own independent checks.
--
-- Design: reuse existing engines, no new parent table, no enum churn.
--   * The Field Report container IS the existing `dprs` row (one per
--     project/subcontractor/report_date).
--   * Each map-pinned work item IS an `inspections` row linked to that day's DPR
--     via the new `dpr_id` FK. It inherits the pin geometry, two-sided photos,
--     and the submitted -> under_review -> approved/rejected state machine.
--   * `origin` distinguishes the subcontractor's work-done pins ('sub', the
--     default that matches every legacy row) from the CM's own checks ('cm').
--
-- This migration is additive and idempotent: legacy inspections keep
-- dpr_id = null and origin = 'sub'; existing DPRs are untouched.

-- 1. Link a pinned work item / CM check to a day's Field Report (the DPR).
alter table public.inspections
  add column if not exists dpr_id uuid
    references public.dprs(id) on delete set null;

create index if not exists inspections_dpr_idx
  on public.inspections(dpr_id);

-- 2. Origin of the pin. 'sub' = subcontractor work-done pin (default; matches
--    every existing row, which was a subcontractor submission). 'cm' = the
--    Construction Manager's own independent check.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'inspection_origin') then
    create type inspection_origin as enum ('sub', 'cm');
  end if;
end$$;

alter table public.inspections
  add column if not exists origin inspection_origin not null default 'sub';

create index if not exists inspections_origin_idx
  on public.inspections(project_id, origin);

-- 3. No data migration needed: the column defaults cover every existing row.
--    RLS is unchanged - subs already insert inspections scoped to their own
--    subcontractor_id, and the CM/Phil already have full write. The `dpr_id`
--    link is written by the new submitFieldReport / submitCmCheck server actions.
