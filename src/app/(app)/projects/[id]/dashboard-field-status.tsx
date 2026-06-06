import Link from "next/link";

import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/format";

type Props = {
  projectId: string;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const STALE_RFI_DAYS = 7;
const SUBMITTAL_LOOKAHEAD_DAYS = 14;

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function isoDaysAhead(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function DashboardFieldStatus({ projectId }: Props) {
  const supabase = createClient();

  const lastDprWindow = isoDaysAgo(30);
  const staleRfiCutoff = isoDaysAgo(STALE_RFI_DAYS);
  const submittalCutoff = isoDaysAhead(SUBMITTAL_LOOKAHEAD_DAYS);

  const [
    openRfisRes,
    staleRfisRes,
    pendingSubmittalsRes,
    blockingSubmittalsRes,
    lastDprRes,
    missingDprRes,
  ] = await Promise.all([
    supabase
      .from("rfis")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId)
      .neq("status", "closed"),
    supabase
      .from("rfis")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId)
      .neq("status", "closed")
      .lte("date_issued", staleRfiCutoff),
    supabase
      .from("submittals")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId)
      .eq("status", "pending"),
    supabase
      .from("rfis")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId)
      .neq("status", "closed")
      .not("date_needed", "is", null)
      .lte("date_needed", submittalCutoff),
    supabase
      .from("dprs")
      .select("report_date, status")
      .eq("project_id", projectId)
      .gte("report_date", lastDprWindow)
      .order("report_date", { ascending: false })
      .limit(1),
    supabase
      .from("dprs")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId)
      .eq("status", "submitted"),
  ]);

  const openRfis = openRfisRes.count ?? 0;
  const staleRfis = staleRfisRes.count ?? 0;
  const pendingSubmittals = pendingSubmittalsRes.count ?? 0;
  const blockingRfis = blockingSubmittalsRes.count ?? 0;
  const lastDpr = lastDprRes.data?.[0] ?? null;
  const pendingDprApprovals = missingDprRes.count ?? 0;

  const lastDprMs = lastDpr ? Date.parse(lastDpr.report_date) : null;
  const daysSinceLastDpr =
    lastDprMs != null
      ? Math.floor((Date.now() - lastDprMs) / ONE_DAY_MS)
      : null;
  const dprTone =
    daysSinceLastDpr == null
      ? "text-destructive"
      : daysSinceLastDpr <= 1
        ? "text-emerald-600"
        : daysSinceLastDpr <= 3
          ? "text-amber-600"
          : "text-destructive";

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Field status</h2>
          <p className="text-xs text-muted-foreground">
            Open items that drive or block the day
          </p>
        </div>
        <Link
          href={`/projects/${projectId}/dprs`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          DPRs &rarr;
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded border bg-muted/30 px-3 py-2">
          <div className="text-muted-foreground">Last DPR</div>
          <div className={cn("text-base font-semibold", dprTone)}>
            {lastDpr ? formatDate(lastDpr.report_date) : "None in 30 days"}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {daysSinceLastDpr == null
              ? "Crew may not be reporting"
              : daysSinceLastDpr === 0
                ? "today"
                : `${daysSinceLastDpr}d ago - ${lastDpr?.status ?? ""}`}
          </div>
        </div>
        <div className="rounded border bg-muted/30 px-3 py-2">
          <div className="text-muted-foreground">DPRs awaiting review</div>
          <div
            className={cn(
              "text-base font-semibold",
              pendingDprApprovals > 0 ? "text-amber-600" : "text-muted-foreground",
            )}
          >
            {pendingDprApprovals}
          </div>
          <div className="text-[10px] text-muted-foreground">
            submitted, not yet approved
          </div>
        </div>
        <div className="rounded border bg-muted/30 px-3 py-2">
          <div className="text-muted-foreground">Open RFIs</div>
          <div
            className={cn(
              "text-base font-semibold",
              staleRfis > 0 ? "text-destructive" : openRfis > 0 ? "text-amber-600" : "text-emerald-600",
            )}
          >
            {openRfis}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {staleRfis} over {STALE_RFI_DAYS}d, {blockingRfis} needed in {SUBMITTAL_LOOKAHEAD_DAYS}d
          </div>
        </div>
        <div className="rounded border bg-muted/30 px-3 py-2">
          <div className="text-muted-foreground">Pending submittals</div>
          <div
            className={cn(
              "text-base font-semibold",
              pendingSubmittals > 0 ? "text-amber-600" : "text-emerald-600",
            )}
          >
            {pendingSubmittals}
          </div>
          <div className="text-[10px] text-muted-foreground">
            awaiting owner / EOR review
          </div>
        </div>
      </div>
    </section>
  );
}
