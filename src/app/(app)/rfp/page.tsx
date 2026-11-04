import Link from "next/link";

import { Input } from "@/components/ui/input";
import { isOpenStage, todayIso } from "@/lib/bd";
import { formatDate } from "@/lib/format";
import { ROUND_KINDS, ROUND_KIND_LABEL, bidderFlags, packageCoverage, type RoundKind } from "@/lib/rfp";
import { rfpClient } from "@/lib/rfp-db";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { ActionForm } from "../bd/_components/action-form";
import { Card, Empty, Field, Select, TextArea, tdClass, thClass } from "../bd/_components/fields";
import { createRound } from "./actions";
import { Pill } from "./_components/flag-pill";

/**
 * Every bid round. A round is a new bid or rebid on a BD opportunity, or a
 * pre-construction reprice on a live project. Business Dev keeps only the
 * overall status of a bid; the bidding itself runs here.
 */
export default async function RfpIndexPage({ searchParams }: { searchParams: { show?: string } }) {
  const supabase = createClient();
  const db = rfpClient(supabase);
  const [rounds, opps, companies, projects, bidders] = await Promise.all([
    db.from("rfp_rounds").select("*").order("due_date", { ascending: true, nullsFirst: false }),
    db.from("bd_opportunities").select("id, name, stage, company_id, state"),
    db.from("bd_companies").select("id, name"),
    supabase.from("projects").select("id, name, status").order("name"),
    db.from("rfp_bidders").select("*"),
  ]);

  const today = todayIso();
  const showClosed = searchParams.show === "closed";
  const oppById = new Map((opps.data ?? []).map((o) => [o.id, o]));
  const companyName = new Map((companies.data ?? []).map((c) => [c.id, c.name]));
  const projectById = new Map((projects.data ?? []).map((p) => [p.id, p]));
  const biddersBy = new Map<string, NonNullable<typeof bidders.data>>();
  for (const b of bidders.data ?? []) biddersBy.set(b.round_id, [...(biddersBy.get(b.round_id) ?? []), b]);

  const list = (rounds.data ?? []).filter((r) => (showClosed ? r.status === "closed" : r.status === "open"));
  const openOpps = (opps.data ?? []).filter((o) => isOpenStage(o.stage)).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Bid rounds</h1>
        <p className="text-sm text-muted-foreground">
          New bids, rebids and pre-construction reprices. Upload each bid, confirm what Claude read, level by
          package. The runbook is in Notion: Runbook - RFP to Submitted EPC Price.
        </p>
      </div>

      <Card
        title={showClosed ? `Closed rounds (${list.length})` : `Open rounds (${list.length})`}
        action={
          <Link href={showClosed ? "/rfp" : "/rfp?show=closed"} className="text-xs text-muted-foreground hover:text-foreground">
            {showClosed ? "Show open" : "Show closed"}
          </Link>
        }
      >
        {list.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className={thClass}>Round</th>
                  <th className={thClass}>For</th>
                  <th className={thClass}>Type</th>
                  <th className={thClass}>State</th>
                  <th className={thClass}>Due</th>
                  <th className={thClass}>Bidders</th>
                  <th className={thClass}>Needs attention</th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => {
                  const opp = r.opportunity_id ? oppById.get(r.opportunity_id) : null;
                  const project = r.project_id ? projectById.get(r.project_id) : null;
                  const rows = biddersBy.get(r.id) ?? [];
                  const received = rows.filter((b) => b.status === "received" || b.status === "carried").length;
                  const unconfirmed = rows.filter((b) => b.extracted_at && !b.lines_confirmed_at).length;
                  const thin = packageCoverage(rows).filter((c) => c.thin).length;
                  const chase = rows.filter((b) => bidderFlags(b, today).some((f) => f.kind !== "license_unverified")).length;
                  const overdue = r.status === "open" && !!r.due_date && r.due_date < today;
                  return (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className={tdClass}>
                        <Link href={`/rfp/${r.id}`} className="font-medium underline-offset-4 hover:underline">
                          {r.label}
                        </Link>
                      </td>
                      <td className={tdClass}>
                        <div>{opp?.name ?? project?.name ?? "-"}</div>
                        <div className="text-xs text-muted-foreground">
                          {opp ? companyName.get(opp.company_id) ?? "Opportunity" : project ? "Live project" : ""}
                        </div>
                      </td>
                      <td className={tdClass}>{ROUND_KIND_LABEL[r.kind as RoundKind] ?? r.kind}</td>
                      <td className={tdClass}>{r.state ?? <Pill tone="warn">Set state</Pill>}</td>
                      <td className={cn(tdClass, "whitespace-nowrap", overdue && "text-destructive")}>{formatDate(r.due_date)}</td>
                      <td className={cn(tdClass, "tabular-nums")}>
                        {received} in / {rows.length}
                      </td>
                      <td className={tdClass}>
                        <div className="flex flex-wrap gap-1">
                          {unconfirmed > 0 && <Pill tone="warn">{unconfirmed} to confirm</Pill>}
                          {thin > 0 && <Pill tone="bad">{thin} thin package{thin === 1 ? "" : "s"}</Pill>}
                          {chase > 0 && <Pill tone="warn">{chase} to chase</Pill>}
                          {!unconfirmed && !thin && !chase && <span className="text-muted-foreground">-</span>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{showClosed ? "No closed rounds." : "No open rounds. Start one below."}</Empty>
        )}
      </Card>

      <Card title="Start a round">
        <ActionForm action={createRound} submitLabel="Start round">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="For" htmlFor="target" required className="sm:col-span-2">
              <select
                id="target"
                name="target"
                required
                defaultValue=""
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">Pick an opportunity or project</option>
                <optgroup label="Open opportunities (new bid or rebid)">
                  {openOpps.map((o) => (
                    <option key={o.id} value={`opp:${o.id}`}>
                      {o.name}
                      {companyName.get(o.company_id) ? ` - ${companyName.get(o.company_id)}` : ""}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Live projects (pre-construction reprice)">
                  {(projects.data ?? []).map((p) => (
                    <option key={p.id} value={`project:${p.id}`}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              </select>
            </Field>
            <Field label="Type" htmlFor="kind" hint="Blank = new bid for an opportunity, reprice for a project">
              <Select
                name="kind"
                blank="-"
                options={ROUND_KINDS.map((k) => ({ value: k, label: ROUND_KIND_LABEL[k] }))}
              />
            </Field>
            <Field label="Round name" htmlFor="label" required>
              <Input id="label" name="label" required placeholder="R1, R2, 90% reprice" />
            </Field>
            <Field label="State" htmlFor="state" hint="Blank = from the opportunity">
              <Input id="state" name="state" maxLength={2} placeholder="VA" />
            </Field>
            <Field label="Bids due" htmlFor="due_date">
              <Input id="due_date" name="due_date" type="date" />
            </Field>
            <Field label="Notes" htmlFor="notes" className="sm:col-span-2">
              <TextArea name="notes" rows={2} />
            </Field>
          </div>
        </ActionForm>
      </Card>
    </div>
  );
}
