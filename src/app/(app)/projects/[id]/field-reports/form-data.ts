import "server-only";

import { createClient } from "@/lib/supabase/server";
import { buildTaskPicker, summaryCodesOf } from "@/lib/schedule-picker";

// Everything the field report form needs to render, independent of whether it
// is opening blank or resuming a saved draft. Both pages load it from here so
// the picker ordering, the active-sub filter and the PO list cannot drift
// between "start a report" and "carry on with the one I started".

export type FieldReportFormData = Awaited<ReturnType<typeof loadFieldReportFormData>>;

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
}

export async function loadFieldReportFormData(projectId: string) {
  const supabase = createClient();

  const [tasksRes, subsRes, posRes] = await Promise.all([
    supabase
      .from("schedule_tasks")
      .select(
        "id, wbs_code, task_name, phase, status, pct_complete, start_date, end_date, parent_wbs_code",
      )
      .eq("project_id", projectId)
      .order("sort_order", { ascending: true, nullsFirst: false })
      .order("wbs_code", { ascending: true }),
    supabase
      .from("subcontractors")
      .select("id, company_name, trade")
      .eq("project_id", projectId)
      .eq("active", true)
      .order("company_name", { ascending: true }),
    supabase
      .from("procurement_orders")
      .select("id, vendor_name, po_number, description")
      .eq("project_id", projectId)
      .order("ordered_date", { ascending: false, nullsFirst: false }),
  ]);

  if (tasksRes.error) {
    return { error: `Failed to load schedule tasks: ${tasksRes.error.message}` } as const;
  }

  // Summary rows are removed and the rest is ordered so what the crew is
  // actually working on sits at the top. See src/lib/schedule-picker.ts for why
  // this matters to billing.
  const summaryCodes = summaryCodesOf(tasksRes.data ?? []);
  const tasks = buildTaskPicker(
    (tasksRes.data ?? []).map((t) => ({
      id: t.id,
      wbsCode: t.wbs_code,
      taskName: t.task_name,
      phase: t.phase,
      currentStatus: t.status,
      currentPct: Number(t.pct_complete ?? 0) || null,
      startDate: t.start_date,
      endDate: t.end_date,
    })),
    summaryCodes,
    todayIso(),
  );

  return {
    error: null,
    tasks,
    subs: (subsRes.data ?? []).map((s) => ({
      id: s.id,
      companyName: s.company_name,
      trade: s.trade,
    })),
    procurementOrders: (posRes.data ?? []).map((p) => ({
      id: p.id,
      vendorName: p.vendor_name,
      poNumber: p.po_number,
      description: p.description,
    })),
  } as const;
}
