import { createClient } from "@/lib/supabase/server";
import { firstOfThisMonthIso } from "@/lib/cashflow";

import { NextAfpPanelClient, type UpcomingEntry } from "./next-afp-panel-client";

type Props = {
  projectId: string;
  variant?: "page" | "widget";
};

// Surfaces upcoming forecast/suggested/reviewed billing_entries and lets the
// PM multi-select them into a single pay_application. Used both on the
// /billing page and embedded in the dashboard's Billing widget.
export async function NextAfpPanel({ projectId, variant = "page" }: Props) {
  const supabase = createClient();

  const { data: entries, error } = await supabase
    .from("billing_entries")
    .select(
      "id, period_month, planned_amount, retainage_amount, afp_number, status, billing_lines!inner(project_id, description, item_number)",
    )
    .eq("billing_lines.project_id", projectId)
    .order("period_month");

  if (error) return null;

  const thisMonthIso = firstOfThisMonthIso();
  const upcoming: UpcomingEntry[] = (entries ?? [])
    .filter(
      (e) =>
        (e.status === "forecast" ||
          e.status === "suggested" ||
          e.status === "reviewed") &&
        e.period_month >= thisMonthIso,
    )
    .sort((a, b) => a.period_month.localeCompare(b.period_month))
    .slice(0, 10)
    .map((e) => {
      const line = e.billing_lines as unknown as {
        description: string | null;
        item_number: string | null;
      } | null;
      const gross = Number(e.planned_amount ?? 0);
      const retainage = Number(e.retainage_amount ?? 0);
      return {
        id: e.id,
        afp: e.afp_number ?? "(no number)",
        period: e.period_month,
        scope: line?.description ?? "(unlinked)",
        item: line?.item_number ?? "",
        gross,
        retainage,
        netCash: Math.max(0, gross - retainage),
        status: e.status ?? "forecast",
      };
    });

  if (upcoming.length === 0) return null;

  return (
    <NextAfpPanelClient
      projectId={projectId}
      upcoming={upcoming}
      variant={variant}
    />
  );
}
