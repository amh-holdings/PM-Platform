-- Solar nameplate + module wattage on the project, so the daily report can roll
-- installed module counts up into MW-installed-to-date and show it against plan.
-- module_watts converts an installed MODULE count to DC watts. dc_capacity_mw is
-- the project's planned nameplate. Additive and idempotent.

alter table public.projects
  add column if not exists dc_capacity_mw numeric(10,3),
  add column if not exists module_watts numeric(8,2);
