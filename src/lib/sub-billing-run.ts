// The verification pass, factored out of the server action so a CLI script can
// run the exact same code path against the same database. Takes the client as
// an argument and imports nothing server-only, so it works under both the
// cookie-bound request client and a service-role client.
//
// If this and the server action ever drift, a bill verified from the terminal
// stops meaning the same thing as one verified in the app. Keeping one
// implementation is the point.

import {
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
export async function loadEvidence(
  db: SubBillingClient,
  projectId: string,
  asOf: string,
  subcontractorId?: string,
): Promise<Evidence> {
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

  return {
    tasks: new Map(
      (tasks ?? []).map((t) => [t.wbs_code, { ...t, wbs_code: t.wbs_code, task_name: t.task_name }]),
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

  // Continuity runs against whatever we last recorded, approved or not.
  const { data: priorRows } = await db
    .from("sub_pay_apps")
    .select("id, app_number, period_end, billed_to_date, approved_this_period, status")
    .eq("subcontractor_id", app.subcontractor_id)
    .lt("app_number", app.app_number)
    .order("app_number", { ascending: false })
    .limit(1);
  let prior: PriorBill | null = null;
  if (priorRows?.[0]) {
    const { data: pl } = await db
      .from("sub_pay_app_lines")
      .select("item_number, total_completed")
      .eq("sub_pay_app_id", priorRows[0].id);
    prior = { ...priorRows[0], lines: pl ?? [] } as PriorBill;
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
