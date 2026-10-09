/**
 * Rebuild an already-issued AFP from live data and diff it against the
 * snapshot that was actually sent.
 *
 * The G703 is the one document on this project that a client reconciles line by
 * line, and the numbers on it come from three moving parts: billing entries,
 * the SOV, and the change order allocations. A green build proves none of them.
 * This does: it runs buildPayAppLines() over today's data for a period already
 * billed and asserts the result still matches what the owner is holding.
 *
 * Sweet Springs AFP 12 is the reference. Its executed G703 spreads CO-02 across
 * nine work lines and carries no CO-02 row, so a replay that comes out right
 * proves the allocations are recorded correctly and that the builder reads them.
 *
 * Retainage is reported but not asserted. The reissued AFP 12 held none of its
 * own - its column I is cumulative through AFP 11 - and whether that was
 * deliberate is still open with the owner.
 *
 * Run: npx tsx scripts/pay-app/replay-afp.ts ["AFP 12"]
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

import { buildPayAppLines, type PayAppEntry } from "@/lib/pay-app-lines";

const PID = "53cff193-21e4-45ff-833d-43813e8578a0";
const APP = process.argv[2] ?? "AFP 12";

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
const usd = (n: number) =>
  "$" + Number(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const gap = (a: number, b: number) => Math.abs(Number(a ?? 0) - Number(b ?? 0));
const near = (a: number, b: number) => gap(a, b) < 0.015;
// A contract this size carries cent-level rounding between a change order's
// markup arithmetic and the figure the owner actually executed: CO-04 prices to
// $67,458.34 and the signed G703 says $67,458.31. Worth seeing, not worth
// failing a document over, and a real misconfiguration is never 3 cents.
const ROUNDING = 1.0;

async function main() {
  const { data: allApps } = await sb
    .from("pay_applications")
    .select("id, app_number, period_start, period_end, total_completed, previous_billings")
    .eq("project_id", PID)
    .order("period_start");
  const app = (allApps ?? []).find((a) => a.app_number === APP);
  if (!app) throw new Error(`${APP} not found`);

  // Replaying an application that is not the latest means the world has moved
  // on: later applications have stamped their own entries, and every one of
  // them would read as "previously billed" here. Drop them, so the replay sees
  // the project as it stood when this application went out.
  const laterAppIds = new Set(
    (allApps ?? [])
      .filter((a) => a.period_start > app.period_start)
      .map((a) => a.id),
  );

  const { data: project } = await sb
    .from("projects")
    .select("contract_value, retainage_pct_default")
    .eq("id", PID)
    .maybeSingle();

  const { data: lines } = await sb
    .from("billing_lines")
    .select("*")
    .eq("project_id", PID)
    .order("sort_order", { ascending: true, nullsFirst: false })
    .order("item_number", { ascending: true });
  const { data: entries } = await sb
    .from("billing_entries")
    .select("id, billing_line_id, period_month, actual_amount, planned_amount, pay_application_id, status, afp_number")
    .in("billing_line_id", (lines ?? []).map((l) => l.id));
  const { data: amendments } = await sb
    .from("billing_line_amendments")
    .select("amendment_line_id, base_line_id, amount")
    .eq("project_id", PID);
  const { data: snapshot } = await sb
    .from("pay_application_lines")
    .select("item_number, scheduled_value, work_completed_previous, work_completed_this_period, total_completed_and_stored, pct_complete, balance_to_finish, retainage_amount")
    .eq("pay_application_id", app.id);

  const asOfEntries = ((entries ?? []) as PayAppEntry[]).filter(
    (e) => !(e.pay_application_id && laterAppIds.has(e.pay_application_id)),
  );

  const built = buildPayAppLines({
    lines: lines ?? [],
    entries: asOfEntries,
    amendments: amendments ?? [],
    periodStart: app.period_start,
    periodEnd: app.period_end,
    retainagePct: Number(project?.retainage_pct_default ?? 5),
    forAppId: app.id,
  });
  if (!built.ok) {
    console.error(`REFUSED: ${built.error}`);
    process.exit(1);
  }

  const issued = new Map((snapshot ?? []).map((s) => [s.item_number, s]));
  const rebuilt = new Map(built.lines.map((l) => [l.item_number, l]));

  const FIELDS: [string, keyof (typeof built.lines)[number]][] = [
    ["scheduled value", "scheduled_value"],
    ["previous", "work_completed_previous"],
    ["this period", "work_completed_this_period"],
    ["total to date", "total_completed_and_stored"],
    ["pct", "pct_complete"],
    ["balance", "balance_to_finish"],
  ];

  let diffs = 0;
  let drift = 0;
  let retainageDiffs = 0;
  for (const [item, s] of Array.from(issued.entries())) {
    const r = rebuilt.get(item);
    if (!r) {
      console.log(`  ${item.padEnd(7)} ON ISSUED SHEET, NOT REBUILT`);
      diffs += 1;
      continue;
    }
    for (const [label, key] of FIELDS) {
      const a = Number((s as Record<string, unknown>)[key as string] ?? 0);
      const b = Number(r[key] ?? 0);
      if (!near(a, b)) {
        const rounding = gap(a, b) < ROUNDING;
        console.log(`  ${item.padEnd(7)} ${label.padEnd(15)} issued ${usd(a).padStart(14)}   rebuilt ${usd(b).padStart(14)}${rounding ? "   (rounding)" : ""}`);
        if (rounding) drift += 1;
        else diffs += 1;
      }
    }
    if (!near(Number(s.retainage_amount ?? 0), r.retainage_amount)) retainageDiffs += 1;
  }
  // A line the SOV has gained since - an approved change order, say - is not a
  // defect in the builder. It only matters if money is sitting on it, which
  // would mean this application should have carried it.
  let addedSince = 0;
  for (const item of Array.from(rebuilt.keys())) {
    if (issued.has(item)) continue;
    const r = rebuilt.get(item)!;
    const money = r.total_completed_and_stored;
    if (Math.abs(money) < 0.005) {
      addedSince += 1;
      continue;
    }
    console.log(`  ${item.padEnd(7)} REBUILT WITH ${usd(money)} BUT NOT ON THE ISSUED SHEET`);
    diffs += 1;
  }

  const omitted = (lines ?? []).length - built.lines.length;
  console.log(`\n${APP}  ${app.period_start} .. ${app.period_end}`);
  console.log(`  lines on issued sheet : ${issued.size}`);
  console.log(`  lines rebuilt         : ${rebuilt.size}  (${omitted} omitted as fully allocated)`);
  console.log(`  this period  issued ${usd(Number(app.total_completed))}   rebuilt ${usd(built.totals.total_completed)}`);
  console.log(`  previous     issued ${usd(Number(app.previous_billings))}   rebuilt ${usd(built.totals.previous_billings)}`);
  console.log(`  SOV total    contract ${usd(Number(project?.contract_value))}   rebuilt ${usd(built.totals.scheduled_value)}`);
  console.log(`  lines added to the SOV since, carrying nothing: ${addedSince}`);
  console.log(`  sub-dollar rounding differences: ${drift}`);
  console.log(`  retainage lines differing from the issued sheet: ${retainageDiffs} (reported, not asserted)`);

  if (diffs > 0) {
    console.error(`\nFAIL: ${diffs} difference(s).`);
    process.exit(1);
  }
  console.log(`\nPASS: every line matches the issued application${drift ? ` (${drift} sub-dollar rounding difference${drift === 1 ? "" : "s"})` : ""}.`);
}

main();
