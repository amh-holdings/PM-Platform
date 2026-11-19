/**
 * The schedule status dot - known-answer tests.
 *
 * Zarina could read Complete off the grid and nothing else. The dot is the
 * fix, so what it must never do is go blank or go the same colour for two
 * different states. Both would put her back where she started.
 *
 * Run: npx tsx scripts/ui/run-status-dot-tests.ts
 */
import { statusDotLabel, statusDotTone, STATUS_TONE } from "../../src/lib/schedule-status-tone";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean) {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}`); }
}
function eq(name: string, a: unknown, b: unknown) {
  check(`${name} (${JSON.stringify(a)})`, JSON.stringify(a) === JSON.stringify(b));
}

console.log("\n=== the three states Zarina named are each distinct ===");
const done = statusDotTone("Complete");
const wip = statusDotTone("In Progress");
const todo = statusDotTone("Not Started");
check("Complete has a tone", !!done);
check("In Progress has a tone", !!wip);
check("Not Started has a tone", !!todo);
check("all three differ", new Set([done, wip, todo]).size === 3);
check("Complete is green", String(done).includes("emerald"));
check("In Progress is blue", String(wip).includes("blue"));
check("Not Started is hollow", String(todo).includes("bg-transparent"));
check("the other two are filled", !String(done).includes("bg-transparent") && !String(wip).includes("bg-transparent"));

console.log("\n=== every status in the grid's dropdown gets a dot ===");
for (const s of Object.keys(STATUS_TONE)) {
  check(`${s} has a dot`, statusDotTone(s) !== null);
}

console.log("\n=== every status actually in the Sussex and Sweet Springs data ===");
// From the live database on 2026-11-19.
for (const s of ["Not Started", "Complete", "In Progress", "Planned", "Rejected"]) {
  check(`${s} has a dot`, statusDotTone(s) !== null);
}

console.log("\n=== a row with no status gets no dot, not a wrong one ===");
eq("null", statusDotTone(null), null);
eq("undefined", statusDotTone(undefined), null);
eq("empty string", statusDotTone(""), null);
eq("whitespace", statusDotTone("   "), null);
eq("a status we do not know", statusDotTone("Superseded"), null);

console.log("\n=== whitespace is not a different status ===");
eq("padded Complete matches Complete", statusDotTone("  Complete  "), statusDotTone("Complete"));
eq("padded In Progress matches", statusDotTone(" In Progress"), statusDotTone("In Progress"));

console.log("\n=== every dot can be named, so none is a bare decoration ===");
eq("Complete", statusDotLabel("Complete"), "Complete");
eq("padded is trimmed", statusDotLabel("  In Progress "), "In Progress");
eq("no status says so", statusDotLabel(null), "No status set");
eq("empty says so", statusDotLabel(""), "No status set");

console.log("\n" + "=".repeat(60));
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) for (const f of failures) console.log(`  - ${f}`);
console.log("=".repeat(60));
process.exit(failures.length > 0 ? 1 : 0);
