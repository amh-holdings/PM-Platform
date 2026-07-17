-- Project site location. Auto-weather (Phase 1a) and the MW-installed rollup
-- (Phase 2a) both key off the project's coordinates. Entered manually for now
-- (no geocoding API in the no-API build); a later backfill can derive lat/long
-- from zip_code. Additive and idempotent.

alter table public.projects
  add column if not exists latitude numeric(9,6),
  add column if not exists longitude numeric(9,6),
  add column if not exists timezone text;
