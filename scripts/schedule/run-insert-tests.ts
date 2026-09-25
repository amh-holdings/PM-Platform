/**
 * Putting a new row exactly where somebody points.
 *
 * Zarina: "I need to add a row in the schedule wherever I want. Not add it at
 * the bottom and just drag to where I want it." Add task put the row after the
 * last task in its branch, so a task that belonged third meant adding it and
 * dragging it seventeen places.
 *
 * The WBS code is not renumbered to make room. That is planIndent's standing
 * rule: a code here is an identifier other records point at, and renumbering a
 * branch to close a cosmetic gap orphans them. Position lives in sort_order.
 */

import { planInsertAt, insertPositionsFor } from "../../src/lib/schedule-insert";
import type { EditTask } from "../../src/lib/schedule-edit";

let passed = 0;
const failures: string[] = [];

function same(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name} - got ${a}, want ${b}`);
    console.log(`  FAIL  ${name} - got ${a}, want ${b}`);
  }
}

function check(name: string, cond: boolean) {
  same(name, cond, true);
}

const t = (
  id: string,
  wbs: string,
  name: string,
  sort: number | null,
): EditTask => ({
  id,
  wbs_code: wbs,
  task_name: name,
  predecessors: null,
  sort_order: sort,
  level_code: wbs.split(".").length,
});

// A branch with a summary, three children, and a task after it.
const TASKS: EditTask[] = [
  t("a", "4", "Electrical", 10),
  t("b", "4.1", "Conduit", 20),
  t("c", "4.2", "Pull wire", 30),
  t("d", "4.3", "Terminate", 40),
  t("e", "5", "Commissioning", 50),
];

console.log("\nWhere the row lands\n");

const below = planInsertAt({ tasks: TASKS, anchorWbs: "4.1", position: "below" });
same("below a leaf sits between it and the next row", below.sortOrder, 25);
same("and takes the next free code under the same parent", below.wbs, "4.4");
same("and the same parent", below.parentWbs, "4");
same("nothing else has to move", below.sortUpdates, []);

const above = planInsertAt({ tasks: TASKS, anchorWbs: "4.2", position: "above" });
same("above a row sits between it and the one before", above.sortOrder, 25);
same("with the same parent as the anchor", above.parentWbs, "4");

const child = planInsertAt({ tasks: TASKS, anchorWbs: "4", position: "child" });
same("inside a summary the parent is the summary", child.parentWbs, "4");
same("and the code is the next child", child.wbs, "4.4");

console.log("\nA summary is not split by its own children\n");

// Dropping a row directly after the summary would put it between 4 and 4.1,
// which reads as the first child, not as "below Electrical".
const belowSummary = planInsertAt({ tasks: TASKS, anchorWbs: "4", position: "below" });
same("below a summary clears its whole subtree", belowSummary.sortOrder, 45);
same("and it becomes a sibling of the summary, not a child", belowSummary.parentWbs, null);
same("taking the next top-level code", belowSummary.wbs, "6");

// Inside, it goes after the last child rather than before the first.
same("inside a summary lands after its last child", child.sortOrder, 45);

console.log("\nDepth and level\n");

same("a top-level insert is level 1", belowSummary.level, 1);
same("a child insert is level 2", child.level, 2);
same(
  "a deep insert keeps its depth",
  planInsertAt({
    tasks: [t("x", "4.4.2.1", "Lead Time", 10), t("y", "4.4.2.2", "Delivery", 20)],
    anchorWbs: "4.4.2.1",
    position: "below",
  }).level,
  4,
);

console.log("\nNo room between two rows\n");

// An imported schedule with consecutive sort orders leaves nowhere to land.
// sort_order is an integer column. A fractional midpoint would be rounded on
// the way into Postgres and land on top of the row it was meant to precede.
const TIGHT: EditTask[] = [
  t("a", "1", "One", 1),
  t("b", "2", "Two", 2),
  t("c", "3", "Three", 3),
];
const tight = planInsertAt({ tasks: TIGHT, anchorWbs: "1", position: "below" });
check("the whole list is respaced", tight.sortUpdates.length === 3);
check("and the new row gets a real gap", tight.sortOrder > 10 && tight.sortOrder < 30);
check("which is a whole number", Number.isInteger(tight.sortOrder));
check(
  "an ordinary insert is a whole number too",
  Number.isInteger(below.sortOrder) && Number.isInteger(above.sortOrder),
);
same("the rows after it are pushed down in order", tight.sortUpdates, [
  { id: "a", sort_order: 10 },
  { id: "b", sort_order: 30 },
  { id: "c", sort_order: 40 },
]);
check("and the note says rows were respaced", tight.note.includes("respaced"));

// Two rows sharing a number is the same problem.
const DUPES: EditTask[] = [t("a", "1", "One", 10), t("b", "2", "Two", 10)];
check(
  "duplicate sort orders respace too",
  planInsertAt({ tasks: DUPES, anchorWbs: "1", position: "below" }).sortUpdates.length > 0,
);

console.log("\nEdges\n");

same(
  "above the very first row still works",
  planInsertAt({ tasks: TASKS, anchorWbs: "4", position: "above" }).sortOrder,
  0,
);

same(
  "below the very last row goes on the end",
  planInsertAt({ tasks: TASKS, anchorWbs: "5", position: "below" }).sortOrder,
  60,
);

const missing = planInsertAt({ tasks: TASKS, anchorWbs: "9.9", position: "below" });
same("an anchor that is not there is refused, not guessed", missing.ok, false);
check("and it says which code", (missing.error ?? "").includes("9.9"));

// A row with no sort_order sorts last, and the planner must not produce NaN.
const NULLS: EditTask[] = [t("a", "1", "One", 10), t("b", "2", "Two", null)];
check(
  "a row with no sort order does not poison the arithmetic",
  Number.isFinite(planInsertAt({ tasks: NULLS, anchorWbs: "1", position: "below" }).sortOrder),
);

console.log("\nThe code is never renumbered to make room\n");

// This is the whole design decision. Inserting above 4.1 offers 4.4, not 4.1
// with everything below it shuffled up. Renumbering would orphan every
// billing line, PO delivery link and predecessor pointing at the old codes.
same("inserting above 4.1 does NOT take 4.1", above.wbs !== "4.1", true);
same("it takes the next free sibling code", above.wbs, "4.4");
check(
  "and no existing row is renamed",
  !JSON.stringify(above).includes("renames"),
);

console.log("\nWhat the menu offers\n");

const opts = insertPositionsFor(TASKS, "4");
same("three positions", opts.map((o) => o.position), ["above", "below", "child"]);
check("all enabled on a real row", opts.every((o) => o.enabled));
check(
  "inside a leaf warns it becomes a summary",
  (insertPositionsFor(TASKS, "4.1").find((o) => o.position === "child")?.label ?? "").includes(
    "summary",
  ),
);
check(
  "inside a summary just says inside",
  !(insertPositionsFor(TASKS, "4").find((o) => o.position === "child")?.label ?? "").includes(
    "summary",
  ),
);
check("a row that is not there offers nothing enabled", insertPositionsFor(TASKS, "9.9").every((o) => !o.enabled));

console.log("\nThe note says where it will land\n");

check("it names the code being added", below.note.includes("4.4"));
check("it names the anchor", below.note.includes("4.1 Conduit"));
check("above says above", above.note.includes("above"));
check("inside says inside", child.note.includes("inside"));

console.log(`\n${"=".repeat(60)}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  console.log("=".repeat(60));
  process.exit(1);
}
console.log("=".repeat(60));
