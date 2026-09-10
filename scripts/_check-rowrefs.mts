// Does every stored predecessor survive the row-number round trip untouched?
// The grid converts display->storage on every keystroke, so any value that
// does not round-trip is silently repointed the moment somebody types in it.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { buildRowIndex, scheduleOrder, toRowRefs, toWbsRefs } from "@/lib/schedule-edit";

const raw = readFileSync(".env.local", "utf8");
const env: Record<string, string> = {};
for (const l of raw.split("\n")) {
  const t = l.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  env[t.slice(0, i)] = t.slice(i + 1);
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: projects } = await sb.from("projects").select("id, name");
for (const p of projects ?? []) {
  const { data: tasks } = await sb
    .from("schedule_tasks")
    .select("id, wbs_code, task_name, predecessors, sort_order, level_code")
    .eq("project_id", p.id);
  if (!tasks?.length) continue;

  const ordered = scheduleOrder(tasks as never);
  const idx = buildRowIndex(ordered);

  const intCodes = tasks.filter((t) => /^\d+$/.test(t.wbs_code));
  console.log(`\n=== ${p.name} (${tasks.length} tasks) ===`);
  console.log(`  bare-integer WBS codes: ${intCodes.length ? intCodes.map((t) => t.wbs_code).join(", ") : "none"}`);

  let bad = 0;
  for (const t of tasks) {
    if (!t.predecessors) continue;
    const shown = toRowRefs(t.predecessors, idx);
    const back = toWbsRefs(shown, idx);
    // Compare as parsed sets, since spacing is normalised on purpose.
    const norm = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean).sort().join("|");
    if (norm(back) !== norm(t.predecessors)) {
      bad++;
      console.log(`  DRIFT ${t.wbs_code} "${t.task_name}"`);
      console.log(`     stored: ${t.predecessors}`);
      console.log(`     shown : ${shown}`);
      console.log(`     back  : ${back}`);
    }
  }
  console.log(`  round-trip failures: ${bad}`);
}
