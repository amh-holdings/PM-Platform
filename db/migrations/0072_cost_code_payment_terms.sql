-- Payment terms on a cost code, for scope that will be subcontracted but has
-- no subcontractor yet.
--
-- The projection dates a cost code's cash-out from its linked subcontractor's
-- payment_terms_days. Sussex's construction codes (300-xxxx, ~$2.5M) have no
-- sub - none is bought out yet - so the cash flow paid them the month the
-- work happens, deepening the low point by a month of construction cost.
-- Phil, 2026-10-08: the subs "will be at a minimum of net 30".
--
-- Precedence: a linked subcontractor's terms win. This column is the
-- placeholder until the subcontract exists, and stops mattering once it does.
-- Retainage is deliberately not modelled here - nothing is agreed yet.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Safe to re-run.

alter table public.cost_codes
  add column if not exists payment_terms_days integer;

comment on column public.cost_codes.payment_terms_days is
  'Net days for this code''s cash-out when no subcontractor is linked (e.g. Sussex 300-xxxx at Net 30 before buyout). A linked subcontractor''s payment_terms_days takes precedence.';
