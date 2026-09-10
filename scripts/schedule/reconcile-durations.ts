// Report and repair tasks whose duration disagrees with their own dates.
//
// duration_days and the start/finish pair were three independent columns and
// nothing kept them in step. A dragged Gantt bar wrote the two dates and left
// the duration alone. Float and the critical path come off the duration, the
// bar is drawn from the dates, so where they drift the float is already wrong
// and the task will collapse to its duration the first time a predecessor
// pushes it.
//
// reconcileDates now keeps them in step on every editing surface, so new drift
// cannot appear. This is for the rows written before that existed.
//
// It deliberately does NOT have a "fix everything" mode. The two clusters on
// Sweet Springs need opposite repairs and only somebody who knows the job can
// say which is which:
//
//   Civil, in progress    dates span far MORE than the duration. A 1-day
//                         culvert whose window ran three weeks because it
//                         waited on an inspection. Elapsed time is real; the
//                         duration is the effort. Usually the DATES are right.
//
//   Mechanical, future    dates span LESS than the duration. A 4-day pile
//                         remediation squeezed into a 2-day window by an
//                         import. Usually the DURATION is right and the dates
//                         want opening up.
//
// Guessing between those silently restates the plan, so this asks.
//
//   npx tsx scripts/schedule/reconcile-durations.ts
//       report every disagreement, grouped by which way it leans
//
//   npx tsx scripts/schedule/reconcile-durations.ts --dates-win 5.1.1.9,5.1.1.10
//       the dates are right: set duration = the working days they span
//
//   npx tsx scripts/schedule/reconcile-durations.ts --duration-wins 5.2.6,5.2.9
//       the duration is right: move the finish to start + duration
//
// Both write modes print the plan and require --apply to touch anything.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

import {
  addWorkingDays,
  makeCalendar,
  type Calendar,
} from "@/lib/schedule-calendar";
import { durationFromDates } from "@/lib/schedule-edit";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");

function codesFor(flag: string): string[] | null {
  const i = argv.indexOf(flag);
  if (i === -1) return null;
  const raw = argv[i + 1];
  if (!raw || raw.startsWith("--")) return [];
  return raw.split(",").map((c) => c.trim()).filter(Boolean);
}

const DATES_WIN = codesFor("--dates-win");
const DURATION_WINS = codesFor("--duration-wins");

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

type Row = {
  id: string;
  project_id: string;
  wbs_code: string;
  task_name: string;
  start_date: string | null;
  end_date: string | null;
  duration_days: number | null;
  is_milestone: boolean | null;
};

async function main() {
  const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: projects, error: pErr } = await db
    .from("projects")
    .select("id, name, work_week");
  if (pErr) throw new Error(pErr.message);

  const { data: exceptions } = await db
    .from("project_calendar_exceptions")
    .select("project_id, exception_date, kind");

  const { data: tasks, error: tErr } = await db
    .from("schedule_tasks")
    .select("id, project_id, wbs_code, task_name, start_date, end_date, duration_days, is_milestone")
    .order("wbs_code");
  if (tErr) throw new Error(tErr.message);

  // One calendar per project. A duration only means anything against the
  // calendar that defines a working day, so a 6-day project must not be
  // measured on a 5-day week.
  const calendars = new Map<string, Calendar>();
  for (const p of projects ?? []) {
    calendars.set(
      p.id as string,
      makeCalendar(
        ((p as { work_week?: number | null }).work_week ?? 5) === 6 ? 6 : 5,
        ((exceptions ?? []) as { project_id: string; exception_date: string; kind: "nonworking" | "working" }[])
          .filter((e) => e.project_id === p.id)
          .map((e) => ({ exception_date: e.exception_date, kind: e.kind })),
      ),
    );
  }
  const nameOf = new Map((projects ?? []).map((p) => [p.id as string, p.name as string]));

  // Summary rows are excluded. They have no dates of their own worth trusting -
  // a parent spans its children - and the CPM engine never schedules them.
  const all = (tasks ?? []) as Row[];
  const isLeaf = (r: Row) =>
    !all.some(
      (o) => o.project_id === r.project_id && o.wbs_code.startsWith(r.wbs_code + "."),
    );

  const drift: Array<{ row: Row; span: number; cal: Calendar }> = [];
  for (const row of all) {
    if (!isLeaf(row)) continue;
    const cal = calendars.get(row.project_id);
    if (!cal) continue;
    const span = durationFromDates(row, cal);
    if (span == null) continue;
    if (row.duration_days == null || row.duration_days === span) continue;
    drift.push({ row, span, cal });
  }

  const selected = new Set([...(DATES_WIN ?? []), ...(DURATION_WINS ?? [])]);

  if (!selected.size) {
    console.log(`${drift.length} leaf tasks disagree with their own dates\n`);
    const longer = drift.filter((d) => d.span > (d.row.duration_days ?? 0));
    const shorter = drift.filter((d) => d.span < (d.row.duration_days ?? 0));

    const show = (title: string, list: typeof drift, hint: string) => {
      if (!list.length) return;
      console.log(`${title}  (${list.length})`);
      console.log(`  ${hint}\n`);
      for (const { row, span } of list) {
        console.log(
          `  ${row.wbs_code.padEnd(11)} ${row.task_name.slice(0, 36).padEnd(36)} ` +
            `${String(row.duration_days).padStart(3)}d planned, ${String(span).padStart(3)}d span   ` +
            `${row.start_date} -> ${row.end_date}   [${nameOf.get(row.project_id)}]`,
        );
      }
      console.log("");
    };

    show(
      "Window LONGER than the duration",
      longer,
      "work that took longer than planned, or a date nobody tightened afterwards",
    );
    show(
      "Window SHORTER than the duration",
      shorter,
      "a duration that no longer fits its window, usually squeezed by an import",
    );

    console.log("Pick a side per task, then re-run with codes:");
    console.log("  --dates-win 5.1.1.9,5.1.1.10      duration := the span");
    console.log("  --duration-wins 5.2.6,5.2.9       finish := start + duration");
    console.log("Add --apply to write.");
    return;
  }

  const plan: Array<{ row: Row; patch: Record<string, unknown>; how: string }> = [];
  const missing: string[] = [];

  for (const code of Array.from(selected)) {
    const hit = drift.find((d) => d.row.wbs_code === code);
    if (!hit) { missing.push(code); continue; }
    const { row, span, cal } = hit;
    if ((DATES_WIN ?? []).includes(code)) {
      plan.push({
        row,
        patch: { duration_days: span },
        how: `duration ${row.duration_days} -> ${span}, dates unchanged`,
      });
    } else {
      const end = addWorkingDays(row.start_date!, row.duration_days!, cal);
      plan.push({
        row,
        patch: { end_date: end },
        how: `finish ${row.end_date} -> ${end}, duration unchanged at ${row.duration_days}`,
      });
    }
  }

  if (missing.length) {
    console.log(`Not found among the drifted tasks: ${missing.join(", ")}`);
    console.log("Run with no arguments to see the list.\n");
  }
  if (!plan.length) return;

  for (const { row, how } of plan) {
    console.log(`  ${row.wbs_code.padEnd(11)} ${row.task_name.slice(0, 36).padEnd(36)} ${how}`);
  }
  console.log("");

  if (!APPLY) {
    console.log(`${plan.length} change${plan.length === 1 ? "" : "s"} planned. Re-run with --apply to write.`);
    return;
  }

  let written = 0;
  for (const { row, patch } of plan) {
    const { error } = await db.from("schedule_tasks").update(patch).eq("id", row.id);
    if (error) {
      console.log(`  FAILED ${row.wbs_code}: ${error.message}`);
      continue;
    }
    written++;
  }
  console.log(`${written} of ${plan.length} written.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
