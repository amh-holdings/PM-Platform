-- SOV lines the owner holds no retainage on.
--
-- Sussex's Exhibit E, Note 3: "Retainage of 5% accrues on each payment and is
-- released at Item 11.00. Retainage does not apply to Item 1.01." Item 1.01 is
-- the LNTP, $290,388.20, billed through nine plan-set lines. With one project
-- rate applied to every line, the cash flow held $14,519.41 of LNTP money
-- until Substantial Completion and a pay application would have withheld it
-- on the G703.
--
-- A per-line flag rather than a per-line rate: the contract states one rate
-- and a list of exceptions, and that is all the flag has to say. Read by
-- buildPayAppLines (pay-app retainage) and the projection (forecast cash-in).
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Safe to re-run. Then: npx tsx scripts/set-sussex-lntp-retainage-exempt.mts --apply

alter table public.billing_lines
  add column if not exists retainage_exempt boolean not null default false;

comment on column public.billing_lines.retainage_exempt is
  'True when the contract holds no retainage on this line (e.g. Sussex LNTP, Exhibit E Note 3). Pay applications and the cash-flow forecast apply 0% here instead of projects.retainage_pct_default.';
