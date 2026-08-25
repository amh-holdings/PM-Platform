-- Auto-proposed daily production - close the gap between an approved Field
-- Report and the owner's Commodity Tracker.
--
-- THE PROBLEM THIS FIXES
-- Nothing in the app has ever written daily_production. The only rows on Sweet
-- Springs came from a one-off run of scripts/commodity/propose-backfill.ts on
-- 2026-08-19, so the tracker froze at 2026-08-18 while approved Field Reports
-- kept arriving. Every day since read as "no work done" on the owner's sheet.
-- Reports now propose their own production the moment the CM approves them.
--
-- WHY A CONFIRMATION FLAG AND NOT A NEW `source` VALUE
-- `production_source` already says where a row CAME FROM. What was missing is
-- whether anyone has STOOD BEHIND it. Those are different questions: a
-- field_report row is proposed on approval and confirmed later by Phil, and it
-- keeps its provenance through that transition. A new enum member would force
-- the row to lie about one or the other. It would also mean ALTER TYPE ... ADD
-- VALUE, which cannot be used in the same transaction that adds it - a real
-- hazard for a script pasted whole into the SQL editor.
--
--   confirmed_at IS NULL      -> PROPOSED. Machine-derived, nobody has signed
--                                off. Must never reach a pay application.
--   confirmed_at IS NOT NULL  -> FILED. Phil saved it on the tracker.
--
-- Apply via Supabase SQL Editor (project sksfyygufnnbzrmneccx). Safe to re-run.

alter table public.daily_production
  add column if not exists confirmed_at timestamptz,
  add column if not exists confirmed_by uuid references public.profiles(id),
  -- Plain-English account of how a proposed number was arrived at: the keywords
  -- matched, the loads counted, the rate applied. Shown on the tracker so the
  -- reviewer judges the reasoning, not just the digit. Kept after confirmation
  -- so the audit trail survives.
  add column if not exists proposal_basis text;

-- Backfill: every row that predates this migration was either typed by AHC or
-- reviewed on the backfill proposal grid before apply-backfill.ts wrote it.
-- Both are confirmed by definition, and leaving them null would drop the whole
-- existing record out of billing the moment the filters below go live.
update public.daily_production
  set confirmed_at = coalesce(updated_at, created_at, now())
  where confirmed_at is null;

-- "What is waiting on Phil" is the tracker's headline query and the coverage
-- alarm's only input. Index just the unconfirmed rows.
create index if not exists daily_production_unconfirmed_idx
  on public.daily_production(project_id, production_date)
  where confirmed_at is null;

-- NO "confirmed rows must name a confirmer" CONSTRAINT.
-- It would be the natural guard here and it cannot be added: all 198 existing
-- rows carry entered_by = null, because apply-backfill.ts wrote them through
-- the service role and never recorded a user. Stamping Phil's id on them to
-- satisfy a check would be inventing an audit record for a review that
-- happened off-system. So confirmed_by is null ONLY on rows predating this
-- migration; saveDailyProduction stamps it on everything from here on.
