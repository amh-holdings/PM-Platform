-- Equipment operating vs idle hours on the daily report, so utilization and
-- standby time are captured (and later costed) instead of just a presence flag.
-- Additive and idempotent.

alter table public.dpr_equipment
  add column if not exists operating_hours numeric(8,2),
  add column if not exists idle_hours numeric(8,2);
