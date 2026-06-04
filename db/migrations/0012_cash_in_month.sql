-- Add cash_in_month to billing_entries to separate billing date from when
-- cash actually arrives from the owner.
--
-- period_month: when the AFP was submitted (billing date) - used for G703 detail
-- cash_in_month: when AHC received payment (cash-in date) - used for the
--                cash flow projection so the Net Cash widget reflects when
--                money actually moved
--
-- For historical entries, cash_in_month = period_month + owner_payment_terms.
-- For Sweet Springs entries that come from Zarina's 2026-05-29 file, the
-- cash_in_month is populated directly from the Cash Flow sheet's column
-- headers (which are cash-in dates by definition per the sheet's header
-- annotation "CASH IN DATE è").
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Safe to re-run.

alter table public.billing_entries
  add column if not exists cash_in_month date;

create index if not exists billing_entries_cash_in_month_idx
  on public.billing_entries(cash_in_month);
