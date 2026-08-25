// Write a reviewed backfill file into daily_production.
//
// Takes the JSON produced by propose-backfill.ts AFTER a human has corrected
// the numbers. Rows land with source='backfill' so they are distinguishable
// from figures a sub entered on a field report at the time.
//
// Idempotent: upserts on (project_id, production_date, commodity_id), so
// re-running a corrected file overwrites that date rather than duplicating it.
// Days already synced to the client's Smartsheet are refused unless --force,
// because silently changing a number we have already reported to the client is
// worse than failing loudly.
//
// Usage:
//   npx tsx scripts/commodity/apply-backfill.ts --file <path.json> [--dry-run] [--force]

import { readFileSync } from "node:fs";

import { COMMODITIES } from "@/lib/commodities";
import { parseArgs, serviceClient } from "./lib";

type BackfillDoc = {
  projectId?: string;
  days: { date: string; values: Record<string, number> }[];
};

async function main() {
  const args = parseArgs();
  const file = args.flag("file");
  if (!file) {
    console.error("Missing --file <path.json>");
    process.exit(1);
  }

  const doc: BackfillDoc = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(doc.days) || doc.days.length === 0) {
    console.error("File has no days to apply");
    process.exit(1);
  }
  const projectId = doc.projectId ?? args.projectId;
  const supabase = serviceClient();

  // ---- Validate before touching anything ----
  const knownKeys = new Set(COMMODITIES.map((c) => c.key));
  const pctKeys = new Set(
    COMMODITIES.filter((c) => c.uom === "pct").map((c) => c.key)
  );
  const problems: string[] = [];
  const seenDates = new Set<string>();

  for (const day of doc.days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date)) {
      problems.push(`Bad date "${day.date}"`);
      continue;
    }
    if (seenDates.has(day.date)) problems.push(`Duplicate date ${day.date}`);
    seenDates.add(day.date);
    for (const [key, raw] of Object.entries(day.values ?? {})) {
      if (!knownKeys.has(key)) {
        problems.push(`${day.date}: unknown commodity "${key}"`);
        continue;
      }
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        problems.push(`${day.date}: ${key} = ${raw} is not a valid quantity`);
      } else if (pctKeys.has(key) && value > 100) {
        problems.push(`${day.date}: ${key} = ${value} exceeds 100% in a single day`);
      }
    }
  }

  // A percent scope cannot pass 100% across the whole window either.
  for (const key of Array.from(pctKeys)) {
    const total = doc.days.reduce((s, d) => s + (Number(d.values?.[key]) || 0), 0);
    if (total > 100) {
      problems.push(
        `${key}: daily percents sum to ${total.toFixed(2)}% across this file, which is over 100%`
      );
    }
  }

  if (problems.length) {
    console.error(`Refusing to apply - ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }

  // ---- Resolve commodities ----
  const { data: commodities, error: commErr } = await supabase
    .from("commodities")
    .select("id, key, label")
    .eq("project_id", projectId);
  if (commErr) {
    console.error(`Could not read commodities: ${commErr.message}`);
    console.error("Has migration 0035 been applied and seed-commodities.ts run?");
    process.exit(1);
  }
  if (!commodities?.length) {
    console.error(`No commodities configured for project ${projectId}. Run seed-commodities.ts first.`);
    process.exit(1);
  }
  const idByKey = new Map(commodities.map((c) => [c.key, c.id]));

  // ---- Refuse to silently rewrite anything already sent to the client ----
  const dates = doc.days.map((d) => d.date);
  const { data: synced } = await supabase
    .from("daily_production")
    .select("production_date")
    .eq("project_id", projectId)
    .in("production_date", dates)
    .not("synced_at", "is", null);
  if (synced?.length && !args.has("force")) {
    const affected = Array.from(new Set(synced.map((r) => r.production_date))).sort();
    console.error(
      `Refusing to apply - ${affected.length} date(s) have already been pushed to the client's Smartsheet:`
    );
    console.error(`  ${affected.join(", ")}`);
    console.error("Re-run with --force only if the client's sheet will be corrected too.");
    process.exit(1);
  }

  // ---- Build rows: every commodity for every date, zeros included ----
  //
  // These land CONFIRMED (migration 0040). That is this script's whole premise:
  // it applies a file whose numbers were read off the proposal grid and
  // corrected by hand, so they are not a machine estimate awaiting review the
  // way the live auto-proposer's rows are. confirmed_by stays null because the
  // review happened on the HTML grid rather than in the app - the same gap the
  // pre-0040 rows carry, and the reason 0040 does not require a confirmer.
  const confirmedAt = new Date().toISOString();
  const rows = doc.days.flatMap((day) =>
    commodities.map((c) => ({
      project_id: projectId,
      commodity_id: idByKey.get(c.key)!,
      production_date: day.date,
      quantity: Number(day.values?.[c.key]) || 0,
      source: "backfill" as const,
      confirmed_at: confirmedAt,
    }))
  );

  const nonZero = rows.filter((r) => r.quantity > 0);
  console.log(`Project:     ${projectId}`);
  console.log(`Dates:       ${doc.days.length} (${dates[0]} to ${dates[dates.length - 1]})`);
  console.log(`Rows:        ${rows.length} (${nonZero.length} non-zero)`);
  console.log("\nNon-zero values:");
  for (const r of nonZero) {
    const label = commodities.find((c) => c.id === r.commodity_id)?.label ?? "?";
    console.log(`  ${r.production_date}  ${label.padEnd(28)} ${r.quantity}`);
  }

  if (args.dryRun) {
    console.log("\nDry run - no changes applied");
    return;
  }

  const { error } = await supabase
    .from("daily_production")
    .upsert(rows, { onConflict: "project_id,production_date,commodity_id" });
  if (error) {
    console.error(`Upsert failed: ${error.message}`);
    process.exit(1);
  }

  const { count } = await supabase
    .from("daily_production")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId);
  console.log(`\nDone. ${count ?? "?"} daily_production rows on this project.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
