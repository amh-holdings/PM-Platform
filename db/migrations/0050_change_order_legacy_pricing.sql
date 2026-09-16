-- Freeze every change order that predates in-app pricing.
--
-- Markup moved from per-line to a single rate on the direct cost total, which
-- is what the contract actually allows: one overall 10% markup, not a stack of
-- line rates. CO-07 is the first change order priced in the app under that
-- model. CO-01 through CO-06 were priced, signed and in some cases already
-- billed outside it.
--
-- Re-pricing one of those would move an executed contract value and, for an
-- approved CO, the scheduled value of its SOV line - which is the number the
-- owner already paid against. So they get flagged here and the app refuses to
-- recompute them. Their cost buildups stay editable for the record; what is
-- frozen is co_value and the billing line, not the detail.
--
-- The flag is set for every change order that exists RIGHT NOW and has moved
-- past draft - a draft has never been executed, so freezing one would be
-- wrong, and CO-07 may already be sitting in the app as a draft. Anything
-- created after this migration runs defaults to false and prices in the app.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Safe to re-run: the backfill only touches rows where the flag is still null.

alter table public.change_orders
  add column if not exists legacy_pricing boolean not null default false;

comment on column public.change_orders.legacy_pricing is
  'True = priced outside the app, before the single total-markup model. '
  'resyncCoTotals never recomputes co_value or the SOV line for these. '
  'Set once, at migration time, for every CO that existed then (CO-01..CO-06 '
  'on Sweet Springs). New change orders default to false.';

-- Backfill. The column default is false, so a plain "where legacy_pricing is
-- null" would match nothing on a second run - guard on created_at instead,
-- captured the first time this runs.
create table if not exists public.change_order_pricing_cutover (
  id boolean primary key default true check (id),
  cutover_at timestamptz not null default now()
);

insert into public.change_order_pricing_cutover (id)
values (true)
on conflict (id) do nothing;

-- created_at is nullable (it carries a default, but a bulk import could have
-- written null). A null created_at means an imported row, which is old by
-- definition, so it freezes too rather than slipping through as in-app.
--
-- approved_at is checked alongside status because migration 0046 reset
-- unrecognized statuses to draft. A row carrying an approval date was executed
-- whatever its status column now says.
update public.change_orders co
   set legacy_pricing = true
  from public.change_order_pricing_cutover c
 where (co.created_at is null or co.created_at < c.cutover_at)
   and (coalesce(co.status, 'draft') <> 'draft' or co.approved_at is not null)
   and co.legacy_pricing = false;

alter table public.change_order_pricing_cutover enable row level security;
drop policy if exists "ahc_read_co_cutover" on public.change_order_pricing_cutover;
create policy "ahc_read_co_cutover" on public.change_order_pricing_cutover
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));

-- Say out loud how many were frozen, so the count can be checked against the
-- change orders actually on the books.
do $$
declare
  frozen_list text;
  open_list   text;
begin
  select string_agg(co_number, ', ' order by co_number)
    into frozen_list from public.change_orders where legacy_pricing;
  select string_agg(co_number, ', ' order by co_number)
    into open_list   from public.change_orders where not legacy_pricing;
  raise notice 'Frozen at pre-app pricing: %', coalesce(frozen_list, '(none)');
  raise notice 'On in-app pricing: %', coalesce(open_list, '(none)');
  raise notice 'Check the frozen list reads CO-01..CO-06. If a change order that was '
               'executed outside the app is missing from it, set its flag by hand: '
               'update public.change_orders set legacy_pricing = true where co_number = ''CO-0X'';';
end $$;
