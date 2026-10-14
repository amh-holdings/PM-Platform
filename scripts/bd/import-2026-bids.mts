/**
 * One-time import of AHC's 2026 bids into the BD pipeline (2026-10-09).
 *
 * Source: Shared drive > C-01-American Helios Constructors > 02_Pipeline_Proposals,
 * mainly "Final RFP Bid Sheets - All Projects". Phil: "Only import 2026" and he
 * fills in outcomes himself once it is in the system, so every bid lands open
 * (Submitted, or Bidding where the sheet carries no price) with a follow-up of
 * today, which puts all of them in his queue. Sussex is the exception: it is
 * already a PM project, so it imports Won and linked.
 *
 * Left out on purpose: 2024-2025 bids, Yarotek Marisol/Tetris (file name says
 * 2025, ambiguous), North Hills (wind takeoff), Cayman Brac (2023 lead).
 *
 * Safe to re-run: clients match by name, opportunities by client + name.
 *
 *   npx tsx --env-file=.env.local scripts/bd/import-2026-bids.mts          # dry run
 *   npx tsx --env-file=.env.local scripts/bd/import-2026-bids.mts --apply
 */

import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const PHIL = "9e92de24-8545-467f-b3a8-f68a894e71ad";
const SUSSEX_PROJECT = "39154377-bd1a-48ea-acdc-5d9b568863c9";
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

type Bid = {
  submitted_on: string;
  price: number;
  equipment_basis: "epc_furnished" | "owner_furnished" | "partial";
  notes: string;
};
type Opp = {
  client: string;
  name: string;
  state?: string;
  county?: string;
  mw?: number;
  stage: "bidding" | "submitted" | "won";
  bid?: Bid;
  won?: { outcome_date: string; project_id: string; notes: string };
  note?: string;
};

const SHEETS = "Final RFP Bid Sheets - All Projects";
const SS = "Standard Solar Projects/Presentation/20260928_AHC_Standard Solar_Bid Breakout_4 Projects.xlsx";

const OPPS: Opp[] = [
  // Standard Solar 4-project portfolio. Prices from the Sep 28 breakout; the
  // R3 proposal's price table is blank.
  ...(
    [
      ["Meadowood (Henry Solar 1)", "VA", "Henry", 4.91175, 7780449],
      ["Farmcrest (Campbell Solar)", "VA", "Campbell", 6.438, 9462927],
      ["King William Solar 1", "VA", "King William", 6.35775, 9633928],
      ["Livingston Solar", "MD", "Prince George's", 4.05162, 6849333],
    ] as const
  ).map(([name, state, county, mw, price]): Opp => ({
    client: "Standard Solar",
    name,
    state,
    county,
    mw,
    stage: "submitted",
    bid: { submitted_on: "2026-09-28", price, equipment_basis: "epc_furnished", notes: `From ${SS}` },
  })),
  {
    client: "Dimension Energy",
    name: "Hackmatack Solar",
    state: "PA",
    mw: 4.36,
    stage: "submitted",
    bid: {
      submitted_on: "2026-04-13",
      price: 7094861.24,
      equipment_basis: "epc_furnished",
      notes: `Bid with Jefferson. From ${SHEETS}/Dimension - Hackmatack & Jefferson (PA)`,
    },
  },
  {
    client: "Dimension Energy",
    name: "Jefferson CSG 1",
    state: "PA",
    mw: 4.46,
    stage: "submitted",
    bid: {
      submitted_on: "2026-04-13",
      price: 6447195.26,
      equipment_basis: "epc_furnished",
      notes: `Bid with Hackmatack. From ${SHEETS}/Dimension - Hackmatack & Jefferson (PA)`,
    },
  },
  {
    client: "Dimension Energy",
    name: "Sussex CSG 1",
    state: "DE",
    mw: 4.3435,
    stage: "won",
    bid: {
      submitted_on: "2026-03-23",
      price: 5740777.29,
      equipment_basis: "epc_furnished",
      notes: `R.1. From ${SHEETS}/Dimension - Sussex CSG 1`,
    },
    won: {
      outcome_date: "2026-06-05",
      project_id: SUSSEX_PROJECT,
      notes: "Decision date set to the project's NTP date (2026-06-05); correct it if the award came earlier.",
    },
  },
  {
    client: "Engie",
    name: "Trenton, OH",
    state: "OH",
    mw: 12.281,
    stage: "submitted",
    bid: {
      submitted_on: "2026-01-22",
      price: 7585445.51,
      equipment_basis: "owner_furnished",
      notes: `Install-heavy: material only $353,059. MW backed out of $0.618/W. From ${SHEETS}/Engie - Trenton OH`,
    },
  },
  {
    client: "Engie",
    name: "Sowers BESS",
    stage: "bidding",
    note: "Bid form on the drive is blank (Sowers_BESS_Comprehensive_Bid_Form.xlsx, Jan 2026). Add the price if we bid it.",
  },
  {
    client: "New Leaf Energy",
    name: "Allen Road Solar",
    mw: 3.09465,
    stage: "bidding",
    note: "Bid sheet on the drive is blank (20260401-Allen Road Bid Sheet.xlsx). Add the price if we bid it.",
  },
  {
    client: "New Leaf Energy",
    name: "Bouchelle Road Solar 1",
    mw: 7.47225,
    stage: "bidding",
    note: "Bid sheet on the drive is blank (20260401-Bouchelle Road Bid Sheet.xlsx). Add the price if we bid it.",
  },
];

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function companyId(name: string): Promise<string> {
  const { data } = await sb.from("bd_companies").select("id").ilike("name", name).maybeSingle();
  if (data) return data.id;
  if (!APPLY) return `(new client ${name})`;
  const { data: row, error } = await sb
    .from("bd_companies")
    .insert({ name, company_type: "Developer", owner_id: PHIL, created_by: PHIL })
    .select("id")
    .single();
  if (error) throw error;
  return row.id;
}

for (const o of OPPS) {
  const cid = await companyId(o.client);
  const { data: existing } = APPLY || !cid.startsWith("(")
    ? await sb.from("bd_opportunities").select("id").eq("company_id", cid).eq("name", o.name).maybeSingle()
    : { data: null };
  const price = o.bid ? `$${o.bid.price.toLocaleString("en-US")}` : "no price";
  if (existing) {
    console.log(`skip   ${o.client} / ${o.name} (already imported)`);
    continue;
  }
  console.log(`${APPLY ? "insert" : "would "} ${o.client} / ${o.name} - ${o.stage}, ${price}`);
  if (!APPLY) continue;

  const { data: opp, error } = await sb
    .from("bd_opportunities")
    .insert({
      company_id: cid,
      name: o.name,
      state: o.state ?? null,
      county: o.county ?? null,
      size_mw_dc: o.mw ?? null,
      stage: o.stage,
      owner_id: PHIL,
      source: "RFP",
      next_follow_up_date: o.stage === "won" ? null : TODAY,
      outcome_date: o.won?.outcome_date ?? null,
      outcome_notes: o.won?.notes ?? o.note ?? null,
      project_id: o.won?.project_id ?? null,
      created_by: PHIL,
    })
    .select("id")
    .single();
  if (error) throw error;

  if (o.bid) {
    const { error: bidErr } = await sb.from("bd_bids").insert({
      opportunity_id: opp.id,
      revision_type: "final",
      created_by: PHIL,
      ...o.bid,
    });
    if (bidErr) throw bidErr;
  }
}
console.log(APPLY ? "\nDone." : "\nDry run. Re-run with --apply to write.");
