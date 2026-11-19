-- Bill deliverable milestones scheduled to finish inside the period, 2026-11-19.
--
-- Phil: "we submit pencil copy every 20th of every month so even if it is not
-- completed yet, they are projected to be included on the month bill, we will
-- reject if delay comes."
--
-- On Sussex the pencil copy goes to the owner on the 20th and covers the
-- whole month. A design package or permit scheduled to finish by month end
-- belongs on it, marked projected; if it slips, it comes off before the
-- final copy. Sweet Springs bills to its 20th cutoff on what has happened,
-- so this is a per-project setting and off unless turned on.
--
-- Only deliverable tasks are projected. Construction progress still comes
-- from field reports and is never billed ahead.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx). Safe to re-run.

alter table public.projects
  add column if not exists bill_scheduled_milestones boolean not null default false;

-- Sussex works this way.
update public.projects
   set bill_scheduled_milestones = true
 where id = '39154377-bd1a-48ea-acdc-5d9b568863c9';
