-- Retainage on a cost code, for scope that will be subcontracted but has no
-- subcontractor yet. The retainage twin of 0072's payment terms.
--
-- Phil, 2026-10-14: every Sussex sub will carry 10% retainage. None is signed,
-- so the cash flow paid construction cost in full while Dimension held 5% of
-- every billing - about $230K of the Aug 2027 low point.
--
-- Precedence: a linked subcontractor's retainage_pct wins. Held amounts are
-- released at the project's retainage release event, the same as a real sub's.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Safe to re-run. Then: npx tsx scripts/cashflow/set-sussex-sub-retainage.mts --apply

alter table public.cost_codes
  add column if not exists retainage_pct numeric(5,2);

comment on column public.cost_codes.retainage_pct is
  'Retainage % withheld on this code''s cash-out when no subcontractor is linked (e.g. Sussex 300-xxxx at 10% before buyout). A linked subcontractor''s retainage_pct takes precedence.';
