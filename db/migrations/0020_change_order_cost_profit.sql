-- Track cost vs profit on change orders explicitly.
--
-- The existing change_orders.co_value column holds the amount billable to
-- the owner (cost + profit). For internal margin tracking and AHC's own
-- forecasting, we need to know the breakdown:
--   cost_amount  - AHC's bare cost to deliver the CO scope
--   profit_pct   - markup percentage applied on top of cost
--   co_value     - existing column, stays as billable = cost * (1 + profit_pct/100)
--
-- New columns are nullable so old CO rows that pre-date this migration
-- aren't broken. The new-CO form auto-computes whichever value is missing
-- when the user enters two of the three.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Safe to re-run.

alter table public.change_orders
  add column if not exists cost_amount numeric(14,2),
  add column if not exists profit_pct numeric(5,2);
