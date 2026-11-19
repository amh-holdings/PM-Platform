/**
 * The in-progress percent hint - known-answer tests.
 *
 * Zarina: "what's the point of the percent number bar if it only shows 100%
 * when completed? How about the in progress number?"
 *
 * The hint exists to answer that without inventing data. So the tests that
 * matter most are the ones where it must stay QUIET: schedule_tasks.pct_complete
 * feeds the sub-billing verifier and the cash-flow projection, and the day this
 * placeholder turns into a stored number is the day the app bills a guess.
 *
 * Run: npx tsx scripts/ui/run-progress-hint-tests.ts
 */
import { scheduleProgressHint } from "../../src/lib/schedule-progress-hint";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, got?: unknown) {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${got === undefined ? "" : `  got ${JSON.stringify(got)}`}`); }
}
const hint = (status: string | null, start: string | null, end: string | null, today: string) =>
  scheduleProgressHint({ status, start, end, today });

console.log("\n=== a running task reports elapsed days ===");
// IFP - Internal Review on Sussex: Nov 19 to Nov 20, read on Nov 19.
check("day 1 of 2 is 50%", hint("In Progress", "2026-11-19", "2026-11-20", "2026-11-19")?.pct === 50,
  hint("In Progress", "2026-11-19", "2026-11-20", "2026-11-19"));
check("day 1 of 10 is 10%", hint("In Progress", "2026-11-02", "2026-11-11", "2026-11-02")?.pct === 10);
check("day 5 of 10 is 50%", hint("In Progress", "2026-11-02", "2026-11-11", "2026-11-06")?.pct === 50);
check("day 9 of 10 is 90%", hint("In Progress", "2026-11-02", "2026-11-11", "2026-11-10")?.pct === 90);
check("the hint explains itself", /elapsed time, not work done/.test(hint("In Progress", "2026-11-02", "2026-11-11", "2026-11-06")!.why));
check("and names the days", /day 5 of 10 planned days/.test(hint("In Progress", "2026-11-02", "2026-11-11", "2026-11-06")!.why));

console.log("\n=== it never speaks for a status that is not In Progress ===");
for (const s of ["Complete", "Approved", "Not Started", "Planned", "Rejected", "Awaiting", "", null]) {
  check(`${JSON.stringify(s)} gets no hint`, hint(s, "2026-11-02", "2026-11-11", "2026-11-06") === null);
}
check("a hollow dot is never contradicted by a number",
  hint("Not Started", "2026-11-02", "2026-11-11", "2026-11-06") === null);

console.log("\n=== it never guesses past the dates it has ===");
check("before the start, nothing", hint("In Progress", "2026-11-19", "2026-11-25", "2026-11-18") === null);
check("on the planned finish, nothing", hint("In Progress", "2026-11-19", "2026-11-20", "2026-11-20") === null);
check("past the planned finish, nothing (the row is late, not 95%)",
  hint("In Progress", "2026-11-02", "2026-11-11", "2026-12-01") === null);
check("a one-day task gets nothing", hint("In Progress", "2026-11-19", "2026-11-19", "2026-11-19") === null);
check("end before start gets nothing", hint("In Progress", "2026-11-20", "2026-11-19", "2026-11-19") === null);

console.log("\n=== missing or unreadable dates stay silent ===");
check("no start", hint("In Progress", null, "2026-11-20", "2026-11-19") === null);
check("no end", hint("In Progress", "2026-11-19", null, "2026-11-19") === null);
check("both blank", hint("In Progress", "", "", "2026-11-19") === null);
check("garbage start", hint("In Progress", "not a date", "2026-11-20", "2026-11-19") === null);
check("garbage today", hint("In Progress", "2026-11-19", "2026-11-25", "soon") === null);

console.log("\n=== the number is always a sane percent ===");
let bad = 0;
const start = Date.parse("2026-01-01T00:00:00Z");
for (let span = 1; span <= 120; span++) {
  for (let d = 0; d <= span + 2; d++) {
    const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const h = hint("In Progress", "2026-01-01", iso(start + span * 86400000), iso(start + d * 86400000));
    if (h && (h.pct < 1 || h.pct > 99 || !Number.isInteger(h.pct))) bad++;
  }
}
check("no hint outside 1-99, across every span to 120 days", bad === 0, bad);

console.log("\n=== timestamps do not shift the answer ===");
check("an ISO timestamp reads as its date",
  hint("In Progress", "2026-11-02T00:00:00+00:00", "2026-11-11", "2026-11-06")?.pct === 50);
check("padding does not change the status",
  hint("  In Progress  ", "2026-11-02", "2026-11-11", "2026-11-06")?.pct === 50);

console.log("\n" + "=".repeat(60));
console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  - ${f}`);
console.log("=".repeat(60));
process.exit(failures.length > 0 ? 1 : 0);
