import Link from "next/link";

import { createClient } from "@/lib/supabase/server";

import { DprForm } from "./dpr-form";

type Params = { id: string };

export default async function NewDprPage({ params }: { params: Params }) {
  const supabase = createClient();

  const [tasksRes, subsRes, posRes] = await Promise.all([
    supabase
      .from("schedule_tasks")
      .select("id, wbs_code, task_name, phase, status, pct_complete, end_date")
      .eq("project_id", params.id)
      .order("sort_order", { ascending: true, nullsFirst: false })
      .order("wbs_code", { ascending: true }),
    supabase
      .from("subcontractors")
      .select("id, company_name, trade")
      .eq("project_id", params.id)
      .eq("active", true)
      .order("company_name", { ascending: true }),
    supabase
      .from("procurement_orders")
      .select("id, vendor_name, po_number, description")
      .eq("project_id", params.id)
      .order("ordered_date", { ascending: false, nullsFirst: false }),
  ]);

  if (tasksRes.error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        Failed to load schedule tasks: {tasksRes.error.message}
      </div>
    );
  }

  const taskRows = (tasksRes.data ?? []).map((t) => ({
    id: t.id,
    wbsCode: t.wbs_code,
    taskName: t.task_name,
    phase: t.phase,
    currentStatus: t.status,
    currentPct: Number(t.pct_complete ?? 0) || null,
    endDate: t.end_date,
  }));

  const subs = (subsRes.data ?? []).map((s) => ({
    id: s.id,
    companyName: s.company_name,
    trade: s.trade,
  }));

  const procurementOrders = (posRes.data ?? []).map((p) => ({
    id: p.id,
    vendorName: p.vendor_name,
    poNumber: p.po_number,
    description: p.description,
  }));

  return (
    <div className="space-y-4">
      <div>
        <Link
          href={`/projects/${params.id}/dprs`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          &larr; DPRs
        </Link>
        <h2 className="mt-1 text-lg font-semibold">Submit DPR</h2>
        <p className="text-xs text-muted-foreground">
          Capture the day: photos, manpower by sub, equipment, deliveries,
          delays, and which schedule tasks moved. On approval the schedule
          and dashboard update.
        </p>
      </div>

      <DprForm
        projectId={params.id}
        tasks={taskRows}
        subs={subs}
        procurementOrders={procurementOrders}
      />
    </div>
  );
}
