import Link from "next/link";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/format";

type Params = { id: string };

const STATUS_TONE: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  submitted: "bg-amber-100 text-amber-900",
  approved: "bg-emerald-100 text-emerald-900",
  returned: "bg-destructive/10 text-destructive",
};

export default async function ProjectDprsPage({ params }: { params: Params }) {
  const supabase = createClient();

  const { data: dprs, error } = await supabase
    .from("dprs")
    .select(
      "id, report_date, status, submitted_at, work_narrative, crew_count, total_man_hours, foreman_id",
    )
    .eq("project_id", params.id)
    .order("report_date", { ascending: false })
    .order("submitted_at", { ascending: false });

  if (error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        Failed to load DPRs: {error.message}
      </div>
    );
  }

  const rows = dprs ?? [];

  // Counts per status for the summary header
  const counts = rows.reduce<Record<string, number>>((acc, d) => {
    const s = d.status ?? "unknown";
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Daily Progress Reports</h2>
          <p className="text-xs text-muted-foreground">
            Submitted DPRs update schedule task status on approval. Approved
            DPRs drive the dashboard&apos;s billing and spend auto-suggest.
          </p>
        </div>
        <Button asChild>
          <Link href={`/projects/${params.id}/dprs/new`}>Submit DPR</Link>
        </Button>
      </div>

      <div className="grid gap-2 sm:grid-cols-4">
        {(["submitted", "approved", "returned", "draft"] as const).map((s) => (
          <div key={s} className="rounded-md border bg-card p-3">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              {s}
            </div>
            <div className="mt-1 text-2xl font-semibold">{counts[s] ?? 0}</div>
          </div>
        ))}
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted-foreground">
            <tr className="border-b">
              <th className="px-3 py-2 text-left font-medium">Report date</th>
              <th className="px-3 py-2 text-left font-medium">Status</th>
              <th className="px-3 py-2 text-left font-medium">Narrative</th>
              <th className="px-3 py-2 text-right font-medium">Crew</th>
              <th className="px-3 py-2 text-right font-medium">Hours</th>
              <th className="px-3 py-2 text-left font-medium">Submitted</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr
                key={d.id}
                className="border-b last:border-0 hover:bg-muted/30"
              >
                <td className="px-3 py-2 font-medium">
                  <Link
                    href={`/projects/${params.id}/dprs/${d.id}`}
                    className="hover:underline"
                  >
                    {formatDate(d.report_date)}
                  </Link>
                </td>
                <td className="px-3 py-2">
                  <span
                    className={cn(
                      "inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                      STATUS_TONE[d.status ?? ""] ?? "bg-muted",
                    )}
                  >
                    {d.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  <span className="line-clamp-2 max-w-md">
                    {d.work_narrative ?? "-"}
                  </span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {d.crew_count ?? "-"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {d.total_man_hours ?? "-"}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {d.submitted_at ? formatDate(d.submitted_at) : "-"}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-6 text-center text-xs text-muted-foreground"
                >
                  No DPRs submitted yet. Click &quot;Submit DPR&quot; to file the first one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
