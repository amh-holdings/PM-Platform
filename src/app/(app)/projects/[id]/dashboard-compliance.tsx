import Link from "next/link";

import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/server";

import { STATUS_TONE, statusLabel } from "./subs-constants";

type Props = {
  projectId: string;
};

function dotTone(status: string | null | undefined): string {
  if (!status) return "bg-muted";
  const tone = STATUS_TONE[status];
  if (!tone) return "bg-muted";
  if (status === "received") return "bg-emerald-500";
  if (status === "pending" || status === "expiring") return "bg-amber-500";
  if (status === "expired") return "bg-destructive";
  return "bg-muted-foreground/60";
}

export async function DashboardCompliance({ projectId }: Props) {
  const supabase = createClient();

  const { data: subs, error } = await supabase
    .from("subcontractors")
    .select("id, company_name, trade, coi_status, w9_status, active")
    .eq("project_id", projectId)
    .eq("active", true)
    .order("company_name");

  if (error) {
    return (
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h2 className="text-sm font-semibold">Compliance</h2>
        <p className="mt-2 text-xs text-destructive">
          Failed to load: {error.message}
        </p>
      </section>
    );
  }

  const rows = subs ?? [];
  const coiReceived = rows.filter((s) => s.coi_status === "received").length;
  const w9Received = rows.filter((s) => s.w9_status === "received").length;
  const totalSubs = rows.length;

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Compliance</h2>
          <p className="text-xs text-muted-foreground">
            COI and W9 status per active sub
          </p>
        </div>
        <Link
          href={`/projects/${projectId}/subs`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          View all &rarr;
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded border bg-muted/30 px-3 py-2">
          <div className="text-muted-foreground">COI received</div>
          <div className="text-base font-semibold">
            {coiReceived}/{totalSubs}
          </div>
        </div>
        <div className="rounded border bg-muted/30 px-3 py-2">
          <div className="text-muted-foreground">W9 received</div>
          <div className="text-base font-semibold">
            {w9Received}/{totalSubs}
          </div>
        </div>
      </div>

      {totalSubs === 0 ? (
        <p className="text-xs text-muted-foreground">No active subs.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[360px] text-xs">
            <thead className="text-muted-foreground">
              <tr className="border-b">
                <th className="py-1.5 pr-2 text-left font-medium">Sub</th>
                <th className="py-1.5 pr-2 text-left font-medium">COI</th>
                <th className="py-1.5 text-left font-medium">W9</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className="border-b last:border-0">
                  <td className="py-1.5 pr-2">
                    <div className="truncate font-medium">{s.company_name}</div>
                    {s.trade && (
                      <div className="truncate text-[10px] text-muted-foreground">
                        {s.trade}
                      </div>
                    )}
                  </td>
                  <td className="py-1.5 pr-2">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5",
                        STATUS_TONE[s.coi_status ?? ""] ?? "bg-muted",
                      )}
                    >
                      <span
                        className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          dotTone(s.coi_status),
                        )}
                      />
                      {statusLabel(s.coi_status)}
                    </span>
                  </td>
                  <td className="py-1.5">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5",
                        STATUS_TONE[s.w9_status ?? ""] ?? "bg-muted",
                      )}
                    >
                      <span
                        className={cn(
                          "h-1.5 w-1.5 rounded-full",
                          dotTone(s.w9_status),
                        )}
                      />
                      {statusLabel(s.w9_status)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
