# Schedule editing - create, import, grid, structure, drag

Built 19 Aug 2026. The engine could already tell you what the schedule meant.
It could not let you build one. `schedule-actions.ts` had `updateScheduleTask`
and `deleteScheduleTask`, no create action at all, and `deleteScheduleTask` was
never wired to a button - so a schedule could only arrive through a one-off
script in `scripts/`.

Three phases, all shipped together.

| Phase | What | Where |
|---|---|---|
| 1 | Add and delete tasks, paste-import with a diff preview | `schedule-import-dialog.tsx`, `task-edit-dialog.tsx` |
| 2 | Inline cell editing, multi-select, bulk shift and set | `schedule-edit-grid.tsx` |
| 3 | Indent, outdent, row moves, drag on the Gantt | `schedule-edit.ts`, `schedule-gantt.tsx` |

## No migration

Every column this uses already exists - `wbs_code`, `level_code`,
`parent_wbs_code` and `sort_order` came with 0005, and `is_milestone` and the
date-constraint pair with 0033. Nothing to apply.

The write path honours the same contract the read path does. The schedule page
probes for the 0033 columns and degrades to "not enabled" rather than breaking,
so a project on an older database still works. An insert naming a column that
does not exist fails the whole row, so `createScheduleTask` and
`applyScheduleImport` catch 42703 / PGRST204 and retry without the Phase 1
fields instead of taking the page down.

## One write path

Everything - a typed cell, a bulk shift, a dragged bar, a pasted sheet - writes
through the same `schedule_tasks` rows the CPM engine reads. There is
deliberately no importer table and no importer-only column. The moment the
forecast depends on which door the data came through, it stops being a forecast.

`BULK_EDITABLE` in `schedule-actions.ts` is an allowlist rather than a
passthrough, because these actions take their patch from the browser.
`pct_complete`, `status_source` and the baseline columns are not on it: progress
belongs to approved field reports and a baseline belongs to the baseline action.
A schedule you can type a percentage into is a schedule nobody believes.

## The rule that shapes all of it: rename as little as possible

A WBS code is not a position. It is an identifier that predecessor strings,
inspections, and - as text arrays with no foreign key - billing lines and cost
codes all point at. So:

- **Indent and outdent renumber the moved branch only.** Former siblings keep
  their codes and the numbering shows a gap. Row order lives in `sort_order`.
- **Row moves rename nothing.** They touch `sort_order` and stop. A move that
  would take a task out of its own branch is refused with a message saying that
  getting it out is an outdent, which is a different and renaming edit.
- **Every rename repoints every predecessor that mentions it**, project-wide,
  including tasks outside the moved subtree and outside the current scope
  filter. `planIndent` on the live civil schedule repoints up to 10 links from a
  single move.
- **What cannot follow the rename is said out loud.** Every structural plan
  carries a warning that billing lines and cost codes hold WBS codes as plain
  text.

`nextChildCode` takes the highest existing child and adds one rather than
filling the first gap. A code that was used and deleted may still be referenced
by an old inspection, and handing it to a different task would silently
re-point that reference.

### A shape the fixtures did not have

Sweet Springs has no depth-1 row - the "5" Construction root went with the
August civil cut - so its top level is 5.1, 5.2, ... Two bugs came out of
testing against it rather than against invented data:

- Asking for a new top-level code returned `1`, because "top level" had been
  written as "depth 1". `nextTopLevelCode` now works from the shallowest row
  actually present, so it answers `5.2`.
- Outdenting 5.1 succeeded and produced a bare `1`, because the code implies a
  parent "5" that does not exist as a task. Outdent now requires the parent code
  to be a real row.

A third came from the move logic: stepping "3" up past a summary "2" that had a
subtask landed it *between* them, because the neighbour was found by looking at
the row immediately above rather than the block that row belongs to.

## The importer

`parseGrid` → `guessColumns` → `buildImportRows` → `diffImport`, all pure, all
in `schedule-edit.ts`. The dialog walks paste → map columns → review, and
nothing is written until the diff has been seen. The browser then sends the plan
it showed you, not the paste: the diff you approved is the diff that runs.

What it handles, because this is what actually comes out of Smartsheet:

| | |
|---|---|
| Delimiter | Tab wins whenever present - a spreadsheet paste is tab separated and its cells routinely contain commas. Quoted CSV fields are honoured. |
| Header | Detected by column-name hints, and rejected if any cell parses as a date, so "Start" is a header and "8/19/26" is data. |
| Dates | ISO, `9/8/26`, `09/08/2026`, `Sep 8, 2026`, `8-Sep-26`. 31 Feb is rejected rather than rolled over. |
| Durations | `5`, `5d`, `5 days`, `5d?` (the estimated flag), `2w` → 10. |
| Predecessors | **Smartsheet writes these as row numbers.** They are translated to WBS codes, and the translation is reported. Relationship type and lag survive: `12SS+5d` → `5.1.2SS+5`. A token that already matches a real WBS code is never rewritten. |
| Hierarchy | From a WBS column, or generated from the leading whitespace the clipboard keeps, optionally nested under a branch you name. |

Two behaviours matter more than the parsing:

**Only mapped fields are compared and written.** A four-column paste must not
blank out phase, assignment and logic on every task it touches. That is the
single most destructive thing a naive importer does, and there is a test for it.

**Deletion is opt-in and always scoped to a branch you name.** "Everything not
in this paste" is a reasonable statement about civil earthworks and a dangerous
one about a whole project.

## Deleting

`describeTaskDeletion` reports the blast radius before anything happens: how
many field-report updates cascade away, how many inspections lose their WBS link
and stop feeding progress, which successors reference the task, whether
subtasks would be orphaned, and that billing lines and cost codes will dangle.

Predecessor references to a deleted task are stripped by default. The engine
skips a link it cannot resolve, so a dangling reference does not error - it
quietly frees the successor to start on day one. Left alone that is a schedule
that reads fine and forecasts nonsense.

## Editing surface

The grid holds edits in a draft rather than writing per keystroke. Bulk actions
land in that same draft, so a shift of 40 rows is one review-and-save gesture
and Discard undoes it. Arrow keys and Enter move between cells; Escape puts a
cell back to what the database says. Left and right only jump cells from the
ends of the text, so arrowing through a task name still works the way typing
expects.

Predecessors are editable as text in the grid - which is the fastest way to do
the kind of work the August civil review needed, eleven links converted from FS
to SS - and validated against the whole project for unknown codes and cycles
before anything is saved.

Structural moves are blocked while cell edits are pending. A rename and a draft
keyed to the same rows would fight.

On the Gantt, dragging is opt-in per call site and drops into a pending list
rather than writing on mouse-up, with the old bar drawn as a dashed outline so
the size of the move is visible while making it. A move keeps the task's
working-day duration rather than its calendar span, so dragging a 5-day task
across a holiday week leaves it a 5-day task. Summary rows have no dates of
their own and cannot be dragged.

## Verifying

```
npm run test:schedule          # 161 known-answer tests, no database
npm run verify:schedule-edit   # dry-run every plan against live Sweet Springs
```

The unit tests all use fixtures I invented, which is exactly how the two
top-level-code bugs survived them. `verify-edit-plans.ts` reads the real 30-task
civil schedule, dry-runs an indent, outdent and move on every task, and then
does the strongest check available without writing anything: it exports the
schedule as a TSV, feeds it back through the importer, and asserts the diff is
empty.

```
Sweet Springs: 30 tasks, top code 5.1
Next top-level branch would be: 5.2
Indent: 26 tasks can indent, 4 refused
Outdent: 29 can outdent, 1 refused
Round-trip import: 0 adds, 0 changes, 30 unchanged, 0 deletes
PASS - the schedule round-trips through the importer unchanged
```

## Where this leaves Smartsheet

It is now optional. Authoring in Smartsheet and pasting in is still the fastest
way to type 150 rows, and the importer exists to make that a clean handoff
rather than a script I write for you. But the platform no longer needs it: you
can build a schedule in the grid, and every adjustment after the first one -
which is the part that never stops - belongs here anyway, wired to the data
date, the baselines, the `schedule_updates` snapshots and field-report progress
that Smartsheet cannot see.
