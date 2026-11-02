import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  ACCOUNT_STAGE_LABEL,
  daysBetween,
  isOpenStage,
  isPursued,
  todayIso,
  type AccountStage,
} from "@/lib/bd";
import { ownerLabel } from "@/lib/bd-db";
import { loadPipeline } from "@/lib/bd-load";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Card, Empty, StagePill, TextLink, tdClass, thClass } from "../_components/fields";

const TIERS = [
  { v: "active", label: "Active" },
  { v: "prospect", label: "Prospects" },
  { v: "all", label: "All" },
];

// The weekly tracker, in the platform: one row per account, soonest due first.
// Not Pursuing sinks to the bottom.
export default async function ClientsPage({
  searchParams,
}: {
  searchParams: { tier?: string; owner?: string };
}) {
  const data = await loadPipeline();
  const today = todayIso();
  const tier = searchParams.tier ?? "active";
  const ownerFilter = searchParams.owner ?? "all";

  const all = data.companies.map((c) => ({
    c,
    owner: ownerLabel(c.bd_owner_id, data.ownerName),
    open: data.opps.filter((o) => o.company_id === c.id && isOpenStage(o.stage)).length,
    last: data.lastTouchByCompany.get(c.id) ?? null,
  }));
  const owners = Array.from(new Set(all.map((r) => r.owner).filter((o) => o !== "-"))).sort();
  const rows = all
    .filter((r) => tier === "all" || r.c.tier === tier)
    .filter((r) => ownerFilter === "all" || r.owner === ownerFilter)
    .sort((a, b) => {
      const pa = isPursued(a.c.relationship_stage) ? 0 : 1;
      const pb = isPursued(b.c.relationship_stage) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return (a.c.next_touch_date ?? "9999").localeCompare(b.c.next_touch_date ?? "9999") ||
        a.c.name.localeCompare(b.c.name);
    });
  const overdue = rows.filter(
    (r) => isPursued(r.c.relationship_stage) && r.c.next_touch_date && r.c.next_touch_date < today,
  ).length;

  const href = (t: string, o: string) => `/bd/clients?tier=${t}&owner=${encodeURIComponent(o)}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Clients</h1>
          <p className="text-sm text-muted-foreground">
            {rows.length} {rows.length === 1 ? "account" : "accounts"}
            {overdue > 0 && <span className="text-destructive">, {overdue} overdue</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border p-0.5 text-sm">
            {TIERS.map((t) => (
              <Link
                key={t.v}
                href={href(t.v, ownerFilter)}
                className={cn(
                  "rounded px-3 py-1",
                  tier === t.v ? "bg-foreground text-background" : "text-muted-foreground",
                )}
              >
                {t.label}
              </Link>
            ))}
          </div>
          <div className="flex rounded-md border p-0.5 text-sm">
            {["all", ...owners].map((o) => (
              <Link
                key={o}
                href={href(tier, o)}
                className={cn(
                  "rounded px-3 py-1",
                  ownerFilter === o ? "bg-foreground text-background" : "text-muted-foreground",
                )}
              >
                {o === "all" ? "Everyone" : o}
              </Link>
            ))}
          </div>
          <Button asChild size="sm">
            <Link href="/bd/clients/new">New client</Link>
          </Button>
        </div>
      </div>
      <Card>
        {rows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className={thClass}>Client</th>
                  <th className={thClass}>Stage</th>
                  <th className={thClass}>Next step</th>
                  <th className={thClass}>Due</th>
                  <th className={thClass}>Last touch</th>
                  <th className={thClass}>Owner</th>
                  <th className={cn(thClass, "text-right")}>Open bids</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ c, owner, open, last }) => {
                  const pursued = isPursued(c.relationship_stage);
                  const late = pursued && c.next_touch_date ? daysBetween(c.next_touch_date, today) : 0;
                  return (
                    <tr key={c.id} className={cn("border-b last:border-0", !pursued && "text-muted-foreground")}>
                      <td className={tdClass}>
                        <TextLink href={`/bd/clients/${c.id}`}>{c.name}</TextLink>
                        {c.state && <div className="text-xs text-muted-foreground">{c.state}</div>}
                      </td>
                      <td className={tdClass}>
                        <StagePill
                          stage={pursued ? "lead" : "dead"}
                          label={ACCOUNT_STAGE_LABEL[c.relationship_stage as AccountStage] ?? c.relationship_stage}
                        />
                      </td>
                      <td className={cn(tdClass, "max-w-xs")}>{c.next_step ?? "-"}</td>
                      <td className={cn(tdClass, "whitespace-nowrap", late > 0 && "font-medium text-destructive")}>
                        {pursued ? formatDate(c.next_touch_date) : "-"}
                        {late > 0 && <span className="ml-1 text-xs">({late}d late)</span>}
                      </td>
                      <td className={cn(tdClass, "whitespace-nowrap")}>{last ? formatDate(last) : "Never"}</td>
                      <td className={tdClass}>{owner}</td>
                      <td className={cn(tdClass, "text-right tabular-nums")}>{open || "-"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>
            No clients here. <TextLink href="/bd/clients/new">Add one</TextLink>.
          </Empty>
        )}
      </Card>
    </div>
  );
}
