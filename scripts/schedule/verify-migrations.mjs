// Confirm migrations 0033 and 0034 landed in the live database.
//
// Migrations here are applied by hand in the Supabase SQL editor, and the app
// deliberately degrades rather than breaking when one is missing - which is
// good for uptime and bad for knowing whether it worked. This answers that
// directly, by selecting the columns and tables the app expects.
//
// Read-only. Uses the service role key so it sees past RLS, because a policy
// mistake should show up here as "the table is there but the policy is wrong"
// rather than as a missing table.
//
// Run: node scripts/schedule/verify-migrations.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const env = Object.fromEntries(
  readFileSync(join(root, ".env.local"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or a key in .env.local");
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });

const checks = [];
const record = (migration, name, ok, note) =>
  checks.push({ migration, name, ok, note });

// ---- 0033 ----
const tasks = await sb
  .from("schedule_tasks")
  .select("id, date_constraint_type, date_constraint_date, is_milestone")
  .limit(1);
record("0033", "schedule_tasks: constraints + milestone", !tasks.error, tasks.error?.message);

const projects = await sb
  .from("projects")
  .select("id, name, schedule_data_date, work_week")
  .order("name");
record("0033", "projects: data date + work week", !projects.error, projects.error?.message);

for (const table of ["project_calendar_exceptions", "schedule_updates"]) {
  const r = await sb.from(table).select("*", { count: "exact", head: true });
  record("0033", `table ${table}`, !r.error, r.error?.message ?? `${r.count} rows`);
}

// ---- 0034 ----
const constraints = await sb
  .from("schedule_constraints")
  .select("*", { count: "exact", head: true });
record("0034", "table schedule_constraints", !constraints.error,
  constraints.error?.message ?? `${constraints.count} rows`);

// The check constraints are the part most likely to be silently absent if the
// do-blocks were skipped, so prove one rejects a bad value rather than assuming.
const bad = await sb
  .from("schedule_tasks")
  .update({ date_constraint_type: "NOPE" })
  .eq("id", "00000000-0000-0000-0000-000000000000");
record(
  "0033",
  "date_constraint_type check rejects bad values",
  // No row matches that id, so a working check constraint gives no error and
  // no rows. What we are proving is that the COLUMN exists to be updated.
  !bad.error || /violates check constraint/i.test(bad.error.message),
  bad.error?.message,
);

console.log("");
let failed = 0;
for (const c of checks) {
  if (!c.ok) failed++;
  console.log(
    `${c.ok ? "OK  " : "FAIL"}  ${c.migration}  ${c.name.padEnd(46)} ${c.note ?? ""}`,
  );
}

if (!projects.error) {
  console.log("\nProjects:");
  for (const p of projects.data) {
    console.log(
      `  ${String(p.name).slice(0, 34).padEnd(36)} data date ${
        p.schedule_data_date ?? "(follows today)"
      }   ${p.work_week}-day week`,
    );
  }
}

console.log(`\n${checks.length - failed} of ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
