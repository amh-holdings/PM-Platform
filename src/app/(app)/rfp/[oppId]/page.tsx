import { Fragment } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { STAGE_LABEL, todayIso, type BdStage } from "@/lib/bd";
import { formatCurrency, formatDate } from "@/lib/format";
import {
  BIDDER_KIND_LABEL,
  BIDDER_STATUS_LABEL,
  DECLINE_REASON_LABEL,
  DOC_STAGE_LABEL,
  MIN_LIVE_BIDDERS,
  PACKAGE_LABEL,
  REQUIRED_DOCS,
  RFP_PHASES,
  STATE_FIELDS,
  TARGET_BIDDERS,
  bidDocsFor,
  bidderFlags,
  coverageDeadlinePassed,
  currentPhase,
  docStagesFor,
  flagText,
  packageCoverage,
  phaseProgress,
  stateCode,
  stateProfileGaps,
  type BidderStatus,
  type RfpPackage,
} from "@/lib/rfp";
import { rfpClient } from "@/lib/rfp-db";
import { canWith } from "@/lib/roles";
import { getEffectiveRole } from "@/lib/roles-server";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { ActionForm } from "../../bd/_components/action-form";
import { Card, Empty, StagePill, tdClass, thClass } from "../../bd/_components/fields";
import { addBidder, deleteBidder, logBidderContact, toggleDoc, toggleStep, updateBidder } from "../actions";
import { BidderFields } from "../_components/bidder-fields";
import { Pill } from "../_components/flag-pill";

const STATUS_TONE: Record<BidderStatus, "bad" | "warn" | "good" | "muted"> = {
  invited: "muted",
  confirmed: "muted",
  at_risk: "warn",
  received: "good",
  carried: "good",
  declined: "bad",
};

export default async function RfpWorkspacePage({
  params,
  searchParams,
}: {
  params: { oppId: string };
  searchParams: { edit?: string; docs?: string };
}) {
  const supabase = createClient();
  const db = rfpClient(supabase);
  const { data: opp } = await db.from("bd_opportunities").select("*").eq("id", params.oppId).maybeSingle();
  if (!opp) notFound();

  const st = stateCode(opp.state);
  const [company, checks, bidders, profile, { effective, grants }] = await Promise.all([
    db.from("bd_companies").select("id, name").eq("id", opp.company_id).maybeSingle(),
    db.from("rfp_step_checks").select("step_key").eq("opportunity_id", opp.id),
    db.from("rfp_bidders").select("*").eq("opportunity_id", opp.id).order("package").order("firm"),
    st
      ? db.from("bd_state_profiles").select("*").eq("state", st).maybeSingle()
      : Promise.resolve({ data: null }),
    getEffectiveRole(),
  ]);

  const bidderRows = (bidders.data ?? []).map((b) => ({ ...b, bid_total: b.bid_total === null ? null : Number(b.bid_total) }));
  const { data: docs } = bidderRows.length
    ? await db.from("rfp_bidder_docs").select("bidder_id, doc_key").in("bidder_id", bidderRows.map((b) => b.id))
    : { data: [] as { bidder_id: string; doc_key: string }[] };

  const today = todayIso();
  const done = new Set((checks.data ?? []).map((c) => c.step_key));
  const progress = new Map(phaseProgress(done).map((p) => [p.key, p]));
  const phase = currentPhase(done);
  const docsBy = new Map<string, Set<string>>();
  for (const d of docs ?? []) docsBy.set(d.bidder_id, (docsBy.get(d.bidder_id) ?? new Set()).add(d.doc_key));
  const coverage = packageCoverage(bidderRows);
  const coverageUrgent = coverageDeadlinePassed(opp.bid_due_date, today);
  const profileGaps = stateProfileGaps(profile.data);
  const canSeeBd = canWith(effective, grants, "viewBD");

  // Everything that needs a person today, worst first.
  const alerts: { tone: "bad" | "warn"; text: string }[] = [];
  if (!st) alerts.push({ tone: "bad", text: "No two-letter state on this bid. Set it on the opportunity so the State Profile applies." });
  else if (!profile.data) alerts.push({ tone: "bad", text: `No State Profile for ${st}. Build it before the bid package goes out.` });
  else if (profileGaps.length)
    alerts.push({ tone: "warn", text: `${st} State Profile is missing: ${profileGaps.map((k) => STATE_FIELDS.find((f) => f.key === k)?.label.split(":")[0]).join(", ")}.` });
  for (const c of coverage.filter((c) => c.thin)) {
    alerts.push({
      tone: coverageUrgent ? "bad" : "warn",
      text: `${PACKAGE_LABEL[c.package as RfpPackage] ?? c.package}: ${c.live} live bidder${c.live === 1 ? "" : "s"}. Invite from the bench${coverageUrgent ? " now, bids are due inside two weeks" : ""}.`,
    });
  }
  for (const b of bidderRows) {
    for (const f of bidderFlags(b, today)) {
      if (f.kind === "license_unverified") continue;
      alerts.push({ tone: f.kind === "validity_lapsed" ? "bad" : "warn", text: `${b.firm}: ${flagText(f)}.` });
    }
    const have = docsBy.get(b.id) ?? new Set();
    if (b.status === "received" || b.status === "carried") {
      const missing = bidDocsFor(b.kind).filter((d) => !have.has(d.key)).length;
      if (missing) alerts.push({ tone: "warn", text: `${b.firm}: bid received with ${missing} required item${missing === 1 ? "" : "s"} missing.` });
    }
  }
  const unlicensed = bidderRows.filter((b) => bidderFlags(b, today).some((f) => f.kind === "license_unverified"));
  if (unlicensed.length)
    alerts.push({ tone: "warn", text: `State license not verified: ${unlicensed.map((b) => b.firm).join(", ")}.` });

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{opp.name}</h1>
          <StagePill stage={opp.stage} label={STAGE_LABEL[opp.stage as BdStage] ?? opp.stage} />
        </div>
        <p className="text-sm text-muted-foreground">
          {company.data?.name ?? "-"}
          {[opp.county, opp.state].filter(Boolean).length > 0 && ` - ${[opp.county, opp.state].filter(Boolean).join(", ")}`}
          {opp.size_mw_dc !== null && ` - ${Number(opp.size_mw_dc)} MW DC`}
          {` - Bid due ${formatDate(opp.bid_due_date)}`}
          {canSeeBd && (
            <>
              {" - "}
              <Link href={`/bd/opportunities/${opp.id}`} className="underline-offset-4 hover:underline">
                Opportunity in Business Dev
              </Link>
            </>
          )}
        </p>
        <p className="text-sm">
          Now: <span className="font-medium">{phase ? `${phase.num}. ${phase.title}` : "Runbook complete"}</span>
          {phase && <span className="text-muted-foreground"> - {phase.owner}</span>}
        </p>
      </div>

      <Card title={alerts.length ? `Needs attention (${alerts.length})` : "Needs attention"}>
        {alerts.length ? (
          <ul className="space-y-1.5 text-sm">
            {alerts.map((a, i) => (
              <li key={i} className="flex gap-2">
                <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", a.tone === "bad" ? "bg-destructive" : "bg-amber-500")} />
                {a.text}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Nothing waiting. Every package covered, nobody silent, no validity lapsing.</Empty>
        )}
      </Card>

      <Card
        title={st ? `${st} State Profile` : "State Profile"}
        action={
          <Link href={st ? `/rfp/states?edit=${st}` : "/rfp/states"} className="text-xs text-muted-foreground hover:text-foreground">
            {profile.data ? "Edit" : "Build it"}
          </Link>
        }
      >
        {profile.data ? (
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            {STATE_FIELDS.filter((f) => profile.data?.[f.key]).map((f) => (
              <div key={f.key}>
                <dt className="text-xs text-muted-foreground">{f.label}</dt>
                <dd className="whitespace-pre-wrap">{profile.data?.[f.key]}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <Empty>
            Everything that changes by state lives here: wage law, licensing, contractor bonds, sales tax, lien forms,
            stormwater. Build it once and every bid in the state reads it.
          </Empty>
        )}
      </Card>

      <Card id="runbook" title="Runbook">
        <div className="space-y-2">
          {RFP_PHASES.map((p) => {
            const pr = progress.get(p.key)!;
            return (
              <details key={p.key} className="rounded-md border" open={phase?.key === p.key}>
                <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <span className="font-medium">
                    {p.num}. {p.title}
                    <span className="ml-2 font-normal text-muted-foreground">{p.owner}</span>
                  </span>
                  <Pill tone={pr.complete ? "good" : pr.done ? "warn" : "muted"}>
                    {pr.done} / {pr.total}
                  </Pill>
                </summary>
                <div className="space-y-3 border-t px-4 py-3">
                  <ul className="space-y-1.5">
                    {p.steps.map((s) => {
                      const isDone = done.has(s.key);
                      return (
                        <li key={s.key}>
                          <form action={toggleStep.bind(null, opp.id, s.key, isDone)}>
                            <button type="submit" className="flex items-start gap-2 text-left text-sm">
                              <span
                                className={cn(
                                  "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px]",
                                  isDone && "border-foreground bg-foreground text-background",
                                )}
                              >
                                {isDone ? "✓" : ""}
                              </span>
                              <span className={cn(isDone && "text-muted-foreground line-through")}>{s.text}</span>
                            </button>
                          </form>
                        </li>
                      );
                    })}
                  </ul>
                  {p.notes?.length ? (
                    <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                      {p.notes.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </details>
            );
          })}
        </div>
      </Card>

      <Card id="bidders" title={`Bidders (${bidderRows.length})`}>
        {coverage.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-2 text-xs">
            {coverage.map((c) => (
              <Pill key={c.package} tone={c.thin ? "bad" : c.belowTarget ? "warn" : "good"}>
                {PACKAGE_LABEL[c.package as RfpPackage]?.split(" (")[0] ?? c.package}: {c.live} live, {c.received} in
              </Pill>
            ))}
            <span className="self-center text-muted-foreground">
              Target {TARGET_BIDDERS} per package, never fewer than {MIN_LIVE_BIDDERS} live.
            </span>
          </div>
        )}
        {bidderRows.length ? (
          <div className="mb-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className={thClass}>Firm</th>
                  <th className={thClass}>Package</th>
                  <th className={thClass}>Status</th>
                  <th className={thClass}>Last contact</th>
                  <th className={cn(thClass, "text-right")}>Bid</th>
                  <th className={thClass}>Valid until</th>
                  <th className={thClass}>Documents</th>
                  <th className={thClass} />
                </tr>
              </thead>
              <tbody>
                {bidderRows.map((b) => {
                  const have = docsBy.get(b.id) ?? new Set<string>();
                  const bidDocs = bidDocsFor(b.kind);
                  const haveBidDocs = bidDocs.filter((d) => have.has(d.key)).length;
                  const flags = bidderFlags(b, today);
                  return (
                    <Fragment key={b.id}>
                      <tr className="border-b last:border-0">
                        <td className={tdClass}>
                          <div className="font-medium">{b.firm}</div>
                          <div className="text-xs text-muted-foreground">
                            {BIDDER_KIND_LABEL[b.kind as keyof typeof BIDDER_KIND_LABEL] ?? b.kind}
                            {b.contact_name && ` - ${b.contact_name}`}
                            {b.contact_email && (
                              <>
                                {" - "}
                                <a href={`mailto:${b.contact_email}`} className="underline-offset-4 hover:underline">
                                  {b.contact_email}
                                </a>
                              </>
                            )}
                          </div>
                          {flags.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {flags.map((f) => (
                                <Pill key={f.kind} tone={f.kind === "validity_lapsed" ? "bad" : "warn"}>
                                  {flagText(f)}
                                </Pill>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className={tdClass}>{PACKAGE_LABEL[b.package as RfpPackage]?.split(" (")[0] ?? b.package}</td>
                        <td className={tdClass}>
                          <Pill tone={STATUS_TONE[b.status as BidderStatus] ?? "muted"}>
                            {BIDDER_STATUS_LABEL[b.status as BidderStatus] ?? b.status}
                          </Pill>
                          {b.status === "declined" && b.decline_reason && (
                            <div className="mt-0.5 text-xs text-muted-foreground">
                              {DECLINE_REASON_LABEL[b.decline_reason as keyof typeof DECLINE_REASON_LABEL] ?? b.decline_reason}
                            </div>
                          )}
                        </td>
                        <td className={cn(tdClass, "whitespace-nowrap")}>{formatDate(b.last_contact_on ?? b.invited_on)}</td>
                        <td className={cn(tdClass, "text-right tabular-nums")}>{formatCurrency(b.bid_total)}</td>
                        <td className={cn(tdClass, "whitespace-nowrap")}>{formatDate(b.validity_date)}</td>
                        <td className={tdClass}>
                          <Link
                            href={`/rfp/${opp.id}?docs=${b.id}#bidder-${b.id}`}
                            scroll={false}
                            className="whitespace-nowrap underline-offset-4 hover:underline"
                          >
                            {haveBidDocs} / {bidDocs.length} {b.kind === "supplier" ? "quote items" : "with bid"}
                          </Link>
                        </td>
                        <td className={cn(tdClass, "text-right")}>
                          <div className="flex justify-end gap-3 whitespace-nowrap">
                            {b.status !== "declined" && (
                              <form action={logBidderContact.bind(null, b.id, opp.id, today)}>
                                <button type="submit" className="text-xs text-muted-foreground hover:text-foreground">
                                  Checked in today
                                </button>
                              </form>
                            )}
                            <Link
                              href={`/rfp/${opp.id}?edit=${b.id}#bidder-${b.id}`}
                              scroll={false}
                              className="text-xs text-muted-foreground hover:text-foreground"
                            >
                              Edit
                            </Link>
                            <form action={deleteBidder.bind(null, b.id, opp.id)}>
                              <button type="submit" className="text-xs text-muted-foreground hover:text-destructive">
                                Remove
                              </button>
                            </form>
                          </div>
                        </td>
                      </tr>
                      {searchParams.edit === b.id && (
                        <tr id={`bidder-${b.id}`} className="border-b last:border-0">
                          <td colSpan={8} className="bg-muted/30 p-4">
                            <ActionForm action={updateBidder.bind(null, b.id, opp.id)} submitLabel="Save bidder">
                              <BidderFields idPrefix={`edit_${b.id}`} bidder={b} today={today} />
                            </ActionForm>
                            <Link
                              href={`/rfp/${opp.id}#bidders`}
                              scroll={false}
                              className="text-xs text-muted-foreground hover:text-foreground"
                            >
                              Cancel
                            </Link>
                          </td>
                        </tr>
                      )}
                      {searchParams.docs === b.id && (
                        <tr id={`bidder-${b.id}`} className="border-b last:border-0">
                          <td colSpan={8} className="bg-muted/30 p-4">
                            <p className="mb-3 text-xs text-muted-foreground">
                              Check a document only once it is in the vendor folder. Email is not the record.
                            </p>
                            <div className="grid gap-4 lg:grid-cols-3">
                              {docStagesFor(b.kind).map((stage) => (
                                <div key={stage}>
                                  <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                    {DOC_STAGE_LABEL[stage]}
                                  </div>
                                  <ul className="space-y-1">
                                    {REQUIRED_DOCS[stage].map((d) => {
                                      const got = have.has(d.key);
                                      return (
                                        <li key={d.key}>
                                          <form action={toggleDoc.bind(null, b.id, opp.id, d.key, got)}>
                                            <button type="submit" className="flex items-start gap-2 text-left text-sm">
                                              <span
                                                className={cn(
                                                  "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px]",
                                                  got && "border-foreground bg-foreground text-background",
                                                )}
                                              >
                                                {got ? "✓" : ""}
                                              </span>
                                              <span className={cn(got && "text-muted-foreground")}>{d.label}</span>
                                            </button>
                                          </form>
                                        </li>
                                      );
                                    })}
                                  </ul>
                                </div>
                              ))}
                            </div>
                            <Link
                              href={`/rfp/${opp.id}#bidders`}
                              scroll={false}
                              className="mt-3 inline-block text-xs text-muted-foreground hover:text-foreground"
                            >
                              Close
                            </Link>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="mb-5">
            <Empty>No bidders yet. Three per package, plus a bench of two.</Empty>
          </div>
        )}
        <details className="rounded-md border p-4" open={bidderRows.length === 0}>
          <summary className="cursor-pointer text-sm font-medium">Add a bidder</summary>
          <p className="mt-2 text-xs text-muted-foreground">
            License check in {st ?? "the project state"} before inviting, every time, even for known subs.
          </p>
          <ActionForm action={addBidder.bind(null, opp.id)} submitLabel="Add bidder" className="mt-4 space-y-4">
            <BidderFields idPrefix="add" today={today} />
          </ActionForm>
        </details>
      </Card>
    </div>
  );
}
