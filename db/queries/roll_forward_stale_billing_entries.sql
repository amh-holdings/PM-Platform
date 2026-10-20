-- Roll unbilled forecast entries forward so nothing is stranded in a closed
-- month.
--
-- Zarina: "can you push it forward so we know everything is billed and we dont
-- missed them and forgotten, there are just somethings we cant bill yet."
--
-- The problem. A billing entry dated in a month that has already been billed,
-- carrying no AFP number and not stamped onto any pay application, is
-- stranded. The next AFP treats anything dated before its period start as
-- PREVIOUS, never as this period, so the amount can never be invoiced from
-- where it sits. The billing page marks these with an amber asterisk on the
-- Previous column; this is how they get unstuck.
--
-- Moving period_month forward is the whole fix. The entry stays a forecast,
-- nothing is billed by running this, and it simply becomes visible in the
-- open period where somebody can decide to bill it or roll it again. Work
-- that cannot be billed yet is meant to be rolled again next month - that is
-- the point, it stays in front of you instead of behind you.
--
-- WHAT IT WILL NOT TOUCH
--   - anything stamped onto a pay application
--   - anything carrying an afp_number
--   - anything whose status is on_pay_app, submitted, approved or paid
-- Those are billed or on their way, and moving one would rewrite history.
--
-- The target month is computed, not typed: the later of this month and the
-- month after the newest pay application period. So it lands in the open
-- period whether or not October has been billed yet.
--
-- READ SECTION 1 FIRST. Section 2 is commented out.
--
-- HOW TO RUN
--   Supabase SQL Editor: paste, Run section 1, read it, then uncomment and
--   run section 2.

-- ===========================================================================
-- 1. What would move, and where to.
-- ===========================================================================
with proj as (
  select id from public.projects where name ilike '%sweet%spring%' limit 1
),
target as (
  select greatest(
           date_trunc('month', current_date)::date,
           (date_trunc('month', coalesce(
              (select max(pa.period_end) from public.pay_applications pa, proj
                where pa.project_id = proj.id),
              current_date
           )) + interval '1 month')::date
         ) as month_start
)
select
  bl.item_number,
  bl.description,
  be.period_month                                as from_month,
  (select month_start from target)               as to_month,
  coalesce(nullif(be.actual_amount, 0), be.planned_amount) as amount,
  be.status,
  be.cash_in_month,
  case
    when be.cash_in_month is not null
         and be.cash_in_month < (select month_start from target)
      then 'CHECK: cash_in_month override is before the new period'
    else ''
  end as flag
from public.billing_entries be
join public.billing_lines bl on bl.id = be.billing_line_id
join proj on proj.id = bl.project_id
where be.pay_application_id is null
  and be.afp_number is null
  and coalesce(be.status, '') not in ('on_pay_app', 'submitted', 'approved', 'paid')
  and be.period_month < (select month_start from target)
  and coalesce(nullif(be.actual_amount, 0), be.planned_amount) > 0
order by be.period_month, bl.item_number;

-- Expect the two rows the audit found:
--   5.05  POI Procurement                           2026-09-01   3,975.25
--   6.02  Civil, Roads and Landscaping if applicable 2026-09-01  80,048.24
--
-- Anything else in this list is another stranded entry and should move too.
-- If a row carries the cash_in_month flag, that override now sits before the
-- period the bill will be raised in. Clear it or move it; this script leaves
-- it alone rather than guessing.

-- ===========================================================================
-- 2. Move them. Uncomment and run.
-- ===========================================================================
-- begin;
--
-- with proj as (
--   select id from public.projects where name ilike '%sweet%spring%' limit 1
-- ),
-- target as (
--   select greatest(
--            date_trunc('month', current_date)::date,
--            (date_trunc('month', coalesce(
--               (select max(pa.period_end) from public.pay_applications pa, proj
--                 where pa.project_id = proj.id),
--               current_date
--            )) + interval '1 month')::date
--          ) as month_start
-- )
-- update public.billing_entries be
--    set period_month = (select month_start from target),
--        -- The old date is kept in the note. A rolled entry that loses where
--        -- it came from is how a line gets rolled forever without anyone
--        -- noticing it has been carried since September.
--        notes = trim(both E'\n' from
--                  coalesce(be.notes, '')
--                  || case when coalesce(be.notes, '') = '' then '' else E'\n' end
--                  || 'Rolled from ' || to_char(be.period_month, 'YYYY-MM-DD')
--                  || ' on ' || to_char(current_date, 'YYYY-MM-DD')
--                  || ' - unbilled, carried to the open period.')
--   from public.billing_lines bl, proj, target
--  where bl.id = be.billing_line_id
--    and bl.project_id = proj.id
--    and be.pay_application_id is null
--    and be.afp_number is null
--    and coalesce(be.status, '') not in ('on_pay_app', 'submitted', 'approved', 'paid')
--    and be.period_month < target.month_start
--    and coalesce(nullif(be.actual_amount, 0), be.planned_amount) > 0;
--
-- commit;

-- ===========================================================================
-- 3. Verify. Run after section 2.
-- ===========================================================================
-- Nothing stranded left. Expect zero rows.
-- with proj as (
--   select id from public.projects where name ilike '%sweet%spring%' limit 1
-- )
-- select bl.item_number, be.period_month,
--        coalesce(nullif(be.actual_amount, 0), be.planned_amount) as amount
-- from public.billing_entries be
-- join public.billing_lines bl on bl.id = be.billing_line_id
-- join proj on proj.id = bl.project_id
-- where be.pay_application_id is null
--   and be.afp_number is null
--   and coalesce(be.status, '') not in ('on_pay_app','submitted','approved','paid')
--   and be.period_month < date_trunc('month', current_date)::date
--   and coalesce(nullif(be.actual_amount, 0), be.planned_amount) > 0;
--
-- And the carried entries, with the trail showing where each came from.
-- select bl.item_number, bl.description, be.period_month,
--        coalesce(nullif(be.actual_amount, 0), be.planned_amount) as amount,
--        be.notes
-- from public.billing_entries be
-- join public.billing_lines bl on bl.id = be.billing_line_id
-- where bl.project_id = (select id from public.projects where name ilike '%sweet%spring%' limit 1)
--   and be.notes ilike '%Rolled from%'
-- order by bl.item_number;
