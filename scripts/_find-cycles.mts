// Diagnostic: find real dependency loops in every project's schedule.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { parsePredecessors } from "@/lib/schedule-cpm";

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
    .select("wbs_code, task_name, predecessors")
    .eq("project_id", p.id);
  if (!tasks?.length) continue;

  const known = new Set(tasks.map((t) => t.wbs_code));
  const preds = new Map<string, string[]>();
  for (const t of tasks) {
    preds.set(
      t.wbs_code,
      parsePredecessors(t.predecessors).map((l) => l.pred).filter((c) => known.has(c)),
    );
  }

  // Self references first - the cheapest and nastiest kind.
  const self = tasks.filter((t) => preds.get(t.wbs_code)?.includes(t.wbs_code));

  // Then any remaining loop, by DFS.
  const state = new Map<string, number>();
  const stack: string[] = [];
  const loops: string[][] = [];
  function dfs(n: string) {
    state.set(n, 1);
    stack.push(n);
    for (const q of preds.get(n) ?? []) {
      const st = state.get(q) ?? 0;
      if (st === 1) loops.push([...stack.slice(stack.indexOf(q)), q]);
      else if (st === 0) dfs(q);
    }
    stack.pop();
    state.set(n, 2);
  }
  for (const t of tasks) if ((state.get(t.wbs_code) ?? 0) === 0) dfs(t.wbs_code);

  if (self.length || loops.length) {
    console.log(`\n=== ${p.name} (${tasks.length} tasks) ===`);
    for (const t of self) console.log(`  SELF: ${t.wbs_code} "${t.task_name}" -> ${t.predecessors}`);
    for (const l of loops.slice(0, 10)) console.log(`  LOOP: ${l.join(" -> ")}`);
    if (loops.length > 10) console.log(`  ...and ${loops.length - 10} more`);
  } else {
    console.log(`ok: ${p.name} (${tasks.length} tasks)`);
  }
}
