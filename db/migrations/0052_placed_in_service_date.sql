-- 0052_placed_in_service_date.sql
--
-- Guaranteed Placed-in-Service Date on Exhibit H.
--
-- The owner's form carries three guaranteed dates, not two. Mechanical
-- Completion and Substantial Completion were modelled in 0046; Placed in
-- Service sits between them on the form and was missing, so a change order
-- that moves the PIS date had nowhere to say so and Phil filled that line of
-- Exhibit H by hand from a date the app did not hold.
--
-- Same shape as the other two, deliberately: the guaranteed date is a project
-- fact, the change order carries a delta in days, and the revised date is
-- derived rather than stored. Nothing about how the first two work changes.
--
-- Both columns are nullable with no default. A project that has no PIS date
-- and a change order that does not touch it read exactly as they do today, so
-- nothing is backfilled and no existing Exhibit H figure moves.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx). Safe to re-run.

alter table public.projects
  add column if not exists guaranteed_placed_in_service_date date;

comment on column public.projects.guaranteed_placed_in_service_date is
  'Guaranteed Placed-in-Service Date from the agreement. Exhibit H adjusts it by a change order''s pis_completion_delta_days.';

alter table public.change_orders
  add column if not exists pis_completion_delta_days integer;

comment on column public.change_orders.pis_completion_delta_days is
  'Days this change order moves the Guaranteed Placed-in-Service Date. Positive pushes it out, negative pulls it in, null or 0 leaves it alone.';
