// Schedule engine - known-answer test harness.
//
// Pure functions only, no database. The CPM engine is the one place in the app
// where a subtle error is invisible: a wrong float does not throw, it just
// quietly puts the wrong tasks on the critical path and nobody notices until
// the job is late. Every relationship type is checked in both directions,
// because the bug that prompted this file was a backward pass that silently
// dropped the lag term on SS, FF and SF links.
//
// Run: npx tsx scripts/schedule/run-tests.ts

import * as XLSX from "xlsx";

import {
  addWorkingDays,
  advance,
  isWorkingDay,
  makeCalendar,
  retreat,
  subWorkingDays,
  workingDaysBetween,
} from "@/lib/schedule-calendar";
import {
  computeCpm,
  parsePredecessors,
  serializeLinks,
  type CpmInput,
} from "@/lib/schedule-cpm";
import { assessSchedule } from "@/lib/schedule-health";
import { resolveMilestoneTask } from "@/lib/progress";
import { hasLinkErrors } from "@/app/(app)/projects/[id]/schedule/predecessor-editor";
import {
  defaultSheetIndex,
  gridFromSheet,
  isWorkbookFile,
  readWorkbook,
  sheetMatrix,
} from "@/lib/schedule-workbook";
import { buildProgress } from "@/lib/schedule-rollup";
import { endpointsFor, headDirection, linkPoints, toPath } from "@/lib/schedule-links";
import {
  collapseToLevel,
  depthOf,
  descendantsOf,
  hasChildren,
  outlineDepth,
  parentOf,
  revealTask,
  summaryCodes,
  toggleBranch,
  visibleRows,
} from "@/lib/schedule-tree";
import {
  buildImportRows,
  compareWbs,
  diffImport,
  guessColumns,
  nextChildCode,
  nextTopLevelCode,
  parseGrid,
  parseLooseDate,
  parseLooseDuration,
  planIndent,
  planDrop,
  planMove,
  planOutdent,
  orderRenames,
  reconcileDates,
  durationFromDates,
  rewritePredecessors,
  shiftDates,
  splitPredecessorToken,
  buildRowIndex,
  gridFromMatrix,
  nearbyPredecessors,
  planChainLink,
  planFanLink,
  planUnlink,
  rowRefsAreSafe,
  toRowRefs,
  toWbsRefs,
  type ColumnKey,
  type EditTask,
} from "@/lib/schedule-edit";

// ---- tiny test runner ----
let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` - ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown) {
  check(
    name,
    actual === expected,
    actual === expected ? "" : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
  );
}

function section(title: string) {
  console.log(`\n${title}`);
  console.log("-".repeat(title.length));
}

// Task factory. Mon 2026-09-07 is Labor Day, so the fixtures below start on
// Tue 2026-09-01 to keep the arithmetic obvious except where a holiday is the
// point of the test.
function task(partial: Partial<CpmInput> & { wbs_code: string }): CpmInput {
  return {
    task_name: partial.wbs_code,
    start_date: null,
    end_date: null,
    duration_days: null,
    predecessors: null,
    pct_complete: null,
    status: null,
    ...partial,
  };
}

// ============================================================================
section("Calendar");
// ============================================================================

eq("Saturday is not worked on a 5-day week", isWorkingDay("2026-09-05", 5), false);
eq("Saturday is worked on a 6-day week", isWorkingDay("2026-09-05", 6), true);
eq("Sunday is never worked", isWorkingDay("2026-09-06", 6), false);
eq("Labor Day 2026 is a holiday", isWorkingDay("2026-09-07", 5), false);

eq("addWorkingDays(x, 1) is the same day", addWorkingDays("2026-09-01", 1), "2026-09-01");
// Thu 3, Fri 4, then Mon 7 is Labor Day so the third day is Tue 8.
eq("addWorkingDays skips the weekend and the holiday", addWorkingDays("2026-09-03", 3), "2026-09-08");
eq("subWorkingDays(x, 0) snaps back", subWorkingDays("2026-09-05", 0), "2026-09-04");
eq("subWorkingDays(x, 1) steps back one", subWorkingDays("2026-09-07", 1), "2026-09-04");

// advance/retreat are exact mirrors, which is what the lag maths depends on.
eq("advance(x, 0) is x", advance("2026-09-01", 0), "2026-09-01");
eq("retreat(x, 0) is x", retreat("2026-09-01", 0), "2026-09-01");
eq("advance then retreat round-trips", retreat(advance("2026-09-01", 4), 4), "2026-09-01");
eq("advance with a negative count retreats", advance("2026-09-10", -2), retreat("2026-09-10", 2));
eq("retreat with a negative count advances", retreat("2026-09-10", -2), advance("2026-09-10", 2));

const rainCal = makeCalendar(5, [
  { exception_date: "2026-09-02", kind: "nonworking" },  // rain day
  { exception_date: "2026-09-05", kind: "working" },     // Saturday recovery
]);
eq("a rain day is not worked", isWorkingDay("2026-09-02", rainCal), false);
eq("a recovery Saturday is worked", isWorkingDay("2026-09-05", rainCal), true);
eq(
  "a rain day pushes the finish",
  addWorkingDays("2026-09-01", 3, rainCal),
  "2026-09-04",
);
eq(
  "the same span without the rain day",
  addWorkingDays("2026-09-01", 3, 5),
  "2026-09-03",
);

// ============================================================================
section("Predecessor parsing");
// ============================================================================

eq("bare code is finish-to-start", parsePredecessors("5.1.1.1")[0].type, "FS");
eq("SS suffix parses", parsePredecessors("5.1.1.1SS")[0].type, "SS");
eq("lag parses", parsePredecessors("5.1.1.2FF+3")[0].lag, 3);
eq("lead parses", parsePredecessors("5.1.1.2SS-2")[0].lag, -2);
eq(
  "round-trips through serialize",
  serializeLinks(parsePredecessors("5.1.1.1, 5.1.2.1SS+2, 5.1.3FF-1")),
  "5.1.1.1, 5.1.2.1SS+2, 5.1.3FF-1",
);

// ============================================================================
section("Relationship types - forward pass");
// ============================================================================

const OPTS = { dataDate: "2026-09-01" as const };

// A: Tue 1 Sep for 5 days -> finishes Mon 7 Sep... except 7 Sep is Labor Day,
// so it runs Tue-Fri then Tue 8 Sep.
{
  const out = computeCpm(
    [
      task({ wbs_code: "1", start_date: "2026-09-01", duration_days: 5 }),
      task({ wbs_code: "2", duration_days: 3, predecessors: "1" }),
    ],
    OPTS,
  );
  eq("FS: predecessor finish skips Labor Day", out.byWbs.get("1")!.ef, "2026-09-08");
  eq("FS: successor starts the next working day", out.byWbs.get("2")!.es, "2026-09-09");
}

{
  const out = computeCpm(
    [
      task({ wbs_code: "1", start_date: "2026-09-01", duration_days: 5 }),
      task({ wbs_code: "2", duration_days: 3, predecessors: "1SS" }),
    ],
    OPTS,
  );
  eq("SS: successor starts with the predecessor", out.byWbs.get("2")!.es, "2026-09-01");
}

{
  const out = computeCpm(
    [
      task({ wbs_code: "1", start_date: "2026-09-01", duration_days: 5 }),
      task({ wbs_code: "2", duration_days: 3, predecessors: "1SS+2" }),
    ],
    OPTS,
  );
  eq("SS+2: successor starts two working days later", out.byWbs.get("2")!.es, "2026-09-03");
}

{
  const out = computeCpm(
    [
      task({ wbs_code: "1", start_date: "2026-09-01", duration_days: 5 }),
      task({ wbs_code: "2", duration_days: 3, predecessors: "1FF" }),
    ],
    OPTS,
  );
  // Predecessor finishes 8 Sep, so the 3-day successor must finish 8 Sep too,
  // which means starting 4 Sep (Fri) and running Fri, Tue, Tue... no: working
  // days back from Tue 8 Sep are Tue 8, Fri 4, Thu 3.
  eq("FF: successor finishes with the predecessor", out.byWbs.get("2")!.ef, "2026-09-08");
  eq("FF: successor start is backed into", out.byWbs.get("2")!.es, "2026-09-03");
}

// ============================================================================
section("Backward pass - the lag bug");
// ============================================================================

// Chain: 1 -> 2 (SS+2) -> 3 (FS). An SS+2 link ties task 1's late start to two
// working days before task 2's, so task 1 is critical: it has no room at all.
// The version that dropped the lag term computed its late finish two days out
// and reported 2 days of float on a task that has none, which is exactly the
// kind of error that takes a task off the critical path and out of the
// look-ahead.
{
  const tasks = [
    task({ wbs_code: "1", start_date: "2026-09-01", duration_days: 4 }),
    task({ wbs_code: "2", duration_days: 4, predecessors: "1SS+2" }),
    task({ wbs_code: "3", duration_days: 2, predecessors: "2" }),
  ];
  const out = computeCpm(tasks, OPTS);
  const t1 = out.byWbs.get("1")!;
  const t2 = out.byWbs.get("2")!;
  const t3 = out.byWbs.get("3")!;

  eq("SS+2 lag: driving task is critical", t2.critical, true);
  eq("SS+2 lag: successor is critical", t3.critical, true);
  eq("SS+2 lag: predecessor has no float (was 2 with the bug)", t1.totalFloat, 0);
  eq("SS+2 lag: predecessor is on the critical path", t1.critical, true);
  check(
    "SS+2 lag: late finish equals early finish",
    workingDaysBetween(t1.ef, t1.lf) === 0,
    `ef ${t1.ef} lf ${t1.lf}`,
  );
}

// FF with lag, mirrored. Same shape: the correct answer is zero float, the
// bug reported two.
{
  const out = computeCpm(
    [
      task({ wbs_code: "1", start_date: "2026-09-01", duration_days: 3 }),
      task({ wbs_code: "2", duration_days: 3, predecessors: "1FF+2" }),
      task({ wbs_code: "3", duration_days: 2, predecessors: "2" }),
    ],
    OPTS,
  );
  const t1 = out.byWbs.get("1")!;
  eq("FF+2 lag: predecessor has no float (was 2 with the bug)", t1.totalFloat, 0);
}

// A pure FS chain must be entirely critical - the control case.
{
  const out = computeCpm(
    [
      task({ wbs_code: "1", start_date: "2026-09-01", duration_days: 3 }),
      task({ wbs_code: "2", duration_days: 3, predecessors: "1" }),
      task({ wbs_code: "3", duration_days: 2, predecessors: "2" }),
    ],
    OPTS,
  );
  eq("FS chain is fully critical", out.criticalPath.length, 3);
  eq("FS chain has zero float throughout", out.byWbs.get("1")!.totalFloat, 0);
}

// ============================================================================
section("Free float");
// ============================================================================

// Two parallel paths into one merge point. The short path has free float; the
// long path has none. Total float is equal for both against the project finish
// only if nothing follows the merge, so a successor is added.
{
  const out = computeCpm(
    [
      task({ wbs_code: "1", start_date: "2026-09-01", duration_days: 10 }),
      task({ wbs_code: "2", start_date: "2026-09-01", duration_days: 4 }),
      task({ wbs_code: "3", duration_days: 3, predecessors: "1, 2" }),
    ],
    OPTS,
  );
  const long = out.byWbs.get("1")!;
  const short = out.byWbs.get("2")!;
  eq("merge: long path is critical", long.critical, true);
  eq("merge: long path has no free float", long.freeFloat, 0);
  eq("merge: short path has 6 days of free float", short.freeFloat, 6);
  eq("merge: short path total float matches", short.totalFloat, 6);
}

// Free float can never exceed total float.
{
  const out = computeCpm(
    [
      task({ wbs_code: "1", start_date: "2026-09-01", duration_days: 2 }),
      task({ wbs_code: "2", start_date: "2026-09-21", duration_days: 2, predecessors: "1" }),
    ],
    OPTS,
  );
  const t1 = out.byWbs.get("1")!;
  check(
    "free float never exceeds total float",
    t1.freeFloat <= t1.totalFloat,
    `free ${t1.freeFloat} total ${t1.totalFloat}`,
  );
}

// ============================================================================
section("Near-critical band");
// ============================================================================

{
  const out = computeCpm(
    [
      task({ wbs_code: "1", start_date: "2026-09-01", duration_days: 10 }),
      task({ wbs_code: "2", start_date: "2026-09-01", duration_days: 8 }),
      task({ wbs_code: "3", start_date: "2026-09-01", duration_days: 2 }),
      task({ wbs_code: "4", duration_days: 2, predecessors: "1, 2, 3" }),
    ],
    { ...OPTS, nearCriticalDays: 5 },
  );
  eq("10-day path is critical", out.byWbs.get("1")!.critical, true);
  eq("8-day path is near-critical", out.byWbs.get("2")!.nearCritical, true);
  eq("2-day path is neither", out.byWbs.get("3")!.nearCritical, false);
  eq("critical is not also near-critical", out.byWbs.get("1")!.nearCritical, false);
}

// ============================================================================
section("Milestones");
// ============================================================================

{
  const out = computeCpm(
    [
      task({ wbs_code: "1", start_date: "2026-09-01", duration_days: 3 }),
      task({ wbs_code: "2", is_milestone: true, predecessors: "1" }),
      task({ wbs_code: "3", duration_days: 2, predecessors: "2" }),
    ],
    OPTS,
  );
  const ms = out.byWbs.get("2")!;
  eq("milestone has zero duration", ms.duration, 0);
  eq("milestone start equals finish", ms.es, ms.ef);
  eq("milestone is flagged", ms.isMilestone, true);
  // Predecessor finishes Thu 3 Sep, the milestone lands Fri 4 Sep without
  // consuming it, and the FS successor starts the next working day - Mon 7 is
  // Labor Day, so Tue 8.
  eq("milestone lands the day after its predecessor", ms.es, "2026-09-04");
  eq("milestone consumes no working time", out.byWbs.get("3")!.es, "2026-09-08");
}

{
  // duration_days = 0 is treated as a milestone even without the flag, which is
  // how imported schedules express one.
  const out = computeCpm(
    [task({ wbs_code: "1", start_date: "2026-09-01", duration_days: 0 })],
    OPTS,
  );
  eq("duration 0 reads as a milestone", out.byWbs.get("1")!.isMilestone, true);
}

// ============================================================================
section("Date constraints");
// ============================================================================

{
  const out = computeCpm(
    [
      task({ wbs_code: "1", start_date: "2026-09-01", duration_days: 3 }),
      task({
        wbs_code: "2",
        duration_days: 2,
        predecessors: "1",
        date_constraint_type: "SNET",
        date_constraint_date: "2026-09-21",
      }),
    ],
    OPTS,
  );
  eq("SNET pushes the start out", out.byWbs.get("2")!.es, "2026-09-21");
}

{
  // FNLT the logic cannot meet drives negative float, which is the whole point:
  // the date is at risk and the schedule should say so rather than absorbing it.
  const out = computeCpm(
    [
      task({ wbs_code: "1", start_date: "2026-09-01", duration_days: 10 }),
      task({
        wbs_code: "2",
        duration_days: 5,
        predecessors: "1",
        date_constraint_type: "FNLT",
        date_constraint_date: "2026-09-15",
      }),
    ],
    OPTS,
  );
  const t2 = out.byWbs.get("2")!;
  check("FNLT that cannot be met goes negative", t2.totalFloat < 0, `float ${t2.totalFloat}`);
  check("FNLT violation is reported", out.constraintViolations.length > 0);
  check(
    "FNLT violation names the task",
    out.constraintViolations.some((v) => v.wbs === "2"),
  );
}

{
  const out = computeCpm(
    [
      task({ wbs_code: "1", start_date: "2026-09-01", duration_days: 10 }),
      task({
        wbs_code: "2",
        duration_days: 2,
        predecessors: "1",
        date_constraint_type: "MSO",
        date_constraint_date: "2026-09-03",
      }),
    ],
    OPTS,
  );
  check(
    "MSO earlier than the logic allows is reported",
    out.constraintViolations.some((v) => v.wbs === "2"),
  );
  eq("MSO still pins the date", out.byWbs.get("2")!.es, "2026-09-03");
}

// ============================================================================
section("Data date");
// ============================================================================

{
  const tasks = [
    task({
      wbs_code: "1",
      start_date: "2026-09-01",
      end_date: "2026-09-04",
      duration_days: 4,
      pct_complete: 50,
      status: "In Progress",
    }),
    task({ wbs_code: "2", duration_days: 3, predecessors: "1" }),
  ];
  const early = computeCpm(tasks, { dataDate: "2026-09-02" });
  const late = computeCpm(tasks, { dataDate: "2026-10-01" });

  eq("data date is reported back", early.dataDate, "2026-09-02");
  eq("before the finish, the plan stands", early.byWbs.get("1")!.projectedEnd, "2026-09-04");
  check(
    "after the finish, remaining work is forecast forward",
    late.byWbs.get("1")!.projectedEnd > "2026-10-01",
    late.byWbs.get("1")!.projectedEnd,
  );
  check(
    "the same data date gives the same answer twice",
    JSON.stringify(computeCpm(tasks, { dataDate: "2026-09-02" }).projectedFinish) ===
      JSON.stringify(early.projectedFinish),
  );
}

// ============================================================================
section("Isolated tasks and cycles");
// ============================================================================

{
  const out = computeCpm(
    [
      task({ wbs_code: "1", start_date: "2026-09-01", duration_days: 3 }),
      task({ wbs_code: "2", duration_days: 3, predecessors: "1" }),
      // Pinned 10 months out with no logic - Permit Closeout.
      task({ wbs_code: "9", start_date: "2027-07-01", duration_days: 1 }),
    ],
    OPTS,
  );
  eq("free-floating task is reported", out.isolated.length, 1);
  eq("free-floating task does not set the finish", out.plannedFinish! < "2027-01-01", true);
  eq("free-floating task is off the critical path", out.criticalPath.includes("9"), false);
  // It computes to zero float because it is measured against itself. That must
  // not read as critical - on the real civil scope it put Fencing Installation
  // and Permit Closeout alongside the four tasks actually driving the finish.
  eq("free-floating task is flagged isolated", out.byWbs.get("9")!.isolated, true);
  eq("free-floating task is not critical", out.byWbs.get("9")!.critical, false);
  eq("free-floating task is not near-critical", out.byWbs.get("9")!.nearCritical, false);
  eq("a networked task is not flagged isolated", out.byWbs.get("1")!.isolated, false);
}

{
  const out = computeCpm(
    [
      task({ wbs_code: "1", duration_days: 3, predecessors: "2" }),
      task({ wbs_code: "2", duration_days: 3, predecessors: "1" }),
    ],
    OPTS,
  );
  check("a cycle is detected", out.cycle !== null);
  eq("a cycle stops the calculation", out.plannedFinish, null);
}

// ============================================================================
section("Schedule health - DCMA checks");
// ============================================================================

{
  const tasks = [
    task({ wbs_code: "1", start_date: "2026-09-01", end_date: "2026-09-03", duration_days: 3 }),
    task({ wbs_code: "2", duration_days: 3, predecessors: "1", start_date: "2026-09-04", end_date: "2026-09-08" }),
    task({ wbs_code: "9", start_date: "2027-07-01", end_date: "2027-07-01", duration_days: 1 }),
  ];
  const cpm = computeCpm(tasks, OPTS);
  const health = assessSchedule(tasks, cpm, { dataDate: "2026-09-01" });

  const logic = health.checks.find((c) => c.id === "logic")!;
  eq("logic check counts the unlinked task", logic.affected.length, 1);
  check("logic check names it", logic.affected.some((a) => a.wbs === "9"));
  check("a score comes out", health.score >= 0 && health.score <= 100, String(health.score));
  // 14 DCMA checks plus our own duration-against-dates check, which is not
  // part of the standard but is the one that catches a Gantt bar and a
  // forecast describing different schedules.
  eq("all 15 checks run", health.checks.length, 15);
  check(
    "the duration check is one of them",
    health.checks.some((c) => c.id === "duration_vs_dates"),
  );
}

{
  // Duration against dates. A 1-day task whose window runs a fortnight is the
  // shape that actually occurs on site - a culvert waiting on an inspection -
  // and the point of the check is that it reports the gap rather than picking
  // a winner.
  const tasks: CpmInput[] = [
    task({ wbs_code: "1", start_date: "2026-09-01", end_date: "2026-09-14", duration_days: 1 }),
    task({ wbs_code: "2", start_date: "2026-09-01", end_date: "2026-09-03", duration_days: 3, predecessors: "1" }),
    task({ wbs_code: "3", start_date: "2026-09-01", end_date: "2026-09-01", duration_days: 0, predecessors: "2", is_milestone: true }),
    task({ wbs_code: "4", start_date: null, end_date: null, duration_days: 6, predecessors: "2" }),
  ];
  const cpm = computeCpm(tasks, { dataDate: "2026-09-01" });
  const health = assessSchedule(tasks, cpm, { dataDate: "2026-09-01" });
  const dur = health.checks.find((c) => c.id === "duration_vs_dates")!;
  eq("only the drifted task is reported", dur.affected.length, 1);
  eq("and it is the right one", dur.affected[0]?.wbs, "1");
  check("a milestone is not reported as drifted", !dur.affected.some((a) => a.wbs === "3"));
  check("a task with no dates is not reported", !dur.affected.some((a) => a.wbs === "4"));

  // What the drift actually costs is worth being exact about. The projection
  // honours the planned finish while nothing is pushing the task, so a drifted
  // row looks right on the Gantt today...
  eq("the projection holds the planned finish", cpm.byWbs.get("1")?.projectedEnd, "2026-09-14");

  // ...but float comes off the duration, so successor 2 is measured against a
  // 1-day predecessor rather than the fortnight its own bar shows. The moment
  // anything pushes task 1, it snaps from a fortnight to a day.
  const pushed = computeCpm(
    [
      task({ wbs_code: "0", start_date: "2026-09-01", end_date: "2026-09-04", duration_days: 4 }),
      ...tasks.map((t) => (t.wbs_code === "1" ? { ...t, predecessors: "0" } : t)),
    ],
    { dataDate: "2026-09-01" },
  );
  // Task 0 finishes Fri 4 Sep, Mon 7 is Labor Day, so the one day of work is
  // Tue 8 - not the 14th its own dates still claim.
  eq(
    "pushed, it runs its duration and not its date span",
    pushed.byWbs.get("1")?.projectedEnd,
    "2026-09-08",
  );
}

{
  // A lead is a zero-tolerance DCMA finding.
  const tasks = [
    task({ wbs_code: "1", start_date: "2026-09-01", duration_days: 5 }),
    task({ wbs_code: "2", duration_days: 3, predecessors: "1FS-2" }),
  ];
  const health = assessSchedule(tasks, computeCpm(tasks, OPTS), { dataDate: "2026-09-01" });
  const leads = health.checks.find((c) => c.id === "leads")!;
  eq("a lead is caught", leads.value, 1);
  eq("a lead fails the check", leads.status, "fail");
}

{
  // The relationship-type check should flag an all-SS schedule, the mirror of
  // the all-FS problem the civil review found.
  const tasks = [
    task({ wbs_code: "1", start_date: "2026-09-01", duration_days: 5 }),
    task({ wbs_code: "2", duration_days: 3, predecessors: "1SS" }),
    task({ wbs_code: "3", duration_days: 3, predecessors: "2SS" }),
  ];
  const health = assessSchedule(tasks, computeCpm(tasks, OPTS), { dataDate: "2026-09-01" });
  const rel = health.checks.find((c) => c.id === "relationship_types")!;
  check("an all-SS network is flagged", rel.status !== "pass", rel.detail);
}


// ============================================================================
section("Editing - WBS arithmetic");

{
  eq("5.1.10 sorts after 5.1.9", compareWbs("5.1.10", "5.1.9") > 0, true);
  eq("5.1 sorts before 5.1.1", compareWbs("5.1", "5.1.1") < 0, true);

  const t = (wbs: string, i: number): EditTask => ({
    id: `id-${wbs}`, wbs_code: wbs, task_name: wbs, predecessors: null,
    sort_order: (i + 1) * 10, level_code: wbs.split(".").length,
  });
  const set = ["5.1", "5.1.1", "5.1.2", "5.1.10"].map(t);
  // Highest child plus one, never the first gap - a reused code silently
  // re-points whatever still references the deleted task.
  eq("next child after 5.1.10 is 5.1.11", nextChildCode(set, "5.1"), "5.1.11");
  // Sweet Springs has no depth-1 row - the "5" root went with the civil cut -
  // so the top of the schedule is 5.1 and a new branch beside it is 5.2.
  eq("no depth-1 task means no depth-1 sibling", nextChildCode(set, null), "1");
  eq("top-level code follows the shallowest row", nextTopLevelCode(set), "5.2");
  eq("empty schedule starts at 1", nextTopLevelCode([]), "1");
}

section("Editing - predecessor rewriting");

{
  const map = new Map([["5.1.1.2", "5.1.1.9"]]);
  eq(
    "rewrite keeps type and lag",
    rewritePredecessors("5.1.1.2SS+3, 5.1.1.4", map),
    "5.1.1.9SS+3, 5.1.1.4",
  );
  eq("rewrite leaves untouched strings alone", rewritePredecessors("5.1.1.4", map), "5.1.1.4");
  eq("rewrite handles null", rewritePredecessors(null, map), null);
}

section("Editing - indent, outdent, move");

{
  const mk = (wbs: string, i: number, preds: string | null = null): EditTask => ({
    id: `id-${wbs}`, wbs_code: wbs, task_name: `Task ${wbs}`, predecessors: preds,
    sort_order: (i + 1) * 10, level_code: wbs.split(".").length,
  });
  // 5.1.3 depends on 5.1.2; indenting 5.1.2 under 5.1.1 must repoint it.
  const tasks = [
    mk("5.1", 0), mk("5.1.1", 1), mk("5.1.2", 2), mk("5.1.3", 3, "5.1.2"),
  ];

  const ind = planIndent(tasks, ["5.1.2"]);
  eq("indent succeeds", ind.ok, true);
  eq("indent renames one task", ind.renames.length, 1);
  eq("indent target is the first free child code", ind.renames[0]?.to, "5.1.1.1");
  eq("indent repoints the successor", ind.predecessorRewrites.length, 1);
  eq(
    "successor now points at the new code",
    ind.predecessorRewrites[0]?.predecessors,
    "5.1.1.1",
  );
  eq("indent sets the new depth", ind.levelUpdates[0]?.level_code, 4);

  // A branch moves whole.
  const withChild = [...tasks, mk("5.1.2.1", 4)];
  const ind2 = planIndent(withChild, ["5.1.2"]);
  eq("indent carries descendants", ind2.renames.length, 2);
  eq(
    "descendant keeps its position under the moved parent",
    ind2.renames.find((r) => r.from === "5.1.2.1")?.to,
    "5.1.1.1.1",
  );

  // The first row at a level has nothing to indent under.
  eq("indent refuses the first sibling", planIndent(tasks, ["5.1.1"]).ok, false);

  const out = planOutdent(withChild, ["5.1.2.1"]);
  eq("outdent succeeds", out.ok, true);
  eq("outdent promotes to the next free sibling", out.renames[0]?.to, "5.1.4");

  // 5.1's code implies a parent "5", but no such task exists, so there is no
  // level to be promoted into and the bare code "1" is not an answer.
  eq("outdent refuses a task whose parent is not a real row", planOutdent(tasks, ["5.1"]).ok, false);
  const rooted = [mk("5", -1), ...tasks];
  eq("outdent works when the parent really exists", planOutdent(rooted, ["5.1.1"]).ok, true);

  // Moving steps over a whole block, not one row.
  const flat = [mk("1", 0), mk("2", 1), mk("2.1", 2), mk("3", 3)];
  const moved = planMove(flat, ["3"], "up");
  eq("move up reorders", moved.sortUpdates.length > 0, true);
  const order = moved.sortUpdates
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((u) => u.id);
  // "3" has to clear both "2" and its subtask, not land between them.
  eq("move up steps over the whole block", order.join(","), "id-1,id-3,id-2,id-2.1");

  const down = planMove(flat, ["2"], "down");
  const downOrder = down.sortUpdates
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((u) => u.id);
  eq("move down carries the subtree", downOrder.join(","), "id-1,id-3,id-2,id-2.1");

  // Reordering is display order only. A move that would change who the parent
  // is has to be refused, or the row order and the WBS tree start disagreeing.
  const nested = [mk("1", 0), mk("1.1", 1), mk("1.2", 2), mk("2", 3)];
  const escape = planMove(nested, ["1.2"], "down");
  eq("a move out of the branch is refused", escape.ok, false);
  eq("moving inside the branch is fine", planMove(nested, ["1.2"], "up").ok, true);
}

{
  // Two tasks that want each other's code have to be ordered, or the unique
  // index rejects the write halfway through.
  const swap = [
    { id: "a", from: "1", to: "2" },
    { id: "b", from: "2", to: "1" },
  ];
  const { direct, viaTemp } = orderRenames(swap, new Set(["1", "2"]));
  eq("a swap needs a temporary code", viaTemp.length > 0, true);
  eq("every rename is still accounted for", direct.length + viaTemp.length, 2);

  const chain = [{ id: "a", from: "1", to: "9" }];
  const r2 = orderRenames(chain, new Set(["1", "2"]));
  eq("a free target needs no temp", r2.viaTemp.length, 0);
}

section("Editing - drag and drop");

{
  const mk = (wbs: string, i: number, preds: string | null = null): EditTask => ({
    id: `id-${wbs}`, wbs_code: wbs, task_name: `Task ${wbs}`, predecessors: preds,
    sort_order: (i + 1) * 10, level_code: wbs.split(".").length,
  });
  const order = (p: { sortUpdates: { id: string; sort_order: number }[] }) =>
    p.sortUpdates.slice().sort((a, b) => a.sort_order - b.sort_order).map((u) => u.id).join(",");

  // Same parent: order only, nothing renamed.
  const sibs = [mk("1", 0), mk("1.1", 1), mk("1.2", 2), mk("1.3", 3)];
  const reorder = planDrop(sibs, ["1.3"], "1.1", "before");
  eq("sibling drop succeeds", reorder.ok, true);
  eq("sibling drop does not re-parent", reorder.reparents, false);
  eq("sibling drop renames nothing", reorder.renames.length, 0);
  eq("sibling drop reorders", order(reorder), "id-1,id-1.3,id-1.1,id-1.2");

  // Dropping after a row places you past its whole subtree, not inside it.
  const nested = [mk("1", 0), mk("1.1", 1), mk("1.1.1", 2), mk("1.2", 3), mk("1.3", 4)];
  const past = planDrop(nested, ["1.3"], "1.1", "after");
  eq("after clears the target's subtree", order(past), "id-1,id-1.1,id-1.1.1,id-1.3,id-1.2");

  // A drop under a different parent renames and repoints.
  const cross = [mk("1", 0), mk("1.1", 1), mk("2", 2), mk("2.1", 3, "1.1")];
  const moved = planDrop(cross, ["1.1"], "2.1", "after");
  eq("cross-branch drop succeeds", moved.ok, true);
  eq("cross-branch drop re-parents", moved.reparents, true);
  eq("cross-branch drop renames the moved row", moved.renames[0]?.to, "2.2");
  eq("cross-branch drop repoints the successor", moved.predecessorRewrites.length, 1);
  eq(
    "successor points at the new code",
    moved.predecessorRewrites[0]?.predecessors,
    "2.2",
  );
  eq("cross-branch drop still sets the order", moved.sortUpdates.length, 4);

  // A summary takes its children with it.
  const withKids = [mk("1", 0), mk("1.1", 1), mk("2", 2), mk("2.1", 3), mk("2.2", 4)];
  const branch = planDrop(withKids, ["2"], "1", "before");
  eq("a dragged summary carries its subtree", order(branch), "id-2,id-2.1,id-2.2,id-1,id-1.1");

  // Dropping a branch into itself would detach it from the schedule.
  eq("cannot drop a task inside itself", planDrop(withKids, ["2"], "2.1", "after").ok, false);
  eq("cannot drop a task onto itself", planDrop(withKids, ["2"], "2", "before").ok, false);

  // Dropping where it already is changes nothing rather than churning sort_order.
  eq("a no-op drop writes nothing", planDrop(sibs, ["1.2"], "1.3", "before").sortUpdates.length, 0);
}

section("Editing - loose value parsing");

{
  eq("ISO date", parseLooseDate("2026-09-08"), "2026-09-08");
  eq("US slash date", parseLooseDate("9/8/26"), "2026-09-08");
  eq("four-digit year", parseLooseDate("09/08/2026"), "2026-09-08");
  eq("spelled month", parseLooseDate("Sep 8, 2026"), "2026-09-08");
  eq("day first spelled month", parseLooseDate("8-Sep-26"), "2026-09-08");
  eq("31 Feb is rejected", parseLooseDate("2/31/26"), null);
  eq("prose is not a date", parseLooseDate("next week"), null);

  eq("bare number duration", parseLooseDuration("5"), 5);
  eq("Smartsheet day suffix", parseLooseDuration("5d"), 5);
  eq("estimated flag ignored", parseLooseDuration("5d?"), 5);
  eq("weeks convert to working days", parseLooseDuration("2w"), 10);
  eq("garbage duration", parseLooseDuration("tbd"), null);
}

{
  const a = splitPredecessorToken("12FS+3d")!;
  eq("token ref", a.ref, "12");
  eq("token type", a.type, "FS");
  eq("token lag", a.lag, 3);

  const b = splitPredecessorToken("5.1.1.2SS")!;
  eq("dotted ref survives", b.ref, "5.1.1.2");
  eq("type without lag", b.type, "SS");
  eq("no lag is zero", b.lag, 0);

  const c = splitPredecessorToken("14FF-2")!;
  eq("negative lag", c.lag, -2);
  eq("bare ref defaults to FS", splitPredecessorToken("7")!.type, "FS");
}

section("Editing - pasted grid import");

{
  const pasted = [
    "WBS\tTask Name\tDuration\tStart\tFinish\tPredecessors",
    "5.1.1\tClear and grub\t10d\t9/1/26\t9/14/26\t",
    "5.1.2\tInstall culvert\t5d\t9/15/26\t9/21/26\t1",
    "5.1.3\tBuild entrance\t8d\t9/16/26\t9/25/26\t2SS+1d",
  ].join("\n");

  const grid = parseGrid(pasted);
  eq("tab delimiter detected", grid.delimiter, "tab");
  eq("header row detected", grid.headers?.[1], "Task Name");
  eq("data rows", grid.rows.length, 3);

  const mapping = guessColumns(grid.headers, grid.rows);
  eq("wbs column mapped", mapping[0], "wbs_code");
  eq("name column mapped", mapping[1], "task_name");
  eq("duration column mapped", mapping[2], "duration_days");
  eq("start column mapped", mapping[3], "start_date");
  eq("finish column mapped", mapping[4], "end_date");
  eq("predecessor column mapped", mapping[5], "predecessors");

  const { rows, notes } = buildImportRows(grid, mapping);
  eq("duration parsed", rows[0].values.duration_days, 10);
  eq("date parsed", rows[0].values.start_date, "2026-09-01");
  // The whole point of the Smartsheet bridge: row numbers become WBS codes.
  eq("row-number predecessor translated", rows[1].values.predecessors, "5.1.1");
  eq("type and lag survive translation", rows[2].values.predecessors, "5.1.2SS+1");
  check("translation is reported", notes.some((n) => n.includes("row numbers")), notes.join(" "));
  eq("no row issues", rows.filter((r) => r.issues.length).length, 0);
}

{
  // No WBS column: hierarchy comes from the indentation the clipboard kept.
  const pasted = [
    "Task Name\tDuration",
    "Sitework\t",
    "  Clear and grub\t10",
    "  Rough grade\t12",
  ].join("\n");
  const grid = parseGrid(pasted);
  const mapping = guessColumns(grid.headers, grid.rows);
  const { rows } = buildImportRows(grid, mapping, { wbsRoot: "5.2" });
  eq("root applied", rows[0].wbs_code, "5.2.1");
  eq("indent becomes depth", rows[1].wbs_code, "5.2.1.1");
  eq("second child increments", rows[2].wbs_code, "5.2.1.2");
}

{
  // A quoted comma must not split the cell.
  const grid = parseGrid('WBS,Task Name\n5.1.1,"Clear, grub and haul"');
  eq("comma delimiter detected", grid.delimiter, "comma");
  eq("quoted comma kept", grid.rows[0][1], "Clear, grub and haul");
}

section("Billing - which task inside a package earns the line");

// The real Sussexx branches. An SOV line linked to the package has to resolve
// to the deliverable underneath it, or it bills on a duration rollup and pays
// early: on 26 Oct the Civil 90% package reads 62% of $30,510.
{
  const sussexx = [
    { wbs_code: "1.2.1.1", task_name: "30% Design", end_date: "2026-09-21" },
    { wbs_code: "1.2.1.1.1", task_name: "Design", end_date: "2026-09-14" },
    { wbs_code: "1.2.1.1.2", task_name: "30% Design - Internal Review", end_date: "2026-09-21" },
    { wbs_code: "1.2.1.1.3", task_name: "DE Page Turn", end_date: "2026-09-15" },
    { wbs_code: "1.2.1.3", task_name: "90% Design", end_date: "2026-11-03" },
    { wbs_code: "1.2.1.3.1", task_name: "Design", end_date: "2026-10-26" },
    { wbs_code: "1.2.1.3.2", task_name: "90% Design - Internal Review", end_date: "2026-11-02" },
    { wbs_code: "1.2.1.3.3", task_name: "DE Page Turn", end_date: "2026-11-03" },
    { wbs_code: "1.2.1.4", task_name: "IFP (Issued For Permit)", end_date: "2026-11-18" },
    { wbs_code: "1.2.1.4.1", task_name: "Design", end_date: "2026-11-10" },
    { wbs_code: "1.2.1.4.2", task_name: "IFP - Internal Review", end_date: "2026-11-17" },
    { wbs_code: "1.2.1.4.3", task_name: "IFP Page Turn", end_date: "2026-11-18" },
  ];

  eq("a package resolves to its page turn", resolveMilestoneTask(sussexx, "1.2.1.3")?.wbs_code, "1.2.1.3.3");
  eq("and so does the IFP package", resolveMilestoneTask(sussexx, "1.2.1.4")?.wbs_code, "1.2.1.4.3");

  // The case that rules out "just take the latest finish": the 30% package
  // ends with its internal review on 21 Sep, six days AFTER the page turn it
  // actually bills on.
  eq("name beats finish date", resolveMilestoneTask(sussexx, "1.2.1.1")?.wbs_code, "1.2.1.1.3");
  check(
    "which is not the latest-finishing leaf",
    sussexx.find((t) => t.wbs_code === "1.2.1.1.2")!.end_date >
      sussexx.find((t) => t.wbs_code === "1.2.1.1.3")!.end_date,
  );
}

{
  // No deliverable-shaped name anywhere: fall back to the leaf that finishes
  // last, since completing it completes the package.
  const plain = [
    { wbs_code: "5.1", task_name: "Sitework", end_date: "2026-10-01" },
    { wbs_code: "5.1.1", task_name: "Clear and grub", end_date: "2026-09-10" },
    { wbs_code: "5.1.2", task_name: "Rough grade", end_date: "2026-10-01" },
  ];
  eq("latest finish is the fallback", resolveMilestoneTask(plain, "5.1")?.wbs_code, "5.1.2");
}

{
  // Nested packages: a sub-package is not a deliverable, only its leaves are.
  const nested = [
    { wbs_code: "2", task_name: "Permitting", end_date: "2027-01-01" },
    { wbs_code: "2.1", task_name: "County", end_date: "2026-12-01" },
    { wbs_code: "2.1.1", task_name: "Application", end_date: "2026-11-01" },
    { wbs_code: "2.1.2", task_name: "Permit Issued", end_date: "2026-12-01" },
  ];
  eq("it reaches through a sub-package", resolveMilestoneTask(nested, "2")?.wbs_code, "2.1.2");
  eq("a leaf has nothing inside it", resolveMilestoneTask(nested, "2.1.2"), null);
  eq("and an unknown code resolves to nothing", resolveMilestoneTask(nested, "9.9"), null);
}

{
  // Ties break on the later code, so the answer is stable rather than
  // dependent on the order rows came back from the database.
  const tied = [
    { wbs_code: "3", task_name: "Pkg", end_date: "2026-10-01" },
    { wbs_code: "3.1", task_name: "Page Turn", end_date: "2026-10-01" },
    { wbs_code: "3.2", task_name: "Page Turn", end_date: "2026-10-01" },
  ];
  eq("ties break on the later code", resolveMilestoneTask(tied, "3")?.wbs_code, "3.2");
  eq("and reversing the input changes nothing", resolveMilestoneTask([...tied].reverse(), "3")?.wbs_code, "3.2");
}

section("Editing - a Smartsheet export, as Phil actually exports one");

// Rows lifted verbatim from Sussex CSG Schedule - Eng/Perm/Proc. Four things
// about this file broke the importer, and all four are normal Smartsheet:
//
//   Column A is the sheet's row-number gutter and has no header.
//   The WBS column is filled on summary rows and blank on the leaves.
//   Predecessors are written against those row numbers, not against WBS.
//   Collapsed sections are missing entirely, so the numbering jumps 78 -> 113.
{
  const H = ["", "WBS", "Task Name", "Assigned To", "Status", "Duration", "Start Date", "End Date", "Predecessors"];
  const DATA = [
    ["1", "0", "Contracts & Agreements", "AHC / Dimension", "", "94d", "05/13/26", "09/21/26", ""],
    ["2", "", "  Award", "", "", "1d", "05/13/26", "05/13/26", ""],
    ["3", "0.1", "  Owner Contracts", "AHC / Dimension", "", "93d", "05/14/26", "09/21/26", ""],
    ["4", "0.1.1", "    LNTP - Engineering", "AHC / Dimension", "", "29d", "05/14/26", "06/23/26", ""],
    ["5", "0.1.1.1", "      AHC Internal Review", "AHC", "Complete", "18d", "05/14/26", "06/08/26", "2"],
    ["6", "0.1.1.3", "      Dimension Countersignature", "Dimension", "Complete", "10d", "06/09/26", "06/22/26", "5"],
    ["37", "1.2.1.1", "      30% Design", "AHC", "", "22d", "08/21/26", "09/21/26", ""],
    ["38", "", "        Design", "AHC / Exactus Energy", "In Progress", "17d", "08/21/26", "09/14/26", "6"],
    ["39", "", "        30% Design - Internal Review", "AHC", "Not Started", "5d", "09/15/26", "09/21/26", "38"],
    ["40", "", "        DE Page Turn", "AHC", "Not Started", "1d", "09/15/26", "09/15/26", "38"],
    ["78", "2", "Permitting", "", "", "1585d", "08/16/21", "09/10/27", ""],
    ["113", "3", "Procurement", "", "", "", "", "", ""],
    ["160", "", "Construction", "", "", "193d", "02/03/27", "10/29/27", ""],
    ["161", "4.0", "  Bat Restriction Period", "AHC", "Not Started", "152d", "04/01/27", "10/29/27", ""],
    ["162", "4.1", "  Mobilization", "AHC", "Not Started", "15d", "02/03/27", "02/23/27", "106"],
    ["163", "4.2", "  Civil / Grading", "AHC / Civil Sub", "Not Started", "50d", "02/24/27", "05/04/27", "162"],
  ];

  const grid = gridFromMatrix([["Sussex CSG Schedule - Eng/Perm/Proc"], [], H, ...DATA], "cells");
  eq("the title row is skipped", grid.headers?.[1], "WBS");
  eq("every data row survives", grid.rows.length, DATA.length);

  const mapping = guessColumns(grid.headers, grid.rows);
  // The gutter has no header at all. Claiming it is the whole fix for
  // predecessors, because it is what they are written against.
  eq("the unheadered gutter is claimed", mapping[0], "source_row");
  eq("wbs still maps", mapping[1], "wbs_code");
  eq("and so does the name", mapping[2], "task_name");

  const { rows, notes } = buildImportRows(grid, mapping);
  const byRow = new Map(rows.map((r) => [r.rowNumber, r]));
  const at = (n: number) => byRow.get(n)!;

  // --- blank WBS cells ------------------------------------------------------
  eq("no row is left without a code", rows.filter((r) => !r.wbs_code).length, 0);
  eq("a leaf is numbered under its summary", at(8).wbs_code, "1.2.1.1.1");
  eq("and its siblings follow", at(9).wbs_code, "1.2.1.1.2");
  eq("in order", at(10).wbs_code, "1.2.1.1.3");
  // Award is a child of 0, and 0.1 is already spoken for by Owner Contracts.
  eq("a filled code never collides with a stated one", at(2).wbs_code, "0.2");
  // The one that buried a whole phase: Construction is level with Permitting
  // and Procurement, so it is their sibling, not Procurement's child.
  eq("a blank top-level row stays top level", at(13).wbs_code, "4");
  check("the fills are reported", notes.some((n) => n.includes("had no WBS code")), notes.join(" "));

  // --- predecessors ---------------------------------------------------------
  // Row 5 says "2", meaning sheet row 2 - Award. There is ALSO a task coded
  // "2" (Permitting). Before the source-row column was read, the code won and
  // half the contract logic pointed at Permitting.
  eq("a row reference beats a same-numbered code", at(5).values.predecessors, "0.2");
  check("and the collision is reported", notes.some((n) => n.includes("also exists as a WBS code")), notes.join(" "));
  // Row 163 says "162", which is only row 162 because the file says so - by
  // position it is the fifteenth row, not the hundred and sixty-second.
  eq("numbering survives the collapsed-section jump", at(16).values.predecessors, "4.1");
  eq("a generated code can be referenced", at(9).values.predecessors, "1.2.1.1.1");
  eq("and referenced from a stated one", at(8).values.predecessors, "0.1.1.3");

  // --- what is genuinely missing -------------------------------------------
  // 106 is inside the collapsed Procurement block and was never exported.
  // Guessing at it would be worse than saying so.
  check(
    "a reference into a collapsed section is named, not guessed",
    at(15).issues.some((i) => i.includes("not a row in this file")),
    at(15).issues.join("; "),
  );
  check("and summarised", notes.some((n) => n.includes("could not be resolved")), notes.join(" "));

  // --- the diff -------------------------------------------------------------
  const diff = diffImport([], rows, mapping);
  eq("every row becomes a task", diff.adds.length, DATA.length);
  eq("nothing blocks", diff.blocking.length, 0);
  eq("source_row is never written to a task", "source_row" in diff.adds[0].values, false);
}

{
  // The silent drop this replaced: a codeless row used to vanish from the diff
  // with no error, so a 166-row schedule imported as 90 tasks and looked fine.
  const grid = gridFromMatrix(
    [["WBS", "Task Name"], ["", "Orphan with nothing above it"], ["5.1", "Real"]],
    "cells",
  );
  const mapping = guessColumns(grid.headers, grid.rows);
  const { rows } = buildImportRows(grid, mapping);
  const diff = diffImport([], rows, mapping);
  check(
    "a row with no derivable code stops the import",
    diff.blocking.some((b) => b.includes("could not be given a WBS code")),
    diff.blocking.join(" "),
  );
}

{
  // The gutter is claimed on strong evidence only. A leading column of numbers
  // that does not climb is data, not a row counter.
  const notRising = gridFromMatrix(
    [["", "Task Name", "Duration"], ["7", "A", "3"], ["3", "B", "4"], ["9", "C", "5"]],
    "cells",
  );
  eq(
    "a jumbled leading column is not a gutter",
    guessColumns(notRising.headers, notRising.rows)[0],
    null,
  );

  // Headerless paste, gutter still found. It has to be claimed before the
  // value heuristics run - 1, 2, 3 all parse as durations.
  const headerless = gridFromMatrix(
    [["1", "Clear and grub", "10"], ["2", "Rough grade", "12"], ["3", "Install culvert", "5"]],
    "cells",
  );
  eq("no header row here", headerless.headers, null);
  const hm = guessColumns(headerless.headers, headerless.rows);
  eq("the gutter is still claimed", hm[0], "source_row");
  eq("and the duration is not stolen by it", hm[2], "duration_days");
  const headed = gridFromMatrix(
    [["Dur", "Task Name"], ["1", "A"], ["2", "B"], ["3", "C"]],
    "cells",
  );
  check(
    "a column with its own header is not a gutter",
    guessColumns(headed.headers, headed.rows)[0] !== "source_row",
  );
}

section("Editing - import diff");

{
  const existing: EditTask[] = [
    {
      id: "a", wbs_code: "5.1.1", task_name: "Clear and grub", predecessors: null,
      sort_order: 10, level_code: 3, duration_days: 10,
      start_date: "2026-09-01", end_date: "2026-09-14",
      phase: "Civil", assigned_to: "Pyramid", status: "In Progress",
    },
    {
      id: "b", wbs_code: "5.1.9", task_name: "Old task", predecessors: null,
      sort_order: 20, level_code: 3,
    },
  ];

  const grid = parseGrid(
    [
      "WBS\tTask Name\tDuration",
      "5.1.1\tClear and grub\t12",
      "5.1.2\tInstall culvert\t5",
    ].join("\n"),
  );
  const mapping = guessColumns(grid.headers, grid.rows);
  const { rows } = buildImportRows(grid, mapping, {
    knownWbs: existing.map((e) => e.wbs_code),
  });

  const diff = diffImport(existing, rows, mapping);
  eq("one add", diff.adds.length, 1);
  eq("one change", diff.changes.length, 1);
  eq("the change is the duration", diff.changes[0].fields[0].field, "duration_days");
  eq("from value", diff.changes[0].fields[0].from, 10);
  eq("to value", diff.changes[0].fields[0].to, 12);
  // The destructive default an unguarded importer gets wrong: a three-column
  // paste must not blank phase, assignment and logic on the task it touches.
  eq("unmapped fields are untouched", diff.changes[0].fields.length, 1);
  eq("no deletes without opting in", diff.deletes.length, 0);

  const scoped = diffImport(existing, rows, mapping, { deleteMissingUnder: "5.1" });
  eq("opting in finds the missing task", scoped.deletes.length, 1);
  eq("and it is the right one", scoped.deletes[0].wbs_code, "5.1.9");

  const otherBranch = diffImport(existing, rows, mapping, { deleteMissingUnder: "6" });
  eq("deletes stay inside the named branch", otherBranch.deletes.length, 0);
}

{
  // A duplicated code has to block the apply, not silently win last-write.
  const grid = parseGrid(["WBS\tTask Name", "5.1.1\tOne", "5.1.1\tTwo"].join("\n"));
  const mapping = guessColumns(grid.headers, grid.rows);
  const { rows } = buildImportRows(grid, mapping);
  const diff = diffImport([], rows, mapping);
  check("duplicate WBS blocks the import", diff.blocking.length > 0, diff.blocking.join(" "));
}

section("Editing - row numbers as a way of writing, not storing");

{
  const sheet = [
    { wbs_code: "5.1" },
    { wbs_code: "5.1.1" },
    { wbs_code: "5.1.2" },
    { wbs_code: "5.1.10" },
    { wbs_code: "5.2" },
  ];
  const idx = buildRowIndex(sheet);

  eq("rows number from one", idx.byWbs.get("5.1"), 1);
  eq("in the order given", idx.byWbs.get("5.1.10"), 4);
  eq("and read back", idx.byRow.get(4), "5.1.10");

  // Display: codes out, numbers in.
  eq("a plain link shows as a row number", toRowRefs("5.1.1", idx), "2");
  eq("type and lag survive the swap", toRowRefs("5.1.10SS+3", idx), "4SS+3");
  eq("a negative lag too", toRowRefs("5.1.2-2", idx), "3-2");
  eq("several at once", toRowRefs("5.1.1, 5.1.2FF", idx), "2, 3FF");
  // A code that is not on the project has no row, so it stays visible as
  // itself rather than disappearing out of the cell.
  eq("an unknown code is left alone", toRowRefs("9.9.9", idx), "9.9.9");
  eq("nothing in, nothing out", toRowRefs(null, idx), "");

  // Storage: numbers in, codes out.
  eq("a row number becomes a code", toWbsRefs("2", idx), "5.1.1");
  eq("with its relationship", toWbsRefs("4SS+3", idx), "5.1.10SS+3");
  eq("and a list of them", toWbsRefs("2, 3FF", idx), "5.1.1, 5.1.2FF");
  // The safety valve: a real code typed while the grid is in row-number mode
  // is still a real code. Only a bare integer means a row.
  eq("a typed WBS code is not reinterpreted", toWbsRefs("5.1.2", idx), "5.1.2");
  // Half-typed. Row 47 does not exist yet, so it is left as-is and the cell
  // shows it as unresolved rather than silently dropping it.
  eq("an out-of-range row is left alone", toWbsRefs("47", idx), "47");
  eq("whitespace is tolerated", toWbsRefs("  2 ,3 ", idx), "5.1.1, 5.1.2");

  // The round trip is what makes the cell safe to type in: every keystroke
  // converts to codes and back to numbers, and must land where it started.
  // The trailing-comma cases are the ones that matter - the cell converts on
  // every keystroke, so a swallowed comma means you can never type a second
  // predecessor at all.
  for (const written of ["2", "3FF", "4SS+3", "2, 3-1", "2, ", "2, 3SS-1, "]) {
    eq(`round trip "${written}"`, toRowRefs(toWbsRefs(written, idx), idx), written);
  }
  eq("a trailing comma survives to storage", toWbsRefs("2, ", idx), "5.1.1, ");
  eq("and parses as one link", parsePredecessors(toWbsRefs("2, ", idx)).length, 1);
  eq("an interior blank is still dropped", toWbsRefs("2, , 3", idx), "5.1.1, 5.1.2");
}

{
  // Row numbers follow the saved order, so a schedule whose sort_order was set
  // by dragging numbers by that order and not by WBS.
  const idx = buildRowIndex([{ wbs_code: "5.2" }, { wbs_code: "5.1" }]);
  eq("order given is order numbered", idx.byWbs.get("5.2"), 1);
  eq("not WBS order", idx.byWbs.get("5.1"), 2);
}

// The Sussexx CSG 1 shape, and the regression that made every edit on it report
// a circular dependency. Its codes are bare integers - 2, 4, 5, 6, 7 - sitting
// alongside 2.1 and 2.1.1, so a typed "2" could be row 2 or code 2. Reading it
// as a row landed on 2.1, and on row 2 that is the task depending on itself.
{
  const sussexx = [
    { wbs_code: "2" },      // row 1
    { wbs_code: "2.1" },    // row 2
    { wbs_code: "2.1.1" },  // row 3
    { wbs_code: "4" },      // row 4
    { wbs_code: "5" },      // row 5
  ];
  const idx = buildRowIndex(sussexx);

  check("integer codes are flagged ambiguous", idx.ambiguous);
  eq("and row mode is not offered by default", rowRefsAreSafe(sussexx), false);
  check("a dotted schedule is safe", rowRefsAreSafe([{ wbs_code: "5.1.1" }]));
  check("and not flagged", !buildRowIndex([{ wbs_code: "5.1.1" }]).ambiguous);

  // The fix: a bare integer that is also a real code stays that code. Same rule
  // the paste importer has always used.
  eq("a typed code wins over a row number", toWbsRefs("2", idx), "2");
  eq("even when the row exists", toWbsRefs("4", idx), "4");
  // 3 is not a code here, so it is still read as a row.
  eq("a number that is not a code is still a row", toWbsRefs("3", idx), "2.1.1");

  // The self-reference guard, which is what surfaced as the false loop.
  eq("a row number landing on the edited task is refused", toWbsRefs("3", idx, "2.1.1"), "3");
  eq("and it does not silently self-link", parsePredecessors(toWbsRefs("3", idx, "2.1.1"))[0].pred, "3");
  eq("an unrelated reference is unaffected", toWbsRefs("3", idx, "5"), "2.1.1");
}

{
  // hasLinkErrors has to name a self-reference as one. Reporting it as a
  // "circular dependency through 2.1" is true and useless.
  const tasks = [
    { wbs_code: "2.1", task_name: "Design Package", predecessors: null },
    { wbs_code: "2.1.1", task_name: "Civil", predecessors: null },
  ];
  const err = hasLinkErrors(tasks, "2.1", "2.1");
  check("a self-reference is caught", !!err, String(err));
  check("and named as one", (err ?? "").includes("its own predecessor"), String(err));
  check("not as a loop", !(err ?? "").toLowerCase().includes("circular"), String(err));
  eq("a real link is still fine", hasLinkErrors(tasks, "2.1.1", "2.1"), null);
}

section("Editing - linking without typing");

// A four-task run with one summary sitting in the middle of it, which is what a
// real selection looks like when somebody drags down the grid.
const linkTasks = [
  { wbs_code: "5.1", task_name: "Sitework", predecessors: null },
  { wbs_code: "5.1.1", task_name: "Clear and grub", predecessors: null },
  { wbs_code: "5.1.2", task_name: "Rough grade", predecessors: null },
  { wbs_code: "5.1.3", task_name: "Install culvert", predecessors: null },
  { wbs_code: "5.1.10", task_name: "Fine grade", predecessors: null },
];

{
  const plan = planChainLink(linkTasks, ["5.1.1", "5.1.2", "5.1.3"]);
  eq("three tasks chain into two links", plan.updates.size, 2);
  eq("the first stays free", plan.updates.get("5.1.1"), undefined);
  eq("the second follows the first", plan.updates.get("5.1.2"), "5.1.1");
  eq("the third follows the second", plan.updates.get("5.1.3"), "5.1.2");
}

{
  // Ticked bottom-up. The chain still runs down the schedule - a backwards
  // chain because of the order the boxes were clicked would be a trap.
  const plan = planChainLink(linkTasks, ["5.1.3", "5.1.1", "5.1.2"]);
  eq("order comes from the schedule, not the clicks", plan.updates.get("5.1.2"), "5.1.1");
  eq("and runs downward", plan.updates.get("5.1.3"), "5.1.2");
}

{
  // 5.1.10 sorts after 5.1.3, not between 5.1.1 and 5.1.2.
  const plan = planChainLink(linkTasks, ["5.1.1", "5.1.10", "5.1.2"]);
  eq("segments sort numerically", plan.updates.get("5.1.10"), "5.1.2");
}

{
  const plan = planChainLink(linkTasks, ["5.1", "5.1.1", "5.1.2"], "SS", 3);
  eq("the summary is dropped", plan.skipped[0], "5.1");
  eq("and the chain is just the leaves", plan.updates.size, 1);
  eq("type and lag apply to the link", plan.updates.get("5.1.2"), "5.1.1SS+3");
  check("and the drop is explained", plan.warnings.some((w) => w.includes("summary")), plan.warnings.join(" "));
}

{
  // FS is the implicit default, so it is not written out. What matters is that
  // the negative lag survives a round trip - "5.1.1-2" has to come back as
  // 5.1.1 with a lag of -2, not as a task code with a stray minus on it.
  const plan = planChainLink(linkTasks, ["5.1.1", "5.1.2"], "FS", -2);
  eq("a negative lag is written bare", plan.updates.get("5.1.2"), "5.1.1-2");
  const back = parsePredecessors(plan.updates.get("5.1.2") ?? null);
  eq("and reads back as the right task", back[0].pred, "5.1.1");
  eq("with the overlap intact", back[0].lag, -2);
  eq("and the default relationship", back[0].type, "FS");
}

{
  // Running Link twice must not double the link, and must not fight a
  // relationship somebody set deliberately on a different predecessor.
  const withLogic = [
    { wbs_code: "5.1.1", task_name: "A", predecessors: null },
    { wbs_code: "5.1.2", task_name: "B", predecessors: "5.1.1, 4.9SS+2" },
  ];
  const plan = planChainLink(withLogic, ["5.1.1", "5.1.2"], "SS", 1);
  eq("the existing link is updated in place", plan.updates.get("5.1.2"), "5.1.1SS+1, 4.9SS+2");
}

{
  // The loop guard. B already feeds A, so chaining A into B closes it.
  const looped = [
    { wbs_code: "5.1.1", task_name: "A", predecessors: "5.1.2" },
    { wbs_code: "5.1.2", task_name: "B", predecessors: null },
  ];
  const plan = planChainLink(looped, ["5.1.1", "5.1.2"]);
  eq("a circular link is not written", plan.updates.size, 0);
  check("and it says so", plan.warnings.some((w) => w.includes("loop")), plan.warnings.join(" "));
}

{
  const plan = planChainLink(linkTasks, ["5.1.1"]);
  eq("one task is not a chain", plan.updates.size, 0);
  check("and it asks for another", plan.warnings.some((w) => w.includes("two")), plan.warnings.join(" "));
}

{
  // Fan-out: everything waits on the same task.
  const plan = planFanLink(linkTasks, "5.1.1", ["5.1.2", "5.1.3", "5.1.10"], "FS", 0);
  eq("all three get the same predecessor", plan.updates.size, 3);
  eq("second", plan.updates.get("5.1.2"), "5.1.1");
  eq("third", plan.updates.get("5.1.3"), "5.1.1");
  eq("and they are not chained to each other", plan.updates.get("5.1.10"), "5.1.1");
}

{
  // Unlink cuts inside the selection only. 5.1.2 keeps its link to 4.9, which
  // is not on screen and was never part of what was being cut.
  const chained = [
    { wbs_code: "5.1.1", task_name: "A", predecessors: "4.9" },
    { wbs_code: "5.1.2", task_name: "B", predecessors: "5.1.1, 4.9SS+2" },
    { wbs_code: "5.1.3", task_name: "C", predecessors: "5.1.2" },
  ];
  const plan = planUnlink(chained, ["5.1.1", "5.1.2", "5.1.3"]);
  eq("two rows change", plan.updates.size, 2);
  eq("the outside link survives", plan.updates.get("5.1.2"), "4.9SS+2");
  eq("a row left with nothing goes null", plan.updates.get("5.1.3"), null);
  eq("the head of the chain is untouched", plan.updates.get("5.1.1"), undefined);
}

{
  const plan = planUnlink(linkTasks, ["5.1.1", "5.1.2"]);
  eq("nothing to cut writes nothing", plan.updates.size, 0);
  check("and says so", plan.warnings.length > 0, plan.warnings.join(" "));
}

{
  // The empty-cell menu: the work immediately above, nearest first, no
  // summaries, nothing already linked.
  const near = nearbyPredecessors(linkTasks, "5.1.10", new Set(["5.1.3"]));
  eq("nearest first", near[0].wbs_code, "5.1.2");
  eq("then the next one up", near[1].wbs_code, "5.1.1");
  eq("summaries and existing links are left out", near.length, 2);

  const top = nearbyPredecessors(linkTasks, "5.1.1", new Set());
  eq("the first task has nothing above it", top.length, 0);
}

section("Editing - Excel import");

// Round-trip through a real workbook. Writing one and reading it back is the
// only honest way to test this: the bugs worth catching (a date landing a day
// early, a title row eaten as a header, a spacer column shifting the mapping)
// all live in the gap between what Excel stores and what the parser sees.
function xlsxBuffer(sheets: { name: string; aoa: unknown[][] }[]): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet(s.aoa, { cellDates: true }),
      s.name,
    );
  }
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as
    | ArrayBuffer
    | Uint8Array;
  return out instanceof Uint8Array
    ? (out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer)
    : out;
}

// Local midnight, which is how a spreadsheet means a date and how SheetJS
// rebuilds one. Constructing it in UTC here would test the test, not the code.
const day = (y: number, m: number, d: number) => new Date(y, m - 1, d);

{
  const buf = xlsxBuffer([
    { name: "Cover", aoa: [["Sweet Springs Solar"]] },
    {
      name: "Schedule",
      aoa: [
        ["Sweet Springs Solar - Construction Schedule"],
        ["Rev 4"],
        [],
        ["WBS", "", "Task Name", "Duration", "Start", "Finish", "Predecessors"],
        ["5.1.1", "", "Clear and grub", "10d", day(2026, 9, 1), day(2026, 9, 14), ""],
        ["5.1.2", "", "Install culvert", 5, day(2026, 9, 15), day(2026, 9, 21), "1"],
        ["5.1.3", "", "Build entrance", 8, day(2026, 9, 16), day(2026, 9, 25), "2SS+1d"],
      ],
    },
  ]);

  const sheets = readWorkbook(buf);
  eq("both sheets read", sheets.length, 2);
  eq("the schedule tab is the one we land on", defaultSheetIndex(sheets), 1);

  const grid = gridFromSheet(sheets[1]);
  eq("the grid knows it came from cells", grid.delimiter, "cells");
  // The title block and the blank line above the header are dropped, and so is
  // the empty spacer column between WBS and Task Name.
  eq("title rows skipped", grid.headers?.[0], "WBS");
  eq("spacer column dropped", grid.headers?.[1], "Task Name");
  eq("header width", grid.headers?.length, 6);
  eq("data rows", grid.rows.length, 3);

  const mapping = guessColumns(grid.headers, grid.rows);
  eq("wbs column mapped", mapping[0], "wbs_code");
  eq("name column mapped", mapping[1], "task_name");
  eq("duration column mapped", mapping[2], "duration_days");
  eq("start column mapped", mapping[3], "start_date");
  eq("finish column mapped", mapping[4], "end_date");
  eq("predecessor column mapped", mapping[5], "predecessors");

  const { rows } = buildImportRows(grid, mapping);
  // The off-by-one this whole path exists to avoid.
  eq("a date cell keeps its day", rows[0].values.start_date, "2026-09-01");
  eq("and so does the finish", rows[0].values.end_date, "2026-09-14");
  eq("a text duration is read", rows[0].values.duration_days, 10);
  eq("a numeric duration is read", rows[1].values.duration_days, 5);
  eq("row-number predecessor translated", rows[1].values.predecessors, "5.1.1");
  eq("type and lag survive", rows[2].values.predecessors, "5.1.2SS+1");
  eq("no unreadable values", rows.filter((r) => r.issues.length).length, 0);
}

{
  // A workbook whose only content is a legend must not be treated as data.
  const sheets = readWorkbook(xlsxBuffer([{ name: "Legend", aoa: [["Key"], [], []] }]));
  eq("empty trailing rows are not counted", sheets[0].filledRows, 1);
  eq("a one-row sheet still yields no data rows", gridFromSheet(sheets[0]).rows.length, 1);
}

{
  // Cells the reader has to interpret rather than copy: a serial that stayed
  // numeric, a formula that failed, a boolean, and formatted indentation.
  const ws: Record<string, unknown> = {
    "!ref": "A1:D3",
    A1: { t: "s", v: "Task Name" },
    B1: { t: "s", v: "Start" },
    C1: { t: "s", v: "Milestone" },
    D1: { t: "s", v: "Duration" },
    A2: { t: "s", v: "Sitework" },
    B2: { t: "n", v: 46266, z: "m/d/yy" },
    C2: { t: "b", v: false },
    D2: { t: "n", v: 1250, z: '#,##0" d"' },
    A3: { t: "s", v: "Rough grade", s: { alignment: { indent: 1 } } },
    B3: { t: "e", v: 0x17, w: "#REF!" },
    C3: { t: "b", v: true },
    D3: { t: "n", v: 12 },
  };
  const m = sheetMatrix(ws as never);
  eq("a date-formatted serial decodes", m[1][1], "2026-09-01");
  eq("a quoted literal is not a date format", m[1][3], "1250");
  eq("a broken formula reads as empty", m[2][1], "");
  eq("false renders as false", m[1][2], "false");
  eq("true renders as true", m[2][2], "true");
  eq("formatted indentation becomes spaces", m[2][0], "  Rough grade");

  // And that indentation is load-bearing: with no WBS column it is the only
  // thing carrying the hierarchy.
  const grid = gridFromMatrix(m, "cells");
  const mapping = guessColumns(grid.headers, grid.rows);
  const { rows } = buildImportRows(grid, mapping, { wbsRoot: "5.2" });
  eq("parent code", rows[0].wbs_code, "5.2.1");
  eq("indent becomes depth", rows[1].wbs_code, "5.2.1.1");
}

{
  eq("xlsx is offered", isWorkbookFile("Sweet Springs Rev4.XLSX"), true);
  eq("csv is offered", isWorkbookFile("schedule.csv"), true);
  eq("a pdf is not", isWorkbookFile("schedule.pdf"), false);
}

{
  // A header that is not row 0 only wins when what sits above it is thinner.
  // Otherwise a task called "Start earthworks" would be read as a header.
  const g = gridFromMatrix(
    [
      ["5.1.1", "Start earthworks", "10"],
      ["5.1.2", "Finish earthworks", "5"],
    ],
    "cells",
  );
  eq("data is not mistaken for a header", g.headers, null);
  eq("and no rows are lost to it", g.rows.length, 2);
}

section("Editing - start, finish and duration are one fact");

{
  // Tue 1 Sep 2026 is a working day. A 5-day task runs Tue-Mon, skipping the
  // weekend, and Mon 7 Sep is Labor Day, so it lands on Tue 8.
  const r = reconcileDates(
    { start_date: "2026-09-01", end_date: "2026-09-03", duration_days: 5 },
    "duration_days",
    5,
  );
  eq("duration keeps the start", r.start_date, "2026-09-01");
  eq("duration moves the finish over weekend and holiday", r.end_date, "2026-09-08");
  eq("duration is kept as typed", r.duration_days, 5);
}

{
  // Moving the start holds the length: a 3-day task stays 3 days long.
  const r = reconcileDates(
    { start_date: "2026-09-09", end_date: "2026-09-03", duration_days: 3 },
    "start_date",
    5,
  );
  eq("start keeps the duration", r.duration_days, 3);
  eq("start moves the finish to match", r.end_date, "2026-09-11");
}

{
  // A start typed onto a Saturday snaps to the next working day rather than
  // scheduling work nobody will do.
  const r = reconcileDates(
    { start_date: "2026-09-05", end_date: "2026-09-10", duration_days: null },
    "start_date",
    5,
  );
  eq("a weekend start snaps forward", r.start_date, "2026-09-08");
}

{
  // Typing a finish restates how long the task is, which is the whole point of
  // typing one.
  const r = reconcileDates(
    { start_date: "2026-09-01", end_date: "2026-09-10", duration_days: 3 },
    "end_date",
    5,
  );
  eq("finish keeps the start", r.start_date, "2026-09-01");
  // Tue 1, Wed 2, Thu 3, Fri 4, (Mon 7 Labor Day), Tue 8, Wed 9, Thu 10 = 7.
  eq("finish recomputes the duration", r.duration_days, 7);
}

{
  // Dragging a finish back past its own start is a resize to one day, not a
  // task of negative length.
  const r = reconcileDates(
    { start_date: "2026-09-10", end_date: "2026-09-01", duration_days: 5 },
    "end_date",
    5,
  );
  eq("a finish before the start clamps to one day", r.end_date, "2026-09-10");
  eq("and the duration follows", r.duration_days, 1);
}

{
  // A milestone marks an instant. Duration 0 is also how isMilestoneTask
  // recognises one, so it must survive every edit.
  const r = reconcileDates(
    { start_date: "2026-09-01", end_date: "2026-09-01", duration_days: 0 },
    "end_date",
    5,
    { isMilestone: true },
  );
  eq("a milestone keeps duration 0", r.duration_days, 0);
  eq("a milestone start and finish are the same day", r.start_date, r.end_date);
}

{
  // Growing backwards off a finish, for a task that has one and no start.
  const r = reconcileDates(
    { start_date: null, end_date: "2026-09-10", duration_days: 3 },
    "duration_days",
    5,
  );
  eq("duration with no start grows off the finish", r.start_date, "2026-09-08");
  eq("and keeps that finish", r.end_date, "2026-09-10");
}

{
  // Clearing the duration leaves the dates alone. The engine falls back to
  // their span, so there is nothing to guess.
  const r = reconcileDates(
    { start_date: "2026-09-01", end_date: "2026-09-03", duration_days: null },
    "duration_days",
    5,
  );
  eq("clearing the duration keeps the start", r.start_date, "2026-09-01");
  eq("clearing the duration keeps the finish", r.end_date, "2026-09-03");
  eq("and leaves it null", r.duration_days, null);
}

{
  // The six-day week counts Saturday, so the same span is one day longer.
  const r = reconcileDates(
    { start_date: "2026-09-01", end_date: null, duration_days: 5 },
    "duration_days",
    6,
  );
  eq("a 6-day week works the Saturday", r.end_date, "2026-09-05");
}

{
  // Reconciling is idempotent: settling an already-settled triple changes
  // nothing. Every write path runs this, so a save must not creep a date.
  const once = reconcileDates(
    { start_date: "2026-09-01", end_date: "2026-09-03", duration_days: 9 },
    "duration_days",
    5,
  );
  const twice = reconcileDates(once, "duration_days", 5);
  eq("reconcile is idempotent on start", twice.start_date, once.start_date);
  eq("reconcile is idempotent on finish", twice.end_date, once.end_date);
  eq("reconcile is idempotent on duration", twice.duration_days, once.duration_days);
}

{
  // Tue 1 to Tue 8 Sep is five working days, not six: the weekend and Labor
  // Day come out. The same five the duration test above lands on, which is the
  // agreement that matters - the two directions have to be mirrors.
  eq(
    "durationFromDates counts inclusive working days",
    durationFromDates({ start_date: "2026-09-01", end_date: "2026-09-08" }, 5),
    5,
  );
  eq(
    "durationFromDates returns 0 for a milestone",
    durationFromDates({ start_date: "2026-09-01", end_date: "2026-09-01", is_milestone: true }, 5),
    0,
  );
  eq(
    "durationFromDates cannot know without both dates",
    durationFromDates({ start_date: "2026-09-01", end_date: null }, 5),
    null,
  );
}

section("Editing - bulk date shift");

{
  // Fri 4 Sep 2026 + 1 working day is Tue 8 Sep, because Mon 7 Sep is Labor Day.
  const moved = shiftDates({ start_date: "2026-09-04", end_date: "2026-09-04" }, 1, 5)!;
  eq("shift skips the weekend and the holiday", moved.start_date, "2026-09-08");
  const back = shiftDates({ start_date: "2026-09-08", end_date: "2026-09-08" }, -1, 5)!;
  eq("negative shift pulls back over the same days", back.start_date, "2026-09-04");
  eq("a task with no dates is skipped", shiftDates({}, 5, 5), null);
}

section("Outline - collapse and expand");

{
  // The real Sweet Springs shape: no "5" row at all, so the shallowest depth
  // present is 2. Every off-by-one in this file has come from assuming the
  // outline starts at depth 1.
  const tree = [
    { wbs_code: "5.1" },
    { wbs_code: "5.1.1" },
    { wbs_code: "5.1.1.1" },
    { wbs_code: "5.1.1.6" },
    { wbs_code: "5.1.1.6.1" },
    { wbs_code: "5.1.1.6.2" },
    { wbs_code: "5.2" },
    { wbs_code: "5.2.1" },
  ];

  eq("parentOf reads the code", parentOf("5.1.1.6.1"), "5.1.1.6");
  eq("parentOf at the top is null", parentOf("5"), null);
  eq("depthOf counts segments", depthOf("5.1.1.6"), 4);

  check("a summary has children", hasChildren("5.1.1.6", tree));
  check("a leaf does not", !hasChildren("5.1.1.6.1", tree));
  // 5.1.1.1 shares a prefix with nothing; the guard against matching "5.1.1.1"
  // as a parent of "5.1.1.10" is the trailing dot.
  check("prefix matching does not confuse 1 with 10", !hasChildren("5.1.1.1", [...tree, { wbs_code: "5.1.1.10" }]));

  eq("summaries are found", summaryCodes(tree).sort().join(","), "5.1,5.1.1,5.1.1.6,5.2");
  eq("outline depth counts levels actually present", outlineDepth(tree), 4);

  eq("nothing collapsed shows everything", visibleRows(tree, new Set()).length, 8);

  {
    const vis = visibleRows(tree, new Set(["5.1.1.6"]));
    eq("collapsing a branch hides its children", vis.length, 6);
    check("but keeps the summary itself", vis.some((t) => t.wbs_code === "5.1.1.6"));
    check("and hides the grandchildren", !vis.some((t) => t.wbs_code === "5.1.1.6.1"));
  }

  {
    // A collapsed ancestor hides a branch even when the branch itself is open.
    const vis = visibleRows(tree, new Set(["5.1"]));
    // 5.2's branch is untouched, so its child stays visible. Collapsing is
    // per-branch, not a global outline level.
    eq("an ancestor collapse hides the whole subtree", vis.length, 3);
    eq("only 5.1's subtree goes", vis.map((t) => t.wbs_code).join(","), "5.1,5.2,5.2.1");
  }

  eq("descendants of a branch", descendantsOf("5.1.1.6", tree).join(","), "5.1.1.6.1,5.1.1.6.2");

  {
    // Level 1 on a schedule with no depth-1 row means 5.1 and 5.2, not nothing.
    const lvl1 = collapseToLevel(tree, 1);
    const vis = visibleRows(tree, lvl1);
    eq("level 1 shows the top branches present", vis.map((t) => t.wbs_code).join(","), "5.1,5.2");
  }

  {
    const vis = visibleRows(tree, collapseToLevel(tree, 2));
    eq("level 2 opens one more", vis.map((t) => t.wbs_code).join(","), "5.1,5.1.1,5.2,5.2.1");
  }

  {
    // Expanding carries the descendants with it, so opening a summary does not
    // reveal a half-open branch underneath.
    const collapsed = new Set(["5.1", "5.1.1", "5.1.1.6"]);
    const opened = toggleBranch(collapsed, "5.1", tree);
    check("expanding clears the inner collapses too", opened.size === 0);
    const closed = toggleBranch(opened, "5.1", tree);
    check("collapsing again marks just the branch", closed.has("5.1") && closed.size === 1);
  }

  {
    const collapsed = new Set(["5.1", "5.1.1", "5.1.1.6"]);
    const revealed = revealTask(collapsed, "5.1.1.6.1");
    eq("revealing opens every ancestor", revealed.size, 0);
    check(
      "and the row is then visible",
      visibleRows(tree, revealed).some((t) => t.wbs_code === "5.1.1.6.1"),
    );
  }
}

section("Progress roll-up");

{
  const rows = [
    { wbs_code: "5.1" },
    { wbs_code: "5.1.1", duration_days: 10, pct_complete: 50 },
    { wbs_code: "5.1.2", duration_days: 2, pct_complete: 100 },
    { wbs_code: "5.1.3", duration_days: 2, pct_complete: null },
    { wbs_code: "5.2", duration_days: 4, pct_complete: 25, status_source: "dpr" },
  ];
  const p = buildProgress(rows);

  // 5.1.1 carries 10 of the 14 duration-days under 5.1, so its half-done
  // dominates: (50*10 + 100*2 + 0*2) / 14 = 50.
  const rolled = p.get("5.1");
  check("a summary rolls up", rolled?.kind === "rolled");
  if (rolled?.kind === "rolled") {
    eq("weighted by duration, not a plain mean", Math.round(rolled.pct), 50);
    eq("and says how many leaves reported", rolled.reported, 2);
    eq("out of how many there are", rolled.leaves, 3);
  }

  // An unweighted mean of 50/100/0 would be 50 too, so make the weighting
  // visible with a case where the two answers differ.
  const skewed = buildProgress([
    { wbs_code: "1" },
    { wbs_code: "1.1", duration_days: 20, pct_complete: 0 },
    { wbs_code: "1.2", duration_days: 1, pct_complete: 100 },
  ]).get("1");
  if (skewed?.kind === "rolled") {
    eq("a long unstarted task outweighs a short finished one", Math.round(skewed.pct), 5);
  }

  eq("a leaf with no report says so", p.get("5.1.3")?.kind, "none");
  const leaf = p.get("5.2");
  check("a reported leaf keeps its source", leaf?.kind === "reported" && leaf.source === "dpr");

  // Deep nesting: 5.1.1 would be a summary if it had children, and the roll-up
  // has to reach past one level to the real leaves.
  const deep = buildProgress([
    { wbs_code: "5" },
    { wbs_code: "5.1" },
    { wbs_code: "5.1.1", duration_days: 1, pct_complete: 100 },
    { wbs_code: "5.1.2", duration_days: 1, pct_complete: 0 },
  ]).get("5");
  if (deep?.kind === "rolled") {
    eq("roll-up reaches the leaves, not the summaries", deep.leaves, 2);
    eq("and averages them", Math.round(deep.pct), 50);
  }
}

section("Dependency arrows");

{
  // The four relationship types connect different ends of the bars, and having
  // these backwards would draw a picture that contradicts the arithmetic the
  // engine already does.
  eq("FS leaves the finish", endpointsFor("FS").from, "finish");
  eq("FS arrives at the start", endpointsFor("FS").to, "start");
  eq("SS leaves the start", endpointsFor("SS").from, "start");
  eq("SS arrives at the start", endpointsFor("SS").to, "start");
  eq("FF leaves the finish", endpointsFor("FF").from, "finish");
  eq("FF arrives at the finish", endpointsFor("FF").to, "finish");
  eq("SF leaves the start", endpointsFor("SF").from, "start");
  eq("SF arrives at the finish", endpointsFor("SF").to, "finish");
}

{
  // The ordinary case: successor starts well after the predecessor finishes.
  const pred = { x1: 0, x2: 100, y: 10 };
  const succ = { x1: 200, x2: 300, y: 40 };
  const pts = linkPoints(pred, succ, "FS");
  eq("a forward FS turns once", pts.length, 4);
  eq("it starts at the predecessor finish", pts[0].x, 100);
  eq("on the predecessor row", pts[0].y, 10);
  eq("and ends at the successor start", pts[pts.length - 1].x, 200);
  eq("on the successor row", pts[pts.length - 1].y, 40);
  check("every segment is horizontal or vertical", pts.every((p, i) =>
    i === 0 || p.x === pts[i - 1].x || p.y === pts[i - 1].y));
  eq("the head points forward", headDirection(pts), 1);
}

{
  // The overlap case, which is what the August review was full of: the
  // successor starts BEFORE the predecessor finishes. A direct line would run
  // straight through both bars, so the arrow has to detour.
  const pred = { x1: 0, x2: 300, y: 10 };
  const succ = { x1: 50, x2: 200, y: 40 };
  const pts = linkPoints(pred, succ, "FS");
  eq("a backwards FS detours", pts.length, 6);
  check("every segment is horizontal or vertical", pts.every((p, i) =>
    i === 0 || p.x === pts[i - 1].x || p.y === pts[i - 1].y));
  // The detour must leave the predecessor's row before turning back, or the
  // line runs along the bar it is leaving.
  check("it clears the predecessor finish before turning", pts[1].x > 300);
  check("it approaches the successor start from the left", pts[4].x < 50);
  eq("and still arrives at the successor start", pts[5].x, 50);
  eq("with the head pointing forward", headDirection(pts), 1);
}

{
  // Same row and already in front: a plain horizontal line, no corners.
  const pts = linkPoints({ x1: 0, x2: 50, y: 20 }, { x1: 90, x2: 140, y: 20 }, "FS");
  eq("a same-row link is a straight line", pts.length, 2);
  eq("from the finish", pts[0].x, 50);
  eq("to the start", pts[1].x, 90);
}

{
  // SS joins two left edges, so it must leave leftwards and come back, never
  // cut across the predecessor bar.
  const pts = linkPoints({ x1: 100, x2: 300, y: 10 }, { x1: 140, x2: 260, y: 40 }, "SS");
  eq("SS starts at the predecessor start", pts[0].x, 100);
  eq("and ends at the successor start", pts[pts.length - 1].x, 140);
  check("every segment is horizontal or vertical", pts.every((p, i) =>
    i === 0 || p.x === pts[i - 1].x || p.y === pts[i - 1].y));
}

{
  // FF joins two right edges.
  const pts = linkPoints({ x1: 0, x2: 100, y: 10 }, { x1: 40, x2: 180, y: 40 }, "FF");
  eq("FF starts at the predecessor finish", pts[0].x, 100);
  eq("and ends at the successor finish", pts[pts.length - 1].x, 180);
  eq("arriving from the right, so the head points back", headDirection(pts), -1);
}

{
  // Upward links - a successor drawn above its predecessor, which happens
  // whenever sort order and logic disagree - route through the channel above.
  const pts = linkPoints({ x1: 0, x2: 300, y: 100 }, { x1: 50, x2: 200, y: 10 }, "FS");
  check("an upward detour goes up", pts[2].y < 100);
  eq("and still lands on the successor row", pts[pts.length - 1].y, 10);
}

{
  eq("a path renders as SVG", toPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 20 }]), "M0 0 L10 0 L10 20");
  eq("a degenerate path renders as nothing", toPath([{ x: 1, y: 1 }]), "");
  eq("and its head defaults forward", headDirection([{ x: 1, y: 1 }]), 1);
}

// ============================================================================
console.log("\n" + "=".repeat(60));
console.log(`${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
console.log("=".repeat(60));
process.exit(failed > 0 ? 1 : 0);
