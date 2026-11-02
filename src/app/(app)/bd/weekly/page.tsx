import Link from "next/link";

import {
  ACCOUNT_STAGE_LABEL,
  ACTIVITY_LABEL,
  REVISION_LABEL,
  STAGE_LABEL,
  addDays,
  isPursued,
  mondayOf,
  todayIso,
  type AccountStage,
  type BdStage,
} from "@/lib/bd";
import { bdClient, ownerLabel } from "@/lib/bd-db";
import { loadPipeline } from "@/lib/bd-load";
import { formatCurrency, formatDate } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { Card, Empty, TextLink, tdClass, thClass } from "../_components/fields";

function stageName(stage: string, isBid: boolean): string {
  return isBid
    ? STAGE_LABEL[stage as BdStage] ?? stage
    : ACCOUNT_STAGE_LABEL[stage as AccountStage] ?? stage;
}

// What moved this week, Monday to Sunday. Replaces comparing two weekly
// spreadsheets by hand. Overdue is as of today, not as of the week shown.
export default async function BdWeeklyPage({ searchParams }: { searchParams: { week?: string } }) {
  const today = todayIso();
  const start = mondayOf(searchParams.week ?? today);
  const end = addDays(start, 6);
  const inWeek = (d: string | null | undefined) => !!d && d.slice(0, 10) >= start && d.slice(0, 10) <= end;

  const data = await loadPipeline();
  const db = bdClient(createClient());
  const [history, activities] = await Promise.all([
    db.from("bd_stage_history").select("*").order("changed_at", { ascending: false }),
    db
      .from("bd_activities")
      .select("*")
      .gte("occurred_on", start)
      .lte("occurred_on", end)
      .order("occurred_on", { ascending: false }),
  ]);

  const companyOwnerId = new Map(data.companies.map((c) => [c.id, c.bd_owner_id]));
  const oppById = new Map(data.opps.map((o) => [o.id, o]));
  const touches = activities.data ?? [];
  const moves = (history.data ?? []).filter((h) => inWeek(h.changed_at));
  const newClients = data.companies.filter((c) => inWeek(c.created_at));
  const bids = data.bids.filter((b) => inWeek(b.submitted_on));
  const overdue = data.companies.filter(
    (c) => isPursued(c.relationship_stage) && c.next_touch_date && c.next_touch_date < today,
  );

  const byOwner = [...data.owners.map((o) => ({ id: o.id, name: o.name })), { id: "", name: "Unassigned" }]
    .map((p) => {
      const mine = (companyId: string) => (companyOwnerId.get(companyId) ?? "") === p.id;
      const t = touches.filter((a) => mine(a.company_id));
      return {
        p,
        touches: t.length,
        clients: new Set(t.map((a) => a.company_id)).size,
        moves: moves.filter((m) => mine(m.company_id)).length,
        overdue: overdue.filter((c) => mine(c.id)).length,
      };
    })
    .filter((r) => r.touches + r.moves + r.overdue > 0);

  const tiles = [
    { label: "Touches", value: touches.length },
    { label: "Stage changes", value: moves.length },
    { label: "New clients", value: newClients.length },
    { label: "Bids submitted", value: bids.length },
    { label: "Accounts overdue today", value: overdue.length },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Weekly review</h1>
          <p className="text-sm text-muted-foreground">
            {formatDate(start)} to {formatDate(end)}
          </p>
        </div>
        <div className="flex gap-2 text-sm">
          <Link href={`/bd/weekly?week=${addDays(start, -7)}`} className="rounded-md border px-3 py-1">
            Previous week
          </Link>
          {end < today && (
            <Link href={`/bd/weekly?week=${addDays(start, 7)}`} className="rounded-md border px-3 py-1">
              Next week
            </Link>
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-lg border bg-card p-4 shadow-sm">
            <div className="text-xs text-muted-foreground">{t.label}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{t.value}</div>
          </div>
        ))}
      </div>

      <Card title="By owner">
        {byOwner.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className={thClass}>Owner</th>
                  <th className={cn(thClass, "text-right")}>Touches</th>
                  <th className={cn(thClass, "text-right")}>Clients touched</th>
                  <th className={cn(thClass, "text-right")}>Stage changes</th>
                  <th className={cn(thClass, "text-right")}>Overdue today</th>
                </tr>
              </thead>
              <tbody>
                {byOwner.map((r) => (
                  <tr key={r.p.id || "none"} className="border-b last:border-0">
                    <td className={tdClass}>{r.p.name}</td>
                    <td className={cn(tdClass, "text-right tabular-nums")}>{r.touches}</td>
                    <td className={cn(tdClass, "text-right tabular-nums")}>{r.clients}</td>
                    <td className={cn(tdClass, "text-right tabular-nums")}>{r.moves}</td>
                    <td className={cn(tdClass, "text-right tabular-nums", r.overdue > 0 && "font-semibold text-destructive")}>
                      {r.overdue}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Nothing moved this week.</Empty>
        )}
      </Card>

      <Card title={`Stage changes (${moves.length})`}>
        {moves.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className={thClass}>Date</th>
                  <th className={thClass}>Client</th>
                  <th className={thClass}>Bid</th>
                  <th className={thClass}>From</th>
                  <th className={thClass}>To</th>
                </tr>
              </thead>
              <tbody>
                {moves.map((m) => (
                  <tr key={m.id} className="border-b last:border-0">
                    <td className={cn(tdClass, "whitespace-nowrap")}>{formatDate(m.changed_at)}</td>
                    <td className={tdClass}>
                      <TextLink href={`/bd/clients/${m.company_id}`}>{data.companyName.get(m.company_id) ?? "-"}</TextLink>
                    </td>
                    <td className={tdClass}>
                      {m.opportunity_id ? (
                        <TextLink href={`/bd/opportunities/${m.opportunity_id}`}>
                          {oppById.get(m.opportunity_id)?.name ?? "-"}
                        </TextLink>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className={tdClass}>{stageName(m.from_stage, !!m.opportunity_id)}</td>
                    <td className={tdClass}>{stageName(m.to_stage, !!m.opportunity_id)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No stage changes this week.</Empty>
        )}
      </Card>

      <Card title={`Touches (${touches.length})`}>
        {touches.length ? (
          <ul className="space-y-3 text-sm">
            {touches.map((a) => (
              <li key={a.id} className="flex gap-3 border-b pb-3 last:border-0 last:pb-0">
                <span className="w-24 shrink-0 text-muted-foreground">{formatDate(a.occurred_on)}</span>
                <div>
                  <TextLink href={`/bd/clients/${a.company_id}`}>{data.companyName.get(a.company_id) ?? "-"}</TextLink>
                  <span className="text-muted-foreground">
                    {" - "}
                    {ACTIVITY_LABEL[a.activity_type as keyof typeof ACTIVITY_LABEL] ?? a.activity_type}
                    {" - "}
                    {ownerLabel(companyOwnerId.get(a.company_id) ?? null, data.ownerName)}
                  </span>
                  {a.notes && <p className="mt-0.5 whitespace-pre-wrap">{a.notes}</p>}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No touches logged this week.</Empty>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={`New clients (${newClients.length})`}>
          {newClients.length ? (
            <ul className="space-y-1 text-sm">
              {newClients.map((c) => (
                <li key={c.id}>
                  <TextLink href={`/bd/clients/${c.id}`}>{c.name}</TextLink>
                  <span className="text-muted-foreground"> - {ownerLabel(c.bd_owner_id, data.ownerName)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No new clients this week.</Empty>
          )}
        </Card>
        <Card title={`Bids submitted (${bids.length})`}>
          {bids.length ? (
            <ul className="space-y-1 text-sm">
              {bids.map((b) => (
                <li key={b.id}>
                  <TextLink href={`/bd/opportunities/${b.opportunity_id}`}>
                    {oppById.get(b.opportunity_id)?.name ?? "-"}
                  </TextLink>
                  <span className="text-muted-foreground">
                    {" - "}
                    {REVISION_LABEL[b.revision_type as keyof typeof REVISION_LABEL] ?? b.revision_type}
                    {" - "}
                    {formatCurrency(b.price)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No bids submitted this week.</Empty>
          )}
        </Card>
      </div>
    </div>
  );
}
