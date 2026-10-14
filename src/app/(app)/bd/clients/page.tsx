import Link from "next/link";

import { Button } from "@/components/ui/button";
import { formatPct, isOpenStage, latestBidByOpp, winRate } from "@/lib/bd";
import { loadPipeline, oppLite } from "@/lib/bd-load";
import { formatCurrency, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Card, Empty, TextLink, tdClass, thClass } from "../_components/fields";

export default async function ClientsPage() {
  const data = await loadPipeline();
  const latest = latestBidByOpp(data.bids);

  const rows = data.companies.map((c) => {
    const opps = data.opps.filter((o) => o.company_id === c.id);
    return {
      c,
      open: opps.filter((o) => isOpenStage(o.stage)).length,
      wr: winRate(opps.map(oppLite), latest),
      last: data.lastTouchByCompany.get(c.id) ?? null,
    };
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Clients</h1>
          <p className="text-sm text-muted-foreground">{rows.length} clients</p>
        </div>
        <Button asChild size="sm">
          <Link href="/bd/clients/new">New client</Link>
        </Button>
      </div>
      <Card>
        {rows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className={thClass}>Client</th>
                  <th className={thClass}>Type</th>
                  <th className={cn(thClass, "text-right")}>Open</th>
                  <th className={cn(thClass, "text-right")}>Won / Lost</th>
                  <th className={cn(thClass, "text-right")}>Win rate</th>
                  <th className={cn(thClass, "text-right")}>$ won</th>
                  <th className={thClass}>Last touch</th>
                  <th className={thClass}>Owner</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ c, open, wr, last }) => (
                  <tr key={c.id} className="border-b last:border-0">
                    <td className={tdClass}>
                      <TextLink href={`/bd/clients/${c.id}`}>{c.name}</TextLink>
                      {c.state && <div className="text-xs text-muted-foreground">{c.state}</div>}
                    </td>
                    <td className={tdClass}>{c.company_type}</td>
                    <td className={cn(tdClass, "text-right tabular-nums")}>{open}</td>
                    <td className={cn(tdClass, "text-right tabular-nums")}>
                      {wr.won} / {wr.lost}
                    </td>
                    <td className={cn(tdClass, "text-right tabular-nums")}>{formatPct(wr.rateCount)}</td>
                    <td className={cn(tdClass, "text-right tabular-nums")}>
                      {wr.wonDollars ? formatCurrency(wr.wonDollars) : "-"}
                    </td>
                    <td className={cn(tdClass, "whitespace-nowrap")}>{formatDate(last)}</td>
                    <td className={tdClass}>{c.owner_id ? data.personName.get(c.owner_id) ?? "-" : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>
            No clients yet. <TextLink href="/bd/clients/new">Add the first one</TextLink>.
          </Empty>
        )}
      </Card>
    </div>
  );
}
