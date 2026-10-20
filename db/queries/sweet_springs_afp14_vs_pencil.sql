-- Sweet Springs AFP 14: the pencil copy against what the app holds.
--
-- Zarina: "Can you adjust this to the current AFP 14 in the app?"
--
-- Source: Drive, "20261018 - PENCIL COPY AFP 14.xlsx", G703 sheet, modified
-- 2026-10-20. Application 14, application date and period to 20-Oct-26.
-- Every figure in the VALUES block below is read straight off that sheet.
--
-- READ ONLY. Nothing here writes. It answers one question line by line: where
-- do the pencil copy and the app disagree, and by how much. Which one is right
-- is a decision, not a query - but you cannot make it without this.
--
-- Three columns matter:
--   sched_diff        the SOV itself disagrees. That is a contract question.
--   previous_diff     the two files disagree about what was billed BEFORE
--                     AFP 14, which means an earlier application is out.
--   this_period_diff  what AFP 14 bills. This is the number going to
--                     Dimension.
--
-- HOW TO RUN
--   Supabase SQL Editor: paste the whole file, Run.

with proj as (
  select id from public.projects where name ilike '%sweet%spring%' limit 1
),
-- The app's AFP 14. Matched on app_number rather than the newest row, because
-- "the newest" is not the same question.
app14 as (
  select pa.id, pa.app_number, pa.status, pa.period_start, pa.period_end
  from public.pay_applications pa, proj
  where pa.project_id = proj.id
    and (pa.app_number = '14' or pa.app_number ilike '%14%')
  order by pa.period_end desc nulls last
  limit 1
),
pencil(item_number, description, sched, previous, this_period) as (
  values
    ('1.01', 'LNTP Execution Engineering',                         22580.68,  22580.68,      0.00),
    ('1.02', 'Electrical 30% Design',                              11290.34,  11290.34,      0.00),
    ('1.03', 'Electrical 90% Design',                              16935.51,  16935.51,      0.00),
    ('1.04', 'Civil Design 90%',                                   22580.68,  22580.68,      0.00),
    ('1.05', 'Structural Design',                                  22580.68,  22580.68,      0.00),
    ('1.06', 'Electrical Design IFC',                               5645.17,      0.00,      0.00),
    ('1.07', 'Civil Design IFC',                                    5645.17,      0.00,      0.00),
    ('1.08', 'Structual Design IFC',                                5645.17,      0.00,      0.00),
    ('1.09', 'Push/Pull Test',                                     23700.00,  23700.00,      0.00),
    ('1.10', 'Tracker/Racking Procurement',                       277667.52, 277667.52,      0.00),
    ('1.11', 'Racker/Tracking Pile Procurement',                   49637.64,  49637.64,      0.00),
    ('1.12', '3 Phase 1500 kVA Transformer Procurement',          110500.50, 110500.50,      0.00),
    ('2.00', 'EPC Contract',                                       85017.50,  85017.50,      0.00),
    ('3.00', 'IFP/ IFC Engineering',                               85017.50,  85017.50,      0.00),
    ('4.00', 'Construction Permits Received',                          0.00,      0.00,      0.00),
    ('5.01', 'Module Procurement Deposit',                             0.00,      0.00,      0.00),
    ('5.02', 'Module Delivery',                                    10000.00,      0.00,      0.00),
    ('5.03', 'Pile and Racking Procurement Deposit',                   0.00,      0.00,      0.00),
    ('5.04', 'Pile and Racking Delivery',                          20000.00,      0.00,      0.00),
    ('5.05', 'POI Procurement',                                   168335.32,  82619.12,      0.00),
    ('5.06', 'Transformer',                                         5000.00,   5000.00,      0.00),
    ('5.07', 'Inverters',                                          10000.00,      0.00,      0.00),
    ('5.08', '3rd Party/ QA/CC',                                   20000.00,      0.00,      0.00),
    ('6.01', 'Mobilization',                                      320762.92, 112267.03, 208495.89),
    ('6.02', 'Civil, Roads and Landscaping if applicable',        413045.92,      0.00,  93018.00),
    ('6.03', 'Fencing/SWPPP',                                     203835.79,      0.00,  79936.00),
    ('7.01', 'Inverters Installed (mounted only)',                 81534.32,      0.00,      0.00),
    ('7.02', 'AC/DC Wire (Trenching and Concrete Pad Installed)', 249331.94,      0.00,      0.00),
    ('7.03', 'Transformers Installed',                             39141.04,      0.00,      0.00),
    ('7.04', 'POI Installed',                                     143500.40,      0.00,      0.00),
    ('8.01', 'Piles and Racking Installed',                       319317.44,      0.00,      0.00),
    ('8.02', 'Modules Installed',                                  65227.45,      0.00,      0.00),
    ('8.03', 'Optimizer, String Wire and Wire Management Installed', 20000.00,    0.00,      0.00),
    ('9.00', 'Mechanical Completion',                             160000.00,      0.00,      0.00),
    ('10.00','Placed In Service/Commercial Operation Date',        160000.00,      0.00,      0.00),
    -- 12.00's scheduled value on the sheet is the TEXT "200% of Punchlist
    -- holdback", not a number, so it contributes nothing to the sheet's own
    -- total. Carried as zero here to match, not because it is worth zero.
    ('11.00','Substantial Completion (Milestone + 5% Retainage less punchlist holdback)', 64000.00, 0.00, 0.00),
    ('12.00','Final Completion (200% of punchlist holdback)',           0.00,      0.00,      0.00),
    ('13.00','Incurred Costs through 8-30-2025',                  368675.48, 368675.48,      0.00),
    ('14.00','SCADA Cost Increase & Storage',                      67458.31,  67458.31,      0.00),
    ('15.00','Piles',                                             102351.52, 102351.52,      0.00),
    ('16.00','Bond Premium',                                       31224.00,  31224.00,      0.00)
)

-- ===========================================================================
-- 1. Line by line.
-- ===========================================================================
select
  coalesce(p.item_number, pal.item_number)                   as item_number,
  coalesce(p.description, pal.description)                   as description,
  p.sched                                                    as pencil_sched,
  pal.scheduled_value                                        as app_sched,
  round(coalesce(pal.scheduled_value,0) - coalesce(p.sched,0), 2)                 as sched_diff,
  p.previous                                                 as pencil_previous,
  pal.work_completed_previous                                as app_previous,
  round(coalesce(pal.work_completed_previous,0) - coalesce(p.previous,0), 2)      as previous_diff,
  p.this_period                                              as pencil_this_period,
  pal.work_completed_this_period                             as app_this_period,
  round(coalesce(pal.work_completed_this_period,0) - coalesce(p.this_period,0), 2) as this_period_diff,
  case
    when pal.item_number is null then 'ON THE PENCIL COPY ONLY - the app has no such line on AFP 14'
    when p.item_number is null   then 'IN THE APP ONLY - the pencil copy has no such row'
    when abs(coalesce(pal.work_completed_this_period,0) - coalesce(p.this_period,0)) >= 0.01
      then 'THIS PERIOD DIFFERS'
    when abs(coalesce(pal.work_completed_previous,0) - coalesce(p.previous,0)) >= 0.01
      then 'previous billings differ - an earlier AFP is out'
    when abs(coalesce(pal.scheduled_value,0) - coalesce(p.sched,0)) >= 0.01
      then 'scheduled value differs - the SOV itself disagrees'
    else 'ties'
  end as verdict
from pencil p
full outer join (
  select pal.*
  from public.pay_application_lines pal
  join app14 on app14.id = pal.pay_application_id
) pal on pal.item_number = p.item_number
order by
  case when coalesce(p.item_number, pal.item_number) ~ '^[0-9]+\.[0-9]+$' then 0 else 1 end,
  coalesce(p.item_number, pal.item_number);

-- ===========================================================================
-- 2. The totals, which is the number that goes to Dimension.
-- ===========================================================================
-- The pencil copy's own footer reads:
--   scheduled   3,787,185.91
--   previous    1,497,104.01
--   this period   381,449.89
--   to date     1,878,553.90   (49.60%)
--   balance     1,908,632.01
--   retainage      28,547.77
-- and a figure of 374,275.33 sitting below it, which is the sheet's net due.
-- The CTEs above belong to statement 1 only, so this one declares its own.
with proj as (
  select id from public.projects where name ilike '%sweet%spring%' limit 1
),
app14 as (
  select pa.id, pa.app_number
  from public.pay_applications pa, proj
  where pa.project_id = proj.id
    and (pa.app_number = '14' or pa.app_number ilike '%14%')
  order by pa.period_end desc nulls last
  limit 1
)
select
  'pencil copy' as source, 3787185.91 as sched, 1497104.01 as previous, 381449.89 as this_period
union all
select
  'app AFP ' || coalesce(app14.app_number, '(none found)'),
  round(coalesce(sum(pal.scheduled_value), 0), 2),
  round(coalesce(sum(pal.work_completed_previous), 0), 2),
  round(coalesce(sum(pal.work_completed_this_period), 0), 2)
from app14
left join public.pay_application_lines pal on pal.pay_application_id = app14.id
group by app14.app_number;

-- ===========================================================================
-- 3. Does an AFP 14 even exist in the app, and what state is it in?
-- ===========================================================================
select pa.app_number, pa.status, pa.period_start, pa.period_end,
       pa.total_completed, pa.total_retainage, pa.amount_due,
       pa.submitted_at, pa.approved_at, pa.paid_at
from public.pay_applications pa
where pa.project_id = (select id from public.projects where name ilike '%sweet%spring%' limit 1)
order by pa.period_end desc nulls last
limit 5;
