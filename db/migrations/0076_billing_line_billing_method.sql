-- How an SOV line is billed: on a milestone, or as the work is completed.
--
-- Sussex: Dimension pays for work completed each month, and the subs bill the
-- same way. The cash-flow projection billed every line in one lump on its
-- task's planned finish, which put $1.08M of electrical install - work done
-- May through August 2027 - into August alone and made most of a -$1.13M low
-- point that the contract does not have.
--
-- 'milestone' (the default, and every line before this) earns the whole line
-- on the linked task's finish. 'progress' is spread over the linked tasks'
-- calendar days, month by month. Read by the projection only
-- (src/lib/progress-billing-spread.ts); pay applications still bill what is
-- actually approved.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Safe to re-run. Then: npx tsx scripts/cashflow/set-sussex-progress-billing.mts --apply

alter table public.billing_lines
  add column if not exists billing_method text not null default 'milestone';

alter table public.billing_lines
  drop constraint if exists billing_lines_billing_method_check;
alter table public.billing_lines
  add constraint billing_lines_billing_method_check
  check (billing_method in ('milestone', 'progress'));

comment on column public.billing_lines.billing_method is
  'milestone = billed in full on the linked task''s planned finish; progress = billed as completed, spread over the linked tasks'' days. Drives the cash-flow forecast.';
