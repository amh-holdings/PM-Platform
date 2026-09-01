// CEO Report - known-answer test harness.
//
// Pure unit tests over src/lib/ceo-report.ts (the progress report that ships)
// and src/lib/ceo-report-financials.ts (built, tested, deliberately dormant -
// see that module's header). No database: the derivations take rows in and
// return the report out, so every case here is a literal fixture.
//
// The cases that matter most are the double-counting traps, because each one
// produced a confidently wrong number during the build and each one would have
// been invisible on the page:
//
//   * counting summary schedule rows alongside the leaves they roll up
//   * summing parent AND child cost codes            (financials)
//   * adding approved COs to a contract that has them (financials)
//
// Run: npx tsx scripts/ceo-report/run-tests.ts

import {
  addDaysIso,
  buildCeoReport,
  computeDates,
  computeProgress,
  daysBetweenIso,
  leavesOf,
  pctOf,
  plannedPct,
  planWindow,
  selectPhotos,
  taskPct,
  type CeoCheck,
  type CeoPhoto,
  type CeoReportInput,
  type CeoTaskRow,
} from "@/lib/ceo-report";
import {
  ACTUAL_COST_COVERAGE_FLOOR,
  contractValue,
  costPosition,
  moneyPosition,
  rollUpCostCodes,
  type CeoCostCodeRow,
  type CeoFinancialInput,
} from "@/lib/ceo-report-financials";

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

const near = (a: number | null, b: number, tol = 0.01) =>
  a != null && Math.abs(a - b) <= tol;

// ---------------------------------------------------------------- fixtures

const PROJECT = {
  id: "p1",
  name: "Sweet Springs Solar",
  client: "Dimension Energy",
  status: "Permitting",
  contract_value: 3_787_185.91,
  ntp_date: null,
  cod_date: null,
  dc_capacity_mw: null,
  retainage_pct_default: 5,
};

const task = (o: Partial<CeoTaskRow> & { wbs_code: string }): CeoTaskRow => ({
  task_name: o.wbs_code,
  parent_wbs_code: null,
  phase: "Construction",
  status: "Not Started",
  pct_complete: null,
  duration_days: 10,
  start_date: null,
  end_date: null,
  baseline_start: null,
  baseline_end: null,
  is_milestone: false,
  ...o,
});

// Two summary rows over three leaves. Window 2026-08-01 -> 2026-08-31.
const TASKS: CeoTaskRow[] = [
  task({ wbs_code: "5.1", task_name: "Civil Construction", duration_days: 30, start_date: "2026-08-01", end_date: "2026-08-31" }),
  task({ wbs_code: "5.1.1", task_name: "Phase 1", parent_wbs_code: "5.1", duration_days: 30, start_date: "2026-08-01", end_date: "2026-08-31" }),
  task({ wbs_code: "5.1.1.1", task_name: "Clearing", parent_wbs_code: "5.1.1", status: "Complete", pct_complete: 100, duration_days: 10, start_date: "2026-08-01", end_date: "2026-08-10" }),
  task({ wbs_code: "5.1.1.2", task_name: "Basin 1", parent_wbs_code: "5.1.1", status: "In Progress", pct_complete: 50, duration_days: 10, start_date: "2026-08-11", end_date: "2026-08-20" }),
  task({ wbs_code: "5.1.1.3", task_name: "Rough Road", parent_wbs_code: "5.1.1", status: "Not Started", pct_complete: 0, duration_days: 10, start_date: "2026-08-21", end_date: "2026-08-31" }),
];

const photo = (o: Partial<CeoPhoto> & { key: string }): CeoPhoto => ({
  day: "2026-08-20",
  who: "Inspection (sub)",
  caption: null,
  source: "inspection",
  taskKey: null,
  url: "https://signed/x",
  ...o,
});

function input(over: Partial<CeoReportInput> = {}): CeoReportInput {
  return { asOf: "2026-08-21", project: PROJECT, tasks: TASKS, photos: [], ...over };
}

// ------------------------------------------------------------------- tests

function progressTests() {
  console.log("\nLeaves and task percent");
  {
    check("summary rows are excluded", leavesOf(TASKS).length === 3);
    check("a Complete status counts as 100 even with a null percent",
      taskPct(task({ wbs_code: "x", status: "Complete", pct_complete: null })) === 100);
    check("a null percent on an unstarted task is 0",
      taskPct(task({ wbs_code: "x", pct_complete: null })) === 0);
    check("percent is clamped to 0-100",
      taskPct(task({ wbs_code: "x", pct_complete: 140 })) === 100 &&
      taskPct(task({ wbs_code: "x", pct_complete: -5 })) === 0);
  }

  console.log("\nThe planned curve");
  {
    const t = task({ wbs_code: "a", start_date: "2026-08-01", end_date: "2026-08-11" });
    check("nothing planned before the task starts", plannedPct(t, "2026-07-31") === 0);
    check("everything planned once it has finished", plannedPct(t, "2026-08-12") === 100);
    check("pro rata in between", near(plannedPct(t, "2026-08-06"), 50), `got ${plannedPct(t, "2026-08-06")}`);
    check("a task with no dates is not plannable", plannedPct(task({ wbs_code: "b" }), "2026-08-06") === null);

    const based = task({
      wbs_code: "c", start_date: "2026-09-01", end_date: "2026-09-11",
      baseline_start: "2026-08-01", baseline_end: "2026-08-11",
    });
    check("baseline dates win over current dates", planWindow(based)?.start === "2026-08-01");
    check("the plan is read off the baseline when there is one", plannedPct(based, "2026-08-06") === 50);

    const zero = task({ wbs_code: "d", start_date: "2026-08-05", end_date: "2026-08-05" });
    check("a same-day task does not divide by zero", plannedPct(zero, "2026-08-05") === 100);
  }

  console.log("\nWhere we are vs where we should be");
  {
    const checks: CeoCheck[] = [];
    // As of 8/21: leaf 1 done (100), leaf 2 at 50, leaf 3 at 0 -> 50.0 actual.
    // Plan on 8/21: leaf1 100, leaf2 100, leaf3 0 -> 66.67 planned.
    const p = computeProgress(TASKS, "2026-08-21", checks);
    check("actual is duration-weighted over leaves", near(p.actualPct, 50), `got ${p.actualPct}`);
    check("planned is duration-weighted over leaves", near(p.plannedPct, 66.67, 0.01), `got ${p.plannedPct}`);
    check("variance is actual less planned", near(p.variance, -16.67, 0.01), `got ${p.variance}`);
    check("behind the plan is a negative variance", (p.variance ?? 0) < 0);
    check("counts split correctly", p.complete === 1 && p.inProgress === 1 && p.notStarted === 1);

    check("the pace date is when the plan hit today's actual", p.planReachedActualOn === "2026-08-16",
      `got ${p.planReachedActualOn}`);
    check("days off plan is negative when behind", p.daysOffPlan === -5, `got ${p.daysOffPlan}`);
    check("a schedule with no baseline is flagged", !p.againstBaseline && checks.some((c) => c.id === "no-baseline"));
  }

  console.log("\nAhead of plan");
  {
    const ahead = TASKS.map((t) =>
      t.wbs_code === "5.1.1.3" ? { ...t, status: "Complete", pct_complete: 100 } : t,
    );
    const p = computeProgress(ahead, "2026-08-21", []);
    check("actual can exceed planned", near(p.actualPct, 83.33, 0.01) && (p.variance ?? 0) > 0, `got ${p.actualPct}`);
    check("days off plan is positive when ahead", (p.daysOffPlan ?? 0) > 0, `got ${p.daysOffPlan}`);
  }

  console.log("\nTasks past their finish");
  {
    const checks: CeoCheck[] = [];
    const p = computeProgress(TASKS, "2026-08-25", checks);
    check("only unfinished tasks past their date are late", p.late.length === 1 && p.late[0].wbs === "5.1.1.2");
    check("days late is measured to the as-of date", p.late[0].daysLate === 5, `got ${p.late[0].daysLate}`);
    check("a late task carries what the plan wanted", p.late[0].plannedPct === 100);
    check("late tasks raise a check", checks.some((c) => c.id === "late-tasks"));
  }

  console.log("\nAreas");
  {
    const p = computeProgress(TASKS, "2026-08-21", []);
    check("areas group by the parent summary task", p.areas.length === 1 && p.areas[0].area === "Phase 1");
    check("an area carries its own plan comparison", near(p.areas[0].plannedPct, 66.67, 0.01));
    check("area variance matches the whole", near(p.areas[0].variance, -16.67, 0.01));
  }

  console.log("\nDates");
  {
    const d = computeDates(PROJECT, TASKS, "2026-08-21");
    check("start is the earliest leaf start", d.start === "2026-08-01");
    check("finish is the latest leaf finish", d.finish === "2026-08-31");
    check("days remaining counts to the finish", d.daysRemaining === 10, `got ${d.daysRemaining}`);
    check("time elapsed is a share of the window", near(d.timeElapsedPct, 66.67, 0.01), `got ${d.timeElapsedPct}`);
    check("no baseline means no slip figure", d.finishSlipDays === null);

    const based = computeDates(
      PROJECT,
      TASKS.map((t) => (t.parent_wbs_code ? { ...t, baseline_end: "2026-08-25" } : t)),
      "2026-08-21",
    );
    check("finish slip is measured against the baseline finish", based.finishSlipDays === 6, `got ${based.finishSlipDays}`);

    const withMs = computeDates(
      PROJECT,
      [...TASKS, task({ wbs_code: "9.0", task_name: "Mechanical Completion", is_milestone: true, end_date: "2026-12-01" })],
      "2026-08-21",
    );
    check("milestones are listed with their distance", withMs.milestones.length === 1 && withMs.milestones[0].daysAway === 102,
      `got ${withMs.milestones[0]?.daysAway}`);

    const withContract = computeDates({ ...PROJECT, ntp_date: "2026-07-01", cod_date: "2027-06-01" }, TASKS, "2026-08-21");
    check("contract dates appear when recorded", withContract.contract.length === 2);
    check("a passed contract date reads as done", withContract.contract[0].done === true);
  }

  console.log("\nCompletion milestones");
  {
    // Work runs 8/01-8/31. Substantial Completion is dated BEFORE the work
    // finishes, so it is threatened; Final Completion sits after it.
    const withMs = [
      ...TASKS,
      task({ wbs_code: "11.00", task_name: "Substantial Completion", is_milestone: true, duration_days: 0, start_date: "2026-08-25", end_date: "2026-08-25" }),
      task({ wbs_code: "12.00", task_name: "Final Completion", is_milestone: true, duration_days: 0, start_date: "2026-09-30", end_date: "2026-09-30" }),
    ];

    // The bug this guards: durationWeighted gives a zero-duration task the
    // AVERAGE weight of the others, so counting milestones as work would drag
    // percent complete down as if new scope had appeared.
    const bare = computeProgress(TASKS, "2026-08-21", []);
    const withMilestones = computeProgress(withMs, "2026-08-21", []);
    check("milestones do not change percent complete", near(withMilestones.actualPct, bare.actualPct),
      `${bare.actualPct} -> ${withMilestones.actualPct}`);
    check("milestones are not counted as tasks", withMilestones.leafCount === bare.leafCount);

    const d = computeDates(PROJECT, withMs, "2026-08-21");
    check("work finish excludes milestones", d.workFinish === "2026-08-31", `got ${d.workFinish}`);
    check("project finish still includes them", d.finish === "2026-09-30", `got ${d.finish}`);
    check("milestones are listed earliest first", d.milestones.map((m) => m.label)[0] === "Substantial Completion");
    check("a milestone the work runs past is flagged late",
      d.milestones[0].vsWorkFinish === 6, `got ${d.milestones[0].vsWorkFinish}`);
    check("a milestone after the work reads early",
      d.milestones[1].vsWorkFinish === -30, `got ${d.milestones[1].vsWorkFinish}`);
    check("threatened lists only the ones at risk",
      d.threatened.length === 1 && d.threatened[0].label === "Substantial Completion");

    const r = buildCeoReport(input({ tasks: withMs }));
    check("a threatened milestone is a blocker",
      r.checks.some((c) => c.id === "milestone-threatened-substantial-completion" && c.severity === "blocker"));
    check("the headline names the threatened milestone",
      r.headline.includes("Substantial Completion is dated") && r.headline.includes("6 days past it"), r.headline);

    const none = buildCeoReport(input());
    check("no completion dates at all is a blocker",
      none.checks.some((c) => c.id === "no-completion-milestones" && c.severity === "blocker"));
    check("the headline says so when none are recorded",
      none.headline.includes("No completion milestones are on record"));

    const met = computeDates(
      PROJECT,
      [...TASKS, task({ wbs_code: "4.00", task_name: "Permits Received", is_milestone: true, status: "Complete", pct_complete: 100, duration_days: 0, start_date: "2026-08-05", end_date: "2026-08-05" })],
      "2026-08-21",
    );
    check("a met milestone is not reported at risk", met.milestones[0].done && met.milestones[0].vsWorkFinish === null);
  }

  console.log("\nPhotographs");
  {
    const candidates = [
      photo({ key: "a", day: "2026-08-20", taskKey: "5.1.1.2", who: "5.1.1.2 Basin 1 (sub)" }),
      photo({ key: "b", day: "2026-08-20", taskKey: "5.1.1.2", who: "5.1.1.2 Basin 1 (AHC)" }),
      photo({ key: "c", day: "2026-08-19", taskKey: "5.1.1.1", who: "5.1.1.1 Clearing (AHC)" }),
      photo({ key: "d", day: "2026-08-18", taskKey: null, source: "cmlog", who: "CM daily log" }),
      photo({ key: "e", day: "2026-08-01", url: null }),
    ];
    const picked = selectPhotos(candidates, 6);
    check("selection runs on unsigned candidates", picked.some((p) => p.key === "e"),
      "selectPhotos must not require a URL - it runs before signing");
    check("AHC beats the sub for the same activity", picked[0].key === "b", `got ${picked[0]?.key}`);
    check("one photo per activity before repeats", picked.slice(0, 3).map((p) => p.taskKey ?? "cm").join(",") === "5.1.1.2,5.1.1.1,cm",
      picked.map((p) => p.key).join(","));
    check("newest first", picked[0].day >= picked[1].day);
    check("the limit is honoured", selectPhotos(candidates, 2).length === 2);
    check("spare slots fill with repeats rather than printing short",
      selectPhotos(candidates, 4).length === 4);
  }

  console.log("\nThe report");
  {
    const r = buildCeoReport(input({ photos: [photo({ key: "a" })], photoCandidateCount: 228 }));
    check("headline states where it is and where it should be",
      r.headline.includes("50.0% complete") && r.headline.includes("should be 66.7%"), r.headline);
    check("headline puts the gap in days", r.headline.includes("5 days ago"), r.headline);
    check("headline gives the finish date", r.headline.includes("August 31, 2026"), r.headline);
    check("a single-branch schedule is flagged", r.checks.some((c) => c.id === "partial-scope"));
    check("checks are sorted worst-first", r.checks[0].severity === "blocker" || r.checks.every((c) => c.severity !== "blocker"));
    check("photo count reports how many were available to choose from", r.photoCount === 228);
    check("an unsigned photo never reaches the report",
      buildCeoReport(input({ photos: [photo({ key: "z", url: null })] })).photos.length === 0);

    const noPhotos = buildCeoReport(input());
    check("no photographs raises a check", noPhotos.checks.some((c) => c.id === "no-photos"));

    const empty = buildCeoReport(input({ tasks: [] }));
    check("no schedule is a blocker", empty.checks.some((c) => c.id === "no-schedule" && c.severity === "blocker"));
    check("an empty schedule does not throw", empty.progress.actualPct === 0);

    // NO MONEY. The whole point of the split - guard it so a future edit that
    // reaches into the financial module gets caught here rather than on a PDF.
    check("the report object carries no financial section",
      !("money" in r) && !("cost" in r) && !JSON.stringify(r).includes("$"), "a dollar figure reached the report");
  }

  console.log("\nHelpers");
  {
    check("daysBetweenIso counts calendar days across a month", daysBetweenIso("2026-08-25", "2026-09-01") === 7);
    check("daysBetweenIso goes negative backwards", daysBetweenIso("2026-09-01", "2026-08-25") === -7);
    check("addDaysIso crosses a month boundary", addDaysIso("2026-08-30", 3) === "2026-09-02");
    check("pctOf guards a zero whole", pctOf(5, 0) === null);
  }
}

// --------------------------------------------------- dormant financial half

const COST_CODES: CeoCostCodeRow[] = [
  { code: "SSC A", name: "AHC Labor", estimated_cost: 164_500, actual_cost: 0, is_change_order: false },
  { code: "SSC T", name: "Main Components", estimated_cost: 674_773, actual_cost: 0, is_change_order: false },
  { code: "SSC T.1", name: "Racking Piles", estimated_cost: 26_801, actual_cost: 0, is_change_order: false },
  { code: "SSC T.2", name: "FTC Racking", estimated_cost: 256_669, actual_cost: 81_633.3, is_change_order: false },
  { code: "SSC T.15", name: "CAB Piles", estimated_cost: null, actual_cost: 0, is_change_order: false },
  { code: "CO-01", name: "Permitting Delay", estimated_cost: 343_821.75, actual_cost: 0, is_change_order: true },
];

function finInput(over: Partial<CeoFinancialInput> = {}): CeoFinancialInput {
  return {
    asOf: "2026-09-01",
    project: PROJECT,
    billingLines: [
      { item_number: "1.01", description: "LNTP", scheduled_value: 3_000_000 },
      { item_number: "13.00", description: "Incurred Costs (CO-01)", scheduled_value: 787_185.91 },
    ],
    payApps: [
      { app_number: "AFP 1", status: "paid", period_start: null, period_end: "2024-05-31", total_completed: 100_000, total_retainage: 5_000, previous_billings: 0, amount_due: 95_000, paid_at: null },
      { app_number: "AFP 2", status: "submitted", period_start: null, period_end: "2024-06-30", total_completed: 50_000, total_retainage: 2_500, previous_billings: 100_000, amount_due: 47_500, paid_at: null },
    ],
    costCodes: COST_CODES,
    subs: [
      { company_name: "Pyramid", trade: "Earthwork", contract_value: 798_067, active: true },
      { company_name: "Retired Co", trade: "Old", contract_value: 500_000, active: false },
    ],
    purchaseOrders: [{ vendor_name: "FTC Solar", description: "Racking", total_value: null, status: "active" }],
    subPayApps: [],
    changeOrders: [{ co_number: "CO-01", description: "Permitting Delay", status: "approved", co_value: 368_675.48, cost_amount: null }],
    ...over,
  };
}

function financialTests() {
  console.log("\n[dormant] Contract value");
  {
    const c = contractValue(finInput().billingLines, PROJECT, finInput().changeOrders);
    check("SOV total wins over the project record", c.source === "sov" && near(c.sovTotal, 3_787_185.91));
    check("approved COs are reported but NOT added", near(c.value, 3_787_185.91) && near(c.approvedChangeOrders, 368_675.48));
    check("falls back to the project record with no SOV", contractValue([], PROJECT, []).source === "project");
    check("reports 'none' when neither exists", contractValue([], { ...PROJECT, contract_value: null }, []).source === "none");
  }

  console.log("[dormant] Cost code rollup");
  {
    const r = rollUpCostCodes(COST_CODES);
    check("naive total sums every row", near(r.naiveTotal, 1_466_564.75), `got ${r.naiveTotal}`);
    check("children of a costed parent are folded", near(r.budget, 1_183_094.75), `got ${r.budget}`);
    check("double-counting is reported", near(r.doubleCounted, 283_470));
    check("an actual booked to a folded child still counts", near(r.actual, 81_633.3));
    check("a child under an UNCOSTED parent is kept",
      near(rollUpCostCodes([
        { code: "X", name: null, estimated_cost: null, actual_cost: 0, is_change_order: false },
        { code: "X.1", name: null, estimated_cost: 500, actual_cost: 0, is_change_order: false },
      ]).budget, 500));
    check("a grandchild folds with no intermediate row",
      near(rollUpCostCodes([
        { code: "A", name: null, estimated_cost: 1000, actual_cost: 0, is_change_order: false },
        { code: "A.1.1", name: null, estimated_cost: 400, actual_cost: 0, is_change_order: false },
      ]).budget, 1000));
  }

  console.log("[dormant] Money and cost position");
  {
    const checks: CeoCheck[] = [];
    const c = contractValue(finInput().billingLines, PROJECT, finInput().changeOrders);
    const m = moneyPosition(finInput(), c, checks);
    check("billed to date sums the periods", near(m.billedToDate, 150_000));
    check("collected counts only paid applications", near(m.collected, 95_000));
    check("outstanding counts billed-but-unpaid", near(m.outstanding, 47_500));
    check("backlog is contract less billed", near(m.backlog, 3_637_185.91));

    const cp = costPosition(finInput(), c, checks);
    check("committed subs exclude inactive", near(cp.committedSubs, 798_067));
    check("empty actual cost is refused, not reported as profit", cp.actualCost === null);
    check("CO cost is recovered from the CO-numbered cost code", near(cp.changeOrders[0].cost, 343_821.75));
    check(`actual cost returns above the ${ACTUAL_COST_COVERAGE_FLOOR * 100}% floor`,
      costPosition(finInput({ costCodes: [{ code: "A", name: null, estimated_cost: 1000, actual_cost: 900, is_change_order: false }] }), c, []).actualCostUsable);
  }
}

progressTests();
financialTests();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
