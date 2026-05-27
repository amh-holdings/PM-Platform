// Backfill phase on schedule_tasks: for any task without a phase,
// take its top-level WBS code prefix (e.g. "1.2.3" -> "1") and look up
// that top-level row's phase, then set it.
//
// Usage: node scripts/backfill-schedule-phase.mjs [--project-id <uuid>] [--dry-run]

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

function loadEnvLocal() {
  const raw = readFileSync(".env.local", "utf8");
  const env = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return env;
}

const env = loadEnvLocal();
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const projectIdIdx = args.indexOf("--project-id");
const projectIdFilter = projectIdIdx >= 0 ? args[projectIdIdx + 1] : null;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function topPrefix(wbs) {
  if (!wbs) return null;
  const first = String(wbs).split(".")[0];
  return first || null;
}

async function main() {
  const all = [];
  const pageSize = 1000;
  let from = 0;
  while (true) {
    let query = supabase
      .from("schedule_tasks")
      .select("id, project_id, wbs_code, phase")
      .order("project_id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (projectIdFilter) query = query.eq("project_id", projectIdFilter);
    const { data, error } = await query;
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  console.log(`Loaded ${all.length} schedule tasks`);

  const phaseByTop = new Map();
  for (const row of all) {
    if (!row.phase) continue;
    const top = topPrefix(row.wbs_code);
    if (!top) continue;
    const key = `${row.project_id}|${top}`;
    if (!phaseByTop.has(key)) phaseByTop.set(key, row.phase);
  }

  console.log(`Built phase map with ${phaseByTop.size} top-level entries`);

  const updates = [];
  let noMatch = 0;
  for (const row of all) {
    if (row.phase) continue;
    const top = topPrefix(row.wbs_code);
    if (!top) continue;
    const key = `${row.project_id}|${top}`;
    const phase = phaseByTop.get(key);
    if (!phase) {
      noMatch += 1;
      continue;
    }
    updates.push({ id: row.id, phase });
  }

  console.log(`Will update ${updates.length} rows; ${noMatch} had no matching top-level phase`);

  if (dryRun) {
    console.log("Dry run - no changes applied");
    return;
  }

  let applied = 0;
  for (const u of updates) {
    const { error } = await supabase
      .from("schedule_tasks")
      .update({ phase: u.phase })
      .eq("id", u.id);
    if (error) {
      console.error(`Failed to update ${u.id}: ${error.message}`);
      continue;
    }
    applied += 1;
    if (applied % 50 === 0) console.log(`Applied ${applied}/${updates.length}`);
  }

  console.log(`Done. Applied ${applied} phase updates.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
