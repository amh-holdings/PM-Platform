-- 0053_fix_billing_summary_fanout_again.sql
--
-- v_project_billing_summary.total_scheduled multi-counts. Again.
--
-- THE SAME BUG, TWICE
-- 0006 created the view as a single LEFT JOIN from billing_lines to
-- billing_entries, then summed bl.scheduled_value across it. That counts each
-- line once per monthly entry it has, so a line with three entries contributes
-- three times its value.
--
-- 0007 fixed it: compute the line total and the entry totals in separate CTEs
-- and stitch them. Its header says so in as many words.
--
-- 0037 then rewrote the view to add an AFP-aware total_billed - and rebuilt it
-- from 0006's single-join shape, carrying the broken total_scheduled back in
-- with it. Nothing noticed, because nothing on the page compared it against a
-- second source.
--
-- On Sweet Springs it reports $8,146,994.84 against a $3,787,185.94 schedule of
-- values, which is what the project dashboard called the contract value until
-- today.
--
-- THE FIX
-- 0007's shape, with 0037's AFP-aware total_billed kept intact. total_billed,
-- total_retainage and future_planned were never wrong: they aggregate columns
-- from billing_entries, which the join produces exactly one row of. Only
-- scheduled_value, which belongs to the LINE, was being multiplied.
--
-- The application no longer reads total_scheduled at all - both dashboard
-- components sum billing_lines directly, which cannot fan out - so this is a
-- correctness fix for anything else that reads the view, not a prerequisite.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx). Safe to re-run.

create or replace view public.v_project_billing_summary as
with totals as (
  select project_id,
         coalesce(sum(scheduled_value), 0) as total_scheduled
    from public.billing_lines
   group by project_id
), billed as (
  select bl.project_id,
         coalesce(sum(
           case when be.pay_application_id is not null
                  or be.afp_number is not null
                  or be.status in ('on_pay_app','submitted','approved','paid')
                then be.actual_amount else 0 end
         ), 0) as total_billed,
         coalesce(sum(be.retainage_amount), 0) as total_retainage,
         coalesce(sum(
           case when be.period_month > current_date
                then be.planned_amount else 0 end
         ), 0) as future_planned
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

-- AFTER RUNNING, on Sweet Springs:
--   select total_scheduled from public.v_project_billing_summary
--    where project_id = '<sweet springs id>';
--     -> should read about 3,787,185.94, not 8,146,994.84
