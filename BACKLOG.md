# PM Platform - Backlog

Known gaps and future work. Newest first. Each entry says what breaks, how it
was found, and what "fixed" looks like - so the fix can be picked up cold.

---

## Weekly report cumulative man-hours disagree with its own weekly figure

**Opened:** 2026-09-02, while building the Monthly Manpower and Incident Report
**Severity:** Low - a number on an owner document, not a billing figure
**Status:** Open. Deliberately NOT fixed in the same change, because it moves a
figure that has already been sent to Dimension.

### What breaks

`deriveManHours` in `src/lib/weekly-report.ts` builds the WEEK's figure from
three sources in order - `dprs.total_man_hours`, then the `dpr_manpower`
regular+OT breakdown, then `crew_count x 8` with a flag. The CUMULATIVE figure
in the same function sums `total_man_hours` alone:

```ts
const cumulative = allTimeDprs
  .filter((d) => d.report_date <= periodEnd)
  .reduce((n, d) => n + (d.total_man_hours != null ? Number(d.total_man_hours) : 0), 0);
```

So any day that reached the week's figure through a fallback is missing from
cumulative, and "hours to date" reads lower than the sum of the weeks that
built it. On Sweet Springs, August alone has one such day (27-Aug, 8 crew and no
hours, counted at 64).

The `dpr_manpower` fallback cannot be applied to cumulative as the code stands -
`allTimeDprs` is selected as `report_date, total_man_hours, crew_count` with no
`id`, so there is nothing to join the manpower rows to.

### What "fixed" looks like

Add `id` to the all-time select in `weekly-report-load.ts`, load `dpr_manpower`
for all time, and run cumulative through the same `hoursOf()` the week uses.
Then decide separately whether to re-issue any weekly report whose cumulative
figure moves - the issued ones print from `issued_payload` and will not change,
which is correct, but a draft will.

The Monthly Manpower report does not have this bug; `deriveManHours` in
`monthly-manpower.ts` runs one code path for the whole period.

---

## Daily report audit / coverage alarm

**Opened:** 2026-08-20, during Sweet Springs AFP 12
**Severity:** High - it silently under-bills the owner
**Status:** Partly addressed 2026-08-24, still open.

Half of this is now covered. The Commodity Tracker had the same disease in a
worse form - nothing in the app had EVER written `daily_production`, so it sat
frozen at 2026-08-18 while approved reports piled up behind it. Migration 0040
plus `src/lib/production-proposal*.ts` make an approved Field Report propose its
own day's production, and the Production page now raises "N approved reports
with nothing on the tracker" for any day whose report was approved but which
carries no quantities. Proposals land unconfirmed and are filtered out of
`loadEvidence` and the next-bill projection, so they cannot reach an AFP.

What is STILL open is the harder half described below: a day where the CM logged
work and the sub filed no DPR at all. That day has no approved report, so it
raises no alarm on the tracker either - the coverage check has to run off the CM
log as the spine, not off the reports that happen to exist.

### What breaks

Progress only reaches a schedule task when the **subcontractor** submits a DPR
and pins a percent to it (every `inspections` row on Sweet Springs is
`origin='sub'`, `dpr_id` set). The CM daily log is a parallel record that moves
nothing. So when a sub stops submitting, billing quietly freezes at the last
report, and nothing in the app says so.

On Sweet Springs in a 14-working-day stretch, Pyramid Excavations missed three:

| Date | CM daily log | Sub DPR | Work the CM recorded |
|---|---|---|---|
| 2026-08-08 | final | **missing** | 7 crew, silt fence crew on site, log harvesting |
| 2026-08-19 | final | **missing** | Debris cleared from front entranceway to start the road, 18 loads out |
| 2026-08-20 | draft | **missing** | Culvert set at front entrance with Timmons for compaction testing |

Consequence on AFP 12: WBS 5.1.1.8 Construct Construction Entrance and 5.1.1.9
Rough Road both still read "Not Started" with `pct_complete` null, so they
contributed **$0** to SOV line 6.02, despite the work being underway. Each is
worth roughly $31,773 at full completion (1/13 of $413,045.92).

A second, quieter variant: on 2026-08-18 the sub *did* submit, and it was
approved, but only pinned Basin 1 and Basin 2. The CM log for the same day notes
"Grabbing the laydown yard" - so WBS 5.1.1.10 was worked, observed, and still
reads Not Started. A day being present is not proof it is complete.

Contributing factor worth designing around: none of this work was scheduled yet.
Construction Entrance baselines to 8/24 and Laydown Yard to 9/2. The crew is
running **ahead** of baseline, and reporting naturally follows the tasks that
look active. Work that starts early is exactly what falls through.

### What "fixed" looks like

1. **Coverage alarm.** For every working day in a period, flag where a CM daily
   log exists but no sub DPR does. Surface it on the project dashboard and, more
   importantly, in the Bill this period / Create AFP flow - the PM should not be
   able to build a pay application over an unreported day without seeing it.
2. **Reconcile the two records.** Show the CM daily log narrative beside the
   sub's DPR for the same date so an under-reported day (8/18 laydown yard) is
   visible, not just a wholly missing one.
3. **Let progress be reported against not-yet-started tasks.** Do not filter the
   reportable-task list by baseline date window, or work running ahead of
   schedule stays invisible to billing.
4. **AFP staleness check.** When creating an application, compare the newest
   approved DPR date against the period end. "Last approved report 8/18, period
   ends 8/31" is the warning that would have caught this one.
5. Optional: a nudge to the sub when a DPR is missing for a day the CM logged.

### Related

- `src/app/(app)/projects/[id]/pay-app-actions.ts` builds the application
- `scripts/derive-afp12.mjs` shows the SOV <-> WBS <-> report derivation
- `scripts/afp12-backup-sheet.mjs` renders the Dimension substantiation package
- Migration `0037_afp_hardening.sql` is **still unapplied** on the live database
  (`pay_applications.retainage_pct`, `commodities.contract_sov_item`, and the
  corrected `v_billing_line_totals` view are all absent). It is the only
  unapplied migration - verify with `scripts/verify-migrations-live.mjs`, which
  probes the live schema for the artifact each migration creates.

---

## Equal-weighting of WBS tasks in AFP percentages

**Opened:** 2026-08-20
**Severity:** Medium

A SOV line's percent complete is the plain average of the `pct_complete` of the
tasks in its `linked_task_wbs_codes`. That treats 1-day "County Inspection" as
equal to 22-day "Site Grading". On AFP 12, 6.02 came out at 21.54% across 13
tasks - defensible, but it is a task-count average, not a dollar measurement.

**Fixed looks like:** cost-loading per WBS task (or duration weighting as a
cheaper approximation), so the roll-up reflects value earned rather than task
count. Needs a decision on where the loading is authored.

---

## Commodity roll-up disagrees with the contract SOV

**Opened:** 2026-08-19 (migration 0037), still unapplied
**Severity:** Medium - blocks billing from measured quantities

`commodities.sov_item` records the client's Smartsheet roll-up verbatim, and on
four rows it contradicts the executed contract: it maps fencing to 6.02 and road
install to 6.03, while the contract has 6.02 = "Civil, Roads and Landscaping"
and 6.03 = "Fencing/SWPPP". Migration 0037 adds `contract_sov_item` to hold the
contract mapping and states only that column may drive billing - but the
migration has not been run.

Until it is, `daily_production` cannot be used as a billing basis. Note this is
live data: Site Prep reads 60.02% and Civil Work 15% cumulative for August
(source `backfill`), both mapped to 6.02, against the 21.54% AFP 12 billed off
the schedule. Reconcile before switching bases.
