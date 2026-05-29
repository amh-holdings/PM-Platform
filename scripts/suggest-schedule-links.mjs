// Propose schedule-task links for each billing_line and cost_code by matching
// against the schedule_tasks for the same project.
//
// Heuristics:
//   billing_lines: each line maps to ONE or a FEW milestone-level tasks.
//                  Score = phase match + distinctive-keyword overlap with
//                  task_name. Top 3 above threshold get written.
//   cost_codes:    overhead / admin / bond codes are skipped. The rest get
//                  ALL tasks where phase or name matches a category keyword.
//
// The script writes its proposals into linked_task_wbs_codes only when the
// row is currently empty; it never overwrites existing manual edits. Phil
// reviews everything in the /billing and /costs UI and tweaks via the
// existing "Edit links" button.
//
// Usage:
//   node scripts/suggest-schedule-links.mjs [--project-id <uuid>] [--dry-run]

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const raw = readFileSync(".env.local", "utf8");
const env = {};
for (const l of raw.split("\n")) {
  const t = l.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); env[t.slice(0, i)] = t.slice(i + 1);
}
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const projectIdIdx = args.indexOf("--project-id");
const PID = projectIdIdx >= 0 ? args[projectIdIdx + 1] : "53cff193-21e4-45ff-833d-43813e8578a0";

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ============ HEURISTIC CONFIG ============

// Billing line type -> candidate phases (matching schedule_tasks.phase verbatim)
const TYPE_TO_PHASES = new Map([
  ["LNTP", ["Enginering", "Procurement", "Contracts"]],
  ["EPC Contract", ["Contracts"]],
  ["Engineering", ["Enginering"]],
  ["Permits", ["Permitting"]],
  ["Procurement", ["Procurement"]],
  ["Site Work", ["Construction"]],
  ["Electrical", ["Construction"]],
  ["Mechanical", ["Construction"]],
  ["Mechanical  Completion", ["Construction"]],
  ["Commercial Operation", ["Construction"]],
  ["Substantial Completion", ["Construction"]],
  ["Final Completion", ["Construction"]],
  ["Permitting Delay", ["Permitting"]],
  ["Construction", ["Construction"]],
]);

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "by", "with",
  "is", "if", "applicable", "only", "all", "this", "that", "from", "into", "as",
  "at", "be", "are", "no", "not", "any",
  // billing-side filler words that don't help match
  "milestone", "less", "holdback", "punch", "list", "retainage", "complete",
  "completion", "received", "deposit",
  // numeric symbols
  "%",
]);

// Strip punctuation, lowercase, split, drop stop words and short tokens
function tokenize(s) {
  if (!s) return [];
  const out = new Set();
  for (const raw of String(s).toLowerCase().replace(/[^a-z0-9% ]/g, " ").split(/\s+/)) {
    const t = raw.trim();
    if (!t || t.length < 3) continue;
    if (STOP_WORDS.has(t)) continue;
    out.add(t);
  }
  return [...out];
}

// Cost codes that have no meaningful schedule-task mapping
const COST_CODE_SKIP = new Set([
  "SSC A",  // AHC Labor (overhead)
  "SSC B",  // General Conditions (overhead)
  "SSC C",  // Per Diem (overhead)
  "SSC D",  // Travel (overhead)
  "SSC E",  // Site Vehicles (overhead)
  "SSC F",  // Communication (overhead)
  "SSC G",  // Reimbursements (overhead)
  "SSC H",  // Equip/Site Facilities (overhead)
  "SSC L",  // ENG Constr Phse Svcs (continuous engineering oversight)
  "SSC T",  // Main Components (too broad - mixed procurement)
  "SSC U",  // Bond (admin)
  "SSC V",  // Insurance (admin)
  "SSC W",  // SubContractor Bonds (admin)
  "CO-02",  // CO-02 Construction (too broad)
]);

// Cost-code -> keywords. Tasks whose phase or name contains ANY of these
// (case insensitive) get linked.
const COST_CODE_KEYWORDS = new Map([
  ["SSC I", ["electrical", "elec"]],
  ["SSC J", ["civil", "survey", "stak"]],
  ["SSC K", ["structural"]],
  ["SSC M", ["pile test", "geotech", "push", "pull"]],
  ["SSC N", ["civil"]],
  ["SSC O", ["civil", "site work"]],
  ["SSC P", ["invert", "foundation"]],
  ["SSC Q", ["fence", "fenc"]],
  ["SSC R", ["tracker", "racking", "pile", "found"]],
  ["SSC S", ["electrical", "collection", "collect", "elec"]],
  ["CO-01", ["permit"]],
]);

// For cost codes that filter only by phase
const COST_CODE_PHASES = new Map([
  ["SSC I", ["Enginering"]],
  ["SSC J", ["Enginering"]],
  ["SSC K", ["Enginering"]],
  ["SSC M", ["Enginering", "Construction"]],
  ["SSC N", ["Construction"]],
  ["SSC O", ["Construction"]],
  ["SSC P", ["Construction"]],
  ["SSC Q", ["Construction"]],
  ["SSC R", ["Construction"]],
  ["SSC S", ["Construction"]],
  ["CO-01", ["Permitting"]],
]);

// ============ FETCH ============

const [{ data: lines }, { data: codes }, { data: tasks }] = await Promise.all([
  sb.from("billing_lines")
    .select("id, item_number, type, description, linked_task_wbs_codes")
    .eq("project_id", PID),
  sb.from("cost_codes")
    .select("id, code, name, linked_task_wbs_codes")
    .eq("project_id", PID),
  sb.from("schedule_tasks")
    .select("wbs_code, task_name, phase")
    .eq("project_id", PID),
]);

console.log(`Loaded ${lines.length} billing lines, ${codes.length} cost codes, ${tasks.length} schedule tasks`);

// Index tasks by phase
const tasksByPhase = new Map();
for (const t of tasks) {
  const p = t.phase ?? "(null)";
  if (!tasksByPhase.has(p)) tasksByPhase.set(p, []);
  tasksByPhase.get(p).push(t);
}

// ============ BILLING LINE MATCHER ============

function scoreBillingMatch(lineDescTokens, task, phaseBoost) {
  const nameTokens = new Set(tokenize(task.task_name));
  let kw = 0;
  for (const t of lineDescTokens) {
    if (nameTokens.has(t)) kw += 1;
  }
  // bonus if a task's whole phrase is contained in the line description
  return kw * 2 + phaseBoost;
}

function suggestForBillingLine(line) {
  const phases = TYPE_TO_PHASES.get((line.type ?? "").trim()) ?? [];
  if (phases.length === 0) return [];
  const lineTokens = tokenize(line.description);
  const candidates = [];
  for (const ph of phases) {
    const phTasks = tasksByPhase.get(ph) ?? [];
    for (const t of phTasks) {
      const score = scoreBillingMatch(lineTokens, t, 1);
      if (score >= 3) candidates.push({ task: t, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  // Top 3
  return candidates.slice(0, 3).map((c) => c.task.wbs_code);
}

// ============ COST CODE MATCHER ============

function suggestForCostCode(code) {
  if (COST_CODE_SKIP.has(code.code)) return { skipped: true, codes: [] };
  const phases = COST_CODE_PHASES.get(code.code) ?? [];
  const keywords = (COST_CODE_KEYWORDS.get(code.code) ?? []).map((k) => k.toLowerCase());
  if (phases.length === 0 || keywords.length === 0) return { skipped: true, codes: [] };
  const matches = [];
  for (const ph of phases) {
    for (const t of tasksByPhase.get(ph) ?? []) {
      const name = (t.task_name ?? "").toLowerCase();
      if (keywords.some((k) => name.includes(k))) {
        matches.push(t.wbs_code);
      }
    }
  }
  return { skipped: false, codes: matches };
}

// ============ COMPUTE + WRITE ============

console.log("");
console.log("=========== BILLING LINE SUGGESTIONS ===========");
console.log("Item    | Existing | Suggested (will write if existing empty)");
console.log("--------+----------+----------------------------------------");

const billingWrites = [];
for (const l of lines) {
  const existing = l.linked_task_wbs_codes ?? [];
  const proposed = suggestForBillingLine(l);
  const action = existing.length > 0 ? "(has manual)" : proposed.length > 0 ? "WRITE" : "no match";
  console.log(
    `${l.item_number.padEnd(8)}|${String(existing.length).padStart(8)}  | ${action.padEnd(12)} ${proposed.join(", ")}`,
  );
  if (existing.length === 0 && proposed.length > 0) {
    billingWrites.push({ id: l.id, codes: proposed });
  }
}

console.log("");
console.log("=========== COST CODE SUGGESTIONS ===========");
console.log("Code    | Existing | Action          | Suggested");
console.log("--------+----------+-----------------+-----------------");

const costWrites = [];
for (const c of codes) {
  const existing = c.linked_task_wbs_codes ?? [];
  const { skipped, codes: proposed } = suggestForCostCode(c);
  let action;
  if (existing.length > 0) action = "(has manual)";
  else if (skipped) action = "SKIP - no map";
  else if (proposed.length === 0) action = "no match";
  else action = `WRITE (${proposed.length})`;
  console.log(
    `${c.code.padEnd(8)}|${String(existing.length).padStart(8)}  | ${action.padEnd(15)} | ${proposed.slice(0, 6).join(", ")}${proposed.length > 6 ? ` +${proposed.length - 6} more` : ""}`,
  );
  if (existing.length === 0 && !skipped && proposed.length > 0) {
    costWrites.push({ id: c.id, codes: proposed });
  }
}

console.log("");
console.log(`Summary: ${billingWrites.length} billing lines to write, ${costWrites.length} cost codes to write`);

if (dryRun) {
  console.log("");
  console.log("Dry run - no writes performed.");
  process.exit(0);
}

console.log("");
console.log("Writing...");
for (const w of billingWrites) {
  const { error } = await sb
    .from("billing_lines")
    .update({ linked_task_wbs_codes: w.codes })
    .eq("id", w.id);
  if (error) {
    console.error(`Failed to update billing_line ${w.id}: ${error.message}`);
  }
}
for (const w of costWrites) {
  const { error } = await sb
    .from("cost_codes")
    .update({ linked_task_wbs_codes: w.codes })
    .eq("id", w.id);
  if (error) {
    console.error(`Failed to update cost_code ${w.id}: ${error.message}`);
  }
}
console.log(`Done. Wrote ${billingWrites.length} billing lines and ${costWrites.length} cost codes.`);
