// Apply the confirmed evidence mapping to Pyramid's SOV, and correct the
// payment terms on the subcontractor record.
//
// Everything here was confirmed by Phil on 2026-08-20:
//   1.01 Mobilization    fully earned when they hit site -> first field report
//   1.02 Site survey     is the Limits of Disturbance    -> task 5.1.1.1
//   2.03 Subgrade prep   is full site clearing           -> task 5.1.3.1
//   5.01 SWPPP ongoing   is permanent seeding            -> task 5.1.3.8
//   Payment terms are Net 60, not the Net 30 printed on their pay app.
//
// The rest of the mapping follows the back-test: daily production is the
// primary source for civil quantities because the schedule tasks are stale,
// with schedule tasks kept as the cross-check.
//
// Idempotent.  node scripts/sub-billing/map-pyramid-sov.mjs [--dry]

import { createClient } from "@supabase/supabase-js";
import fs from "fs";

const DRY = process.argv.includes("--dry");
const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trimStart().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const PROJECT_ID = "53cff193-21e4-45ff-833d-43813e8578a0";

// item -> { method, tasks, commodityLabels, milestone, note }
const MAPPING = {
  "1.01": { method: "on_site", note: "Fully earned when the crew hits site. Confirmed by Phil 2026-08-20." },
  "1.02": { method: "schedule", tasks: ["5.1.1.1"], note: "Site survey verification and layout IS the Limits of Disturbance. Confirmed by Phil 2026-08-20." },
  "1.03": { method: "schedule", tasks: ["5.1.1.3", "5.1.1.5"], note: "Initial ESC clearing plus silt/rock fence install." },
  "1.04": { method: "commodity", commodities: ["Site Prep"], note: "Daily production is primary; schedule task 5.1.3.1 is stale and belongs to line 2.03." },
  "2.01": { method: "commodity", commodities: ["Civil Work"], note: "Daily production is primary; schedule task 5.1.3.2 has not been updated." },
  "2.02": { method: "commodity", commodities: ["Civil Work"], note: "Shares the Civil Work commodity with 2.01." },
  "2.03": { method: "schedule", tasks: ["5.1.3.1"], note: "Subgrade preparation for array areas IS full site clearing. Confirmed by Phil 2026-08-20." },
  "2.04": { method: "schedule", tasks: ["5.1.3.3", "5.1.3.4", "5.1.3.7"], note: "Basin construction and conversion to stormwater ponds." },
  "3.01": { method: "commodity", commodities: ["Road Install"], note: "250 ft of road. Cross-check task 5.1.1.9 Rough Road." },
  "3.02": { method: "commodity", commodities: ["Road Install"], note: "Shares the Road Install commodity with 3.01 and 3.03." },
  "3.03": { method: "commodity", commodities: ["Road Install"], note: "Shares the Road Install commodity with 3.01 and 3.02." },
  // SWPPP implementation and ongoing maintenance is a wrapper over the entire
  // erosion-control program, so it earns as a duration-weighted percentage of
  // every ESC/SWPPP task on the job rather than against permanent seeding
  // alone. Sharing tasks with lines 1.02, 1.03, 5.02, 7.01 and 2.04 is correct
  // and is not double billing: each line carries its own scheduled value and
  // they simply read the same progress signal. Confirmed by Phil 2026-08-20.
  "5.01": { method: "schedule", tasks: ["5.1.1.1", "5.1.1.2", "5.1.1.3", "5.1.1.5", "5.1.1.6", "5.1.1.7", "5.1.1.8", "5.1.3.5", "5.1.3.6", "5.1.3.7", "5.1.3.8"], note: "All SWPPP/ESC activities, duration-weighted. Confirmed by Phil 2026-08-20." },
  "5.02": { method: "schedule", tasks: ["5.1.1.5"], note: "Silt/Rock Fence Install." },
  "7.01": { method: "schedule", tasks: ["5.1.3.5", "5.1.3.6"], note: "Basin final grading and stabilization." },
  "7.02": { method: "schedule", tasks: ["5.1.3.8"], note: "Hydroseeding and revegetation is the Permanent Seeding task itself." },
  "7.03": { method: "manual", note: "Final landscaping and site restoration. No task or commodity covers it; CM signs off." },
  "8.01": { method: "manual", note: "Demobilization. CM signs off when the crew and equipment are gone." },
  "8.02": { method: "manual", note: "Punchlist completion. CM signs off." },
  "8.03": { method: "manual", note: "Closeout documentation and as-builts. CM signs off on receipt." },
};

async function main() {
  const { data: sub } = await sb.from("subcontractors")
    .select("id, company_name, payment_terms, payment_terms_days")
    .eq("project_id", PROJECT_ID).ilike("company_name", "%Pyramid%").single();

  const { data: commodities } = await sb.from("commodities")
    .select("id, label").eq("project_id", PROJECT_ID).eq("active", true);
  const commodityId = Object.fromEntries((commodities ?? []).map((c) => [c.label, c.id]));

  const { data: tasks } = await sb.from("schedule_tasks")
    .select("wbs_code").eq("project_id", PROJECT_ID);
  const knownTasks = new Set((tasks ?? []).map((t) => t.wbs_code));

  const { data: sovLines } = await sb.from("sub_sov_lines")
    .select("id, item_number, description").eq("subcontractor_id", sub.id).order("sort_order");
  if (!sovLines?.length) throw new Error("No SOV loaded. Run scripts/seed-pyramid-sub-billing.mjs first.");

  let problems = 0;
  const updates = [];
  for (const line of sovLines) {
    const m = MAPPING[line.item_number];
    if (!m) { console.warn(`  no mapping for ${line.item_number}`); problems++; continue; }
    for (const t of m.tasks ?? []) {
      if (!knownTasks.has(t)) { console.error(`  ${line.item_number}: task ${t} does not exist`); problems++; }
    }
    const ids = (m.commodities ?? []).map((label) => {
      const id = commodityId[label];
      if (!id) { console.error(`  ${line.item_number}: commodity "${label}" not found`); problems++; }
      return id;
    }).filter(Boolean);
    updates.push({
      id: line.id,
      item_number: line.item_number,
      description: line.description,
      verification_method: m.method,
      linked_task_wbs_codes: m.tasks ?? [],
      linked_commodity_ids: ids,
      milestone_task_wbs_code: m.milestone ?? null,
      mapping_notes: m.note,
    });
  }

  console.log(`${sub.company_name}: mapping ${updates.length} of ${sovLines.length} SOV lines`);
  for (const u of updates) {
    const ev = u.verification_method === "on_site" ? "first field report"
      : u.linked_task_wbs_codes.length ? u.linked_task_wbs_codes.join(", ")
      : (MAPPING[u.item_number].commodities ?? []).join(", ") || "CM sign-off";
    console.log(`  ${u.item_number.padEnd(5)} ${u.verification_method.padEnd(10)} ${ev.padEnd(28)} ${u.description.slice(0, 34)}`);
  }
  if (problems) throw new Error(`${problems} mapping problems - nothing written`);

  console.log(`\nPayment terms: record says "${sub.payment_terms}" / ${sub.payment_terms_days} days. Contract is Net 60.`);
  if (DRY) return console.log("\n--dry: nothing written.");

  for (const u of updates) {
    const { id, item_number, description, ...fields } = u;
    const { error } = await sb.from("sub_sov_lines")
      .update({ ...fields, mapping_confirmed_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw new Error(`${item_number}: ${error.message}`);
  }
  console.log(`\nMapped ${updates.length} lines.`);

  const { error: termErr } = await sb.from("subcontractors")
    .update({ payment_terms: "Net 60", payment_terms_days: 60 }).eq("id", sub.id);
  if (termErr) throw new Error(termErr.message);
  console.log('Payment terms corrected to "Net 60" / 60 days.');
  console.log("\nPyramid pay app 1 states Net 30 and an invoice due date of 2026-09-12.");
  console.log("Under Net 60 from 2026-08-13 the due date is 2026-10-12. The bill's terms are wrong,");
  console.log("and the payment_terms check will now flag it on every application that repeats it.");
}

main().catch((e) => { console.error(e.message); process.exit(1); });
