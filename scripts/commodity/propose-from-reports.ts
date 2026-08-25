// Catch the Commodity Tracker up on Field Reports that were approved before the
// auto-proposer existed (or on any day it was skipped).
//
// This is deliberately NOT a second implementation. It calls the exact function
// the approval hook calls, one report at a time, so a day filled by this script
// is indistinguishable from a day filled live - same evidence, same rate, same
// unconfirmed rows waiting on Phil. A separate catch-up algorithm would be a
// second source of truth for the owner's sheet.
//
// Days that already carry production are left untouched, so this is safe to
// re-run over any window.
//
// Usage:
//   npx tsx scripts/commodity/propose-from-reports.ts \
//     [--project-id <uuid>] [--from 2026-08-19] [--to 2026-08-31] [--dry-run]

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { proposeProductionForReport } from "@/lib/production-proposal-run";
import { parseArgs, serviceClient } from "./lib";

async function main() {
  const args = parseArgs();
  const admin = serviceClient() as unknown as SupabaseClient<Database>;

  const from = args.flag("from");
  const to = args.flag("to");

  let query = admin
    .from("dprs")
    .select("id, report_date, status")
    .eq("project_id", args.projectId)
    .eq("status", "approved")
    .order("report_date", { ascending: true });
  if (from) query = query.gte("report_date", from);
  if (to) query = query.lte("report_date", to);

  const { data: reports, error } = await query;
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  if (!reports?.length) {
    console.log("No approved Field Reports in that window.");
    return;
  }

  console.log(
    `${reports.length} approved report(s)${from || to ? ` between ${from ?? "start"} and ${to ?? "today"}` : ""}\n`,
  );

  if (args.dryRun) {
    console.log("--dry-run: listing only, nothing written.\n");
    for (const r of reports) console.log(`  ${r.report_date}`);
    return;
  }

  let written = 0;
  for (const r of reports) {
    const result = await proposeProductionForReport(admin, {
      projectId: args.projectId,
      dprId: r.id,
    });
    written += result.written;
    const head = result.error
      ? `ERROR ${result.error}`
      : result.written > 0
        ? `${result.written} value(s) proposed`
        : "nothing to propose";
    console.log(`  ${r.report_date}  ${head}`);
    for (const n of result.notes) console.log(`      - ${n}`);
  }

  console.log(
    `\n${written} row(s) written, all unconfirmed. Review them on the project's Production page and save to file them.`,
  );
}

main();
