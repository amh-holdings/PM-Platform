"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { describeTypedVsEvidence } from "@/lib/afp-po-staging";
import { formatCurrency } from "@/lib/format";
import { shortMonthLabel } from "@/lib/cashflow";

import { createAfpFromBillThisPeriod } from "../pay-app-actions";
import type {
  BillableRow,
  BilledElsewhere,
  NotBillableLine,
} from "../billing-actions";
import { billedElsewhereMessage } from "@/lib/pay-app-undo";
import { UndoAfpButton } from "./undo-afp-button";
import { periodLabel } from "@/lib/billing-period";

type Props = {
  projectId: string;
  rows: BillableRow[];
  /** Linked lines with nothing to bill this period, and why. */
  notBillable: NotBillableLine[];
  variant: "page" | "widget";
  /** YYYY-MM-01 of the month being billed. */
  periodMonth: string;
  /** Set when the period is empty because its lines went onto an AFP. */
  billedTo?: BilledElsewhere | null;
};

const CONF_STYLES: Record<string, string> = {
  high: "text-emerald-700",
  medium: "text-amber-700",
  low: "text-orange-700",
  none: "text-muted-foreground",
};

export function BillThisPeriodClient({
  projectId,
  rows,
  notBillable,
  variant,
  periodMonth,
  billedTo,
}: Props) {
  // Default selection: ALL forecast rows checked, suggestion rows unchecked
  // (so the panel acts like the old Next AFP panel by default - lower friction).
  const initialSelected = new Set(
    rows
      .filter((r) => r.kind === "forecast" && !r.blockedReason)
      .map((r) => r.key),
  );
  const [selected, setSelected] = useState<Set<string>>(initialSelected);
  // The recommendation wins by default. r.amount on a forecast row is the
  // imported cash-flow plan; recommendedAmount is what the approved field
  // reports and the schedule support. Defaulting to the plan meant Create AFP
  // was pre-loaded with a number nobody had verified.
  const [amounts, setAmounts] = useState<Record<string, number>>(
    Object.fromEntries(
      rows.map((r) => [
        r.key,
        r.kind === "forecast" && r.recommendedAmount != null
          ? r.recommendedAmount
          : r.amount,
      ]),
    ),
  );
  // A row proposing nothing is not a projection for this period. It is a note
  // about why a line cannot bill yet, and it belongs behind a disclosure -
  // nine SOV lines with one real number and eight zeroes reads as "everything
  // is here" when the honest answer is "one thing is billable".
  //
  // Kept rather than dropped, because a $0 with a reason is how you find out a
  // line is linked to a summary row. Dropping it silently is how it stays
  // broken until somebody reconciles the AFP.
  const isProposing = (r: BillableRow) =>
    r.kind === "suggestion"
      ? r.amount > 0
      : !r.blockedReason && (r.recommendedAmount ?? r.amount) > 0;

  const proposing = rows.filter(isProposing);
  const unsupported = rows.filter((r) => !isProposing(r));
  const [showUnsupported, setShowUnsupported] = useState(false);
  const visibleRows = showUnsupported ? [...proposing, ...unsupported] : proposing;

  const [openEvidence, setOpenEvidence] = useState<Set<string>>(new Set());
  function toggleEvidence(key: string) {
    setOpenEvidence((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  const [appNumber, setAppNumber] = useState(
    rows.find((r) => r.kind === "forecast")?.afpNumber ?? "",
  );

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const { count, gross } = useMemo(() => {
    let c = 0;
    let g = 0;
    for (const r of rows) {
      if (selected.has(r.key)) {
        c++;
        g += Number(amounts[r.key] ?? r.amount);
      }
    }
    return { count: c, gross: g };
  }, [rows, selected, amounts]);

  const disabled = count === 0;

  return (
    <section
      className={cn(
        "rounded-lg border border-emerald-500/40 bg-emerald-500/5",
        variant === "page" ? "p-4 shadow-sm" : "p-3",
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3
            className={cn(
              "font-semibold uppercase tracking-wide text-emerald-700",
              variant === "page" ? "text-sm" : "text-xs",
            )}
          >
            Bill {periodLabel(periodMonth)}
          </h3>
          <p className="text-xs text-muted-foreground">
            {/* Was three dense lines explaining the machinery. Anything a
                row needs to say, the row says. */}
            Tick what to bill, then create the AFP. Anything the evidence does
            not support arrives unchecked with the reason.
          </p>
        </div>
      </div>

      <form action={createAfpFromBillThisPeriod} className="mt-3 space-y-3">
        <input type="hidden" name="projectId" value={projectId} />

        {/* For each selected row, render the right hidden inputs. */}
        {rows
          .filter((r) => selected.has(r.key))
          .map((r) =>
            r.kind === "forecast" ? (
              /* The amount box next to a forecast row used to go nowhere. The
                 row posted its entry id and nothing else, so the server billed
                 whatever the entry already held and the number that had just
                 been typed was thrown away without a word. A blocked row
                 arrives at $0 precisely so somebody can overwrite it, which
                 only worked on suggestion rows. */
              <div key={r.key} className="contents">
                <input type="hidden" name="forecastEntryIds" value={r.entryId} />
                <input
                  type="hidden"
                  name="forecastAmounts"
                  value={amounts[r.key] ?? r.amount}
                />
              </div>
            ) : (
              <div key={r.key} className="contents">
                <input
                  type="hidden"
                  name="suggestionLineIds"
                  value={r.billingLineId}
                />
                <input
                  type="hidden"
                  name="suggestionAmounts"
                  value={amounts[r.key] ?? r.amount}
                />
                <input
                  type="hidden"
                  name="suggestionPeriods"
                  value={r.periodMonth}
                />
              </div>
            ),
          )}

        {billedTo && (
          <div className="mb-2 flex flex-wrap items-start justify-between gap-2 rounded-md border border-blue-500/30 bg-blue-50/60 p-2.5">
            <div className="text-xs">
              <div className="font-medium text-blue-900">
                {billedElsewhereMessage({
                  periodLabel: periodLabel(periodMonth),
                  appNumber: billedTo.appNumber,
                  lineCount: billedTo.entryCount,
                  amount: billedTo.amount,
                  formatAmount: formatCurrency,
                })}
              </div>
              <div className="mt-0.5 text-blue-900/80">
                {billedTo.undoable
                  ? "Created by mistake? Undo puts the lines back on this panel and deletes the draft."
                  : billedTo.blockedReason}
              </div>
            </div>
            {billedTo.undoable && (
              <UndoAfpButton
                projectId={projectId}
                payAppId={billedTo.payAppId}
                appNumber={billedTo.appNumber}
                entryCount={billedTo.entryCount}
              />
            )}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="border-b border-emerald-500/20">
                <th className="w-8 py-1.5 text-left font-medium"></th>
                <th className="py-1.5 pr-2 text-left font-medium">Item</th>
                <th className="py-1.5 pr-2 text-left font-medium">Period</th>
                <th className="py-1.5 pr-2 text-left font-medium">Source</th>
                <th className="py-1.5 pr-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((r) => {
                const isChecked = selected.has(r.key);
                // Label what the AMOUNT is, not where the row came from - the
                // row may be a forecast entry while the figure is the
                // evidence-based recommendation that replaced it.
                const usingRecommendation =
                  r.kind === "suggestion" ||
                  (r.kind === "forecast" && r.recommendedAmount != null);
                // "Field evidence" is right for a line measured by approved
                // field reports and schedule progress. A procurement line is
                // measured by PO payment milestones - there is no field
                // evidence involved, and calling it that sends the reader
                // looking for a daily report that does not exist.
                const fromMilestones = (r.evidence ?? []).some(
                  (e) => e.source === "payment milestone",
                );
                // A figure somebody typed on a PO's Add to AFP dialog is not a
                // milestone reading and not a forecast. Calling it either sends
                // the reader to the wrong place to change it.
                const typedFromPo = r.kind === "forecast" && r.typedFromPo === true;
                const sourceLabel = typedFromPo
                  ? "Typed from POs"
                  : usingRecommendation
                    ? fromMilestones
                      ? "Payment milestones"
                      : "Field evidence"
                    : `Forecast (${r.status})${r.kind === "forecast" && r.afpNumber ? ` ${r.afpNumber}` : ""}`;
                const sourceColor = typedFromPo
                  ? "text-emerald-700"
                  : usingRecommendation
                  ? CONF_STYLES[
                      r.kind === "suggestion"
                        ? r.confidence
                        : r.scheduleConfidence ?? "none"
                    ] ?? "text-emerald-700"
                  : "text-muted-foreground";
                return (
                  <tr
                    key={r.key}
                    className={cn(
                      "border-b border-emerald-500/10 last:border-0 align-top",
                      isChecked && "bg-emerald-500/10",
                    )}
                  >
                    <td className="py-1.5">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggle(r.key)}
                        className="h-3.5 w-3.5 accent-emerald-700"
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <div className="font-medium">
                        {r.itemNumber} {r.description}
                      </div>
                      {r.kind === "suggestion" && (
                        /* "target 0%, billed $82,619.12 - payment milestones"
                           repeated the Source column and printed a target of
                           0% on a row whose whole point is that the target is
                           disputed. A blocked row says it all in the amber
                           line below; an ordinary one only needs the number it
                           is measured against. */
                        <div
                          className="mt-0.5 text-[10px] text-muted-foreground"
                          title={r.reasons.join(" | ")}
                        >
                          {r.blockedReason
                            ? null
                            : `${formatCurrency(r.alreadyBilled)} billed so far`}
                        </div>
                      )}
                      {/* What the typed figure is made of. Several POs can
                          bill one SOV line in one period, and the sum on its
                          own cannot be checked against anything. */}
                      {r.kind === "forecast" && r.manualBreakdown && (
                        <div className="mt-0.5 text-[10px] text-emerald-700">
                          {r.manualBreakdown}
                        </div>
                      )}
                      {/* What the evidence makes of a typed figure. Said, not
                          acted on: a typed amount is a decision, not an
                          estimate for the app to correct. */}
                      {r.kind === "forecast" &&
                        r.typedFromPo &&
                        (() => {
                          const note = describeTypedVsEvidence({
                            typedAmount: r.amount,
                            evidenceAmount: r.scheduleSuggestedAmount,
                            formatAmount: formatCurrency,
                          });
                          return note ? (
                            <div className="mt-0.5 text-[10px] text-muted-foreground">
                              {note}
                            </div>
                          ) : null;
                        })()}
                      {/* Both kinds can be blocked now. A suggestion row
                          carrying one is a line whose earned value is masked
                          by pre-app billing - it arrives at $0 for a person to
                          overwrite, not as a verdict. */}
                      {r.blockedReason && (
                        <div className="mt-0.5 text-[10px] font-medium text-amber-700">
                          ⚠ {r.blockedReason}
                        </div>
                      )}
                      {r.kind === "forecast" &&
                        r.recommendedAmount != null &&
                        (() => {
                          const rec = r.recommendedAmount ?? 0;
                          const fcst = r.amount;
                          const ratio = rec > 0 ? fcst / rec : Infinity;
                          const bigMismatch = ratio >= 1.5 || ratio <= 0.5;
                          return (
                            <div className="mt-0.5 text-[10px] text-muted-foreground">
                              <span
                                className={cn(
                                  bigMismatch && "font-medium text-amber-700",
                                )}
                              >
                                {bigMismatch && "⚠ "}
                                Cash-flow forecast was {formatCurrency(fcst)}
                              </span>
                              {" - "}
                              {r.scheduleConfidence} confidence
                            </div>
                          );
                        })()}
                      {r.evidence && r.evidence.length > 0 && (
                        <>
                          <button
                            type="button"
                            onClick={() => toggleEvidence(r.key)}
                            className="mt-0.5 text-[10px] underline underline-offset-2 text-muted-foreground hover:text-foreground"
                          >
                            {/* A procurement line's evidence is PO payment
                                milestones, not schedule tasks. Calling them
                                tasks is why nobody looks here when a linked PO
                                is not billing - the one place that says WHY
                                sounds like it is about something else. */}
                            {(() => {
                              const isProcurement = r.evidence.some(
                                (e) => e.source === "payment milestone",
                              );
                              const noun = isProcurement
                                ? `payment milestone${r.evidence.length === 1 ? "" : "s"}`
                                : `task${r.evidence.length === 1 ? "" : "s"}`;
                              const verb = openEvidence.has(r.key) ? "Hide" : "Show";
                              return `${verb} the ${r.evidence.length} ${noun} behind this`;
                            })()}
                          </button>
                          {openEvidence.has(r.key) &&
                            (() => {
                              // Duration, weight and source are how a SCHEDULE
                              // roll-up is audited. On a milestone they are a
                              // dash, 0.0% and the same two words on every row -
                              // three columns of nothing, repeated nine times.
                              // The EARNED / not earned text already carries
                              // the state and the reason.
                              const milestones = r.evidence!.some(
                                (e) => e.source === "payment milestone",
                              );
                              return (
                            <table className="mt-1 w-full text-[10px]">
                              <tbody>
                                {r.evidence!
                                  .slice()
                                  .sort((a, b) => b.pct * b.weight - a.pct * a.weight)
                                  .map((e) => (
                                    <tr
                                      key={e.wbsCode}
                                      className={cn(
                                        e.pct === 0 && "text-muted-foreground/60",
                                      )}
                                    >
                                      <td className="pr-2 font-mono">
                                        {/* The job number is the same on every
                                            row and never the thing being read. */}
                                        {milestones
                                          ? e.wbsCode.replace(/^\S*\s+/, "")
                                          : e.wbsCode}
                                      </td>
                                      <td className="pr-2">{e.taskName}</td>
                                      {!milestones && (
                                        <>
                                      <td className="pr-2 text-right tabular-nums">
                                        {e.pct}%
                                      </td>
                                      <td className="pr-2 text-right tabular-nums text-muted-foreground">
                                        {e.durationDays != null
                                          ? `${e.durationDays}d`
                                          : "-"}
                                      </td>
                                      <td className="pr-2 text-right tabular-nums text-muted-foreground">
                                        {(e.weight * 100).toFixed(1)}%
                                      </td>
                                      <td className="text-muted-foreground">
                                        {e.source === "pct_complete"
                                          ? "field report"
                                          : e.source}
                                      </td>
                                        </>
                                      )}
                                    </tr>
                                  ))}
                              </tbody>
                            </table>
                              );
                            })()}
                        </>
                      )}
                    </td>
                    <td className="py-1.5 pr-2">
                      {shortMonthLabel(r.periodMonth)}
                    </td>
                    <td className={cn("py-1.5 pr-2 font-medium", sourceColor)}>
                      {sourceLabel}
                    </td>
                    <td className="py-1.5 pr-2 text-right">
                      <Input
                        type="number"
                        step="0.01"
                        value={amounts[r.key] ?? r.amount}
                        onChange={(e) =>
                          setAmounts((prev) => ({
                            ...prev,
                            [r.key]: Number(e.target.value || 0),
                          }))
                        }
                        className="ml-auto h-7 w-28 text-right text-xs"
                      />
                    </td>
                  </tr>
                );
              })}
              {visibleRows.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-4 text-center text-muted-foreground">
                    {billedTo
                      ? billedElsewhereMessage({
                          periodLabel: periodLabel(periodMonth),
                          appNumber: billedTo.appNumber,
                          lineCount: billedTo.entryCount,
                          amount: billedTo.amount,
                          formatAmount: formatCurrency,
                        })
                      : unsupported.length > 0
                        ? `Nothing billable for ${periodLabel(periodMonth)}. ${unsupported.length} line${unsupported.length === 1 ? "" : "s"} could not be supported - see below.`
                        : "Nothing to bill: no forecast entries queued up, no schedule progress detected."}
                  </td>
                </tr>
              )}
              {unsupported.length > 0 && (
                <tr>
                  <td colSpan={5} className="py-1.5">
                    <button
                      type="button"
                      onClick={() => setShowUnsupported((v) => !v)}
                      className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    >
                      {/* "not billable" was true when these were dead rows.
                          A blocked row now carries an editable amount, so the
                          honest word is "needs a decision" - and it stops this
                          colliding with the "nothing to bill" list below, which
                          really is read-only.

                          It names the items. "Show 1 line needing a decision"
                          is a grey link that could be about anything, and
                          somebody hunting for SOV 5.05 has no reason to open
                          it. Print the item numbers and the row is findable by
                          the thing the person is actually looking for. */}
                      {showUnsupported ? "Hide" : "Show"} {unsupported.length} line
                      {unsupported.length === 1 ? "" : "s"} needing a decision
                      {": "}
                      {unsupported
                        .slice(0, 4)
                        .map((u) => u.itemNumber)
                        .join(", ")}
                      {unsupported.length > 4 ? ` and ${unsupported.length - 4} more` : ""}
                    </button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {variant === "page" && notBillable.length > 0 && (
          /* The answer to "why is my line not here". A linked line that earned
             nothing new used to appear nowhere at all - not in the rows, not
             in the hidden list, and not in the unlinked banner, which is the
             one place somebody hunting for it would look. */
          <details className="mb-3 rounded-md border bg-muted/30 p-3 text-xs">
            <summary className="cursor-pointer font-medium">
              {notBillable.length} linked line
              {notBillable.length === 1 ? "" : "s"} with nothing to bill this
              period, and why
            </summary>
            <table className="mt-2 w-full">
              <tbody>
                {notBillable.map((n) => (
                  <tr key={n.billingLineId} className="border-t align-top">
                    <td className="py-1.5 pr-2 font-mono">{n.itemNumber}</td>
                    <td className="py-1.5 pr-2">
                      <div>{n.description}</div>
                      <div className="mt-0.5 text-[10px] text-muted-foreground">
                        {n.reason}
                      </div>
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                      {formatCurrency(n.remaining)}
                      <span className="block text-[10px]">left on the line</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}

        {rows.length > 0 && (
          <div className="flex flex-wrap items-end justify-between gap-3 rounded-md border border-emerald-500/30 bg-card p-3">
            <div className="flex items-end gap-3">
              <div>
                <Label htmlFor="bill-afp-number" className="text-xs">
                  AFP number
                </Label>
                <Input
                  id="bill-afp-number"
                  name="appNumber"
                  value={appNumber}
                  onChange={(e) => setAppNumber(e.target.value)}
                  placeholder="e.g. AFP 3"
                  className="mt-1 h-8 w-32 text-xs"
                />
              </div>
              <div className="text-xs">
                <div className="text-muted-foreground">
                  {count} of {rows.length} selected
                </div>
                <div className="font-semibold text-emerald-700">
                  {formatCurrency(gross)} gross
                </div>
              </div>
            </div>
            <Button
              type="submit"
              disabled={disabled}
              className="bg-emerald-700 hover:bg-emerald-700/90"
            >
              Create AFP from selected
            </Button>
          </div>
        )}
      </form>
    </section>
  );
}
