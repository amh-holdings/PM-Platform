// Link the last three deliveries to the installs that consume them.
//
// Phil, 2026-10-01: the recloser goes with Set Poles alongside the rest of the
// MV gear; the AC disconnect and the GroundWorks Zenith both feed AC Wiring.
//
// Until now these three had a delivery date and no successor, so a vendor
// slipping any of them moved nothing downstream. They were the last isolated
// tasks on the job.
//
//   node scripts/link-equipment-consumers.mjs           # dry run
//   node scripts/link-equipment-consumers.mjs --apply

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const PROJECT_ID = "53cff193-21e4-45ff-833d-43813e8578a0";
const APPLY = process.argv.includes("--apply");

const LINKS = [
  { consumer: "5.5.10.1", add: "4.4.4.2",  what: "27kV Recloser (Tavrida)" },
  { consumer: "5.5.9",    add: "4.4.12.2", what: "30A AC Disconnect + fuses" },
  { consumer: "5.5.9",    add: "4.4.5.2",  what: "GroundWorks Zenith" },
];

const env = {};
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); env[t.slice(0, i)] = t.slice(i + 1);
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: tasks, error } = await sb.from("schedule_tasks")
  .select("wbs_code, task_name, predecessors").eq("project_id", PROJECT_ID);
if (error) throw new Error(error.message);

const next = new Map();
for (const l of LINKS) {
  const t = tasks.find((x) => x.wbs_code === l.consumer);
  if (!t) { console.log(`${l.consumer} MISSING`); continue; }
  const have = (next.get(l.consumer) ?? String(t.predecessors ?? ""))
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (!have.some((p) => p.replace(/(FS|SS|FF|SF).*$/i, "") === l.add)) have.push(l.add);
  next.set(l.consumer, have.join(", "));
}
for (const [wbs, preds] of next) {
  const t = tasks.find((x) => x.wbs_code === wbs);
  console.log(`${wbs}  ${t.task_name}`);
  console.log(`  was: ${t.predecessors ?? "(none)"}`);
  console.log(`  now: ${preds}`);
  console.log(`  adds: ${LINKS.filter((l) => l.consumer === wbs).map((l) => l.what).join("; ")}\n`);
}

if (!APPLY) { console.log("Dry run. Re-run with --apply."); process.exit(0); }

for (const [wbs, preds] of next) {
  const { error: e } = await sb.from("schedule_tasks").update({ predecessors: preds })
    .eq("project_id", PROJECT_ID).eq("wbs_code", wbs);
  if (e) console.error(`  ${wbs}: ${e.message}`);
}
console.log(`Wrote ${next.size} tasks.`);
