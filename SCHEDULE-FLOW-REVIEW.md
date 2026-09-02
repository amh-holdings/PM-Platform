# Civil Schedule Flow Review - Sweet Springs Solar

Prepared 17 Aug 2026 | Review with Mark Wooley | Civil scope, 30 tasks | Sub: Pyramid Excavation

---

## The diagnosis

Thirteen tasks are scheduled to start before the task they depend on is allowed
to finish. That is not thirteen mistakes. It is one inherited assumption showing
up thirteen times.

**Every link came out of Smartsheet as finish-to-start.** The imported schedule
assumes each task waits for the one before it to finish. Dennis Brookman's
look-ahead describes the opposite: in every single week, work overlaps. Basins
are de-stumped *and* Basin 1 installation begins. The culvert goes in *and* the
roadway starts. Entrance, roadway, parking and laydown all run together.

So the dates and the logic disagree, and the logic is what is wrong. Correcting
the relationship type on eleven links reconciles them without touching a single
date.

Two findings are more than notation: one link points the wrong way, and one
genuine constraint is missing entirely.

| Category | Count |
|---|---|
| Missing gate | 1 |
| Backwards link | 1 |
| Wrong link type | 11 |
| Unlinked tasks | 3 |
| Duplicate task | 1 |

---

## Fix first - these are not notation

### 1. Full Site Clearing does not wait for county approval (5.1.2.5) - PERMIT RISK

Full Site Clearing depends only on the two basins. **County Inspection has no
successor at all** - nothing in the schedule waits on it. As written, the
schedule permits mass clearing to begin whether or not the county has signed off.

> Complete Basin 1 & 2 installation. E&S inspections from county. Begin complete
> de-stump and clearing process *with county approval*.
> - Dennis Brookman, week of 31 Aug

| | |
|---|---|
| Predecessors now | `5.1.2.2, 5.1.2.4` |
| Change to | `5.1.2.2, 5.1.2.4, 5.1.1.11` |

### 2. The culvert and the entrance are the wrong way round (5.1.1.2 / 5.1.1.12)

The RCP culvert is set to follow the Construction Entrance. You install the
culvert and then build the entrance over it. Dennis has the culvert going in
this week and the entrance completing next week - the reverse of what the
schedule says.

The entrance is already 85% complete, so it should not restart. A
finish-to-finish link says what is actually true: the entrance cannot be called
complete until the culvert is in.

| Task | Now | Change to |
|---|---|---|
| 5.1.1.12 after | `5.1.1.2` | *(nothing)* |
| 5.1.1.2 after | `5.1.1.1` | `5.1.1.1SS, 5.1.1.12FF` |

---

## Concurrent work chained as finish-to-start

Each row is a task whose planned start precedes what its own predecessor
permits. "Overlap" is how many days the schedule currently contradicts itself.
Changing the link type resolves every one of them without moving a date.

| # | WBS | Task | Now | Overlap | Change to |
|---|---|---|---|---|---|
| 1 | 5.1.1.2 | Install stabilized Construction Entrance | `5.1.1.1` | 48d | `5.1.1.1SS` |
| 2 | 5.1.1.5 | Initial clearing for Perimeter ESC | `5.1.1.1` | 45d | `5.1.1.1SS` |
| 3 | 5.1.1.4 | Prepare parking / storage and perimeter controls | `5.1.1.2` | 7d | `5.1.1.2SS` |
| 4 | 5.1.1.8 | Construct Basin 1 ESC | `5.1.1.7` | 7d | `5.1.1.7SS` |
| 5 | 5.1.1.13 | Construct access roadway | `5.1.1.12` | 5d | `5.1.1.12SS+2` |
| 6 | 5.1.1.14 | Temporary parking area | `5.1.1.13` | 7d | `5.1.1.13SS` |
| 7 | 5.1.1.15 | Establish laydown yard | `5.1.1.13` | 5d | `5.1.1.13SS+2` |
| 8 | 5.1.2.1 | Basin 1 Clearing and grubbing | `5.1.1.5` | 7d | `5.1.1.5SS` |
| 9 | 5.1.2.2 | Build Basin 1 | `5.1.2.1` | 4d | `5.1.2.1SS+2` |
| 10 | 5.1.2.5 | Full Site Clearing | `5.1.2.2, 5.1.2.4` | 7d | see permit gate above |
| 11 | 5.1.1.11 | County Inspection | `5.1.1.10` | 8d | keep FS, move dates |

### Decide as a set: 5.1.1.10, 5.1.1.11, 5.1.2.5

Stabilization, County Inspection and Full Site Clearing are all dated into the
same week, 31 Aug to 4 Sep. An inspection genuinely should follow stabilization,
and clearing genuinely should follow the inspection - so the link types are
right and the **dates** are what need to move. Dennis has all three happening in
one week, which cannot be true if the sequence is real.

Settling this fixes the permit gate at the same time.

**Ask Mark:** does the county inspect once, at the end of stabilization, or
progressively as each measure goes in?

---

## Tasks floating free of the network

### Fencing Installation (5.1.1.6) - no predecessor, no successor

Still dated 16 Jul to 5 Aug, both now in the past, and never mentioned in
Pyramid's look-ahead because Hercules Fence is a different subcontractor.
Nothing drives it and nothing waits on it, so a slip here moves nothing and
nothing moves it.

**Needs from Mark:** real dates, and what fencing has to follow. Perimeter
clearing is the likely answer.

### Permit Closeout (5.1.4) - pinned to July 2027, unlinked

Sitting eleven months past the work with no logic attached. The app now excludes
free-floating milestones from setting the project finish. Without that, this one
task was the entire critical path and gave every real task around 230 days of
float.

| | |
|---|---|
| Predecessors now | *(nothing)* |
| Change to | `5.1.2.9` |

### Timber processing (5.1.2.10) - no predecessor

There is no timber to process until something has been cleared, so this should
hang off perimeter clearing rather than starting on its own.

| | |
|---|---|
| Predecessors now | *(nothing)* |
| Change to | `5.1.1.5SS` |

### Duplicate parking scope (5.1.1.4 / 5.1.1.14) - my error

I added `5.1.1.14 Temporary parking area` from Dennis's week-two list without
noticing that `5.1.1.4 Prepare parking / storage and perimeter controls` already
covered it. They overlap.

Either delete 5.1.1.14 and let the original stand, or narrow 5.1.1.4 to *storage
and perimeter controls* and let 5.1.1.14 own parking. The second is cleaner if
parking and laydown are billed separately.

---

## Still open from the last pass

| Item | Detail |
|---|---|
| Mass Grading has no finish date | Dennis gives 8 Sep as a start and nothing more. Left deliberately blank rather than invented - shows as "Needs date" in the app. Largest remaining civil scope |
| Everything after 11 Sep is derived | The look-ahead stops there. Seeding, both final gradings and the pond conversion were shifted by the slip, not agreed with anyone. They are also the current critical path |
| Two approved field pins orphaned | Both sat on `1.2.2 Civil`, a contracts-branch task removed with the non-civil scope. They keep photos and approvals but no longer feed progress. Real work needs re-pinning; a mis-pin needs nothing |

---

## Where the schedule stands now

| | |
|---|---|
| Planned finish | 9 Oct 2026 |
| Projected finish | 15 Oct 2026 |
| Slip | 4 working days |
| Critical path | Permanent Seeding -> Basin 1 Final Grading -> Basin 2 Final Grading -> Convert Basins to Ponds |

## How to apply the changes

Changes go in through **Edit** on any task. Pick the predecessor from the
dropdown, set the relationship, add lag in working days. Circular dependencies
are blocked before they save.

Hold off on **Set baseline** until this walkthrough is done - baselining against
dates you are about to change means doing it twice.
