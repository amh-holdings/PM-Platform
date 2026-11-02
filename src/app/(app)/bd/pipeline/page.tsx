import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  COST_CATEGORIES,
  COST_CATEGORY_LABEL,
  OPEN_STAGES,
  STAGE_LABEL,
  dollarsPerWatt,
  formatCompactUsd,
  formatPerWatt,
  isOpenStage,
  latestBidByOpp,
  opportunityValue,
  pipeline,
  probabilityOf,
  rollUpCostLines,
  type BdStage,
} from "@/lib/bd";
import { bdClient, ownerLabel } from "@/lib/bd-db";
import { loadPipeline, oppLite } from "@/lib/bd-load";
import { formatCurrency, formatDate } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { Card, Empty, StagePill, TextLink, tdClass, thClass } from "../_components/fields";

const VIEWS = [
  { v: "open", label: "Open" },
  { v: "won", label: "Won" },
  { v: "lost", label: "Lost" },
  { v: "closed", label: "All closed" },
  { v: "all", label: "Everything" },
] as const;

export default async function PipelinePage({
  searchParams,
}: {
  searchParams: { view?: string; owner?: string; breakdown?: string };
}) {
  const data = await loadPipeline();
  const view = searchParams.view ?? "open";
  const owner = searchParams.owner ?? "";
  const showBreakdown = searchParams.breakdown === "1";
  const latest = latestBidByOpp(data.bids);

  const rows = data.opps.filter((o) => {
    if (owner && o.bd_owner_id !== owner) return false;
    if (view === "open") return isOpenStage(o.stage);
    if (view === "won") return o.stage === "won";
    if (view === "lost") return o.stage === "lost";
    if (view === "closed") return !isOpenStage(o.stage);
    return true;
  });
  // Open work reads in pipeline order; closed work reads newest first.
  const stageOrder = (s: string) => {
    const i = (OPEN_STAGES as readonly string[]).indexOf(s);
    return i === -1 ? 99 : -i;
  };
  if (view === "open") rows.sort((a, b) => stageOrder(a.stage) - stageOrder(b.stage));

  const totals = pipeline(rows.map(oppLite), latest);
  const { data: costLines } = showBreakdown
    ? await bdClient(createClient()).from("bd_bid_cost_lines").select("bid_id, category, amount")
    : { data: null };
  const href = (patch: { view?: string; owner?: string; breakdown?: string }) => {
    const q = new URLSearchParams({ view, owner, breakdown: showBreakdown ? "1" : "", ...patch });
    if (!q.get("owner")) q.delete("owner");
    if (!q.get("breakdown")) q.delete("breakdown");
    return `/bd/pipeline?${q.toString()}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Pipeline</h1>
          <p className="text-sm text-muted-foreground">
            {rows.length} {rows.length === 1 ? "opportunity" : "opportunities"}
            {view === "open" &&
              ` - ${formatCompactUsd(totals.total)} open, ${formatCompactUsd(totals.weighted)} weighted`}
          </p>
        </div>
        <Button asChild size="sm">
          <Link href="/bd/opportunities/new">New opportunity</Link>
        </Button>
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        {VIEWS.map((o) => (
          <Link
            key={o.v}
            href={href({ view: o.v })}
            className={cn(
              "rounded-full border px-3 py-1",
              view === o.v ? "border-foreground bg-foreground text-background" : "text-muted-foreground",
            )}
          >
            {o.label}
          </Link>
        ))}
        <span className="mx-1 self-center text-muted-foreground">|</span>
        {[{ id: "", name: "All owners" }, ...data.owners].map((p) => (
          <Link
            key={p.id || "all"}
            href={href({ owner: p.id })}
            className={cn(
              "rounded-full border px-3 py-1",
              owner === p.id ? "border-foreground bg-foreground text-background" : "text-muted-foreground",
            )}
          >
            {p.name}
          </Link>
        ))}
        <span className="mx-1 self-center text-muted-foreground">|</span>
        <Link
          href={href({ breakdown: showBreakdown ? "" : "1" })}
          className={cn(
            "rounded-full border px-3 py-1",
            showBreakdown ? "border-foreground bg-foreground text-background" : "text-muted-foreground",
          )}
        >
          Price breakdown
        </Link>
      </div>

      <Card>
        {rows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className={thClass}>Opportunity</th>
                  <th className={thClass}>Client</th>
                  <th className={thClass}>Stage</th>
                  <th className={cn(thClass, "text-right")}>MW DC</th>
                  <th className={cn(thClass, "text-right")}>Latest bid</th>
                  <th className={cn(thClass, "text-right")}>$/W</th>
                  {showBreakdown &&
                    COST_CATEGORIES.map((c) => (
                      <th key={c} className={cn(thClass, "text-right")}>
                        {COST_CATEGORY_LABEL[c]}
                      </th>
                    ))}
                  <th className={cn(thClass, "text-right")}>Prob.</th>
                  <th className={thClass}>{view === "open" ? "Follow up" : "Decided"}</th>
                  <th className={thClass}>Owner</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => {
                  const lite = oppLite(o);
                  const bid = latest.get(o.id);
                  const value = opportunityValue(lite, bid);
                  const own = bid ? (costLines ?? []).filter((l) => l.bid_id === bid.id) : [];
                  const parts = rollUpCostLines(own).byCategory;
                  return (
                    <tr key={o.id} className="border-b last:border-0">
                      <td className={tdClass}>
                        <TextLink href={`/bd/opportunities/${o.id}`}>{o.name}</TextLink>
                        {o.state && <div className="text-xs text-muted-foreground">{o.state}</div>}
                      </td>
                      <td className={tdClass}>
                        <TextLink href={`/bd/clients/${o.company_id}`}>
                          {data.companyName.get(o.company_id) ?? "-"}
                        </TextLink>
                      </td>
                      <td className={tdClass}>
                        <StagePill stage={o.stage} label={STAGE_LABEL[o.stage as BdStage] ?? o.stage} />
                      </td>
                      <td className={cn(tdClass, "text-right tabular-nums")}>{lite.size_mw_dc ?? "-"}</td>
                      <td className={cn(tdClass, "text-right tabular-nums")}>
                        {bid ? formatCurrency(bid.price) : value !== null ? `est. ${formatCompactUsd(value)}` : "-"}
                      </td>
                      <td className={cn(tdClass, "text-right tabular-nums")}>
                        {formatPerWatt(bid ? dollarsPerWatt(bid.price, lite.size_mw_dc) : null)}
                      </td>
                      {showBreakdown &&
                        COST_CATEGORIES.map((c) => (
                          <td key={c} className={cn(tdClass, "text-right tabular-nums")}>
                            {own.length ? formatCurrency(parts[c]) : "-"}
                          </td>
                        ))}
                      <td className={cn(tdClass, "text-right tabular-nums")}>
                        {isOpenStage(o.stage) ? `${probabilityOf(lite)}%` : "-"}
                      </td>
                      <td className={cn(tdClass, "whitespace-nowrap")}>
                        {formatDate(isOpenStage(o.stage) ? o.next_follow_up_date : o.outcome_date)}
                      </td>
                      <td className={tdClass}>{ownerLabel(o.bd_owner_id, data.ownerName)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>
            No opportunities in this view. <TextLink href="/bd/opportunities/new">Add one</TextLink>.
          </Empty>
        )}
      </Card>
    </div>
  );
}
