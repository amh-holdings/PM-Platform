// The verification pass, factored out of the server action so a CLI script can
// run the exact same code path against the same database. Takes the client as
// an argument and imports nothing server-only, so it works under both the
// cookie-bound request client and a service-role client.
//
// If this and the server action ever drift, a bill verified from the terminal
// stops meaning the same thing as one verified in the app. Keeping one
// implementation is the point.

import {
  approvedToDateByItem,
  runBillChecks,
  verifyLine,
  type BillHeader,
  type BillLine,
  type Evidence,
  type PriorBill,
  type SovLine,
  type SubContext,
} from "@/lib/sub-billing";
import type { SubBillingClient } from "@/lib/sub-billing.types";
import {
  basisFor,
  pickSnapshotFor,
  type ScheduleBasis,
} from "@/lib/weekly-schedule-basis";

export type VerificationRun = {
  ok: boolean;
  error?: string;
  checks?: number;
  failures?: number;
  warnings?: number;
  linesVerified?: number;
};

// Every evidence source the engine can draw on, as of a given date. Production
// is summed only up to the period end, so a bill is judged on what had actually
// been installed by its own cut-off rather than by today.
//
// The schedule needed the same treatment and did not have it. pct_complete is
// one column holding one number - today's - so a bill cut off on 31 August was
// being judged on schedule percentages that include September's work. For a
// cut-off in the past the task rows are read from the weekly snapshot saved at
// the time instead (schedule_updates, 0033), and Evidence.scheduleAsOf says
// which copy was used so the caller can print the caveat rather than imply a
// precision that is not there.
export async function loadEvidence(
  db: SubBillingClient,
  projectId: string,
  asOf: string,
  subcontractorId?: string,
): Promise<Evidence> {
  const todayIso = new Date().toISOString().slice(0, 10);

  const [{ data: tasks }, { data: commodities }, { data: production }] = await Promise.all([
    db
      .from("schedule_tasks")
      .select("wbs_code, task_name, status, pct_complete, start_date, end_date, duration_days")
      .eq("project_id", projectId),
    db
      .from("commodities")
      .select("id, label, uom, total_quantity")
      .eq("project_id", projectId)
      .eq("active", true),
    db
      .from("daily_production")
      .select("commodity_id, quantity, production_date")
      .eq("project_id", projectId)
      .lte("production_date", asOf),
      // EVERY ROW ON THE TRACKER COUNTS, whoever put it there. The tracker is a
      // report of the approved field record, not a second approval gate on top
      // of it, and this query is verification evidence rather than the bill
      // itself: it computes what the record says was installed so a variance
      // against what the sub billed can be flagged. Filtering rows out here did
      // not make a bill safer, it made an approved day read as no work done and
      // flagged an honest sub for over-billing.
  ]);

  const installed = new Map<string, number>();
  for (const row of production ?? []) {
    if (!row.commodity_id) continue;
    installed.set(
      row.commodity_id,
      (installed.get(row.commodity_id) ?? 0) + Number(row.quantity ?? 0),
    );
  }

  // Earliest field report from this sub - the platform's record of the day they
  // hit site, which is what a mobilization line is earned against.
  let subOnSiteDate: string | null = null;
  if (subcontractorId) {
    const { data: firstDpr } = await db
      .from("dprs")
      .select("report_date")
      .eq("project_id", projectId)
      .eq("subcontractor_id", subcontractorId)
      .order("report_date", { ascending: true })
      .limit(1);
    subOnSiteDate = firstDpr?.[0]?.report_date ?? null;
  }

  // A cut-off in the past asks for the schedule as it stood then. The newest
  // snapshot on or before that date is the one that was current; a later one
  // already carries work done after the cut-off, which is the whole thing this
  // avoids. Best effort: no snapshot means the live rows, said out loud rather
  // than hidden.
  type SnapshotTask = {
    wbs_code: string;
    task_name?: string | null;
    status?: string | null;
    pct_complete?: number | null;
    start_date?: string | null;
    end_date?: string | null;
    duration_days?: number | null;
  };
  let scheduleRows = (tasks ?? []) as SnapshotTask[];
  let picked: { dataDate: string } | null = null;
  if (asOf < todayIso) {
    const { data: snaps } = await db
      .from("schedule_updates")
      .select("data_date, tasks")
      .eq("project_id", projectId)
      .lte("data_date", asOf)
      .order("data_date", { ascending: false })
      .limit(1);
    const row = (snaps ?? [])[0] as { data_date: string; tasks: unknown } | undefined;
    const hit = row ? pickSnapshotFor([{ dataDate: row.data_date }], asOf) : null;
    if (hit && Array.isArray(row?.tasks) && row.tasks.length) {
      scheduleRows = row.tasks as SnapshotTask[];
      picked = hit;
    }
  }
  const scheduleAsOf: ScheduleBasis = basisFor({
    periodEnd: asOf,
    today: todayIso,
    snapshot: picked,
  });

  return {
    scheduleAsOf,
    tasks: new Map(
      scheduleRows
        .filter((t) => t.wbs_code)
        .map((t) => [t.wbs_code, { ...t, wbs_code: t.wbs_code, task_name: t.task_name ?? null }]),
    ),
    commodities: new Map(
      (commodities ?? []).map((c) => [
        c.id,
        {
          label: c.label ?? "",
          installed: installed.get(c.id) ?? 0,
          total: Number(c.total_quantity ?? 0),
          uom: c.uom ?? null,
        },
      ]),
    ),
    subOnSiteDate,
    todayIso: asOf,
  };
}

export async function runVerificationCore(
  db: SubBillingClient,
  appId: string,
): Promise<VerificationRun> {
  const { data: app } = await db.from("sub_pay_apps").select("*").eq("id", appId).single();
  if (!app) return { ok: false, error: "Bill not found" };

  const { data: sub } = await db
    .from("subcontractors")
    .select(
      "company_name, contract_value, retainage_pct, payment_terms, payment_terms_days, coi_status, w9_status",
    )
    .eq("id", app.subcontractor_id)
    .single();
  if (!sub) return { ok: false, error: "Subcontractor not found" };

  const [{ data: lineRows }, { data: sovRows }] = await Promise.all([
    db.from("sub_pay_app_lines").select("*").eq("sub_pay_app_id", appId).order("sort_order"),
    db
      .from("sub_sov_lines")
      .select("*")
      .eq("subcontractor_id", app.subcontractor_id)
      .eq("active", true),
  ]);
  const lines = lineRows ?? [];
  const sovLines = (sovRows ?? []) as unknown as SovLine[];

  // Continuity runs against everything we have recorded EXCEPT rejected
  // applications. A bill AHC refused is not the accepted starting point for
  // the bill that replaces it. Every remaining application is pulled, not just
  // the newest, because approved-to-date is a sum across all of them.
  const { data: priorRows } = await db
    .from("sub_pay_apps")
    .select("id, app_number, period_end, billed_to_date, approved_this_period, status")
    .eq("subcontractor_id", app.subcontractor_id)
    .lt("app_number", app.app_number)
    .neq("status", "rejected")
    .order("app_number", { ascending: false });
  let prior: PriorBill | null = null;
  if (priorRows?.[0]) {
    const [{ data: latestLines }, { data: allLines }] = await Promise.all([
      db
        .from("sub_pay_app_lines")
        .select("item_number, total_completed")
        .eq("sub_pay_app_id", priorRows[0].id),
      db
        .from("sub_pay_app_lines")
        .select("item_number, this_period, materials_stored, approved_this_period")
        .in("sub_pay_app_id", priorRows.map((p) => p.id)),
    ]);
    const approvedByItem = approvedToDateByItem(allLines ?? []);
    let approvedToDate = 0;
    approvedByItem.forEach((v) => {
      approvedToDate += v;
    });
    prior = {
      ...priorRows[0],
      lines: latestLines ?? [],
      approvedByItem,
      approvedToDate: Math.round(approvedToDate * 100) / 100,
    } as PriorBill;
  }

  // ---- Pass 1: arithmetic and continuity ----
  const checks = runBillChecks({
    header: app as unknown as BillHeader,
    lines: lines as unknown as BillLine[],
    sovLines,
    sub: sub as unknown as SubContext,
    prior,
  });

  await db.from("sub_pay_app_checks").delete().eq("sub_pay_app_id", appId);
  if (checks.length > 0) {
    await db.from("sub_pay_app_checks").insert(
      checks.map((c) => ({
        sub_pay_app_id: appId,
        check_key: c.key,
        label: c.label,
        severity: c.severity,
        status: c.status,
        expected: c.expected ?? null,
        actual: c.actual ?? null,
        delta: c.delta ?? null,
        message: c.message,
        line_item_number: c.lineItemNumber ?? null,
      })),
    );
  }

  // ---- Pass 2: field substantiation, as of the period end ----
  const evidence = await loadEvidence(db, app.project_id, app.period_end, app.subcontractor_id);
  const sovByItem = new Map(sovLines.map((l) => [l.item_number, l]));

  let linesVerified = 0;
  for (const line of lines) {
    const sov = sovByItem.get(line.item_number);
    if (!sov) continue;
    const v = verifyLine(sov, line as unknown as BillLine, evidence);
    await db
      .from("sub_pay_app_lines")
      .update({
        verified_pct: v.verifiedPct,
        verified_amount: v.verifiedAmount,
        verification_source: v.source,
        verification_confidence: v.confidence,
        verification_detail: v.detail,
        variance_amount: v.varianceAmount,
        variance_pct: v.variancePct,
        flag_level: v.flag,
      })
      .eq("id", line.id);
    linesVerified++;
  }

  return {
    ok: true,
    checks: checks.length,
    failures: checks.filter((c) => c.status === "fail").length,
    warnings: checks.filter((c) => c.status === "warn").length,
    linesVerified,
  };
}
