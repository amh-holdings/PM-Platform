# Schedule engine - Phase 1, health check, constraint log

Built 17 Aug 2026. Three pieces: the engine fixes that make a forecast
defensible, the DCMA health check that automates the civil review, and the
constraint log that turns the look-ahead into a commitment.

## Apply these first

Two migrations, in order, in the Supabase SQL editor (project
`sksfyygufnnbzrmneccx`). Both are additive and safe to re-run.

| File | What it adds |
|---|---|
| `db/migrations/0033_schedule_engine_phase1.sql` | Date constraints and milestones on `schedule_tasks`; data date and work week on `projects`; `project_calendar_exceptions`; `schedule_updates` |
| `db/migrations/0034_schedule_constraint_log.sql` | `schedule_constraints` |

Both were applied on 17 Aug 2026 and verified with
`node scripts/schedule/verify-migrations.mjs` - 6 of 6 checks pass.

The app works without them. Every optional column and table is probed at load
and the UI degrades to "not enabled" rather than breaking, so a migration can
land on its own schedule without a deploy alongside it.

### Migration 0020, found while doing this

Regenerating `src/lib/database.types.ts` after 0033/0034 landed broke the
change-orders build. The cause was not this work.

The checked-in types declared `change_orders.cost_amount` and
`change_orders.profit_pct`. Those columns did not exist in the live database -
`db/migrations/0020_change_order_cost_profit.sql` was written but never
applied. The types file was *ahead* of the database, and was the only reason
the change-orders code compiled. Five call sites read or wrote those columns,
including the select lists on both change-orders pages, so those pages were
returning a 400 in production against a schema that did not have the columns.

0020 was applied on 17 Aug 2026 and the types regenerated. Both pages now query
successfully. `untyped()` has been removed and every `as never` cast in
`schedule-actions.ts` went with it - the types now describe the real schema, so
the escape hatches are gone rather than merely tidied.

The lesson worth keeping: `database.types.ts` can drift from the database in
**both** directions, and a compiling build proves nothing about the schema.
`node scripts/schedule/verify-migrations.mjs` checks the schedule side against
the live database directly.

Note also that `npm run db:types` used to be
`supabase gen types ... 2>/dev/null > src/lib/database.types.ts`, which
truncates the types file to empty on any failure and hides the reason. It now
runs through `npx`, writes to a temp file, checks it is non-empty, and only
then moves it - which is what caught the missing binary rather than wiping the
file.

## Two defects fixed

**The backward pass ignored lag on SS, FF and SF links.** The forward pass
applied `1 + lag`; the backward pass used a bare `1`, and read the successor's
late *start* rather than its late *finish* on SF. Float and therefore the
critical path were wrong on any non-finish-to-start link. The civil review on
17 Aug converted eleven links to SS, so this was live on Sweet Springs. Forward
and backward candidates now come from one mirrored pair of functions
(`candidateStart` / `candidateFinish`) so they cannot drift apart again.

**CPM ran on the scope filter, not the schedule.** Filtering to Civil dropped
every predecessor pointing outside civil, because a link to an unknown task is
silently discarded - so the Civil view computed float and a critical path as if
civil had no external constraints. CPM now always runs over every task; the
filter is a lens on the results.

A third, found while testing against the real data: an isolated task computes
to zero float because it is measured against itself, and was reading as
CRITICAL. Fencing Installation and Permit Closeout were showing on the civil
critical path alongside the four tasks actually driving the finish. They now
carry an `isolated` flag and read as UNLINKED.

## What else Phase 1 added

| | |
|---|---|
| **Data date** | Every calculation is as of a date, not as of today. An update that recalculates itself every time it is opened cannot be reproduced or compared. Null falls back to today. |
| **Free float** | Alongside total float. Total says the project can absorb five days; free says the foreman can take two without phoning anyone. On the civil scope, Construct Basin 2 ESC carries 24 days total float and zero free float. |
| **Near-critical** | Float at or below five days, above zero. The tasks that become critical next. |
| **Date constraints** | SNET, SNLT, FNET, FNLT, MSO, MFO. A start date is a plan and logic can push it; a constraint cannot. A constraint the logic cannot meet drives negative float and is reported rather than quietly absorbed. |
| **Milestones** | Zero duration. `durationOf` used to floor at one day, so every milestone finished a day late and consumed a working day it does not. Drawn as a diamond. |
| **Project calendar** | Work week per project, plus exception days in both directions - rain days and shutdowns that remove a day, recovery Saturdays that add one back. The holiday list was compiled into the source with no way to record a lost week. |
| **Schedule updates** | Immutable snapshots keyed to a data date, holding the full task set as jsonb. Insert-only by RLS policy. Migration 0032's own note records that the July civil re-baseline destroyed the prior dates with the only copy on disk; that is now impossible. |

## Health check

`src/lib/schedule-health.ts` implements all fourteen DCMA checks over our own
network. It is a tab on the schedule, not a separate page, because every
finding names tasks and the fix is an Edit on that task.

Each check reports a measured value, a verdict, the responsible tasks and what
to do. A check that cannot be evaluated - BEI without a baseline - returns
`na` and is excluded from the score rather than counted as a pass.

Run against the real civil scope it scores 76/100 (C) and finds: missing logic
on 9 of 27 tasks, one invalid date, an SS-heavy network, one unassigned task.
That is the SCHEDULE-FLOW-REVIEW.md findings, generated.

Run against the full 288-task import it scores 54/100 (F) with 100% missing
logic - correctly, because most predecessors in that import are legacy
Smartsheet row numbers ("5", "116, 115") rather than WBS codes, and the engine
discards them.

## Constraint log

`schedule_constraints`, plus a tab. Categories, an owner, and a need-by date
that is when the constraint must be **cleared** - upstream of the task start by
whatever lead time the answer needs.

Subs can raise a constraint but not clear one, enforced in RLS and in the
action. The foreman is the first to know the pipe is not on site. Closing one
requires a resolution note; a constraint closed with no explanation is not a
record of anything.

Open constraints surface as a BLOCKED badge on the schedule table and in the
look-ahead, which is the point: a task planned for this week with something in
its way is the row to talk about in the meeting.

## Tests

`npm run test:schedule` - 77 known-answer tests, no database. Every
relationship type in both directions, free float at a merge point, milestones,
each constraint type, data-date reproducibility, cycles, and the health checks.

The engine reproduces the manual civil review exactly: planned finish 9 Oct
2026, projected 15 Oct, 4 working days of slip, critical path Permanent Seeding
to Basin 1 Final Grading to Basin 2 Final Grading to Convert Basins to Ponds.

## Not built

Phase 4 (quantity-based progress and productivity forecasting) was deliberately
deferred until Sweet Springs reaches pile driving. Note that
`schedule_tasks` already carries `target_quantity`, `installed_quantity` and
`unit_of_measure` columns, so the data model is partly there already.
