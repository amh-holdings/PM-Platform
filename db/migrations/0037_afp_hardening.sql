-- AFP hardening: retainage rate on the application, contract SOV mapping on
-- commodities, and a total_billed that only counts money that actually went out.
-- Idempotent, like every migration here. Apply in the Supabase SQL editor.

-- 1. The retainage percentage used on a pay application.
--    pay_application_lines stores retainage_amount per line, but the rate was
--    never persisted - it was read from projects.retainage_pct_default at
--    creation time and thrown away. A G702 has to print the rate ("Retainage
--    10% of completed work"), and the default can change between applications,
--    so an AFP that does not carry its own rate cannot be reprinted faithfully.
alter table public.pay_applications
  add column if not exists retainage_pct numeric(5,2);

comment on column public.pay_applications.retainage_pct is
  'Retainage rate applied to this application, captured at creation. Null on applications created before 0037; fall back to projects.retainage_pct_default when printing those.';

-- 2. Contract SOV item on each commodity.
--    commodities.sov_item records the CLIENT ROLL-UP sheet verbatim, because
--    the Smartsheet export has to match their column and row labels. On four
--    rows the roll-up disagrees with the executed contract - it maps fencing to
--    6.02 and road install to 6.03, while the contract has 6.02 = "Civil, Roads
--    and Landscaping" and 6.03 = "Fencing/SWPPP". Phil confirmed the contract
--    is authoritative (2026-08-19). Only this column may drive billing.
alter table public.commodities
  add column if not exists contract_sov_item text;

comment on column public.commodities.contract_sov_item is
  'SOV item on the executed contract. Differs from sov_item (the client roll-up) on fencing, road_install, inverter_pads and site_prep. Null means the commodity does not map to a single contract line and must not drive a billing percentage. Source of truth is COMMODITIES in src/lib/commodities.ts.';

-- 3. total_billed must mean "billed", not "has a number in actual_amount".
--
--    The old view summed actual_amount with no status filter:
--      total_billed      = coalesce(sum(be.actual_amount), 0)
--      remaining_to_bill = scheduled_value - coalesce(sum(be.actual_amount), 0)
--
--    scripts/import-cashflow*.mjs loaded the owner cash-flow workbook into
--    actual_amount for months that were only ever projections. Sweet Springs
--    carried $160,381 / $80,000 / $40,000 on 2026-06 with status 'forecast',
--    no afp_number and no pay_application_id, for civil work that had not
--    happened - the first field report on the job is dated 2026-08-04. The app
--    therefore reported $120,000 of civil already billed, which suppressed the
--    first legitimate civil billing and overstated completion on the G703.
--
--    A row now counts as billed only when something shows it went out: a
--    pay_application_id, an afp_number, or a status past 'forecast'. This
--    mirrors hasBillingEvidence() in pay-app-actions.ts - keep the two in step.
create or replace view public.v_billing_line_totals as
select
  bl.id as billing_line_id,
  bl.project_id,
  bl.item_number,
  bl.scheduled_value,
  coalesce(sum(be.planned_amount), 0) as total_planned,
  coalesce(sum(
    case when be.pay_application_id is not null
           or be.afp_number is not null
           or be.status in ('on_pay_app','submitted','approved','paid')
         then be.actual_amount else 0 end
  ), 0) as total_billed,
  coalesce(sum(be.retainage_amount), 0) as total_retainage,
  bl.scheduled_value - coalesce(sum(
    case when be.pay_application_id is not null
           or be.afp_number is not null
           or be.status in ('on_pay_app','submitted','approved','paid')
         then be.actual_amount else 0 end
  ), 0) as remaining_to_bill
from public.billing_lines bl
left join public.billing_entries be on be.billing_line_id = bl.id
group by bl.id;

create or replace view public.v_project_billing_summary as
select
  bl.project_id,
  coalesce(sum(bl.scheduled_value), 0) as total_scheduled,
  coalesce(sum(
    case when be.pay_application_id is not null
           or be.afp_number is not null
           or be.status in ('on_pay_app','submitted','approved','paid')
         then be.actual_amount else 0 end
  ), 0) as total_billed,
  coalesce(sum(be.retainage_amount), 0) as total_retainage,
  coalesce(sum(case when be.period_month > current_date then be.planned_amount else 0 end), 0) as future_planned
from public.billing_lines bl
left join public.billing_entries be on be.billing_line_id = bl.id
group by bl.project_id;
