-- OPTIONAL - the app does NOT need this. Nothing is broken until it runs.
--
-- Per-line markup opt-out ships WITHOUT a schema change. It rides on
-- change_order_cost_lines.markup_pct, a column 0046 created for the per-line
-- RATE model, which that same migration then abandoned. Nothing has read it
-- since; the app wrote null into it on every save. So it was free real estate:
--
--   markup_pct = 0     this line is held out of the markup base
--   markup_pct is null  this line bears the change order's markup
--
-- Zero is not a repurposing so much as the literal reading - a line whose
-- markup rate is zero earns no markup - and it is exactly what 0046's own
-- comment on the column describes.
--
-- WHAT THIS FILE WOULD BUY
-- A boolean says what is meant without the reader having to know that history,
-- and it closes the one soft edge: a rate someone writes into markup_pct from
-- outside the app (a script, the SQL editor) reads as "bears markup at the CO
-- rate", silently ignoring the number. That matches the behaviour before this
-- feature existed, so it is not a regression, but it is a column carrying two
-- meanings.
--
-- APPLYING THIS ALONE CHANGES NOTHING. The code reads markup_pct. Switching it
-- over is a follow-up commit: map markupApplies off markup_applies in
-- change-order-load.ts and resyncCoTotals, write it in saveCostLine and
-- addPastedCostLines, then backfill from the old encoding:
--
--   update public.change_order_cost_lines
--      set markup_applies = false
--    where markup_pct = 0;
--
-- Do the backfill in the same window as the deploy, or lines held out of the
-- markup base silently start bearing it again and every affected CO reprices.

alter table public.change_order_cost_lines
  add column if not exists markup_applies boolean not null default true;

comment on column public.change_order_cost_lines.markup_applies is
  'False keeps this line out of the change order markup base. Its cost still counts toward the direct cost total and toward what the owner is billed - it is only excluded from the cost x markup calculation. Use for permits at cost, taxes, and contract pass-throughs.';

create index if not exists co_cost_lines_no_markup_idx
  on public.change_order_cost_lines(change_order_id)
  where markup_applies = false;
