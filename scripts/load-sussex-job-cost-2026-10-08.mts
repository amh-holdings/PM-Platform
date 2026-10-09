// Load Sussex's internal job cost into cost_codes.
//
// Source: "20210921 - Sussex SOlar Project Job Cost final draft 1.xlsx", sheet
// JC, rows 7-10 (LNTP) and 15-47 (EPCA). Total $5,076,698.10 against an EPCA
// value of $5,972,586 (15% margin). This is the BUDGET only - no actuals, no
// forecasts, and the project's contract value is left alone until the
// executed Dimension SOV is loaded.
//
// Two edits to the sheet, both agreed with Phil on 2026-10-08:
//   - Structural Design was coded 200-1030 under phase 100 Engineering, which
//     collides with Racking at 200-1030. Recoded to 100-1030.
//   - Contingency was 34232.9899999983 (a plug), rounded to 34,232.99.
//
// Zero-dollar lines are loaded as $0 so the code structure matches the sheet.
//
// Civil Design and Electrical Design are linked to Exactus and Pure Power by
// subcontractor_id. commitment_covered stays false: Exactus has no SOV in the
// app, and Pure Power's SOV ($96,100) is $3,000 under the $99,100 budget line,
// so flagging it would drop that $3,000 from the forecast.
//
// Refuses to run if Sussex already has cost codes. Dry run by default; pass
// --apply to write.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const PID = "39154377-bd1a-48ea-acdc-5d9b568863c9";

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

// [stage, phase code, phase description, cost code, cost code description, extended cost]
const JC: [string, number, string, string, string, number][] = [
  ["LNTP", 100, "Engineering", "100-1010", "Civil Design", 19950],
  ["LNTP", 100, "Engineering", "100-1020", "Electrical Design", 99100],
  ["LNTP", 100, "Engineering", "100-1030", "Structural Design", 10000],
  ["LNTP", 800, "General Conditions", "800-1030", "TVIG Annex A - LNTP", 49450],
  ["EPCA", 100, "Engineering", "100-1040", "Permitting & Environmental", 7500],
  ["EPCA", 200, "Procurement", "200-1020", "Inverters", 0],
  ["EPCA", 200, "Procurement", "200-1030", "Racking, Mounting & Trackers", 900454.74],
  ["EPCA", 200, "Procurement", "200-1040", "DC Cabling & Combiner Boxes", 0],
  ["EPCA", 200, "Procurement", "200-1050", "AC/MV Cabling & Conductors", 281703.28],
  ["EPCA", 200, "Procurement", "200-1060", "Transformers & Switchgear", 0],
  ["EPCA", 200, "Procurement", "200-1070", "Substation Equipment", 0],
  ["EPCA", 300, "Construction", "300-1010", "Site Preparation & Grading", 94659.6],
  ["EPCA", 300, "Construction", "300-1020", "Civil Works & Access Roads", 302686.37],
  ["EPCA", 300, "Construction", "300-1030", "Foundations & Pile Driving", 116290.63],
  ["EPCA", 300, "Construction", "300-1040", "Mechanical Installation (Modules/Racking)", 505640.19],
  ["EPCA", 300, "Construction", "300-1050", "DC Electrical Installation", 225880.66],
  ["EPCA", 300, "Construction", "300-1060", "AC/MV Electrical Installation", 968617.91],
  ["EPCA", 300, "Construction", "300-1070", "Substation Construction", 0],
  ["EPCA", 300, "Construction", "300-1080", "SCADA, Monitoring & Controls", 113513.33],
  ["EPCA", 300, "Construction", "300-1090", "Fencing & Site Security", 124314.4],
  ["EPCA", 300, "Construction", "300-1100", "Commissioning & Testing", 49577],
  ["EPCA", 800, "General Conditions", "800-1010", "TVIG Annex A - EPCA", 774333],
  ["EPCA", 800, "General Conditions", "800-1020", "IBT Annex A - EPCA", 95000],
  ["EPCA", 800, "General Conditions", "800-1040", "Health, Safety & Environmental (HSE)", 0],
  ["EPCA", 800, "General Conditions", "800-1050", "Travel Expense", 42000],
  ["EPCA", 800, "General Conditions", "800-1060", "Small Tools", 6000],
  ["EPCA", 800, "General Conditions", "800-1070", "Field Office", 9000],
  ["EPCA", 800, "General Conditions", "800-1080", "Yard Fencing", 0],
  ["EPCA", 800, "General Conditions", "800-1090", "Utilities-Field Office", 11700],
  ["EPCA", 800, "General Conditions", "800-1100", "Port a Lets", 3330],
  ["EPCA", 800, "General Conditions", "800-1110", "Dumpsters", 0],
  ["EPCA", 800, "General Conditions", "800-1120", "Safety Supply", 4500],
  ["EPCA", 800, "General Conditions", "800-1130", "Refreshments", 7264],
  ["EPCA", 800, "General Conditions", "800-1140", "Legal Fees", 0],
  ["EPCA", 800, "General Conditions", "800-1150", "Bonds", 120000],
  ["EPCA", 800, "General Conditions", "800-1160", "Insurance", 100000],
  ["EPCA", 800, "General Conditions", "800-1200", "Contingency", 34232.99],
];

const SUB_FOR_CODE: Record<string, RegExp> = {
  "100-1010": /exactus/i,
  "100-1020": /pure power/i,
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const sum = (stage?: string) =>
  r2(JC.filter((r) => !stage || r[0] === stage).reduce((s, r) => s + r[5], 0));

// The sheet's own totals - stop if the transcription drifted.
const expect = { LNTP: 178500, EPCA: 4898198.1, all: 5076698.1 };
const got = { LNTP: sum("LNTP"), EPCA: sum("EPCA"), all: sum() };
for (const k of Object.keys(expect) as (keyof typeof expect)[]) {
  if (got[k] !== expect[k]) throw new Error(`${k} total ${got[k]} != sheet ${expect[k]}`);
}
if (new Set(JC.map((r) => r[3])).size !== JC.length) throw new Error("duplicate cost code");

const { count } = await sb
  .from("cost_codes")
  .select("*", { count: "exact", head: true })
  .eq("project_id", PID);
if ((count ?? 0) > 0) throw new Error(`Sussex already has ${count} cost codes - not loading over them`);

const { data: subs, error: subErr } = await sb.from("subcontractors").select("*").eq("project_id", PID);
if (subErr) throw subErr;
const subId = (code: string) => {
  const re = SUB_FOR_CODE[code];
  if (!re) return null;
  const hit = (subs ?? []).filter((s) => re.test(JSON.stringify(s)));
  if (hit.length !== 1) throw new Error(`${code}: expected one sub matching ${re}, found ${hit.length}`);
  return hit[0].id as string;
};

const rows = JC.map(([stage, phase, phaseName, code, name, cost], i) => ({
  project_id: PID,
  code,
  name,
  description: `${stage} - ${phase} ${phaseName}`,
  estimated_cost: cost,
  actual_cost: 0,
  is_change_order: false,
  sort_order: i + 1,
  subcontractor_id: subId(code),
  commitment_covered: false,
}));

console.table(
  rows.map((r) => ({
    "#": r.sort_order,
    code: r.code,
    name: r.name.slice(0, 40),
    group: r.description,
    budget: r.estimated_cost.toLocaleString("en-US", { minimumFractionDigits: 2 }),
    sub: r.subcontractor_id ? "linked" : "",
  })),
);
console.log(`LNTP $${got.LNTP.toLocaleString()}  EPCA $${got.EPCA.toLocaleString()}  total $${got.all.toLocaleString()}`);

if (!APPLY) {
  console.log("\nDry run. Pass --apply to write.");
  process.exit(0);
}
const { error } = await sb.from("cost_codes").insert(rows);
if (error) throw error;
const { data: check } = await sb.from("cost_codes").select("estimated_cost").eq("project_id", PID);
console.log(
  `\nWrote ${check?.length} codes, budget $${r2((check ?? []).reduce((s, c) => s + Number(c.estimated_cost), 0)).toLocaleString()}`,
);
