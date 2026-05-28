-- Phase 3 fixup - v_project_billing_summary.total_scheduled was multi-counting
-- scheduled_value because of the JOIN with billing_entries. Rewrite to compute
-- the two sides in separate CTEs and stitch.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Safe to re-run.

create or replace view public.v_project_billing_summary as
with totals as (
  select project_id,
         coalesce(sum(scheduled_value), 0) as total_scheduled
  from public.billing_lines
  group by project_id
), billed as (
  select bl.project_id,
         coalesce(sum(be.actual_amount), 0)    as total_billed,
         coalesce(sum(be.retainage_amount), 0) as total_retainage,
         coalesce(sum(case when be.period_month > current_date
                           then be.planned_amount else 0 end), 0) as future_planned
  from public.billing_lines bl
  join public.billing_entries be on be.billing_line_id = bl.id
  group by bl.project_id
)
select t.project_id,
       t.total_scheduled,
       coalesce(b.total_billed, 0)    as total_billed,
       coalesce(b.total_retainage, 0) as total_retainage,
       coalesce(b.future_planned, 0)  as future_planned
from totals t
left join billed b on b.project_id = t.project_id;
