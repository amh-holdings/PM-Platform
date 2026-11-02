/**
 * Load the priced lines of the 2026 bid forms into bd_bid_cost_lines, sorted into
 * Phil's six categories (2026-11-02). Each form is checked against its own total
 * before anything is written; a form that does not tie stops the run.
 *
 * Needs migration 0081. Safe to re-run: a bid's lines are replaced.
 *
 *   npx tsx --env-file=.env.local scripts/bd/import-cost-lines.mts <folder of bid forms>          # dry run
 *   npx tsx --env-file=.env.local scripts/bd/import-cost-lines.mts <folder of bid forms> --apply
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";

const APPLY = process.argv.includes("--apply");
const DIR = process.argv.slice(2).find((a) => !a.startsWith("--"));

type Category = "gc" | "civil" | "mechanical" | "electrical" | "ohp" | "bonds_insurance";
type RowMap = Record<Category, number[]>;

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

// Row numbers on each form type. Standard Solar repeats labels between its
// sections, so labelFor adds the section name.
const STANDARD: RowMap = {
  gc: [5, 17],
  civil: [9, 10, 12, 14, ...range(20, 31)],
  mechanical: [11, 34, 35, 36, 47, 48, 49],
  electrical: [13, ...range(37, 44), ...range(50, 57), ...range(60, 65)],
  ohp: [6],
  bonds_insurance: [4],
};
const HACKMATACK_JEFFERSON: RowMap = {
  gc: [14, 46, 47, 48, 50, 51],
  civil: [11, 27, 28, 29, 30, 31, 32],
  mechanical: [12, 16, 19, 22, 34, 35, 37],
  electrical: [13, 18, 20, 21, 23, 24, 25, 39, 40, 41, 42, 43, 44],
  ohp: [54],
  bonds_insurance: [52, 53],
};
const SUSSEX: RowMap = {
  gc: [14, 45, 46, 47, 49, 50],
  civil: [11, 27, 28, 29, 30, 31, 32],
  mechanical: [12, 16, 21, 22, 34, 35, 37],
  electrical: [13, 18, 19, 20, 23, 24, 25, 39, 40, 41, 42, 43],
  ohp: [53],
  bonds_insurance: [51, 52],
};
const TRENTON: RowMap = {
  gc: [20, 45, 46, 50, 51, 55],
  civil: [32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 48, 49],
  mechanical: [12, 13, 14, 15, 16],
  electrical: [19, 21, 22, 23, 24, 25, 26, 27, 28, 29, 47],
  ohp: [56],
  bonds_insurance: [54],
};

const SS_FILE = "20260928_AHC_Standard Solar_Bid Breakout_4 Projects.xlsx";
const HJ_FILE = "Dimension - Hackmatack & Jefferson (PA) - 20260413 - Bid Proposal Respnse Form.xlsx";
const SX_FILE = "Dimension - Sussex CSG 1 - Bid Proposal Response Form R.1 - Sussex CSG 1 3.23.26.xlsx";
const TR_FILE = "Engie - Trenton OH - Bid Template_Trenton, OH_GM_Date.xlsx";

const FORMS = [
  { opp: "Meadowood (Henry Solar 1)", file: SS_FILE, sheet: "Meadowood", map: STANDARD, labelCol: 1, cols: [3], total: 67 },
  { opp: "Farmcrest (Campbell Solar)", file: SS_FILE, sheet: "Farmcrest", map: STANDARD, labelCol: 1, cols: [3], total: 67 },
  { opp: "King William Solar 1", file: SS_FILE, sheet: "King William", map: STANDARD, labelCol: 1, cols: [3], total: 67 },
  { opp: "Livingston Solar", file: SS_FILE, sheet: "Livingston", map: STANDARD, labelCol: 1, cols: [3], total: 67 },
  { opp: "Hackmatack Solar", file: HJ_FILE, sheet: "Hackmatack", map: HACKMATACK_JEFFERSON, labelCol: 0, cols: [1], total: 55 },
  { opp: "Jefferson CSG 1", file: HJ_FILE, sheet: "Jefferson CSG 1 LLC", map: HACKMATACK_JEFFERSON, labelCol: 0, cols: [1], total: 55 },
  { opp: "Sussex CSG 1", file: SX_FILE, sheet: "Sussex CSG 1", map: SUSSEX, labelCol: 0, cols: [1], total: 54 },
  // Trenton prices material and installation in separate columns.
  { opp: "Trenton, OH", file: TR_FILE, sheet: "Bid Template", map: TRENTON, labelCol: 0, cols: [5, 7], total: 58 },
];

function labelFor(file: string, row: number, raw: unknown): string {
  const label = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (file !== SS_FILE) return label;
  if (row >= 34 && row <= 44) return `${label} (material)`;
  if (row >= 47 && row <= 57) return `${label} (install)`;
  if (row >= 9 && row <= 14) return `${label} (engineering)`;
  return label;
}

const num = (v: unknown) => (typeof v === "number" ? v : 0);

async function main() {
  if (!DIR) throw new Error("Pass the folder holding the bid forms.");
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
  const { data: opps, error } = await db
    .from("bd_opportunities")
    .select("name, bd_bids(id, price, submitted_on)");
  if (error) throw error;

  for (const f of FORMS) {
    const wb = XLSX.read(readFileSync(join(DIR, f.file)));
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[f.sheet], { header: 1, raw: true, defval: null });
    const lines: { category: Category; label: string; amount: number; source_file: string; source_row: number }[] = [];
    for (const [category, list] of Object.entries(f.map) as [Category, number[]][]) {
      for (const row of list) {
        const r = rows[row - 1] ?? [];
        const hasNumber = f.cols.some((c) => typeof r[c] === "number");
        if (!hasNumber) continue;
        lines.push({
          category,
          label: labelFor(f.file, row, r[f.labelCol]),
          amount: Math.round(f.cols.reduce((s, c) => s + num(r[c]), 0) * 100) / 100,
          source_file: `${f.file} / ${f.sheet}`,
          source_row: row,
        });
      }
    }
    const sum = lines.reduce((s, l) => s + l.amount, 0);
    const formTotal = f.cols.reduce((s, c) => s + num(rows[f.total - 1]?.[c]), 0);
    if (Math.abs(sum - formTotal) > 1) throw new Error(`${f.opp}: lines ${sum} do not tie to form total ${formTotal}`);

    const opp = (opps ?? []).find((o) => o.name === f.opp);
    const bid = opp?.bd_bids?.[0];
    if (!bid) throw new Error(`${f.opp}: no bid in BD`);
    if ((opp?.bd_bids?.length ?? 0) > 1) throw new Error(`${f.opp}: more than one bid; pick which form belongs to which`);
    const gap = Math.round(sum - Number(bid.price));
    console.log(`${f.opp} | ${lines.length} lines | form ${Math.round(sum).toLocaleString()} | bid record ${Math.round(Number(bid.price)).toLocaleString()}${gap ? ` | DIFF ${gap.toLocaleString()}` : ""}`);
    if (!APPLY) continue;

    const { error: de } = await db.from("bd_bid_cost_lines").delete().eq("bid_id", bid.id);
    if (de) throw new Error(`${f.opp}: ${de.message}`);
    const { error: ie } = await db.from("bd_bid_cost_lines").insert(lines.map((l) => ({ ...l, bid_id: bid.id })));
    if (ie) throw new Error(`${f.opp}: ${ie.message}`);
  }
  console.log(APPLY ? "Applied." : "Dry run. Add --apply to write.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
