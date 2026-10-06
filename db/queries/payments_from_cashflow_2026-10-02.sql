-- payments_from_cashflow_2026-10-02.sql
--
-- Record the payments already made on Sweet Springs, from the cash flow
-- workbook dated 2026-10-02 ("sweet springs" sheet, rows 3 to 69).
--
-- Zarina: "Need to update payment records to the app. help me so I dont have
-- to input them one by one."
--
-- WHAT IS IN THE SHEET
--   67 lines carry a description. 29 are marked Actual - money that has moved.
--   The other 38 are forecast or waiting; those are a projection, not a payment
--   record, and the app builds its own projection now. They are not touched.
--
--   The 29 actual lines net to +$26,595.37 against an opening balance of
--   $3,349.50, giving $29,944.87, which is exactly the running balance the
--   sheet carries on its last actual line. Nothing was dropped.
--
-- WHERE THE 29 GO
--   3   owner receipts      -> pay_applications
--   3   subcontractors      -> sub_pay_apps
--   6   vendors on a PO     -> procurement_payments
--   17  operating costs     -> nowhere. Per diem, bank fees, AMH Holdings,
--                              Kimley Horn, Hirschler, Pure Power, United
--                              Rentals and the Cambria County fee have no
--                              payment record in the app at all.
--
-- HOW TO RUN THIS
--   Step 1 is read-only and runs as written. It puts the sheet's figures beside
--   what the app currently holds, so every match is checked against real data
--   before anything is written. Read it.
--   Step 2 is commented out. Uncomment it once step 1 looks right.
--
--   Supabase SQL Editor: open the project, paste this file, Run.
--
-- WHY IT IS NOT ONE BIG UPDATE
--   Three of the twelve cannot be matched from the sheet alone, and step 1 is
--   what resolves them. They are called out at the bottom. Writing a guess into
--   a payment record is worse than leaving it blank: a wrong paid date moves
--   the cash forecast and a wrong "paid" status hides money still owed.

-- ===========================================================================
-- STEP 1 - what the app holds today, beside what the sheet says
-- ===========================================================================

-- 1a. Owner receipts. Expect three rows, one per AFP.
--     Compare amount_due to what Dimension actually paid: a gap is a short
--     payment worth knowing about, not something to paper over.
with project as (
  select id from public.projects where name ilike '%sweet spring%' limit 1
),
sheet(app_no, paid_on, amount_paid) as (values
  ('9',  date '2026-07-16', 126821.62),
  ('10', date '2026-07-30', 112985.86),
  ('11', date '2026-09-14', 136316.47)
)
select
  s.app_no                       as sheet_afp,
  s.paid_on                      as sheet_paid_date,
  s.amount_paid                  as sheet_amount,
  pa.id                          as app_id,
  pa.app_number                  as app_number_in_app,
  pa.status                      as status_now,
  pa.paid_at                     as paid_at_now,
  pa.amount_due                  as amount_due_in_app,
  round(s.amount_paid - coalesce(pa.amount_due, 0), 2) as difference
from sheet s
left join public.pay_applications pa
  on pa.project_id = (select id from project)
 -- Matched on the digits only, so '9', 'AFP-9' and '009' all resolve.
 and regexp_replace(pa.app_number, '\D', '', 'g') = s.app_no
order by s.app_no::int;

-- 1b. Subcontractor bills. Lists every app for the three subs that appear in
--     the actual rows, so the right one can be picked by number and amount.
select
  sc.company_name,
  spa.id          as sub_pay_app_id,
  spa.app_number,
  spa.period_end,
  spa.invoice_number,
  spa.amount_due,
  spa.approved_amount_due,
  spa.status,
  spa.paid_at
from public.sub_pay_apps spa
join public.subcontractors sc on sc.id = spa.subcontractor_id
where spa.project_id = (select id from public.projects where name ilike '%sweet spring%' limit 1)
  and (sc.company_name ilike '%pyramid%'
    or sc.company_name ilike '%lumina%'
    or sc.company_name ilike '%sunstall%')
order by sc.company_name, spa.app_number;

-- 1c. Payment milestones on the POs for the vendors in the actual rows.
--     The sheet names a vendor and an amount, never a milestone, so the
--     milestone is chosen here by looking at what is actually unpaid.
select
  po.vendor_name,
  po.po_number,
  pp.id            as milestone_id,
  pp.milestone_name,
  pp.amount,
  pp.expected_date,
  pp.paid_at,
  pp.paid_amount
from public.procurement_payments pp
join public.procurement_orders po on po.id = pp.procurement_order_id
where po.project_id = (select id from public.projects where name ilike '%sweet spring%' limit 1)
  and (po.vendor_name ilike '%ftc%'
    or po.vendor_name ilike '%grid%power%'
    or po.vendor_name ilike '%maddox%'
    or po.vendor_name ilike '%elevated steel%')
order by po.vendor_name, pp.sort_order nulls last, pp.expected_date;

-- The six vendor payments to place, for reference while reading 1c:
--   2026-07-20    $1,853.50   GridPower Solutions
--   2026-07-27   $36,000.00   FTC Solar
--   2026-07-30   $16,500.00   FTC Solar
--   2026-08-17    $1,000.00   Maddox - storage
--   2026-09-23   $47,584.51   Elevated Steel, invoice 26.0339
--   2026-09-23      $300.75   Gridpower Solutions, S103199493.001 and two others

-- ===========================================================================
-- STEP 2 - the writes
-- ===========================================================================
--
-- Uncomment to run. One transaction: all of it lands or none of it does.
-- Only the four unambiguous payments are written here. The rest need an id
-- read off step 1 and are at the bottom.

-- begin;
--
-- -- ---- Owner receipts: AFP 9, 10 and 11 ----
-- -- Matched on the AFP number, which the sheet states outright. The amount is
-- -- deliberately NOT written over amount_due: what we billed and what Dimension
-- -- paid are two facts, and step 1 shows the gap if there is one.
-- update public.pay_applications pa
-- set paid_at = v.paid_on,
--     status  = 'paid'
-- from (values
--   ('9',  date '2026-07-16'),
--   ('10', date '2026-07-30'),
--   ('11', date '2026-09-14')
-- ) as v(app_no, paid_on)
-- where pa.project_id = (select id from public.projects where name ilike '%sweet spring%' limit 1)
--   and regexp_replace(pa.app_number, '\D', '', 'g') = v.app_no;
--
-- -- ---- Pyramid Excavation, app 1 ----
-- -- The one sub line the sheet identifies completely: "Pyramid Excavation 1383
-- -- approved app1", $127,152.84, paid 2026-09-14.
-- update public.sub_pay_apps spa
-- set paid_at = date '2026-09-14',
--     status  = 'paid'
-- from public.subcontractors sc
-- where sc.id = spa.subcontractor_id
--   and spa.project_id = (select id from public.projects where name ilike '%sweet spring%' limit 1)
--   and sc.company_name ilike '%pyramid%'
--   and spa.app_number = 1;
--
-- -- Read these back before committing.
-- select app_number, status, paid_at, amount_due
--   from public.pay_applications
--  where project_id = (select id from public.projects where name ilike '%sweet spring%' limit 1)
--  order by app_number;
--
-- commit;

-- ===========================================================================
-- STEP 3 - the eight that need a decision, not a guess
-- ===========================================================================
--
-- LUMINA ENERGY SERVICES - do NOT mark the app paid.
--   The sheet pays $18,579.40 on 2026-09-23 against AFP 1, and the note beside
--   it says that app is $146,856.90 net of retainage, billed on two invoices:
--   $18,579.40 for the bond and the rest for mobilisation, procurement and
--   initial payroll. The remaining $128,277.50 is still sitting in the forecast
--   rows further down the sheet. This is a part payment on an open app.
--   Marking it paid would hide $128,277.50 that is still owed.
--
--   The app has no partial-payment field on sub_pay_apps, so there are two
--   honest options and both are AHC's call:
--     a) leave it open and record the part payment in notes, or
--     b) add a paid_amount column to sub_pay_apps and record it properly.
--   Nothing is written here either way.
--
-- SUNSTALL - $33,293.33 paid 2026-09-08.
--   The sheet gives no app or invoice number. Step 1b lists Sunstall's apps
--   with their amounts; if one matches $33,293.33 exactly, fill its id in
--   below. If none does, this is a part payment too and the Lumina note
--   applies.
--
--   update public.sub_pay_apps
--   set paid_at = date '2026-09-08', status = 'paid'
--   where id = '<sub_pay_app_id from step 1b>';
--
-- THE SIX VENDOR PAYMENTS.
--   Each names a vendor and an amount but never a milestone. Read step 1c, pick
--   the milestone whose amount matches, and run one of these per payment. The
--   paid amount is written as well as the date, because a milestone can be paid
--   short and the forecast should carry what actually left the bank.
--
--   update public.procurement_payments
--   set paid_at = date '<paid date>', paid_amount = <amount as a positive number>
--   where id = '<milestone_id from step 1c>';
--
--   2026-07-20    1853.50   GridPower Solutions
--   2026-07-27   36000.00   FTC Solar
--   2026-07-30   16500.00   FTC Solar
--   2026-08-17    1000.00   Maddox, storage - may not be a PO milestone at all,
--                           in which case leave it: storage is a period cost.
--   2026-09-23   47584.51   Elevated Steel 26.0339
--   2026-09-23     300.75   Gridpower Solutions S103199493.001 + 2 others
