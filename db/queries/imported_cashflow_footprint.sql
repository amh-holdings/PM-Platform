-- What the uploaded cash-flow spreadsheet is still carrying.
--
-- Zarina: "Please override the cashflow spreadsheet that was initially
-- uploaded in the app. I think it should call the details that was entered in
-- the app."
--
-- As of PR #99 it no longer decides anything. The amount box takes the
-- evidence or zero, and the cash curve skips planned-only entries and
-- forecasts that money from the schedule instead. These entries are inert.
--
-- They are still in the table though, and they still show as rows and as the
-- "Cash-flow forecast was $X" comparison. This says exactly what is left, so
-- the decision to keep or clear them is made on numbers rather than a feeling.
--
-- A planned-only entry is one with no pay application, no AFP number, and a
-- status still at 'forecast'. That is the same test the app uses everywhere
-- (hasBillingEvidence, and the case expression in v_billing_line_totals).
--
-- Read only. Nothing here writes.

-- 1. The total, and how it splits between months already past and months ahead.
select
  case
    when period_month < date_trunc('month', current_date)::date then 'past months'
    else 'this month and later'
  end                                   as bucket,
  count(*)                              as entries,
  count(distinct billing_line_id)       as sov_lines,
  min(period_month)                     as earliest,
  max(period_month)                     as latest,
  sum(coalesce(planned_amount, 0))      as planned_total
from public.billing_entries be
join public.billing_lines bl on bl.id = be.billing_line_id
where bl.project_id = :project_id
  and be.pay_application_id is null
  and be.afp_number is null
  and coalesce(be.status, 'forecast') = 'forecast'
group by 1
order by 1;

-- 2. Line by line, so a figure that looks wrong can be traced to one SOV item.
--    "billed" is real billing only, the same rule the G703 uses.
select
  bl.item_number,
  bl.description,
  bl.scheduled_value,
  sum(coalesce(be.planned_amount, 0))                     as spreadsheet_plan,
  count(*)                                                as plan_entries,
  string_agg(to_char(be.period_month, 'Mon YY'), ', '
             order by be.period_month)                    as months,
  (select coalesce(sum(
      case when x.pay_application_id is not null
             or x.afp_number is not null
             or x.status in ('on_pay_app','submitted','approved','paid')
           then x.actual_amount else 0 end), 0)
     from public.billing_entries x
    where x.billing_line_id = bl.id)                      as actually_billed
from public.billing_entries be
join public.billing_lines bl on bl.id = be.billing_line_id
where bl.project_id = :project_id
  and be.pay_application_id is null
  and be.afp_number is null
  and coalesce(be.status, 'forecast') = 'forecast'
group by bl.id, bl.item_number, bl.description, bl.scheduled_value
order by bl.item_number;

-- 3. The one that matters for 6.03: what each line is worth on the SOV against
--    what the spreadsheet thinks it is worth. A gap here means the two
--    documents disagree about the contract, not just about timing.
select
  bl.item_number,
  bl.scheduled_value                                       as sov_value,
  sum(coalesce(be.planned_amount, 0))                      as spreadsheet_total,
  sum(coalesce(be.planned_amount, 0)) - bl.scheduled_value as gap
from public.billing_entries be
join public.billing_lines bl on bl.id = be.billing_line_id
where bl.project_id = :project_id
group by bl.id, bl.item_number, bl.scheduled_value
having abs(sum(coalesce(be.planned_amount, 0)) - bl.scheduled_value) > 0.01
order by abs(sum(coalesce(be.planned_amount, 0)) - bl.scheduled_value) desc;
