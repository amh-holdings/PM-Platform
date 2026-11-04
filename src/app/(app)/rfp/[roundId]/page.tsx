import { Fragment } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Input } from "@/components/ui/input";
import { todayIso } from "@/lib/bd";
import { formatCurrency, formatDate } from "@/lib/format";
import {
  BIDDER_KIND_LABEL,
  BIDDER_STATUS_LABEL,
  DECLINE_REASON_LABEL,
  DOC_STAGE_LABEL,
  MIN_LIVE_BIDDERS,
  PACKAGES,
  PACKAGE_LABEL,
  REQUIRED_DOCS,
  ROUND_KINDS,
  ROUND_KIND_LABEL,
  STATE_FIELDS,
  TARGET_BIDDERS,
  bidDocsFor,
  bidderFlags,
  costCodeBaseline,
  coverageDeadlinePassed,
  docStagesFor,
  flagText,
  footCheck,
  level,
  packageCoverage,
  stateProfileGaps,
  type BidderStatus,
  type RfpPackage,
  type RoundKind,
} from "@/lib/rfp";
import { rfpClient } from "@/lib/rfp-db";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { ActionForm } from "../../bd/_components/action-form";
import { Card, Empty, Field, Select, TextArea, tdClass, thClass } from "../../bd/_components/fields";
import {
  addBidder,
  addLine,
  addPackage,
  confirmLines,
  deleteBidder,
  deleteLine,
  deleteRound,
  logBidderContact,
  mapCostCode,
  setCarried,
  setEstimate,
  toggleDoc,
  unmapCostCode,
  updateBidder,
  updateLine,
  updateRound,
  uploadBid,
} from "../actions";
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

const small = "h-8 rounded-md border border-input bg-background px-2 text-xs";
const pkgShort = (p: string) => PACKAGE_LABEL[p as RfpPackage]?.split(" (")[0] ?? p;

export default async function RoundPage({
  params,
  searchParams,
}: {
  params: { roundId: string };
  searchParams: { edit?: string; docs?: string; lines?: string; upload?: string };
}) {
  const supabase = createClient();
  const db = rfpClient(supabase);
  const { data: round } = await db.from("rfp_rounds").select("*").eq("id", params.roundId).maybeSingle();
  if (!round) notFound();

  const [opp, project, bidders, pkgRows, mappings, costCodes, profile] = await Promise.all([
    round.opportunity_id
      ? db.from("bd_opportunities").select("id, name, company_id, county, size_mw_dc").eq("id", round.opportunity_id).maybeSingle()
      : Promise.resolve({ data: null }),
    round.project_id
      ? supabase.from("projects").select("id, name, client, dc_capacity_mw").eq("id", round.project_id).maybeSingle()
      : Promise.resolve({ data: null }),
    db.from("rfp_bidders").select("*").eq("round_id", round.id).order("package").order("firm"),
    db.from("rfp_round_packages").select("*").eq("round_id", round.id),
    db.from("rfp_round_cost_codes").select("*").eq("round_id", round.id),
    round.project_id
      ? supabase.from("cost_codes").select("id, code, name, estimated_cost").eq("project_id", round.project_id).order("code")
      : Promise.resolve({ data: [] as { id: string; code: string; name: string; estimated_cost: number | null }[] }),
    round.state ? db.from("bd_state_profiles").select("*").eq("state", round.state).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const company = opp.data
    ? (await db.from("bd_companies").select("name").eq("id", opp.data.company_id).maybeSingle()).data
    : null;

  const bidderRows = (bidders.data ?? []).map((b) => ({
    ...b,
    bid_total: b.bid_total === null ? null : Number(b.bid_total),
    printed_total: b.printed_total === null ? null : Number(b.printed_total),
  }));
  const ids = bidderRows.map((b) => b.id);
  const [docsRes, linesRes] = ids.length
    ? await Promise.all([
        db.from("rfp_bidder_docs").select("bidder_id, doc_key").in("bidder_id", ids),
        db.from("rfp_bid_lines").select("*").in("bidder_id", ids).order("sort_order"),
      ])
    : [{ data: [] as { bidder_id: string; doc_key: string }[] }, { data: [] }];
  const lines = (linesRes.data ?? []).map((l) => ({
    ...l,
    amount: l.amount === null ? null : Number(l.amount),
    quantity: l.quantity === null ? null : Number(l.quantity),
  }));

  const today = todayIso();
  const isProject = !!round.project_id;
  const docsBy = new Map<string, Set<string>>();
  for (const d of docsRes.data ?? []) docsBy.set(d.bidder_id, (docsBy.get(d.bidder_id) ?? new Set()).add(d.doc_key));
  const linesBy = new Map<string, typeof lines>();
  for (const l of lines) linesBy.set(l.bidder_id, [...(linesBy.get(l.bidder_id) ?? []), l]);

  // Baseline: the project's cost code budget where packages are mapped,
  // otherwise the estimate typed for the package.
  const ccRows = (costCodes.data ?? []).map((c) => ({ ...c, estimated_cost: c.estimated_cost === null ? null : Number(c.estimated_cost) }));
  const mapRows = mappings.data ?? [];
  const ccBaseline = costCodeBaseline(mapRows, ccRows);
  const baseline = new Map<string, number>();
  for (const p of pkgRows.data ?? []) if (p.estimate !== null) baseline.set(p.package, Number(p.estimate));
  ccBaseline.forEach((v, pkg) => baseline.set(pkg, v));
  const carried = new Map((pkgRows.data ?? []).map((p) => [p.package, p.carried_bidder_id]));
  const estimateBy = new Map((pkgRows.data ?? []).map((p) => [p.package, p.estimate === null ? null : Number(p.estimate)]));

  const leveling = level({
    bidders: bidderRows.map((b) => ({ id: b.id, firm: b.firm, confirmed: !!b.lines_confirmed_at })),
    lines,
    packages: [
      ...bidderRows.filter((b) => b.status !== "declined").map((b) => b.package),
      ...(pkgRows.data ?? []).map((p) => p.package),
    ],
    baseline,
    carried,
  });
  const firmOf = new Map(bidderRows.map((b) => [b.id, b.firm]));
  const coverage = packageCoverage(bidderRows);
  const coverageUrgent = coverageDeadlinePassed(round.due_date, today);
  const profileGaps = stateProfileGaps(profile.data);
  const ccName = new Map(ccRows.map((c) => [c.id, `${c.code} ${c.name}`]));
  const name = opp.data?.name ?? project.data?.name ?? "Round";
  const sizeMw = opp.data?.size_mw_dc ?? project.data?.dc_capacity_mw ?? null;

  const alerts: { tone: "bad" | "warn"; text: string }[] = [];
  if (!round.state) alerts.push({ tone: "warn", text: "No state on this round. Set it under Round details so the State Profile applies." });
  else if (!profile.data) alerts.push({ tone: "warn", text: `No State Profile for ${round.state}. Build it before the bid package goes out.` });
  else if (profileGaps.length) alerts.push({ tone: "warn", text: `${round.state} State Profile has required fields blank.` });
  for (const b of bidderRows) {
    if (b.extracted_at && !b.lines_confirmed_at) alerts.push({ tone: "warn", text: `${b.firm}: Claude read the bid. Check and confirm the lines before they count.` });
  }
  for (const c of coverage.filter((c) => c.thin)) {
    alerts.push({
      tone: coverageUrgent ? "bad" : "warn",
      text: `${pkgShort(c.package)}: ${c.live} live bidder${c.live === 1 ? "" : "s"}. Invite from the bench${coverageUrgent ? " now, bids are due inside two weeks" : ""}.`,
    });
  }
  for (const b of bidderRows) {
    for (const f of bidderFlags(b, today)) {
      if (f.kind !== "license_unverified") alerts.push({ tone: f.kind === "validity_lapsed" ? "bad" : "warn", text: `${b.firm}: ${flagText(f)}.` });
    }
  }
  for (const w of leveling.wholeScope) {
    alerts.push({
      tone: "bad",
      text: `${w.firm} is carried for ${w.carriedIn.map(pkgShort).join(", ")} but also priced ${w.pricedButNotCarried.map(pkgShort).join(", ")}. A sub keeps its whole bid: price the split before carrying part of it.`,
    });
  }
  const unlicensed = bidderRows.filter((b) => bidderFlags(b, today).some((f) => f.kind === "license_unverified"));
  if (unlicensed.length) alerts.push({ tone: "warn", text: `State license not verified: ${unlicensed.map((b) => b.firm).join(", ")}.` });

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">
            {name} - {round.label}
          </h1>
          <Pill tone={round.status === "open" ? "good" : "muted"}>{round.status === "open" ? "Open" : "Closed"}</Pill>
        </div>
        <p className="text-sm text-muted-foreground">
          {ROUND_KIND_LABEL[round.kind as RoundKind] ?? round.kind}
          {company?.name && ` - ${company.name}`}
          {project.data && " - Live project"}
          {round.state && ` - ${[opp.data?.county, round.state].filter(Boolean).join(", ")}`}
          {sizeMw !== null && ` - ${Number(sizeMw)} MW DC`}
          {` - Bids due ${formatDate(round.due_date)}`}
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
          <Empty>Nothing waiting.</Empty>
        )}
      </Card>

      <Card id="leveling" title="Leveling">
        <p className="mb-3 text-xs text-muted-foreground">
          Package totals from confirmed bids only. A blank cell means not bid, never $0. Baseline is{" "}
          {isProject ? "the cost code budget where a package is mapped, else the estimate" : "the estimate per package"}.
        </p>
        {leveling.rows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className={thClass}>Package</th>
                  <th className={cn(thClass, "text-right")}>{isProject ? "Budget / est." : "Estimate"}</th>
                  {leveling.bidders.map((b) => (
                    <th key={b.id} className={cn(thClass, "text-right")}>
                      {b.firm}
                    </th>
                  ))}
                  <th className={cn(thClass, "text-right")}>Spread</th>
                  <th className={thClass}>Carry</th>
                  <th className={cn(thClass, "text-right")}>Carried</th>
                  <th className={cn(thClass, "text-right")}>Variance</th>
                </tr>
              </thead>
              <tbody>
                {leveling.rows.map((r) => {
                  const fromBudget = ccBaseline.has(r.package);
                  const pricedBy = r.cells.filter((c) => c.amount !== null);
                  return (
                    <tr key={r.package} className="border-b last:border-0">
                      <td className={cn(tdClass, "font-medium")}>{pkgShort(r.package)}</td>
                      <td className={cn(tdClass, "text-right")}>
                        {fromBudget ? (
                          <span className="tabular-nums" title="Sum of mapped cost codes">
                            {formatCurrency(r.baseline)}
                          </span>
                        ) : (
                          <form action={setEstimate.bind(null, round.id, r.package)} className="flex justify-end gap-1">
                            <input
                              name="estimate"
                              defaultValue={estimateBy.get(r.package) ?? ""}
                              placeholder="$"
                              className={cn(small, "w-28 text-right tabular-nums")}
                            />
                            <button type="submit" className="text-xs text-muted-foreground hover:text-foreground">
                              Set
                            </button>
                          </form>
                        )}
                      </td>
                      {r.cells.map((c) => (
                        <td
                          key={c.bidderId}
                          className={cn(
                            tdClass,
                            "text-right tabular-nums",
                            c.isLow && "bg-emerald-50 font-medium dark:bg-emerald-950",
                            c.amount === null && "text-muted-foreground",
                          )}
                        >
                          {c.amount === null ? "Not bid" : formatCurrency(c.amount)}
                        </td>
                      ))}
                      <td className={cn(tdClass, "text-right tabular-nums")}>{formatCurrency(r.spread)}</td>
                      <td className={tdClass}>
                        <form action={setCarried.bind(null, round.id, r.package)} className="flex gap-1">
                          <select name="bidder_id" defaultValue={r.carriedBidderId ?? ""} className={cn(small, "max-w-40")}>
                            <option value="">-</option>
                            {pricedBy.map((c) => (
                              <option key={c.bidderId} value={c.bidderId}>
                                {firmOf.get(c.bidderId)}
                              </option>
                            ))}
                          </select>
                          <button type="submit" className="text-xs text-muted-foreground hover:text-foreground">
                            Set
                          </button>
                        </form>
                      </td>
                      <td className={cn(tdClass, "text-right tabular-nums")}>{formatCurrency(r.carried)}</td>
                      <td
                        className={cn(
                          tdClass,
                          "text-right tabular-nums",
                          r.variance !== null && r.variance > 0 && "text-destructive",
                        )}
                      >
                        {r.variance === null ? "-" : `${r.variance > 0 ? "+" : ""}${formatCurrency(r.variance)}`}
                      </td>
                    </tr>
                  );
                })}
                <tr className="border-t-2 font-semibold">
                  <td className={tdClass}>Total</td>
                  <td className={cn(tdClass, "text-right tabular-nums")}>{formatCurrency(leveling.baselineTotal)}</td>
                  {leveling.bidders.map((b) => (
                    <td key={b.id} />
                  ))}
                  <td />
                  <td />
                  <td className={cn(tdClass, "text-right tabular-nums")}>{formatCurrency(leveling.carriedTotal)}</td>
                  <td className={cn(tdClass, "text-right tabular-nums")}>
                    {formatCurrency(leveling.carriedTotal - leveling.baselineTotal)}
                  </td>
                </tr>
              </tbody>
            </table>
            {leveling.uncarried.length > 0 && (
              <p className="mt-3 text-xs text-muted-foreground">
                No carried price yet for {leveling.uncarried.map(pkgShort).join(", ")}. The carried total is not a
                price until every package has one, or a named allowance.
              </p>
            )}
            {sizeMw ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Carried $/W DC: {(leveling.carriedTotal / (Number(sizeMw) * 1_000_000)).toFixed(3)}
              </p>
            ) : null}
          </div>
        ) : (
          <Empty>Add bidders or a package to start the leveling.</Empty>
        )}
        <form action={addPackage.bind(null, round.id)} className="mt-4 flex flex-wrap items-end gap-2">
          <select name="package" defaultValue="" className={cn(small, "w-56")}>
            <option value="">Add a package</option>
            {PACKAGES.map((p) => (
              <option key={p} value={p}>
                {PACKAGE_LABEL[p]}
              </option>
            ))}
          </select>
          {!isProject && <input name="estimate" placeholder="Estimate $" className={cn(small, "w-32")} />}
          <button type="submit" className="text-xs font-medium text-muted-foreground hover:text-foreground">
            Add
          </button>
        </form>
      </Card>

      {isProject && (
        <Card id="budget" title="Packages to cost codes">
          <p className="mb-3 text-xs text-muted-foreground">
            Map each package to the cost codes it reprices. The budget column sums their estimated cost.
          </p>
          {mapRows.length ? (
            <ul className="mb-4 space-y-1 text-sm">
              {mapRows
                .slice()
                .sort((a, b) => a.package.localeCompare(b.package))
                .map((m) => (
                  <li key={m.id} className="flex items-center gap-3">
                    <span className="w-48 font-medium">{pkgShort(m.package)}</span>
                    <span className="flex-1">{ccName.get(m.cost_code_id) ?? "Removed cost code"}</span>
                    <span className="tabular-nums">
                      {formatCurrency(ccRows.find((c) => c.id === m.cost_code_id)?.estimated_cost ?? null)}
                    </span>
                    <form action={unmapCostCode.bind(null, m.id, round.id)}>
                      <button type="submit" className="text-xs text-muted-foreground hover:text-destructive">
                        Remove
                      </button>
                    </form>
                  </li>
                ))}
            </ul>
          ) : (
            <div className="mb-4">
              <Empty>No cost codes mapped yet.</Empty>
            </div>
          )}
          {ccRows.length ? (
            <form action={mapCostCode.bind(null, round.id)} className="flex flex-wrap items-end gap-2">
              <select name="package" defaultValue="" className={cn(small, "w-56")} required>
                <option value="">Package</option>
                {PACKAGES.map((p) => (
                  <option key={p} value={p}>
                    {PACKAGE_LABEL[p]}
                  </option>
                ))}
              </select>
              <select name="cost_code_id" defaultValue="" className={cn(small, "w-72")} required>
                <option value="">Cost code</option>
                {ccRows.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} {c.name} ({formatCurrency(c.estimated_cost)})
                  </option>
                ))}
              </select>
              <button type="submit" className="text-xs font-medium text-muted-foreground hover:text-foreground">
                Map
              </button>
            </form>
          ) : (
            <Empty>This project has no cost codes yet. Add them on the project&apos;s Costs tab.</Empty>
          )}
        </Card>
      )}

      <Card id="bidders" title={`Bidders (${bidderRows.length})`}>
        {coverage.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-2 text-xs">
            {coverage.map((c) => (
              <Pill key={c.package} tone={c.thin ? "bad" : c.belowTarget ? "warn" : "good"}>
                {pkgShort(c.package)}: {c.live} live, {c.received} in
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
                  <th className={thClass}>Invited for</th>
                  <th className={thClass}>Status</th>
                  <th className={thClass}>Bid read</th>
                  <th className={thClass}>Last contact</th>
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
                  const myLines = linesBy.get(b.id) ?? [];
                  const foot = footCheck(b.printed_total, myLines);
                  const expanded = searchParams.edit === b.id || searchParams.docs === b.id || searchParams.lines === b.id || searchParams.upload === b.id;
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
                        <td className={tdClass}>{pkgShort(b.package)}</td>
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
                        <td className={tdClass}>
                          {b.extracted_at ? (
                            <Link
                              href={`/rfp/${round.id}?lines=${b.id}#bidder-${b.id}`}
                              scroll={false}
                              className="underline-offset-4 hover:underline"
                            >
                              <span className="tabular-nums">{formatCurrency(foot.extracted)}</span>
                              <span className="ml-1">
                                {b.lines_confirmed_at ? <Pill tone="good">Confirmed</Pill> : <Pill tone="warn">Check</Pill>}
                              </span>
                              {foot.foots === false && (
                                <span className="ml-1">
                                  <Pill tone="bad">Does not foot</Pill>
                                </span>
                              )}
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </td>
                        <td className={cn(tdClass, "whitespace-nowrap")}>{formatDate(b.last_contact_on ?? b.invited_on)}</td>
                        <td className={cn(tdClass, "whitespace-nowrap")}>{formatDate(b.validity_date)}</td>
                        <td className={tdClass}>
                          <Link
                            href={`/rfp/${round.id}?docs=${b.id}#bidder-${b.id}`}
                            scroll={false}
                            className="whitespace-nowrap underline-offset-4 hover:underline"
                          >
                            {haveBidDocs} / {bidDocs.length}
                          </Link>
                        </td>
                        <td className={cn(tdClass, "text-right")}>
                          <div className="flex justify-end gap-3 whitespace-nowrap">
                            {b.status !== "declined" && (
                              <Link
                                href={`/rfp/${round.id}?upload=${b.id}#bidder-${b.id}`}
                                scroll={false}
                                className="text-xs font-medium hover:underline"
                              >
                                {b.extracted_at ? "Re-upload bid" : "Upload bid"}
                              </Link>
                            )}
                            {b.status !== "declined" && (
                              <form action={logBidderContact.bind(null, b.id, round.id, today)}>
                                <button type="submit" className="text-xs text-muted-foreground hover:text-foreground">
                                  Checked in
                                </button>
                              </form>
                            )}
                            <Link
                              href={`/rfp/${round.id}?edit=${b.id}#bidder-${b.id}`}
                              scroll={false}
                              className="text-xs text-muted-foreground hover:text-foreground"
                            >
                              Edit
                            </Link>
                            <form action={deleteBidder.bind(null, b.id, round.id)}>
                              <button type="submit" className="text-xs text-muted-foreground hover:text-destructive">
                                Remove
                              </button>
                            </form>
                          </div>
                        </td>
                      </tr>
                      {expanded && (
                        <tr id={`bidder-${b.id}`} className="border-b last:border-0">
                          <td colSpan={8} className="bg-muted/30 p-4">
                            {searchParams.upload === b.id && (
                              <ActionForm action={uploadBid.bind(null, b.id, round.id)} submitLabel="Read bid">
                                <p className="text-xs text-muted-foreground">
                                  Excel bid sheet, PDF proposal or CSV. Claude reads every line and sorts it by package.
                                  Takes up to two minutes. Nothing counts until you confirm the lines.
                                </p>
                                <Input name="file" type="file" accept=".xlsx,.xlsm,.xls,.pdf,.csv" required />
                              </ActionForm>
                            )}
                            {searchParams.edit === b.id && (
                              <ActionForm action={updateBidder.bind(null, b.id, round.id)} submitLabel="Save bidder">
                                <BidderFields idPrefix={`edit_${b.id}`} bidder={b} today={today} />
                              </ActionForm>
                            )}
                            {searchParams.docs === b.id && (
                              <>
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
                                              <form action={toggleDoc.bind(null, b.id, round.id, d.key, got)}>
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
                              </>
                            )}
                            {searchParams.lines === b.id && (
                              <div className="space-y-3">
                                <div className="flex flex-wrap items-center gap-3 text-sm">
                                  <span>
                                    {b.source_file_name ?? "Bid"} - read {b.extracted_at ? formatDate(b.extracted_at) : "-"}
                                  </span>
                                  <span className="tabular-nums">Lines: {formatCurrency(foot.extracted)}</span>
                                  <span className="tabular-nums">Printed total: {formatCurrency(b.printed_total)}</span>
                                  {foot.foots === false && <Pill tone="bad">Off by {formatCurrency(foot.difference)}</Pill>}
                                  {foot.foots === true && <Pill tone="good">Foots</Pill>}
                                </div>
                                {b.defects.length > 0 && (
                                  <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950">
                                    <div className="mb-1 font-medium">Defects Claude flagged</div>
                                    <ul className="list-disc space-y-0.5 pl-5">
                                      {b.defects.map((d, i) => (
                                        <li key={i}>{d}</li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                                {b.extraction_notes && (
                                  <div className="text-sm">
                                    <div className="mb-1 font-medium">Exclusions and clarifications</div>
                                    <p className="whitespace-pre-wrap text-muted-foreground">{b.extraction_notes}</p>
                                  </div>
                                )}
                                <div className="space-y-1">
                                  <div className="grid grid-cols-[10rem_1fr_5rem_4rem_8rem_8rem_auto] gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                    <span>Package</span>
                                    <span>Line</span>
                                    <span>Qty</span>
                                    <span>Unit</span>
                                    <span>Amount</span>
                                    <span>Source</span>
                                    <span />
                                  </div>
                                  {myLines.map((l) => (
                                    <div key={l.id} className="flex items-center gap-2">
                                      <form
                                        action={updateLine.bind(null, l.id, b.id, round.id)}
                                        className="grid flex-1 grid-cols-[10rem_1fr_5rem_4rem_8rem_8rem_auto] items-center gap-2"
                                      >
                                        <select name="package" defaultValue={l.package} className={small}>
                                          {PACKAGES.map((p) => (
                                            <option key={p} value={p}>
                                              {pkgShort(p)}
                                            </option>
                                          ))}
                                        </select>
                                        <input name="description" defaultValue={l.description} className={small} />
                                        <input name="quantity" defaultValue={l.quantity ?? ""} className={cn(small, "text-right")} />
                                        <input name="unit" defaultValue={l.unit ?? ""} className={small} />
                                        <input
                                          name="amount"
                                          defaultValue={l.amount ?? ""}
                                          placeholder="Excluded"
                                          className={cn(small, "text-right tabular-nums")}
                                        />
                                        <span className="truncate text-xs text-muted-foreground" title={l.source_ref ?? ""}>
                                          {l.source_ref ?? "-"}
                                        </span>
                                        <button type="submit" className="text-xs text-muted-foreground hover:text-foreground">
                                          Save
                                        </button>
                                      </form>
                                      <form action={deleteLine.bind(null, l.id, b.id, round.id)}>
                                        <button type="submit" className="text-xs text-muted-foreground hover:text-destructive">
                                          Delete
                                        </button>
                                      </form>
                                    </div>
                                  ))}
                                  <form
                                    action={addLine.bind(null, b.id, round.id)}
                                    className="grid grid-cols-[10rem_1fr_5rem_4rem_8rem_8rem_auto] items-center gap-2 pt-2"
                                  >
                                    <select name="package" defaultValue={b.package} className={small}>
                                      {PACKAGES.map((p) => (
                                        <option key={p} value={p}>
                                          {pkgShort(p)}
                                        </option>
                                      ))}
                                    </select>
                                    <input name="description" placeholder="Add a line" className={small} />
                                    <input name="quantity" className={cn(small, "text-right")} />
                                    <input name="unit" className={small} />
                                    <input name="amount" placeholder="$" className={cn(small, "text-right")} />
                                    <span />
                                    <button type="submit" className="text-xs font-medium text-muted-foreground hover:text-foreground">
                                      Add
                                    </button>
                                  </form>
                                </div>
                                <form action={confirmLines.bind(null, b.id, round.id, !b.lines_confirmed_at)} className="flex items-center gap-3 pt-2">
                                  <button
                                    type="submit"
                                    className={cn(
                                      "rounded-md px-3 py-1.5 text-sm font-medium",
                                      b.lines_confirmed_at ? "border" : "bg-foreground text-background",
                                    )}
                                  >
                                    {b.lines_confirmed_at ? "Unconfirm" : "Confirm lines"}
                                  </button>
                                  <span className="text-xs text-muted-foreground">
                                    Confirmed lines feed the leveling. Any edit un-confirms them.
                                  </span>
                                </form>
                              </div>
                            )}
                            <Link
                              href={`/rfp/${round.id}#bidders`}
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
            License check in {round.state ?? "the project state"} before inviting, every time, even for known subs.
          </p>
          <ActionForm action={addBidder.bind(null, round.id)} submitLabel="Add bidder" className="mt-4 space-y-4">
            <BidderFields idPrefix="add" today={today} />
          </ActionForm>
        </details>
      </Card>

      <Card
        title={round.state ? `${round.state} State Profile` : "State Profile"}
        action={
          <Link
            href={round.state ? `/rfp/states?edit=${round.state}` : "/rfp/states"}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
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
          <Empty>No profile for this state yet.</Empty>
        )}
      </Card>

      <details className="rounded-lg border bg-card p-5 shadow-sm">
        <summary className="cursor-pointer text-base font-semibold">Round details</summary>
        <ActionForm action={updateRound.bind(null, round.id)} submitLabel="Save" className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Field label="Round name" htmlFor="r_label" required>
              <Input id="r_label" name="label" required defaultValue={round.label} />
            </Field>
            <Field label="Type" htmlFor="r_kind">
              <Select
                id="r_kind"
                name="kind"
                defaultValue={round.kind}
                options={ROUND_KINDS.map((k) => ({ value: k, label: ROUND_KIND_LABEL[k] }))}
              />
            </Field>
            <Field label="State" htmlFor="r_state">
              <Input id="r_state" name="state" maxLength={2} defaultValue={round.state ?? ""} />
            </Field>
            <Field label="Bids due" htmlFor="r_due">
              <Input id="r_due" name="due_date" type="date" defaultValue={round.due_date ?? ""} />
            </Field>
            <Field label="Status" htmlFor="r_status">
              <Select
                id="r_status"
                name="status"
                defaultValue={round.status}
                options={[
                  { value: "open", label: "Open" },
                  { value: "closed", label: "Closed" },
                ]}
              />
            </Field>
          </div>
          <Field label="Notes" htmlFor="r_notes">
            <TextArea id="r_notes" name="notes" rows={2} defaultValue={round.notes} />
          </Field>
        </ActionForm>
        <form action={deleteRound.bind(null, round.id)} className="mt-6 border-t pt-4">
          <button type="submit" className="text-sm text-muted-foreground hover:text-destructive">
            Delete this round, its bidders and their lines
          </button>
        </form>
      </details>
    </div>
  );
}
