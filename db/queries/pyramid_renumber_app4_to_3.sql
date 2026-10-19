-- Pyramid Excavation: the approved September application is 3, not 4.
--
-- Pyramid billed application 3 for 1 - 25 September. AHC rejected it. Pyramid
-- revised and resent, and the app filed the resubmission as application 4,
-- because the old unique key would not let the number come round again.
-- Pyramid's own G702, their invoice 1407 and their lien waiver all say 3.
--
-- Zarina: "I rejected the previous pay app 3, the new approved should still
-- be pay app 3."
--
-- This renames ONE row. app_number is a label: no amount, date, period,
-- invoice number or approval moves, and the rejected application stays
-- exactly where it is, keeping its own number 3 and marked superseded in the
-- bill list.
--
-- RUN db/migrations/0078_sub_pay_app_number_reuse.sql FIRST. Until it has
-- run, the old unique key on (subcontractor_id, app_number) refuses this
-- update, because a row numbered 3 already exists.
--
-- HOW TO RUN
--   Supabase SQL Editor. Run step 1, read it, then run step 2.

-- ===========================================================================
-- STEP 1 - what is on file now. Read this before writing anything.
-- ===========================================================================
select
  s.company_name,
  a.app_number,
  a.status,
  a.invoice_number,
  a.period_start,
  a.period_end,
  a.billed_this_period,
  a.approved_this_period,
  a.approved_amount_due,
  a.amount_due,
  a.id
from public.sub_pay_apps a
join public.subcontractors s on s.id = a.subcontractor_id
where s.company_name ilike '%pyramid%'
order by a.app_number, a.created_at;

-- Expect four rows:
--   1  paid       invoice 1383  through 13 Aug   133,845.09
--   2  approved   invoice 1394  14 - 31 Aug      113,460.04
--   3  rejected   no invoice     1 - 25 Sep       79,085.37
--   4  approved   invoice 1407   1 - 28 Sep        62,931.76   <- becomes 3
--
-- If step 1 shows anything else, STOP and send it to me rather than running
-- step 2.

-- ===========================================================================
-- STEP 2 - renumber. Uncomment the block and run it.
-- ===========================================================================
-- begin;
--
-- -- Guard: exactly one row may match, and it must be the approved one
-- -- numbered 4 on invoice 1407. Anything else aborts before the update.
-- do $$
-- declare
--   n integer;
-- begin
--   select count(*) into n
--   from public.sub_pay_apps a
--   join public.subcontractors s on s.id = a.subcontractor_id
--   where s.company_name ilike '%pyramid%'
--     and a.app_number = 4
--     and a.status = 'approved'
--     and a.invoice_number = '1407';
--   if n <> 1 then
--     raise exception 'Expected exactly 1 matching application, found %', n;
--   end if;
-- end $$;
--
-- update public.sub_pay_apps a
--    set app_number = 3
--   from public.subcontractors s
--  where s.id = a.subcontractor_id
--    and s.company_name ilike '%pyramid%'
--    and a.app_number = 4
--    and a.status = 'approved'
--    and a.invoice_number = '1407';
--
-- commit;

-- ===========================================================================
-- STEP 3 - verify. Run after step 2.
-- ===========================================================================
-- Two rows numbered 3: the rejected one and invoice 1407. Nothing numbered 4.
-- select a.app_number, a.status, a.invoice_number, a.period_end, a.amount_due
-- from public.sub_pay_apps a
-- join public.subcontractors s on s.id = a.subcontractor_id
-- where s.company_name ilike '%pyramid%'
-- order by a.app_number, a.status;
--
-- Approved to date must be unchanged by all of this: 133,845.09 + 113,460.04
-- + 62,931.76 = 310,236.89.
-- select company_name, apps_received, billed_to_date, approved_to_date
-- from public.v_sub_billing_summary
-- where company_name ilike '%pyramid%';
