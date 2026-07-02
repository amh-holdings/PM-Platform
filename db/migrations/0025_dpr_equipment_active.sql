-- Field Report equipment tracks whether a piece of equipment is active on site
-- rather than rental details. Additive and idempotent; existing rows default to
-- active = true.

alter table public.dpr_equipment
  add column if not exists active boolean not null default true;
