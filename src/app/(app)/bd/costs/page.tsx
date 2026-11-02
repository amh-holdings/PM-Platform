import Link from "next/link";

import {
  COST_CATEGORIES,
  COST_CATEGORY_LABEL,
  dollarsPerWatt,
  formatPerWatt,
  rollUpCostLines,
} from "@/lib/bd";
import { bdClient } from "@/lib/bd-db";
import { loadPipeline, oppLite } from "@/lib/bd-load";
import { formatCurrency, formatDate } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { Card, Empty, TextLink, tdClass, thClass } from "../_components/fields";

// What AHC quoted, by category, bid by bid. Sell prices off the bid forms, so
// profit and overhead sit inside the lines on most of them (0081).
export default async function BdCostsPage({ searchParams }: { searchParams: { view?: string } }) {
  const view = searchParams.view === "perw" ? "perw" : "dollars";
  const data = await loadPipeline();
  const { data: lines } = await bdClient(createClient())
    .from("bd_bid_cost_lines")
    .select("*")
    .order("source_row");

  const oppById = new Map(data.opps.map((o) => [o.id, o]));
  const rows = data.bids
    .map((bid) => {
      const own = (lines ?? []).filter((l) => l.bid_id === bid.id);
      const opp = oppById.get(bid.opportunity_id);
      return {
        bid,
        opp,
        own,
        client: opp ? data.companyName.get(opp.company_id) ?? "-" : "-",
        size: opp ? oppLite(opp).size_mw_dc : null,
        rollup: rollUpCostLines(own),
      };
    })
    .filter((r) => r.own.length > 0)
    .sort((a, b) => a.client.localeCompare(b.client) || a.bid.submitted_on.localeCompare(b.bid.submitted_on));

  const cell = (amount: number, size: number | null) =>
    view === "dollars" ? formatCurrency(amount) : formatPerWatt(dollarsPerWatt(amount, size));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Costs</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Sell prices from the bid forms, not what the work cost. Profit and overhead sit inside the lines on
            most forms, so OH&amp;P shows $0 there. Equipment scope differs by bid; check it before comparing
            Electrical.
          </p>
        </div>
        <div className="flex rounded-md border p-0.5 text-sm">
          {[
            { v: "dollars", label: "Dollars" },
            { v: "perw", label: "$/W" },
          ].map((o) => (
            <Link
              key={o.v}
              href={`/bd/costs?view=${o.v}`}
              className={cn(
                "rounded px-3 py-1",
                view === o.v ? "bg-foreground text-background" : "text-muted-foreground",
              )}
            >
              {o.label}
            </Link>
          ))}
        </div>
      </div>

      <Card>
        {rows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className={thClass}>Project</th>
                  <th className={thClass}>Client</th>
                  <th className={thClass}>Bid date</th>
                  <th className={cn(thClass, "text-right")}>MW DC</th>
                  {COST_CATEGORIES.map((c) => (
                    <th key={c} className={cn(thClass, "text-right")}>
                      {COST_CATEGORY_LABEL[c]}
                    </th>
                  ))}
                  <th className={cn(thClass, "text-right")}>Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ bid, opp, client, size, rollup }) => {
                  const differs = Math.abs(rollup.total - bid.price) > 1;
                  return (
                    <tr key={bid.id} className="border-b last:border-0">
                      <td className={tdClass}>
                        {opp ? <TextLink href={`/bd/opportunities/${opp.id}`}>{opp.name}</TextLink> : "-"}
                      </td>
                      <td className={tdClass}>{client}</td>
                      <td className={cn(tdClass, "whitespace-nowrap")}>{formatDate(bid.submitted_on)}</td>
                      <td className={cn(tdClass, "text-right tabular-nums")}>{size ?? "-"}</td>
                      {COST_CATEGORIES.map((c) => (
                        <td key={c} className={cn(tdClass, "text-right tabular-nums")}>
                          {cell(rollup.byCategory[c], size)}
                        </td>
                      ))}
                      <td className={cn(tdClass, "text-right font-medium tabular-nums")}>
                        {cell(rollup.total, size)}
                        {differs && (
                          <div className="text-xs font-normal text-destructive">
                            Bid record: {formatCurrency(bid.price)}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No bid forms loaded yet.</Empty>
        )}
      </Card>

      {rows.length > 0 && (
        <Card title="Lines behind each number">
          <div className="space-y-2">
            {rows.map(({ bid, opp, own, size }) => (
              <details key={bid.id} className="rounded-md border p-3">
                <summary className="cursor-pointer text-sm font-medium">{opp?.name ?? "-"}</summary>
                <p className="mt-2 text-xs text-muted-foreground">Source: {own[0]?.source_file}</p>
                {COST_CATEGORIES.map((c) => {
                  const list = own.filter((l) => l.category === c);
                  if (!list.length) return null;
                  return (
                    <div key={c} className="mt-3">
                      <h3 className="text-xs font-semibold uppercase text-muted-foreground">
                        {COST_CATEGORY_LABEL[c]}
                      </h3>
                      <table className="mt-1 w-full text-sm">
                        <tbody>
                          {list.map((l) => (
                            <tr key={l.id} className="border-b last:border-0">
                              <td className={tdClass}>{l.label}</td>
                              <td className={cn(tdClass, "w-24 text-right text-xs text-muted-foreground")}>
                                Row {l.source_row}
                              </td>
                              <td className={cn(tdClass, "w-32 text-right tabular-nums")}>
                                {cell(Number(l.amount), size)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  );
                })}
              </details>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
