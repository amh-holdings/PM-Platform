import Link from "next/link";
import { notFound } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { createClient } from "@/lib/supabase/server";
import {
  ACTIVITY_LABEL,
  EQUIPMENT_BASES,
  EQUIPMENT_LABEL,
  FOLLOW_UP_DAYS,
  LOSS_REASONS,
  LOSS_REASON_LABEL,
  REVISION_LABEL,
  REVISION_TYPES,
  STAGE_LABEL,
  addDays,
  dollarsPerWatt,
  formatPerWatt,
  isOpenStage,
  latestBidByOpp,
  probabilityOf,
  todayIso,
  type BdStage,
  type LossReason,
} from "@/lib/bd";
import { bdClient, loadBdPeople } from "@/lib/bd-db";
import { oppLite } from "@/lib/bd-load";
import { formatCurrency, formatDate } from "@/lib/format";
import { can } from "@/lib/roles";
import { getEffectiveRole } from "@/lib/roles-server";
import { cn } from "@/lib/utils";
import {
  addBid,
  deleteBid,
  deleteOpportunity,
  logActivity,
  recordOutcome,
  updateOpportunity,
} from "../../actions";
import { ActionForm } from "../../_components/action-form";
import { Card, Empty, Field, Select, StagePill, TextArea, TextLink, tdClass, thClass } from "../../_components/fields";
import { LogTouchFields } from "../../_components/log-touch-fields";
import { OpportunityFields } from "../../_components/opportunity-fields";

export default async function OpportunityPage({ params }: { params: { id: string } }) {
  const supabase = createClient();
  const db = bdClient(supabase);
  const { data: opp } = await db.from("bd_opportunities").select("*").eq("id", params.id).maybeSingle();
  if (!opp) notFound();

  const [companies, contacts, bids, activities, people, { effective }] = await Promise.all([
    db.from("bd_companies").select("*").order("name"),
    db.from("bd_contacts").select("*").order("name"),
    db.from("bd_bids").select("*").eq("opportunity_id", opp.id).order("submitted_on", { ascending: false }),
    db
      .from("bd_activities")
      .select("*")
      .eq("opportunity_id", opp.id)
      .order("occurred_on", { ascending: false })
      .order("created_at", { ascending: false }),
    loadBdPeople(supabase),
    getEffectiveRole(),
  ]);

  const company = (companies.data ?? []).find((c) => c.id === opp.company_id);
  const companyContacts = (contacts.data ?? []).filter((c) => c.company_id === opp.company_id);
  const contactName = new Map((contacts.data ?? []).map((c) => [c.id, c.name]));
  const personName = new Map(people.map((p) => [p.id, p.name]));
  const bidRows = (bids.data ?? []).map((b) => ({ ...b, price: Number(b.price) }));
  const latest = latestBidByOpp(bidRows).get(opp.id);
  const lite = oppLite(opp);
  const open = isOpenStage(opp.stage);
  const stageLabel = STAGE_LABEL[opp.stage as BdStage] ?? opp.stage;
  const lastTouch = activities.data?.[0]?.occurred_on ?? null;
  const today = todayIso();
  const canTransfer = can(effective, "transferBdToProject");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold">{opp.name}</h1>
            <StagePill stage={opp.stage} label={stageLabel} />
          </div>
          <p className="text-sm text-muted-foreground">
            {company ? <TextLink href={`/bd/clients/${company.id}`}>{company.name}</TextLink> : "-"}
            {[opp.county, opp.state].filter(Boolean).length > 0 && ` - ${[opp.county, opp.state].filter(Boolean).join(", ")}`}
            {opp.owner_id && ` - Owner: ${personName.get(opp.owner_id) ?? "-"}`}
          </p>
        </div>
        {opp.stage === "won" &&
          (opp.project_id ? (
            canTransfer ? (
              <Button asChild size="sm" variant="outline">
                <Link href={`/projects/${opp.project_id}`}>Open project</Link>
              </Button>
            ) : (
              <span className="text-sm text-muted-foreground">Transferred to a project</span>
            )
          ) : canTransfer ? (
            <Button asChild size="sm">
              <Link href={`/bd/opportunities/${opp.id}/transfer`}>Transfer to project</Link>
            </Button>
          ) : (
            <span className="text-sm text-muted-foreground">Waiting on Phil to set up the project</span>
          ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Fact label="Latest bid" value={latest ? formatCurrency(latest.price) : "-"} />
        <Fact label="$/W DC" value={formatPerWatt(latest ? dollarsPerWatt(latest.price, lite.size_mw_dc) : null)} />
        <Fact label="Size" value={lite.size_mw_dc ? `${lite.size_mw_dc} MW DC` : "-"} />
        {open ? (
          <>
            <Fact
              label="Next follow-up"
              value={formatDate(opp.next_follow_up_date)}
              alert={!!opp.next_follow_up_date && opp.next_follow_up_date < today}
            />
            <Fact label="Expected decision" value={formatDate(opp.expected_decision_date)} />
            <Fact label="Win probability" value={`${probabilityOf(lite)}%`} />
          </>
        ) : (
          <>
            <Fact label="Decided" value={formatDate(opp.outcome_date)} />
            <Fact label="Last touch" value={formatDate(lastTouch)} />
            <Fact label="Bid due was" value={formatDate(opp.bid_due_date)} />
          </>
        )}
      </div>

      {open && company && (
        <Card id="log" title="Log a touch">
          <ActionForm action={logActivity} submitLabel="Log touch">
            <LogTouchFields
              companyId={company.id}
              opportunityId={opp.id}
              contacts={companyContacts}
              suggestedNext={addDays(today, FOLLOW_UP_DAYS[opp.stage as BdStage] || 7)}
            />
          </ActionForm>
        </Card>
      )}

      <Card title={`Bids (${bidRows.length})`}>
        {bidRows.length ? (
          <div className="mb-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className={thClass}>Revision</th>
                  <th className={thClass}>Submitted</th>
                  <th className={cn(thClass, "text-right")}>Price</th>
                  <th className={cn(thClass, "text-right")}>$/W</th>
                  <th className={cn(thClass, "text-right")}>Margin</th>
                  <th className={thClass}>Equipment</th>
                  <th className={thClass}>Exclusions / notes</th>
                  <th className={thClass} />
                </tr>
              </thead>
              <tbody>
                {bidRows.map((b) => (
                  <tr key={b.id} className="border-b last:border-0">
                    <td className={tdClass}>
                      {REVISION_LABEL[b.revision_type as keyof typeof REVISION_LABEL] ?? b.revision_type}
                      {b.id === latest?.id && bidRows.length > 1 && (
                        <span className="ml-1 text-xs text-muted-foreground">(of record)</span>
                      )}
                    </td>
                    <td className={cn(tdClass, "whitespace-nowrap")}>{formatDate(b.submitted_on)}</td>
                    <td className={cn(tdClass, "text-right tabular-nums")}>{formatCurrency(b.price)}</td>
                    <td className={cn(tdClass, "text-right tabular-nums")}>
                      {formatPerWatt(dollarsPerWatt(b.price, lite.size_mw_dc))}
                    </td>
                    <td className={cn(tdClass, "text-right tabular-nums")}>
                      {b.margin_pct !== null ? `${Number(b.margin_pct)}%` : "-"}
                    </td>
                    <td className={tdClass}>
                      {EQUIPMENT_LABEL[b.equipment_basis as keyof typeof EQUIPMENT_LABEL] ?? b.equipment_basis}
                    </td>
                    <td className={cn(tdClass, "max-w-xs text-muted-foreground")}>
                      {[b.exclusions, b.notes].filter(Boolean).join(" - ") || "-"}
                      {b.proposal_url && (
                        <>
                          {" "}
                          <a href={b.proposal_url} target="_blank" rel="noreferrer" className="underline">
                            Proposal
                          </a>
                        </>
                      )}
                    </td>
                    <td className={cn(tdClass, "text-right")}>
                      <form action={deleteBid.bind(null, b.id, opp.id)}>
                        <button type="submit" className="text-xs text-muted-foreground hover:text-destructive">
                          Remove
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="mb-5">
            <Empty>No bids yet.</Empty>
          </div>
        )}
        <details className="rounded-md border p-4" open={bidRows.length === 0 && open}>
          <summary className="cursor-pointer text-sm font-medium">Add a bid revision</summary>
          <p className="mt-2 text-xs text-muted-foreground">
            Saving moves the opportunity to Submitted (Shortlist for a BAFO) and sets the next
            follow-up 7 days after the submit date.
          </p>
          <ActionForm action={addBid.bind(null, opp.id)} submitLabel="Add bid" className="mt-4 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Revision" htmlFor="revision_type">
                <Select
                  name="revision_type"
                  defaultValue={bidRows.length ? "bafo" : "final"}
                  options={REVISION_TYPES.map((r) => ({ value: r, label: REVISION_LABEL[r] }))}
                />
              </Field>
              <Field label="Submitted" htmlFor="submitted_on">
                <Input id="submitted_on" name="submitted_on" type="date" defaultValue={today} />
              </Field>
              <Field label="Price" htmlFor="price" required>
                <MoneyInput id="price" name="price" required />
              </Field>
              <Field label="Margin %" htmlFor="margin_pct">
                <Input id="margin_pct" name="margin_pct" inputMode="decimal" />
              </Field>
              <Field label="Equipment basis" htmlFor="equipment_basis" hint="Only compare $/W on the same basis">
                <Select
                  name="equipment_basis"
                  defaultValue={latest?.equipment_basis ?? "epc_furnished"}
                  options={EQUIPMENT_BASES.map((e) => ({ value: e, label: EQUIPMENT_LABEL[e] }))}
                />
              </Field>
              <Field label="Proposal link" htmlFor="proposal_url" className="sm:col-span-1 lg:col-span-3">
                <Input id="proposal_url" name="proposal_url" placeholder="Google Drive link" />
              </Field>
              <Field label="Key exclusions" htmlFor="exclusions" className="sm:col-span-2">
                <TextArea name="exclusions" rows={2} placeholder="Interconnection, substation..." />
              </Field>
              <Field label="Notes" htmlFor="notes" className="sm:col-span-2">
                <TextArea name="notes" rows={2} />
              </Field>
            </div>
          </ActionForm>
        </details>
      </Card>

      <Card id="outcome" title={open ? "Record outcome" : "Outcome"}>
        {open ? (
          <ActionForm action={recordOutcome.bind(null, opp.id)} submitLabel="Record outcome">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Result" htmlFor="outcome" required>
                <Select
                  name="outcome"
                  required
                  blank="Pick one"
                  options={[
                    { value: "won", label: "Won" },
                    { value: "lost", label: "Lost" },
                    { value: "no_bid", label: "No-bid (we passed)" },
                    { value: "dead", label: "Dead (client cancelled)" },
                  ]}
                />
              </Field>
              <Field label="Decision date" htmlFor="outcome_date">
                <Input id="outcome_date" name="outcome_date" type="date" defaultValue={today} />
              </Field>
              <Field label="Loss reason" htmlFor="loss_reason" hint="Required when lost">
                <Select
                  name="loss_reason"
                  blank="-"
                  options={LOSS_REASONS.map((r) => ({ value: r, label: LOSS_REASON_LABEL[r] }))}
                />
              </Field>
              <Field label="Who won" htmlFor="winner" hint="If lost and known">
                <Input id="winner" name="winner" />
              </Field>
              <Field label="Winning price" htmlFor="winning_price" hint="If lost and known">
                <MoneyInput id="winning_price" name="winning_price" />
              </Field>
              <Field label="Notes" htmlFor="outcome_notes" className="sm:col-span-1 lg:col-span-3">
                <TextArea name="outcome_notes" rows={2} />
              </Field>
            </div>
          </ActionForm>
        ) : (
          <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Item label="Result" value={stageLabel} />
            <Item label="Decided" value={formatDate(opp.outcome_date)} />
            {opp.stage === "lost" && (
              <>
                <Item
                  label="Loss reason"
                  value={LOSS_REASON_LABEL[opp.loss_reason as LossReason] ?? opp.loss_reason ?? "-"}
                />
                <Item label="Who won" value={opp.winner ?? "-"} />
                <Item label="Winning price" value={opp.winning_price !== null ? formatCurrency(Number(opp.winning_price)) : "-"} />
                {opp.winning_price !== null && latest && (
                  <Item
                    label="Our bid vs winner"
                    value={`${(((latest.price - Number(opp.winning_price)) / Number(opp.winning_price)) * 100).toFixed(1)}%`}
                  />
                )}
              </>
            )}
            {opp.outcome_notes && <Item label="Notes" value={opp.outcome_notes} wide />}
          </dl>
        )}
      </Card>

      <Card title={`History (${activities.data?.length ?? 0})`}>
        {activities.data?.length ? (
          <ul className="space-y-3 text-sm">
            {activities.data.map((a) => (
              <li key={a.id} className="flex gap-3 border-b pb-3 last:border-0 last:pb-0">
                <span className="w-24 shrink-0 text-muted-foreground">{formatDate(a.occurred_on)}</span>
                <div>
                  <span className="font-medium">
                    {ACTIVITY_LABEL[a.activity_type as keyof typeof ACTIVITY_LABEL] ?? a.activity_type}
                  </span>
                  {a.contact_id && <span className="text-muted-foreground"> with {contactName.get(a.contact_id)}</span>}
                  {a.logged_by && <span className="text-muted-foreground"> - {personName.get(a.logged_by) ?? ""}</span>}
                  {a.notes && <p className="mt-0.5 whitespace-pre-wrap">{a.notes}</p>}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No touches logged yet.</Empty>
        )}
      </Card>

      <details className="rounded-lg border bg-card p-5 shadow-sm">
        <summary className="cursor-pointer text-base font-semibold">
          {open ? "Edit details" : "Edit details / reopen"}
        </summary>
        {!open && (
          <p className="mt-2 text-xs text-muted-foreground">
            Saving here reopens the opportunity and clears the recorded outcome.
          </p>
        )}
        <ActionForm action={updateOpportunity.bind(null, opp.id)} submitLabel="Save" className="mt-4 space-y-4">
          <OpportunityFields
            companies={companies.data ?? []}
            contacts={contacts.data ?? []}
            people={people}
            opp={opp}
          />
        </ActionForm>
        <form action={deleteOpportunity.bind(null, opp.id)} className="mt-6 border-t pt-4">
          <button type="submit" className="text-sm text-muted-foreground hover:text-destructive">
            Delete this opportunity and its bids
          </button>
        </form>
      </details>
    </div>
  );
}

function Fact({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 font-semibold tabular-nums", alert && "text-destructive")}>{value}</div>
    </div>
  );
}

function Item({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={cn(wide && "sm:col-span-2 lg:col-span-4")}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="whitespace-pre-wrap">{value}</dd>
    </div>
  );
}
