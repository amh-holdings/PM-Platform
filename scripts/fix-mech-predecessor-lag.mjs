// Fix the lag syntax on three mechanical predecessors.
//
// I wrote "5.2.4SS+3d". The CPM parser's grammar (schedule-cpm.ts:138) is
//
//     /^([0-9.]+?)(FS|SS|FF|SF)?([+-]\d+)?$/i
//
// so lag is "+3", with no unit suffix. The trailing "d" makes the whole token
// fail the match, and parsePredecessors DROPS an unmatched token rather than
// erroring. The result is the worst kind of wrong: Racking Assembly, Module
// Installation and QA/QC Closeout imported with no logic at all, and nothing
// anywhere said so.
//
// The import script's own validator did not catch it because it stripped
// "([+-]\d+d)?" before checking - it validated against my assumption about the
// format instead of against the parser that actually consumes it. Both this
// script and the import now test the real grammar.
//
//   node scripts/fix-mech-predecessor-lag.mjs --dry-run
//   node scripts/fix-mech-predecessor-lag.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const raw = readFileSync(".env.local", "utf8");
const env = {};
for (const l of raw.split("\n")) { const t = l.trim(); if (!t || t.startsWith("#")) continue; const i = t.indexOf("="); env[t.slice(0, i)] = t.slice(i + 1); }
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const PID = "53cff193-21e4-45ff-833d-43813e8578a0";
const DRY = process.argv.includes("--dry-run");

// Copied verbatim from src/lib/schedule-cpm.ts:138. If that grammar changes,
// this check is what should fail first.
const REL_RE = /^([0-9.]+?)(FS|SS|FF|SF)?([+-]\d+)?$/i;
const parses = (raw) =>
  (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)
    .every((tok) => REL_RE.test(tok));

const { data: tasks } = await sb.from("schedule_tasks").select("id,wbs_code,task_name,predecessors").eq("project_id", PID);
const live = new Set(tasks.map((t) => t.wbs_code));

const broken = tasks.filter((t) => t.predecessors && !parses(t.predecessors));
console.log(`mode: ${DRY ? "DRY RUN" : "APPLY"}\n`);
console.log(`Scanned ${tasks.length} tasks. ${broken.length} carry a predecessor string the CPM parser cannot read.\n`);

const fixes = [];
for (const t of broken) {
  // Drop the unit suffix only: "+3d" -> "+3". Nothing else about the string moves.
  const fixed = t.predecessors.replace(/([+-]\d+)\s*d\b/gi, "$1");
  if (!parses(fixed)) { console.error(`FATAL ${t.wbs_code}: "${t.predecessors}" -> "${fixed}" still unparseable`); process.exit(1); }
  for (const tok of fixed.split(",").map((s) => s.trim())) {
    const code = tok.match(REL_RE)[1];
    if (!live.has(code)) { console.error(`FATAL ${t.wbs_code}: predecessor ${code} has no task`); process.exit(1); }
  }
  fixes.push({ t, fixed });
  console.log(`  ${t.wbs_code.padEnd(8)} ${String(t.task_name).slice(0, 30).padEnd(31)} "${t.predecessors}"  ->  "${fixed}"`);
}

if (!fixes.length) { console.log("  Nothing to fix."); process.exit(0); }
if (DRY) { console.log("\n[dry-run] Nothing written.\n"); process.exit(0); }

for (const f of fixes) {
  const { error } = await sb.from("schedule_tasks").update({ predecessors: f.fixed }).eq("id", f.t.id);
  if (error) { console.error(`FATAL updating ${f.t.wbs_code}: ${error.message}`); process.exit(1); }
}
console.log(`\nFixed ${fixes.length} predecessor string(s). Every task's logic is now parseable by the CPM engine.\n`);
