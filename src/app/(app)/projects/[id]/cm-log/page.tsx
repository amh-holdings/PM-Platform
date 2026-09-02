import Link from "next/link";

import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";
import { guardCapability } from "@/lib/roles-server";
import { formatDate } from "@/lib/format";

type Params = { id: string };

export default async function CmLogListPage({ params }: { params: Params }) {
  await guardCapability("viewAllReports");
  const supabase = createClient();

  const [logsRes, photosRes] = await Promise.all([
    supabase
      .from("cm_daily_logs")
      .select(
        "id, status, log_date, weather_conditions, progress_summary, site_conditions, ahc_headcount, ahc_man_hours",
      )
      .eq("project_id", params.id)
      .order("log_date", { ascending: false }),
    supabase
      .from("cm_daily_log_photos")
      .select("id, cm_daily_log_id"),
  ]);

  if (logsRes.error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        Failed to load daily logs: {logsRes.error.message}
      </div>
    );
  }

  const rows = logsRes.data ?? [];
  const logIds = new Set(rows.map((r) => r.id));
  const photoCount = new Map<string, number>();
  for (const p of photosRes.data ?? []) {
    if (!logIds.has(p.cm_daily_log_id)) continue;
    photoCount.set(
      p.cm_daily_log_id,
      (photoCount.get(p.cm_daily_log_id) ?? 0) + 1,
    );
  }

  const missingAhc = rows.filter(
    (r) => r.status === "final" && (r.ahc_headcount == null || r.ahc_man_hours == null),
  );

  return (
    <div className="space-y-6">
      {missingAhc.length > 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          <p className="font-medium">
            {missingAhc.length} finalized log
            {missingAhc.length === 1 ? "" : "s"} have no AHC hours on them.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            These were filed before AHC staff hours were required, so the
            owner&apos;s monthly manpower report reads short for those months.
            Reopen each one, enter the headcount and hours, and finalize again.
            Newest first:{" "}
            {missingAhc.slice(0, 12).map((r, i) => (
              <span key={r.id}>
                {i > 0 && ", "}
                <Link
                  href={`/projects/${params.id}/cm-log/${r.id}`}
                  className="underline"
                >
                  {formatDate(r.log_date)}
                </Link>
              </span>
            ))}
            {missingAhc.length > 12 && ` and ${missingAhc.length - 12} more`}.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs text-muted-foreground">
            The Construction Manager&apos;s own daily record - site conditions,
            progress, safety, and photos. One log per day.
          </p>
        </div>
        <Button asChild>
          <Link href={`/projects/${params.id}/cm-log/new`}>New Daily Log</Link>
        </Button>
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted-foreground">
            <tr className="border-b">
              <th className="px-3 py-2 text-left font-medium">Date</th>
              <th className="px-3 py-2 text-left font-medium">Status</th>
              <th className="px-3 py-2 text-left font-medium">AHC</th>
              <th className="px-3 py-2 text-left font-medium">Weather</th>
              <th className="px-3 py-2 text-left font-medium">Summary</th>
              <th className="px-3 py-2 text-left font-medium">Photos</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const summary = r.progress_summary ?? r.site_conditions ?? "";
              return (
                <tr
                  key={r.id}
                  className="border-b last:border-0 hover:bg-muted/30"
                >
                  <td className="px-3 py-2 font-medium">
                    <Link
                      href={`/projects/${params.id}/cm-log/${r.id}`}
                      className="hover:underline"
                    >
                      {formatDate(r.log_date)}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.status === "final" ? (
                      <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-600 dark:text-emerald-400">
                        Finalized
                      </span>
                    ) : (
                      <span className="rounded-full bg-amber-500/10 px-2 py-0.5 font-medium text-amber-600 dark:text-amber-400">
                        Draft
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.ahc_man_hours == null ? (
                      <span className="text-amber-600 dark:text-amber-400">
                        not entered
                      </span>
                    ) : (
                      <span className="tabular-nums">
                        {Number(r.ahc_man_hours) === 0
                          ? "none on site"
                          : `${r.ahc_man_hours} hrs`}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.weather_conditions ?? "-"}
                  </td>
                  <td className="max-w-xs truncate px-3 py-2 text-xs text-muted-foreground">
                    {summary || "-"}
                  </td>
                  <td className="px-3 py-2 text-xs tabular-nums">
                    {photoCount.get(r.id) ?? 0}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-6 text-center text-xs text-muted-foreground"
                >
                  No daily logs yet. Click &quot;New Daily Log&quot; to file the
                  first one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
