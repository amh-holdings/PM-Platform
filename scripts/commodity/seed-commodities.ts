// Seed the 18 commodities for a project from the canonical list in
// src/lib/commodities.ts.
//
// Totals are seeded from the client's roll-up sheet with total_verified = FALSE,
// because those numbers are Jan-2025 template placeholders (250 ft road install,
// 500 ft trenching, 1,000 ft fencing, 12,000 modules, 500 piles) that do not
// trace to the Sweet Springs contract. They are seeded anyway so the row shape
// matches the client's sheet, but nothing should publish a % complete against
// them until each is replaced and flipped to verified.
//
// Idempotent: upserts on (project_id, key). Re-running updates labels, units and
// Smartsheet row ids without touching total_quantity on rows an operator has
// already verified.
//
// Usage:
//   npx tsx scripts/commodity/seed-commodities.ts [--project-id <uuid>] [--dry-run]

import { COMMODITIES, UOM_LABEL } from "@/lib/commodities";
import { parseArgs, serviceClient } from "./lib";

async function main() {
  const args = parseArgs();
  const supabase = serviceClient();

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id, name")
    .eq("id", args.projectId)
    .single();
  if (projectError || !project) {
    console.error(`Project ${args.projectId} not found: ${projectError?.message ?? "no row"}`);
    process.exit(1);
  }
  console.log(`Project: ${project.name} (${project.id})`);

  // Existing rows tell us which totals an operator has already verified, so a
  // re-run never stomps a real contract quantity with a placeholder.
  const { data: existing, error: existingError } = await supabase
    .from("commodities")
    .select("key, total_quantity, total_verified")
    .eq("project_id", args.projectId);
  if (existingError) {
    console.error(`Could not read commodities: ${existingError.message}`);
    console.error("Has migration 0035_commodity_tracking.sql been applied?");
    process.exit(1);
  }

  const verified = new Map<string, number | null>();
  for (const row of existing ?? []) {
    if (row.total_verified) verified.set(row.key, row.total_quantity);
  }
  if (verified.size > 0) {
    console.log(`${verified.size} commodity total(s) already verified - preserving them`);
  }

  const rows = COMMODITIES.map((c, index) => {
    const keepTotal = verified.has(c.key);
    return {
      project_id: args.projectId,
      key: c.key,
      label: c.formColumn,
      category: c.category,
      uom: UOM_LABEL[c.uom],
      total_quantity: keepTotal ? verified.get(c.key) : c.placeholderTotal,
      total_verified: keepTotal,
      sov_item: c.sovItem,
      smartsheet_rollup_row_id: c.rollupRowId,
      sort_order: index,
      active: true,
    };
  });

  console.log(`\n${rows.length} commodities to upsert:`);
  for (const r of rows) {
    const flag = r.total_verified ? "verified" : "PLACEHOLDER";
    console.log(
      `  ${String(r.sort_order).padStart(2)} ${r.category.padEnd(10)} ${r.label.padEnd(28)} ${String(r.uom).padEnd(5)} total=${r.total_quantity ?? "-"} (${flag})`
    );
  }

  if (args.dryRun) {
    console.log("\nDry run - no changes applied");
    return;
  }

  const { error } = await supabase
    .from("commodities")
    .upsert(rows, { onConflict: "project_id,key" });
  if (error) {
    console.error(`Upsert failed: ${error.message}`);
    process.exit(1);
  }

  const { count } = await supabase
    .from("commodities")
    .select("id", { count: "exact", head: true })
    .eq("project_id", args.projectId);

  console.log(`\nDone. ${count ?? "?"} commodities on this project.`);
  console.log(
    "Totals are placeholders from the client's Jan-2025 template. Replace them " +
      "from the contract SOV and set total_verified = true before publishing any % complete."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
