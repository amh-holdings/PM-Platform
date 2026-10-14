import Link from "next/link";

import {
  EQUIPMENT_LABEL,
  LOSS_REASON_LABEL,
  dollarsPerWatt,
  firstBidDateByOpp,
  formatCompactUsd,
  formatPct,
  formatPerWatt,
  isOpenStage,
  latestBidByOpp,
  lossReasonMix,
  medianCycleDays,
  pipeline,
  queueBucket,
  todayIso,
  winRate,
} from "@/lib/bd";
import { loadPipeline, oppLite } from "@/lib/bd-load";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Card, Empty, TextLink, tdClass, thClass } from "../_components/fields";

export default async function BdDashboardPage({ searchParams }: { searchParams: { year?: string } }) {
  const data = await loadPipeline();
  const today = todayIso();
  const thisYear = today.slice(0, 4);
  const year = searchParams.year ?? thisYear;
  const inYear = (d: string | null) => year === "all" || (!!d && d.startsWith(year));

  const latest = latestBidByOpp(data.bids);
  const lites = data.opps.map(oppLite);
  // Win rate counts jobs DECIDED in the year, whenever they were bid.
  const decided = lites.filter((o) => (o.stage === "won" || o.stage === "lost") && inYear(o.outcome_date));
  const wr = winRate(decided, latest);
  const pipe = pipeline(lites, latest);
  const cycle = medianCycleDays(decided, firstBidDateByOpp(data.bids));
  const losses = lossReasonMix(decided);
  const maxLoss = Math.max(1, ...losses.map((l) => l.count));
  const bidsInYear = data.bids.filter((b) => inYear(b.submitted_on));

  const years = Array.from(
    new Set([
      thisYear,
      ...data.opps.map((o) => o.outcome_date?.slice(0, 4)).filter((y): y is string => !!y),
      ...data.bids.map((b) => b.submitted_on.slice(0, 4)),
    ]),
  ).sort((a, b) => b.localeCompare(a));

  // Follow-up health per owner, open work only.
  const health = [...data.people, { id: "", name: "Unassigned" }]
    .map((p) => {
      const open = lites.filter((o) => isOpenStage(o.stage) && (o.owner_id ?? "") === p.id);
      return {
        p,
        open: open.length,
        overdue: open.filter((o) => queueBucket(o.next_follow_up_date, today) === "overdue").length,
        week: open.filter((o) => ["today", "week"].includes(queueBucket(o.next_follow_up_date, today))).length,
      };
    })
    .filter((r) => r.open > 0 || r.p.id);

  const byClient = data.companies
    .map((c) => ({
      c,
      wr: winRate(
        decided.filter((o) => o.company_id === c.id),
        latest,
      ),
      bids: new Set(bidsInYear.filter((b) => data.opps.find((o) => o.id === b.opportunity_id)?.company_id === c.id).map((b) => b.opportunity_id)).size,
    }))
    .filter((r) => r.wr.won + r.wr.lost > 0 || r.bids > 0)
    .sort((a, b) => b.wr.wonDollars - a.wr.wonDollars || b.bids - a.bids);

  // $/W by quarter and equipment basis. Owner-furnished and EPC-furnished
  // prices are different animals, so they never share an average.
  const sizeById = new Map(lites.map((o) => [o.id, o.size_mw_dc]));
  const perWatt = new Map<string, { sum: number; n: number }>();
  for (const b of bidsInYear) {
    const w = dollarsPerWatt(b.price, sizeById.get(b.opportunity_id) ?? null);
    if (w === null) continue;
    const q = `${b.submitted_on.slice(0, 4)} Q${Math.floor((Number(b.submitted_on.slice(5, 7)) - 1) / 3) + 1}`;
    const key = `${q}|${b.equipment_basis}`;
    const cur = perWatt.get(key) ?? { sum: 0, n: 0 };
    perWatt.set(key, { sum: cur.sum + w, n: cur.n + 1 });
  }
  const perWattRows = Array.from(perWatt.entries())
    .map(([k, v]) => {
      const [quarter, basis] = k.split("|");
      return { quarter, basis, avg: v.sum / v.n, n: v.n };
    })
    .sort((a, b) => b.quarter.localeCompare(a.quarter) || a.basis.localeCompare(b.basis));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">BD dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Win rate counts jobs decided in the period. No-bids and dead jobs are left out.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-sm">
          {[...years, "all"].map((y) => (
            <Link
              key={y}
              href={`/bd/dashboard?year=${y}`}
              className={cn(
                "rounded-full border px-3 py-1",
                year === y ? "border-foreground bg-foreground text-background" : "text-muted-foreground",
              )}
            >
              {y === "all" ? "All time" : y}
            </Link>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Tile label="Win rate (count)" value={formatPct(wr.rateCount)} sub={`${wr.won} won of ${wr.won + wr.lost} decided`} />
        <Tile
          label="Win rate ($)"
          value={formatPct(wr.rateDollars)}
          sub={`${formatCompactUsd(wr.wonDollars)} of ${formatCompactUsd(wr.decidedDollars)}`}
        />
        <Tile label="Open pipeline" value={formatCompactUsd(pipe.total)} sub={`${pipe.count} open`} />
        <Tile label="Weighted pipeline" value={formatCompactUsd(pipe.weighted)} sub="value x win probability" />
        <Tile label="Bid to decision" value={cycle === null ? "-" : `${cycle} days`} sub="median, first bid to result" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Follow-up health">
          {health.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className={thClass}>Owner</th>
                  <th className={cn(thClass, "text-right")}>Open</th>
                  <th className={cn(thClass, "text-right")}>Overdue</th>
                  <th className={cn(thClass, "text-right")}>Due in 7 days</th>
                </tr>
              </thead>
              <tbody>
                {health.map((r) => (
                  <tr key={r.p.id || "none"} className="border-b last:border-0">
                    <td className={tdClass}>{r.p.name}</td>
                    <td className={cn(tdClass, "text-right tabular-nums")}>{r.open}</td>
                    <td className={cn(tdClass, "text-right tabular-nums", r.overdue > 0 && "font-semibold text-destructive")}>
                      {r.overdue}
                    </td>
                    <td className={cn(tdClass, "text-right tabular-nums")}>{r.week}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No open work.</Empty>
          )}
        </Card>

        <Card title="Why we lost">
          {losses.length ? (
            <ul className="space-y-2 text-sm">
              {losses.map((l) => (
                <li key={l.reason} className="grid grid-cols-[10rem_1fr_2rem] items-center gap-3">
                  <span>{LOSS_REASON_LABEL[l.reason]}</span>
                  <span className="h-2 rounded-full bg-muted">
                    <span
                      className="block h-2 rounded-full bg-foreground/70"
                      style={{ width: `${(l.count / maxLoss) * 100}%` }}
                    />
                  </span>
                  <span className="text-right tabular-nums">{l.count}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No losses recorded in this period.</Empty>
          )}
        </Card>
      </div>

      <Card title="By client">
        {byClient.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className={thClass}>Client</th>
                  <th className={cn(thClass, "text-right")}>Jobs bid</th>
                  <th className={cn(thClass, "text-right")}>Won / Lost</th>
                  <th className={cn(thClass, "text-right")}>Win rate</th>
                  <th className={cn(thClass, "text-right")}>Win rate ($)</th>
                  <th className={cn(thClass, "text-right")}>$ won</th>
                </tr>
              </thead>
              <tbody>
                {byClient.map(({ c, wr: cw, bids }) => (
                  <tr key={c.id} className="border-b last:border-0">
                    <td className={tdClass}>
                      <TextLink href={`/bd/clients/${c.id}`}>{c.name}</TextLink>
                    </td>
                    <td className={cn(tdClass, "text-right tabular-nums")}>{bids}</td>
                    <td className={cn(tdClass, "text-right tabular-nums")}>
                      {cw.won} / {cw.lost}
                    </td>
                    <td className={cn(tdClass, "text-right tabular-nums")}>{formatPct(cw.rateCount)}</td>
                    <td className={cn(tdClass, "text-right tabular-nums")}>{formatPct(cw.rateDollars)}</td>
                    <td className={cn(tdClass, "text-right tabular-nums")}>
                      {cw.wonDollars ? formatCurrency(cw.wonDollars) : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No bids or decisions in this period.</Empty>
        )}
      </Card>

      <Card title="Bid $/W by quarter">
        {perWattRows.length ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className={thClass}>Quarter</th>
                <th className={thClass}>Equipment basis</th>
                <th className={cn(thClass, "text-right")}>Bids</th>
                <th className={cn(thClass, "text-right")}>Average $/W DC</th>
              </tr>
            </thead>
            <tbody>
              {perWattRows.map((r) => (
                <tr key={`${r.quarter}${r.basis}`} className="border-b last:border-0">
                  <td className={tdClass}>{r.quarter}</td>
                  <td className={tdClass}>{EQUIPMENT_LABEL[r.basis as keyof typeof EQUIPMENT_LABEL] ?? r.basis}</td>
                  <td className={cn(tdClass, "text-right tabular-nums")}>{r.n}</td>
                  <td className={cn(tdClass, "text-right tabular-nums")}>{formatPerWatt(r.avg)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No bids with a project size in this period.</Empty>
        )}
      </Card>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}
