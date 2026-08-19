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
  rewritePredecessors,
  shiftDates,
  splitPredecessorToken,
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

section("Editing - bulk date shift");

{
  // Fri 4 Sep 2026 + 1 working day is Tue 8 Sep, because Mon 7 Sep is Labor Day.
  const moved = shiftDates({ start_date: "2026-09-04", end_date: "2026-09-04" }, 1, 5)!;
  eq("shift skips the weekend and the holiday", moved.start_date, "2026-09-08");
  const back = shiftDates({ start_date: "2026-09-08", end_date: "2026-09-08" }, -1, 5)!;
  eq("negative shift pulls back over the same days", back.start_date, "2026-09-04");
  eq("a task with no dates is skipped", shiftDates({}, 5, 5), null);
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
