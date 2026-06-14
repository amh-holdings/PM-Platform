-- Phase 5: Link billing_lines to procurement_orders so the procurement
-- workflow drives owner billing.
--
-- For procurement-scope SOV lines (Module Procurement, POI Procurement,
-- Tracker/Racking Procurement, etc.) the billing trigger is "we submitted
-- a PO and the equipment is being procured" - NOT calendar progress.
-- Schedule date interpolation is irrelevant here.
--
-- This column lets a billing_line declare which procurement_orders feed
-- its scope. When the suggestion engine sees a procurement line with
-- linked POs, it uses sum(po.total_value) as the billable progress
-- instead of date math. When no PO is linked, suggestion = 0 (the PM
-- must submit a PO first to unlock billing on this scope).
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx).
-- Safe to re-run.

alter table public.billing_lines
  add column if not exists linked_procurement_order_ids uuid[];

create index if not exists billing_lines_procurement_link_idx
  on public.billing_lines using gin(linked_procurement_order_ids);
