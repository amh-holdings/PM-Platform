// Load Sussex's executed owner SOV (Exhibit E) and contract terms.
//
// Source: "20260922 - Sussex CSG1 Exhibit E SOV 1.xlsx" - sheet "Project 1 SOV
// (2)" for values, sheet "Milestone Triggers" for each line's trigger and the
// notes. Phil confirmed 2026-10-08 that this Exhibit E is executed.
//
// THE LNTP LINES
// Item 1.01 is the LNTP, $290,388.20, inside the contract value (Note 1). It
// is billed off its own LNTP SOV, already in the app as nine lines tied to
// plan-set tasks. Those stay broken out and keep their ids, task links and
// amounts; only their numbers move, 1.01-1.09 -> 1.01.1-1.01.9, so Exhibit E's
// 1.02 onward have room. No 1.01 parent line is added - it would bill the LNTP
// twice. The nine total $290,388.11, $0.09 under Exhibit E's 1.01; left as-is
// because the LNTP SOV is its own document.
//
// HALF CENTS
// 7.01 ($104,520.255) and 7.04 ($44,794.395) are half-cent figures. Stored as
// $104,520.26 and $44,794.39 so the 24 lines still total the sheet's
// $5,682,197.80.
//
// PROJECT TERMS (Exhibit E notes)
//   contract_value / original_contract_value  $5,972,586 (LNTP included)
//   retainage_pct_default                      5   (Note 3; was 10)
//   retainage_release_event                    substantial_completion (Item 11.00; was cod_plus_30)
//   contractor_legal_name                      IBT TVIG CT JV, LLC
//
// Refuses to run if a pay application exists or the LNTP lines are not the
// nine expected. Dry run by default; pass --apply to write.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const PID = "39154377-bd1a-48ea-acdc-5d9b568863c9";
const CONTRACT = 5972586;

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

// [item, type (section), description, scheduled value, chart of accounts, milestone trigger]
const SOV: [string, string, string, number, string, string][] = [
  ["1.02", "LNTP", "Material procurement", 0, "14060", "No material procured under LNTP."],
  ["2.00", "NTP", "EPC Contract - NTP (minus payments under LNTP)", 238903.44, "14060", "Execution of the Agreement and issuance of Notice to Proceed. Includes the Delaware performance and payment bond required under 30 Del. C. 375 and project insurance."],
  ["3.00", "Engineering", "Engineering deliverables from Part I, Sections 1.1 - 1.5 in Exhibit S", 59725.86, "14060", "Delivery of engineering deliverables per Part I, Sections 1.1 - 1.5 of Exhibit S."],
  ["4.00", "Permits", "Construction Permits Received", 59725.86, "14060", "Receipt of construction permits. Permitting and AHJ support scope was funded under the LNTP."],
  ["5.01", "Procurement", "Module Procurement Deposit", 0, "14070", "Modules are Owner-furnished. No Contractor procurement scope."],
  ["5.02", "Procurement", "Module Delivery", 89588.79, "14070", "Receipt, offloading and inventory of Owner-furnished modules at site, including storage and safekeeping through Substantial Completion."],
  ["5.03", "Procurement", "Inverters", 0, "14080", "Inverters are Owner-furnished."],
  ["5.04", "Procurement", "Pile and Racking Procurement Deposit", 358355.16, "14090", "Execution of the tracker and pile supply agreement and issuance of purchase order."],
  ["5.05", "Procurement", "Pile and Racking Delivery", 656984.46, "14090", "Delivery of tracker and pile material to site, including freight."],
  ["5.06", "Procurement", "Switchgear/Switchboard (Primary Meter, Recloser, GOAB) and DAS", 388218.09, "14100", "Issuance of purchase order and payment of supplier deposit for medium voltage collection equipment and data acquisition equipment. Deposit is required at order placement."],
  ["5.07", "Procurement", "Transformer", 0, "14100", "Transformers are Owner-furnished."],
  ["6.01", "Site Work", "Mobilization", 895887.9, "14060", "Mobilization of Contractor and subcontractor personnel and equipment to site."],
  ["6.02", "Site Work", "Fencing/SWPPP (temporary ESC measures)", 209040.51, "14060", "Installation of perimeter fencing, gates and erosion and sediment control measures."],
  ["6.03", "Site Work", "Civil/Roads (permanent SWM facilities)", 328492.23, "14060", "Completion of site grading, access roads, drainage and stormwater management facilities, restoration and required plantings."],
  ["7.01", "Electrical", "Inverters Installed (mounted only)", 104520.26, "14060", "Owner-furnished inverters set and mounted."],
  ["7.02", "Electrical", "AC/DC Wire (Trenching, Conduit and Concrete Pad Installed)", 814540.21, "14060", "Trenching, conduit, ductbank, DC and AC cable installation, terminations, grounding and lightning protection."],
  ["7.03", "Electrical", "Switchgear/Switchboard and DAS Installed", 119451.72, "14060", "Medium voltage equipment, metering, monitoring and weather station installed. Includes commissioning and acceptance testing."],
  ["7.04", "Electrical", "Transformers Installed", 44794.39, "14060", "Owner-furnished transformers offloaded, set and terminated."],
  ["8.01", "Mechanical", "Piles and Racking Installed", 328492.23, "14060", "Pile installation and tracker assembly complete with verification records."],
  ["8.02", "Mechanical", "Modules Installed", 89588.79, "14060", "Modules mounted and secured."],
  ["8.03", "Mechanical", "Optimizer, String Wire and Wire Management Installed", 0, "14060", "No scope."],
  ["9.00", "Milestone", "Mechanical Completion", 298629.3, "14060", "Mechanical Completion achieved per the Agreement."],
  ["10.00", "Milestone", "Placed In Service/Commercial Operation Date", 298629.3, "14060", "Placed In Service / Commercial Operation Date achieved."],
  ["11.00", "Milestone", "Substantial Completion (+ 5% Retainage Accrual Payment, less punchlist holdback)", 298629.3, "14060", "Substantial Completion achieved. Accrued retainage of 5% released, less the punchlist holdback carried to Item 12.00."],
  ["12.00", "Milestone", "Final Completion (+200% of punchlist holdback)", 0, "14060", "Final Completion achieved and punchlist closed. Value is the punchlist holdback carried from Item 11.00 at 200% of the agreed punchlist value. No percentage of Contract Value is allocated to this item."],
];

const r2 = (n: number) => Math.round(n * 100) / 100;
const epcTotal = r2(SOV.reduce((s, r) => s + r[3], 0));
if (epcTotal !== 5682197.8) throw new Error(`Exhibit E lines total ${epcTotal}, sheet says 5,682,197.80`);

const { count: payApps } = await sb
  .from("pay_applications")
  .select("*", { count: "exact", head: true })
  .eq("project_id", PID);
if ((payApps ?? 0) > 0) throw new Error(`${payApps} pay application(s) exist - renumbering lines under them is not safe`);

const { data: existing, error: exErr } = await sb
  .from("billing_lines")
  .select("id, item_number, type, scheduled_value, sort_order")
  .eq("project_id", PID)
  .order("sort_order");
if (exErr) throw exErr;
const want = ["1.01", "1.02", "1.03", "1.04", "1.05", "1.06", "1.07", "1.08", "1.09"];
if (JSON.stringify((existing ?? []).map((l) => l.item_number)) !== JSON.stringify(want)) {
  throw new Error(`expected the nine LNTP lines 1.01-1.09, found ${(existing ?? []).map((l) => l.item_number).join(", ")}`);
}
const lntpTotal = r2((existing ?? []).reduce((s, l) => s + Number(l.scheduled_value), 0));

const renumber = (existing ?? []).map((l, i) => ({ id: l.id, from: l.item_number, to: `1.01.${i + 1}`, type: l.type }));
const inserts = SOV.map(([item, type, description, value, coa, trigger], i) => ({
  project_id: PID,
  item_number: item,
  type,
  description,
  scheduled_value: value,
  sort_order: 100 + i * 10,
  notes: `Exhibit E. CoA ${coa}. Trigger: ${trigger}`,
}));

console.log("Renumber LNTP lines (ids, task links and amounts unchanged):");
console.table(renumber.map((r) => ({ from: r.from, to: r.to, type: r.type })));
console.log("Insert Exhibit E lines:");
console.table(inserts.map((r) => ({ item: r.item_number, type: r.type, description: r.description.slice(0, 50), value: r.scheduled_value.toLocaleString("en-US", { minimumFractionDigits: 2 }) })));
console.log(`LNTP lines $${lntpTotal.toLocaleString()} + Exhibit E $${epcTotal.toLocaleString()} = $${r2(lntpTotal + epcTotal).toLocaleString()} vs contract $${CONTRACT.toLocaleString()}`);

const projectPatch = {
  contract_value: CONTRACT,
  original_contract_value: CONTRACT,
  retainage_pct_default: 5,
  retainage_release_event: "substantial_completion",
  contractor_legal_name: "IBT TVIG CT JV, LLC",
};
console.log("Project:", projectPatch);

if (!APPLY) {
  console.log("\nDry run. Pass --apply to write.");
  process.exit(0);
}

for (const r of renumber) {
  const { error } = await sb.from("billing_lines").update({ item_number: r.to }).eq("id", r.id);
  if (error) throw error;
}
const { error: insErr } = await sb.from("billing_lines").insert(inserts);
if (insErr) throw insErr;
const { error: pErr } = await sb.from("projects").update(projectPatch).eq("id", PID);
if (pErr) throw pErr;

const { data: after } = await sb.from("billing_lines").select("scheduled_value").eq("project_id", PID);
console.log(
  `\nWrote. ${after?.length} SOV lines, $${r2((after ?? []).reduce((s, l) => s + Number(l.scheduled_value), 0)).toLocaleString()}`,
);
