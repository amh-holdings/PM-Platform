-- 0036_daily_production_phil_only.sql
--
-- Corrects the ownership of the daily commodity production report.
--
-- 0035 modelled production as something the subcontractor enters on their Field
-- Report. That was wrong. The Commodity Tracker is AHC's deliverable to the
-- owner (Sweet Spring Solar / DE): the sub files a Field Report, the CM checks
-- it, and Phil reads the quantities off those reports and files the owner's
-- daily production report. The sub never touches it.
--
-- After this migration:
--   daily_production - phil writes; phil/zarina/ahc_super/owner/counsel read;
--                      subs have no access at all
--   commodities      - phil writes; same read set as above, minus subs
--
-- Idempotent: safe to re-run.

-- ---- daily_production ----
-- Subs lose all access. They never entered these numbers and do not need to see
-- what AHC reports to the owner.
drop policy if exists "sub_read_daily_production"   on public.daily_production;
drop policy if exists "sub_insert_daily_production" on public.daily_production;
drop policy if exists "sub_update_daily_production" on public.daily_production;

-- Writes narrow from the AHC team to Phil alone. Zarina and Mark keep read so
-- they can see and sanity-check what has been filed, but a client deliverable
-- gets one author.
drop policy if exists "ahc_write_daily_production" on public.daily_production;
drop policy if exists "phil_write_daily_production" on public.daily_production;
create policy "phil_write_daily_production" on public.daily_production
  for all to authenticated
  using (public.current_user_role() = 'phil')
  with check (public.current_user_role() = 'phil');

drop policy if exists "ahc_read_daily_production" on public.daily_production;
create policy "ahc_read_daily_production" on public.daily_production
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super'));

-- ---- commodities ----
-- The commodity list, its targets, and the owner's roll-up row mapping are all
-- part of the same deliverable, so they follow the same rule.
drop policy if exists "sub_read_commodities"  on public.commodities;
drop policy if exists "ahc_write_commodities" on public.commodities;
drop policy if exists "phil_write_commodities" on public.commodities;
create policy "phil_write_commodities" on public.commodities
  for all to authenticated
  using (public.current_user_role() = 'phil')
  with check (public.current_user_role() = 'phil');

-- ---- commodity_task_links ----
drop policy if exists "ahc_write_commodity_task_links" on public.commodity_task_links;
drop policy if exists "phil_write_commodity_task_links" on public.commodity_task_links;
create policy "phil_write_commodity_task_links" on public.commodity_task_links
  for all to authenticated
  using (public.current_user_role() = 'phil')
  with check (public.current_user_role() = 'phil');

-- The old read policy allowed anyone authenticated (it only checked the
-- commodity row existed), which now leaks the mapping to subs. Scope it to the
-- roles that can see commodities at all.
drop policy if exists "read_commodity_task_links" on public.commodity_task_links;
create policy "read_commodity_task_links" on public.commodity_task_links
  for select to authenticated
  using (public.current_user_role() in ('phil','zarina','ahc_super','owner','counsel'));
