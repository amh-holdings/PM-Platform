import Link from "next/link";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/format";
import { STATUS_STYLE, type InspectionStatus } from "@/lib/inspection-status";

type Params = { id: string };

const DPR_TONE: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  submitted: "bg-amber-100 text-amber-900",
  approved: "bg-emerald-100 text-emerald-900",
  returned: "bg-destructive/10 text-destructive",
};

export default async function FieldReportsPage({
  params,
}: {
  params: Params;
}) {
  const supabase = createClient();

  const [dprsRes, pinsRes, subsRes] = await Promise.all([
    supabase
      .from("dprs")
      .select(
        "id, report_date, status, submitted_at, work_narrative, subcontractor_id, safety_incident, near_miss",
      )
      .eq("project_id", params.id)
      .order("report_date", { ascending: false })
      .order("submitted_at", { ascending: false }),
    supabase
      .from("inspections")
      .select("id, dpr_id, status, origin")
      .eq("project_id", params.id)
      .not("dpr_id", "is", null),
    supabase
      .from("subcontractors")
      .select("id, company_name")
      .eq("project_id", params.id),
  ]);

  if (dprsRes.error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        Failed to load field reports: {dprsRes.error.message}
      </div>
    );
  }

  const rows = dprsRes.data ?? [];
  const subName = new Map(
    (subsRes.data ?? []).map((s) => [s.id, s.company_name]),
  );

  // Tally work pins per report by inspection status.
  type Tally = Record<InspectionStatus, number>;
  const pinsByDpr = new Map<string, Tally>();
  for (const p of pinsRes.data ?? []) {
    if (!p.dpr_id) continue;
    const t =
      pinsByDpr.get(p.dpr_id) ??
      ({ submitted: 0, under_review: 0, approved: 0, rejected: 0 } as Tally);
    const s = p.status as InspectionStatus;
    if (s in t) t[s] += 1;
    pinsByDpr.set(p.dpr_id, t);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Field Reports</h2>
          <p className="text-xs text-muted-foreground">
            One daily report per sub: the progress narrative plus work marked on
            the site map. The Construction Manager reviews each pin.
          </p>
        </div>
        <Button asChild>
          <Link href={`/projects/${params.id}/field-reports/new`}>
            New Field Report
          </Link>
        </Button>
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted-foreground">
            <tr className="border-b">
              <th className="px-3 py-2 text-left font-medium">Date</th>
              <th className="px-3 py-2 text-left font-medium">Subcontractor</th>
              <th className="px-3 py-2 text-left font-medium">Report</th>
              <th className="px-3 py-2 text-left font-medium">Work pins</th>
              <th className="px-3 py-2 text-left font-medium">Submitted</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => {
              const tally = pinsByDpr.get(d.id);
              const totalPins = tally
                ? tally.submitted + tally.approved + tally.rejected
                : 0;
              return (
                <tr
                  key={d.id}
                  className="border-b last:border-0 hover:bg-muted/30"
                >
                  <td className="px-3 py-2 font-medium">
                    <Link
                      href={`/projects/${params.id}/field-reports/${d.id}`}
                      className="hover:underline"
                    >
                      {formatDate(d.report_date)}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {d.subcontractor_id
                      ? subName.get(d.subcontractor_id) ?? "-"
                      : "-"}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={cn(
                          "inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                          DPR_TONE[d.status ?? ""] ?? "bg-muted",
                        )}
                      >
                        {d.status}
                      </span>
                      {d.safety_incident ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-red-600 px-2 py-0.5 text-xs font-semibold text-white">
                          ⚠ Safety incident
                        </span>
                      ) : d.near_miss ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
                          Near miss
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    {totalPins === 0 ? (
                      <span className="text-xs text-muted-foreground">-</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {(
                          [
                            "submitted",
                            "approved",
                            "rejected",
                          ] as InspectionStatus[]
                        ).map((s) =>
                          tally && tally[s] > 0 ? (
                            <span
                              key={s}
                              className={cn(
                                "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
                                STATUS_STYLE[s].chip,
                              )}
                            >
                              {tally[s]} {STATUS_STYLE[s].label}
                            </span>
                          ) : null,
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {d.submitted_at ? formatDate(d.submitted_at) : "-"}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="px-3 py-6 text-center text-xs text-muted-foreground"
                >
                  No field reports yet. Click &quot;New Field Report&quot; to
                  file the first one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
