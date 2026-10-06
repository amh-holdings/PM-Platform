# Schedule task records - the popup behind a row

Built 1 Oct 2026, migration applied 5 Oct 2026. The schedule could always tell
you a task was 65% complete and on the critical path. It could never tell you
**why**.

The evidence existed the whole time. Every `inspections` row has carried
`schedule_task_id` since the table was built, and an approved inspection holds
the photographs the CM accepted the percent on. `dpr_task_updates` has carried
the same key for every field-report pin. Nothing on the schedule side ever read
either of them back, so substantiating a billed percent meant walking the
Inspections tab by hand - which is what AFP 12 substantiation actually was.

Seven of the eight parts below needed **no migration**. They are joins that
already resolved and were never queried from this direction.

## The one migration

| File | What it adds |
|---|---|
| `db/migrations/0069_schedule_task_documents.sql` | `schedule_task_documents`, a join table so a document can hang off the task it governs |

**Applied 5 Oct 2026** and verified against the live database, not assumed:

```
node scripts/verify-migrations-live.mjs   # 0069_schedule_task_documents -> LIVE
```

Four things were probed directly rather than inferred from the table existing,
because a table with a broken trigger is worse than no table:

| Probed | Result |
|---|---|
| The table and all seven columns | live |
| The `project_documents` embed the loader selects through | resolves |
| The trigger's cross-project guard | refuses a task and a document from different projects |
| The trigger overwriting a client-supplied `project_id` | corrects it |
| The `unique (schedule_task_id, document_id)` constraint | refuses a duplicate attach with 23505 |

The probe inserted one real link and deleted it again. The degrade path is still
in the code and still correct - the table is probed on both the count path and
the load path, and a missing one reads "Not enabled yet" rather than 400ing the
query - it just is not being exercised any more on this database.

### Why a join table, and why not keyed on wbs_code

One drawing covers a dozen tasks. Sheet C-301 is Basin 1 grading *and* Basin 1
final grading *and* the pond conversion, so a `schedule_task_id` column on
`project_documents` would force one copy of the PDF per task and the library
would then hold four rows that are the same file.

The key is `schedule_task_id`, **not** `wbs_code`, and this is the one place
this codebase deliberately departs from its neighbours.
`billing_lines.linked_task_wbs_codes` and the cost codes both hold WBS codes as
plain text, and every structural plan in SCHEDULE-EDITING.md carries a warning
that they dangle on a rename. Indent, outdent and the importer all renumber
codes. Unlike a billing line there is no reason to accept that here: a task has
a stable id, so it is used.

A trigger sets `project_id` from the task and refuses a task and a document
from different projects, so a link can never join one client's task to another
client's drawing.

## What is on the popup

Five tabs, each with its count on the tab, so an empty section can be seen
without opening it. Four empty tabs in a row is a fact about the task and it
should not cost four clicks to learn.

| Tab | Source | Migration |
|---|---|---|
| **Evidence** | `inspections.schedule_task_id` -> `inspection_photos` | none |
| **Photos** | the above pooled with `dpr_task_updates` -> `dprs` -> `photos` | none |
| **Reports** | `dpr_task_updates`, every pin in date order | none |
| **Logic & links** | predecessors resolved, successors derived, `schedule_constraints`, `procurement_orders.linked_delivery_task_wbs_code` | none |
| **Documents** | `schedule_task_documents` | **0069** |

### Successors, which the grid has never been able to show

The schedule stores logic in one direction: a task names what it comes after.
So the grid can tell you Build Basin 1 follows the grubbing, and cannot tell
you that Full Site Clearing and Basin 1 Final Grading are both waiting on it.
That second list is the one asked for in a meeting - it is the answer to "what
happens if this slips" - and `successorsOf` derives it by reading every other
task's predecessors.

It is derived over every task on the **project**, not the current scope. The
successor list is built server-side in `getTaskRecords` for exactly that
reason: filtering to Civil and then asking what Build Basin 1 drives would
silently omit any successor outside civil. That is the same class of bug as the
CPM running on the scope filter, fixed in Phase 1, and passing `allTasks` from
the browser would have walked it straight back in.

A predecessor that does not resolve is **named rather than dropped**. The
engine silently discards an unresolvable link, which frees the successor to
start on day one - a schedule that reads fine and forecasts nonsense. This is
the only surface that says so on the row itself.

### Reported is not the same as progressing

`markMovement` marks only the pins that raised the percent, measured against
the high-water mark rather than the previous report, so 95 -> 25 (a typo) -> 95
is not progress on the third day.

This is the quieter half of the under-billing in BACKLOG.md. Debris Removal was
reported almost every day from 20 Aug to 16 Sep and read 10% every time. A
missing report is visible; a report that moves nothing is not, until the pins
are listed side by side with the ones that moved marked.

The Reports tab says so out loud when more than half the pins did not move.

### The alert line

`taskRecordsAlert` returns at most one line, ordered by what would change
somebody's afternoon:

1. **Outside the network.** No predecessor and no successor. Outranks
   everything else because it is a structural fault - Fencing Installation and
   Permit Closeout both read as critical before the engine learned about
   isolated tasks.
2. **Open constraints.** The task is not ready to start.
3. **Stale report.** Days since the last approved report, counted **to the data
   date, not to today**. Every other figure on the schedule is as of the data
   date and a staleness number following the wall clock would disagree with the
   float beside it for no reason a reader could work out.
4. **Under way with no report at all.** This is the shape AFP 12 took: work in
   progress on a task still contributing $0 because nothing was ever approved
   against it.

A deliverable, a procurement row and a summary are never nagged about field
reports, because no report was ever going to cover them.

### Empty states name the rule

"Nothing here" is a worse answer than either of the real ones. A construction
task with no evidence is *waiting for an approved report*; a permit never had
one to wait for and its evidence is the attached document. An unclassified row
says the missing Type is why the app cannot tell which it is.

## Getting into it

The grid already spends clicks on three things - a cell click starts inline
editing, the checkbox selects for bulk and structural edits, the row body drags
to reorder. So a bare row click was not available, and the popup has three
targets of its own:

| Target | Why |
|---|---|
| The **Records** badge | already the thing saying there is something to see; shows a dash when empty so there is always something to click |
| The **row number** | that column is derived and read-only, so turning it into a button costs nothing |
| A **chevron** in the gutter on row hover | for anyone who thinks to do neither |

Then `↑` / `↓` or the arrow keys walk the scope without closing, which is the
one thing a popup does better than a route: a review of a whole scope before a
meeting is a dozen tasks read in order, not a dozen page loads.

The arrows walk `rows` - the list as filtered and collapsed **on screen** - so
filtering to Blocked and arrowing down visits the blocked rows rather than
every row between them.

## Two performance rules this is built around

**Counts are one pass, not one per row.** `loadTaskRecordCounts` runs four
queries for the whole project regardless of task count, selecting ids and
foreign keys only. A count per row would be 288 round trips on the full Sweet
Springs import for a badge, which is how a read-only feature ends up making the
page slower than the thing it was meant to illuminate.

**Signed URLs are minted on open, never at page load.** Both photo buckets are
private. Signing every photograph on the project at page load would be hundreds
of URLs that expire in an hour and that nobody opens, so the records load is a
server action fired when a row is actually opened.

`createSignedUrls` fails the *whole batch* if any path is missing from the
bucket, which on a project with one deleted file would blank every photograph
in the gallery. A failed batch falls back to signing one at a time, and the
individual failures come back null - a tile with a caption and no image beats
no gallery.

## It reads, and only reads

Nothing on this popup writes a percent, a date or a predecessor. Progress still
comes only from an approved field report and the schedule still belongs to the
edit dialog, which the popup opens unchanged rather than reimplementing. The
only writes in the whole feature are attaching and detaching a document, and
detach removes the **link** - the file stays in the library, which is the point
of a join table.

A reading surface that can write is how a careful rule gets quietly bypassed,
and `BULK_EDITABLE` in `schedule-actions.ts` exists because that rule is worth
protecting.

## The types, and why they were hand-edited once

`schedule_task_documents` is in `src/lib/database.types.ts` as a **hand-written
entry**, added 5 Oct 2026. The cast that stood in for it while the migration was
pending (`taskDocumentsTable`) is gone, and the queries are checked by the real
types, embed included.

It was hand-written because **`npm run db:types` cannot authenticate**:

```
{"_tag":"Error","error":{"code":"AccessTokenRequiredError",
 "message":"Access token not provided. Supply an access token by running
 `supabase login` or setting the SUPABASE_ACCESS_TOKEN environment variable."}}
```

That is not specific to this feature - type generation is broken for everybody
until somebody runs `supabase login` or puts `SUPABASE_ACCESS_TOKEN` in the
environment. Worth knowing, because the script's own guard means it fails
*quietly*: it writes to a temp file and checks it is non-empty before moving it,
so a failed run leaves the old types in place and prints nothing. The file does
not get truncated any more, but it also does not get updated, and nothing says
so. Check the line count or `grep` for the table rather than trusting a silent
success.

This is **not** the migration-0020 mistake, and the difference is the direction
of the drift. 0020 had the types *ahead* of the database, declaring
`change_orders` columns that did not exist - which was the only reason that code
compiled while both pages returned 400 in production. Here the database is
ahead, the table is real, and the entry was transcribed from the live schema's
own PostgREST OpenAPI definition rather than from the migration file or from
memory: required columns, nullability and all four foreign keys came back from
the database and match what is written down.

**Still worth doing:** once the CLI can authenticate, run `npm run db:types` and
let the generator replace the hand-written entry. It should produce the same
thing; if it does not, the generator is right and this block is the bug.

## Who can see it

The Schedule tab is `viewSchedule`, which is Phil and the CM. Subs do not have
it, so 0069 ships with no sub policy and a sub cannot read these rows at all -
deliberate, because the documents a task governs include permits and contract
exhibits, and the library they come from is already closed to subs.

The CM is blocked from financials, so the Procurement panel shows the PO number,
the vendor and the dates and **no dollar figures**.

## Verifying

```
npm run test:schedule                     # 754 known-answer tests, 33 of them new, no database
npm run build                             # the gate that matters - a failed build keeps the old deploy live
node scripts/verify-migrations-live.mjs   # 0069 against the live schema
```

The 33 new tests cover the successor derivation on the real civil shape,
numeric WBS ordering, dangling predecessors, movement against the high-water
mark, out-of-order report dates, staleness against the data date rather than
today, each branch of the alert ordering, and every empty-state reason.

`npm run test:inspections` has one pre-existing failure (`U-05 submitted ->
approved NOT allowed`) that predates this work and is unrelated to it.

Two things the live verifier turned up that have nothing to do with this
feature, recorded because they are easy to lose: **`0046_change_order_buildup`
is unapplied** (`change_order_buildup_lines` is absent live), and the
verifier's check list **stopped at 0048**, so 0049 through 0068 have never been
probed at all. 0069 was added to the list; the gap below it was not filled.

## Not built

| | Why |
|---|---|
| Comments per task | Needs a table, notifications and a read/unread model to be worth anything. Half-built it is a box nobody checks |
| CM log photos | `cm_daily_log_photos` has no task link, only a date. Joining by date would attach the wrong photographs to the wrong row |
| RFI and submittal links | `rfis` points at `wbs_sov`, `submittals` points at nothing. Re-pointing them is its own piece of work |
| An edit-history trail | There is no audit table on `schedule_tasks` at all. That is a trigger migration and a separate build |
| Upload straight into the task | The Documents tab links out to the library's uploader rather than duplicating it. Attach-from-library covers the case that matters, and one upload control is better than two that drift |

A mobile view is the real gap left. The grid is barely usable at phone width,
so a popup over it cannot be reached by a CM standing in a basin - which is
exactly where the photographs matter most. That wants its own surface, not a
wider popup.
