// Change the relationship type on specific links, and nothing else.
//
// A predecessor cell holds a list - `5.1.1.2, 5.1.1.5SS+3` - so retyping the
// whole string to fix one link is how the other links on that task get lost.
// This parses the list, rewrites the single token named, and serialises the
// rest back exactly as it found them.
//
//   npx tsx scripts/schedule/relink.ts --set 5.1.1.9:5.1.1.8.2:SS
//   npx tsx scripts/schedule/relink.ts --set a:b:SS --set c:d:FF --apply
//
// Lag is preserved unless given: append it to the type, as in SS+2 or FS-1.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

import {
  parsePredecessors,
  serializeLinks,
  type Link,
  type RelType,
} from "@/lib/schedule-cpm";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const PROJECT = "53cff193-21e4-45ff-833d-43813e8578a0";

const REL: RelType[] = ["FS", "SS", "FF", "SF"];

const edits: { task: string; pred: string; type: RelType; lag: number | null }[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== "--set") continue;
  const spec = argv[i + 1];
  if (!spec) continue;
  const [task, pred, rel] = spec.split(":");
  const m = (rel ?? "").match(/^(FS|SS|FF|SF)([+-]\d+)?$/i);
  if (!task || !pred || !m) {
    console.log(`Not a valid --set: "${spec}". Use task:pred:TYPE, e.g. 5.1.1.9:5.1.1.8.2:SS`);
    process.exit(1);
  }
  const type = m[1].toUpperCase() as RelType;
  if (!REL.includes(type)) { console.log(`Unknown type ${type}`); process.exit(1); }
  edits.push({ task, pred, type, lag: m[2] ? Number(m[2]) : null });
}

if (!edits.length) {
  console.log("Nothing to do. Pass --set task:pred:TYPE at least once.");
  process.exit(0);
}

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);

async function main() {
  const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await db
    .from("schedule_tasks")
    .select("id, wbs_code, task_name, predecessors")
    .eq("project_id", PROJECT);
  if (error) throw new Error(error.message);
  const rows = data as { id: string; wbs_code: string; task_name: string; predecessors: string | null }[];
  const by = new Map(rows.map((r) => [r.wbs_code, r]));

  const plan: { id: string; wbs: string; name: string; from: string; to: string | null }[] = [];
  for (const e of edits) {
    const t = by.get(e.task);
    if (!t) { console.log(`  SKIP ${e.task} - not on this project`); continue; }
    const links = parsePredecessors(t.predecessors);
    const hit = links.find((l) => l.pred === e.pred);
    if (!hit) {
      console.log(`  SKIP ${e.task} - has no link to ${e.pred} (has: ${t.predecessors ?? "none"})`);
      continue;
    }
    const next: Link[] = links.map((l) =>
      l.pred === e.pred ? { ...l, type: e.type, lag: e.lag ?? l.lag } : l,
    );
    // serializeLinks answers null for an empty list. That cannot happen here -
    // this only ever retypes an existing link, never removes one - but the
    // column is nullable and writing "" instead of NULL would leave a task
    // that reads as having a predecessor it does not have.
    const to = serializeLinks(next);
    if ((to ?? null) === (t.predecessors ?? null)) {
      console.log(`  SKIP ${e.task} - already ${e.type}`);
      continue;
    }
    plan.push({ id: t.id, wbs: t.wbs_code, name: t.task_name, from: t.predecessors ?? "", to });
  }

  if (!plan.length) { console.log("\nNothing to change."); return; }

  for (const p of plan) {
    console.log(`  ${p.wbs.padEnd(11)} ${p.name.slice(0, 32).padEnd(32)} ${p.from}  ->  ${p.to ?? "(none)"}`);
  }
  console.log("");

  if (!APPLY) {
    console.log(`${plan.length} change${plan.length === 1 ? "" : "s"} planned. Re-run with --apply to write.`);
    return;
  }
  let n = 0;
  for (const p of plan) {
    const { error: e } = await db.from("schedule_tasks").update({ predecessors: p.to }).eq("id", p.id);
    if (e) { console.log(`  FAILED ${p.wbs}: ${e.message}`); continue; }
    n++;
  }
  console.log(`${n} of ${plan.length} written.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
