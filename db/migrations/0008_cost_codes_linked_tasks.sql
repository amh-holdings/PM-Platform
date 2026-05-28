-- Phase 3 cash flow - link cost codes to schedule tasks so spend forecasts
-- can be auto-suggested in the same way billing forecasts are.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Safe to re-run.

alter table public.cost_codes
  add column if not exists linked_task_wbs_codes text[];
