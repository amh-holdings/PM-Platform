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
  eq("all 14 checks run", health.checks.length, 14);
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
console.log("\n" + "=".repeat(60));
console.log(`${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
console.log("=".repeat(60));
process.exit(failed > 0 ? 1 : 0);
