-- Sweet Springs: is the owner billing page current for civil work?
--
-- Zarina: "audit the billing page for SSS to make sure it is up to date based
-- on civil work."
--
-- READ ONLY. Nothing here writes. Run the whole file and read the six
-- sections in order; each one answers a different way the page can be stale.
--
-- HOW A CIVIL LINE EARNS ITS PERCENT, in precedence order (commodity-progress):
--   1. A rule of credit on the line. An agreement with the owner beats any
--      measurement, because it IS the agreement.
--   2. The commodity tracker, where the reading can be trusted.
--   3. Duration-weighted schedule progress. The fallback.
--
-- So a civil line is out of date when any of these is true, and the sections
-- below are ordered to find them:
--   A. The tracker has not been fed recently, or carries unconfirmed rows.
--   B. A commodity still has a template placeholder total, so its reading is
--      thrown away and the line silently falls back to the schedule.
--   C. A civil line carries no rule of credit and bundles unlike scopes.
--   D. A commodity points at an SOV item that does not exist.
--   E. What the last AFP billed has drifted from what the basis now says.
--
-- HOW TO RUN
--   Supabase SQL Editor: paste the whole file, Run, read each result.

-- ===========================================================================
-- 0. The project, so everything below is scoped to the right one.
-- ===========================================================================
-- billing_cutoff_day arrives with migration 0067, which may not be applied.
-- Read through to_jsonb so a missing column reads null instead of erroring
-- the whole section.
select
  p.id,
  p.name,
  p.schedule_data_date,
  to_jsonb(p) ->> 'billing_cutoff_day' as billing_cutoff_day
from public.projects p
where p.name ilike '%sweet%spring%';

-- Note the id. If more than one row comes back, stop and send it to me.

-- ===========================================================================
-- 1. Every civil commodity: is it being fed, and can it be billed from?
-- ===========================================================================
-- total_verified = false means the total is still a January-2025 template
-- placeholder (250 ft of road install on a $3.95M job). The app REFUSES to
-- bill from those, so the line falls back to the schedule without saying so
-- on the invoice. Those rows are the first thing to fix.
select
  c.key,
  c.label,
  c.uom,
  c.sov_item,
  c.total_quantity,
  c.total_verified,
  round(sum(dp.quantity) filter (where dp.confirmed_at is not null), 2) as confirmed_to_date,
  round(sum(dp.quantity) filter (where dp.confirmed_at is null), 2)     as unconfirmed_waiting,
  max(dp.production_date) filter (where dp.confirmed_at is not null)    as last_confirmed_day,
  current_date
    - max(dp.production_date) filter (where dp.confirmed_at is not null) as days_since_fed,
  case
    when c.uom = 'pct' then 'billable: percent commodity needs no total'
    when coalesce(c.total_quantity, 0) <= 0 then 'NOT BILLABLE: no total quantity'
    when not c.total_verified then 'NOT BILLABLE: placeholder total, verify it'
    else 'billable'
  end as reading_status
from public.commodities c
left join public.daily_production dp on dp.commodity_id = c.id
where c.project_id = (select id from public.projects where name ilike '%sweet%spring%' limit 1)
  and c.category = 'civil'
  and c.active
group by c.id, c.key, c.label, c.uom, c.sov_item, c.total_quantity, c.total_verified, c.sort_order
order by c.sort_order;

-- Read: any row with unconfirmed_waiting above zero is production somebody
-- entered that nobody approved, and it is NOT in the billed percent. Any row
-- with days_since_fed large is a tracker nobody is feeding.

-- ===========================================================================
-- 2. Civil contract lines: what basis is each one actually billing on?
-- ===========================================================================
with proj as (
  select id from public.projects where name ilike '%sweet%spring%' limit 1
)
select
  bl.item_number,
  bl.description,
  bl.scheduled_value,
  -- billing_method arrives with 0076; null here means that migration has not
  -- run, not that the line has no method.
  to_jsonb(bl) ->> 'billing_method' as billing_method,
  case when bl.rule_of_credit is null then 'no' else 'yes' end as has_rule_of_credit,
  bl.rule_of_credit,
  coalesce(array_length(bl.linked_task_wbs_codes, 1), 0) as linked_tasks,
  (
    select count(*) from public.commodities c
    where c.project_id = bl.project_id and c.active and c.sov_item = bl.item_number
  ) as commodities_mapped,
  (
    select count(*) from public.commodities c
    where c.project_id = bl.project_id and c.active and c.sov_item = bl.item_number
      and (c.uom = 'pct' or (coalesce(c.total_quantity,0) > 0 and c.total_verified))
  ) as commodities_billable
from public.billing_lines bl, proj
where bl.project_id = proj.id
  and (
    bl.description ilike '%civil%'
    or bl.description ilike '%road%'
    or bl.description ilike '%fenc%'
    or bl.description ilike '%swppp%'
    or bl.description ilike '%mobiliz%'
    or bl.description ilike '%grading%'
    or bl.description ilike '%erosion%'
  )
order by bl.sort_order, bl.item_number;

-- Read: commodities_mapped above zero with commodities_billable at zero is
-- the quiet failure - the line LOOKS measured by the tracker and is actually
-- falling back to the schedule.
--
-- has_rule_of_credit 'no' on a line bundling unlike scopes is the other one.
-- 6.03 Fencing/SWPPP got a rule (SWPPP 30, fence 70, Decision Log 54 and the
-- 9/29/26 correction). 6.02 Civil Roads and Landscaping was noted as still
-- having none.

-- ===========================================================================
-- 3. Commodities pointing at an SOV item that does not exist.
-- ===========================================================================
-- A mapping typo earns nothing and says nothing. Expect zero rows.
select c.key, c.label, c.sov_item
from public.commodities c
where c.project_id = (select id from public.projects where name ilike '%sweet%spring%' limit 1)
  and c.active
  and c.sov_item is not null
  and not exists (
    select 1 from public.billing_lines bl
    where bl.project_id = c.project_id and bl.item_number = c.sov_item
  )
order by c.sort_order;

-- ===========================================================================
-- 4. One commodity feeding several lines, or several feeding one.
-- ===========================================================================
-- A commodity shared across lines gives every one of them the SAME percent.
-- That is right when the lines really are one scope and wrong when they are
-- not - it is what put two Pyramid SOV lines both at 47.30%.
select c.sov_item, count(*) as commodities_on_this_line,
       string_agg(c.label, ', ' order by c.sort_order) as commodities
from public.commodities c
where c.project_id = (select id from public.projects where name ilike '%sweet%spring%' limit 1)
  and c.active and c.category = 'civil' and c.sov_item is not null
group by c.sov_item
having count(*) > 1
order by c.sov_item;

-- ===========================================================================
-- 5. Civil schedule progress, for the lines that fall back to it.
-- ===========================================================================
-- The construction branch encodes discipline: 5.1 is civil. This is what a
-- fallback line is actually billing off, and how fresh it is.
select
  t.wbs_code,
  t.task_name,
  t.status,
  t.pct_complete,
  t.start_date,
  t.end_date,
  t.last_report_date
from public.schedule_tasks t
where t.project_id = (select id from public.projects where name ilike '%sweet%spring%' limit 1)
  and (t.wbs_code = '5.1' or t.wbs_code like '5.1.%')
order by t.sort_order nulls last, t.wbs_code;

-- Read: a task sitting at a percent with an old last_report_date is a line
-- billing off a number nobody has touched since then.

-- ===========================================================================
-- 6. What the last AFP actually billed on those lines.
-- ===========================================================================
-- The drift check. Compare pct_complete here against what sections 1 and 2
-- say the basis is now.
with proj as (
  select id from public.projects where name ilike '%sweet%spring%' limit 1
),
latest as (
  select pa.id, pa.app_number, pa.period_start, pa.period_end, pa.status
  from public.pay_applications pa, proj
  where pa.project_id = proj.id
  order by pa.period_end desc nulls last, pa.created_at desc
  limit 1
)
select
  l.app_number,
  l.period_start,
  l.period_end,
  l.status,
  pal.item_number,
  pal.description,
  pal.scheduled_value,
  pal.pct_complete,
  pal.work_completed_previous,
  pal.work_completed_this_period,
  pal.total_completed_and_stored,
  pal.balance_to_finish
from latest l
join public.pay_application_lines pal on pal.pay_application_id = l.id
where pal.description ilike '%civil%'
   or pal.description ilike '%road%'
   or pal.description ilike '%fenc%'
   or pal.description ilike '%swppp%'
   or pal.description ilike '%mobiliz%'
   or pal.description ilike '%grading%'
   or pal.description ilike '%erosion%'
order by pal.sort_order nulls last, pal.item_number;
