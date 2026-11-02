import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  ACCOUNT_STAGE_LABEL,
  STAGE_LABEL,
  STALE_CLIENT_DAYS,
  daysBetween,
  isOpenStage,
  isPursued,
  needsOutcome,
  queueBucket,
  todayIso,
  type AccountStage,
  type BdStage,
  type QueueBucket,
} from "@/lib/bd";
import { ownerLabel, type BdOpportunity } from "@/lib/bd-db";
import { loadPipeline, oppLite, type PipelineData } from "@/lib/bd-load";
import { formatDate } from "@/lib/format";
import { getEffectiveRole } from "@/lib/roles-server";
import { cn } from "@/lib/utils";
import { Card, Empty, StagePill, TextLink, tdClass, thClass } from "./_components/fields";

const BUCKETS: { key: QueueBucket; title: string }[] = [
  { key: "overdue", title: "Overdue" },
  { key: "today", title: "Due today" },
  { key: "week", title: "Next 7 days" },
];

export default async function FollowUpQueuePage({
  searchParams,
}: {
  searchParams: { who?: string };
}) {
  const data = await loadPipeline();
  const { effective } = await getEffectiveRole();
  // Luke and Shannon open on their own list; Phil opens on everyone's.
  const who = searchParams.who ?? (effective === "bd" ? "mine" : "all");
  const today = todayIso();

  // A user with no owner row has no work of their own, not everything unassigned.
  const isMine = (ownerId: string | null) => who === "all" || (!!data.me && ownerId === data.me);

  const open = data.opps.filter((o) => isOpenStage(o.stage) && isMine(o.bd_owner_id));
  // Lead or Bidding: no price in yet. A bid with no date sorts first, because
  // nobody can plan around it.
  const bidsDue = open
    .filter((o) => o.stage === "bidding" || (o.stage === "lead" && o.bid_due_date))
    .sort((a, b) => (a.bid_due_date ?? "").localeCompare(b.bid_due_date ?? ""));
  const outcomeDue = open.filter((o) => needsOutcome(oppLite(o), today));
  const outcomeIds = new Set(outcomeDue.map((o) => o.id));
  const byBucket = new Map<QueueBucket, BdOpportunity[]>();
  for (const o of open) {
    if (outcomeIds.has(o.id)) continue;
    const b = queueBucket(o.next_follow_up_date, today);
    byBucket.set(b, [...(byBucket.get(b) ?? []), o]);
  }
  byBucket.forEach((list) =>
    list.sort((a, b) => (a.next_follow_up_date ?? "").localeCompare(b.next_follow_up_date ?? "")),
  );
  const laterCount = byBucket.get("later")?.length ?? 0;

  const myCompanies = data.companies.filter(
    (c) => isPursued(c.relationship_stage) && isMine(c.bd_owner_id),
  );
  // Accounts due within the week, most overdue first. Bid follow-ups above,
  // relationship touches here - the weekly tracker, worked from the platform.
  // A client whose owner is already chasing an open bid there is worked from
  // the bid list above; listing it twice is noise.
  const accountsDue = myCompanies
    .filter((c) => !data.opps.some((o) => o.company_id === c.id && isOpenStage(o.stage) && o.bd_owner_id === c.bd_owner_id))
    .filter((c) => c.next_touch_date && daysBetween(today, c.next_touch_date) <= 7)
    .sort((a, b) => (a.next_touch_date ?? "").localeCompare(b.next_touch_date ?? ""));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Follow-ups</h1>
          <p className="text-sm text-muted-foreground">
            Every open bid has a next follow-up date. Work this list top to bottom.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border p-0.5 text-sm">
            {[
              { v: "mine", label: "Mine" },
              { v: "all", label: "Everyone" },
            ].map((o) => (
              <Link
                key={o.v}
                href={`/bd?who=${o.v}`}
                className={cn(
                  "rounded px-3 py-1",
                  who === o.v ? "bg-foreground text-background" : "text-muted-foreground",
                )}
              >
                {o.label}
              </Link>
            ))}
          </div>
          <Button asChild size="sm">
            <Link href="/bd/opportunities/new">New opportunity</Link>
          </Button>
        </div>
      </div>

      <Card title={`Bid deadlines (${bidsDue.length})`}>
        {bidsDue.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className={thClass}>Opportunity</th>
                  <th className={thClass}>Client</th>
                  <th className={thClass}>Stage</th>
                  <th className={thClass}>Bid due</th>
                  <th className={thClass}>Owner</th>
                </tr>
              </thead>
              <tbody>
                {bidsDue.map((o) => {
                  const left = o.bid_due_date ? daysBetween(today, o.bid_due_date) : null;
                  return (
                    <tr key={o.id} className="border-b last:border-0">
                      <td className={tdClass}>
                        <TextLink href={`/bd/opportunities/${o.id}`}>{o.name}</TextLink>
                      </td>
                      <td className={tdClass}>{data.companyName.get(o.company_id) ?? "-"}</td>
                      <td className={tdClass}>
                        <StagePill stage={o.stage} label={STAGE_LABEL[o.stage as BdStage] ?? o.stage} />
                      </td>
                      <td
                        className={cn(
                          tdClass,
                          "whitespace-nowrap",
                          (left === null || left <= 3) && "font-medium text-destructive",
                        )}
                      >
                        {o.bid_due_date ? formatDate(o.bid_due_date) : "No date set"}
                        {left !== null && left < 0 && <span className="ml-1 text-xs">({-left}d late)</span>}
                        {left !== null && left >= 0 && <span className="ml-1 text-xs">({left}d left)</span>}
                      </td>
                      <td className={tdClass}>{ownerLabel(o.bd_owner_id, data.ownerName)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No bids being priced.</Empty>
        )}
      </Card>

      {outcomeDue.length > 0 && (
        <Card title={`Record the outcome (${outcomeDue.length})`}>
          <p className="mb-3 text-sm text-muted-foreground">
            The client&apos;s decision date has passed. Find out who won and record it.
          </p>
          <QueueTable rows={outcomeDue} data={data} today={today} dateField="expected_decision_date" />
        </Card>
      )}

      {BUCKETS.map(({ key, title }) => {
        const rows = byBucket.get(key) ?? [];
        return (
          <Card key={key} title={`${title} (${rows.length})`}>
            {rows.length ? (
              <QueueTable rows={rows} data={data} today={today} dateField="next_follow_up_date" />
            ) : (
              <Empty>Nothing here.</Empty>
            )}
          </Card>
        );
      })}

      {laterCount > 0 && (
        <p className="text-sm text-muted-foreground">
          {laterCount} more open {laterCount === 1 ? "opportunity is" : "opportunities are"} scheduled
          past next week. <TextLink href="/bd/pipeline">See the pipeline</TextLink>.
        </p>
      )}

      <Card title={`Accounts to touch (${accountsDue.length})`}>
        <p className="mb-3 text-sm text-muted-foreground">
          Relationship follow-ups due this week or late. Last touch turns red at {STALE_CLIENT_DAYS}+ days or Never.
        </p>
        {accountsDue.length ? (
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
                  <th className={thClass} />
                </tr>
              </thead>
              <tbody>
                {accountsDue.map((c) => {
                  const late = daysBetween(c.next_touch_date!, today);
                  const last = data.lastTouchByCompany.get(c.id) ?? null;
                  const cold = !last || daysBetween(last, today) >= STALE_CLIENT_DAYS;
                  return (
                    <tr key={c.id} className="border-b last:border-0">
                      <td className={tdClass}>
                        <TextLink href={`/bd/clients/${c.id}`}>{c.name}</TextLink>
                      </td>
                      <td className={cn(tdClass, "whitespace-nowrap")}>
                        {ACCOUNT_STAGE_LABEL[c.relationship_stage as AccountStage] ?? c.relationship_stage}
                      </td>
                      <td className={cn(tdClass, "max-w-xs")}>{c.next_step ?? "-"}</td>
                      <td className={cn(tdClass, "whitespace-nowrap", late > 0 && "font-medium text-destructive")}>
                        {formatDate(c.next_touch_date)}
                        {late > 0 && <span className="ml-1 text-xs">({late}d late)</span>}
                      </td>
                      <td className={cn(tdClass, "whitespace-nowrap", cold && "font-medium text-destructive")}>
                        {last ? formatDate(last) : "Never"}
                      </td>
                      <td className={tdClass}>{ownerLabel(c.bd_owner_id, data.ownerName)}</td>
                      <td className={cn(tdClass, "text-right")}>
                        <Button asChild size="sm" variant="outline">
                          <Link href={`/bd/clients/${c.id}#log`}>Log touch</Link>
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No account touches due this week.</Empty>
        )}
      </Card>
    </div>
  );
}

function QueueTable({
  rows,
  data,
  today,
  dateField,
}: {
  rows: BdOpportunity[];
  data: PipelineData;
  today: string;
  dateField: "next_follow_up_date" | "expected_decision_date";
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b">
            <th className={thClass}>Opportunity</th>
            <th className={thClass}>Client</th>
            <th className={thClass}>Stage</th>
            <th className={thClass}>{dateField === "next_follow_up_date" ? "Follow up" : "Decision was"}</th>
            <th className={thClass}>Last touch</th>
            <th className={thClass}>Owner</th>
            <th className={thClass} />
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => {
            const date = o[dateField];
            const late = date ? daysBetween(date, today) : 0;
            return (
              <tr key={o.id} className="border-b last:border-0">
                <td className={tdClass}>
                  <TextLink href={`/bd/opportunities/${o.id}`}>{o.name}</TextLink>
                </td>
                <td className={tdClass}>{data.companyName.get(o.company_id) ?? "-"}</td>
                <td className={tdClass}>
                  <StagePill stage={o.stage} label={STAGE_LABEL[o.stage as BdStage] ?? o.stage} />
                  {(o.stage === "submitted" || o.stage === "shortlist") && !o.expected_decision_date && (
                    <div className="mt-1 text-xs text-muted-foreground">No decision date</div>
                  )}
                </td>
                <td className={cn(tdClass, "whitespace-nowrap", late > 0 && "font-medium text-destructive")}>
                  {formatDate(date)}
                  {late > 0 && <span className="ml-1 text-xs">({late}d late)</span>}
                </td>
                <td className={cn(tdClass, "whitespace-nowrap")}>
                  {formatDate(data.lastTouchByOpp.get(o.id) ?? null)}
                </td>
                <td className={tdClass}>{ownerLabel(o.bd_owner_id, data.ownerName)}</td>
                <td className={cn(tdClass, "text-right")}>
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/bd/opportunities/${o.id}#${dateField === "next_follow_up_date" ? "log" : "outcome"}`}>
                      {dateField === "next_follow_up_date" ? "Log touch" : "Record"}
                    </Link>
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
