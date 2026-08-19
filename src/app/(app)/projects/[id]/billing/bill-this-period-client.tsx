"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import { shortMonthLabel } from "@/lib/cashflow";

import { createAfpFromBillThisPeriod } from "../pay-app-actions";
import type { BillableRow, HiddenForecast } from "../billing-actions";
import { periodLabel } from "@/lib/billing-period";

type Props = {
  projectId: string;
  rows: BillableRow[];
  hidden: HiddenForecast[];
  variant: "page" | "widget";
  /** YYYY-MM-01 of the month being billed. */
  periodMonth: string;
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
  hidden,
  variant,
  periodMonth,
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
            What the field evidence supports for{" "}
            {periodLabel(periodMonth)} - existing forecasts alongside live
            schedule-driven amounts, measured as of the last day of the month.
            Rows that the schedule does not support are shown with the reason
            and arrive unchecked.
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
              <input
                key={r.key}
                type="hidden"
                name="forecastEntryIds"
                value={r.entryId}
              />
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
              {rows.map((r) => {
                const isChecked = selected.has(r.key);
                // Label what the AMOUNT is, not where the row came from - the
                // row may be a forecast entry while the figure is the
                // evidence-based recommendation that replaced it.
                const usingRecommendation =
                  r.kind === "suggestion" ||
                  (r.kind === "forecast" && r.recommendedAmount != null);
                const sourceLabel = usingRecommendation
                  ? "Field evidence"
                  : `Forecast (${r.status})${r.kind === "forecast" && r.afpNumber ? ` ${r.afpNumber}` : ""}`;
                const sourceColor = usingRecommendation
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
                        <div
                          className="mt-0.5 text-[10px] text-muted-foreground"
                          title={r.reasons.join(" | ")}
                        >
                          target {(r.targetPct * 100).toFixed(0)}%, billed{" "}
                          {formatCurrency(r.alreadyBilled)} - {r.sourcesSummary}
                        </div>
                      )}
                      {r.kind === "forecast" && r.blockedReason && (
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
                            {`${openEvidence.has(r.key) ? "Hide" : "Show"} the ${r.evidence.length} task${r.evidence.length === 1 ? "" : "s"} behind this`}
                          </button>
                          {openEvidence.has(r.key) && (
                            <table className="mt-1 w-full text-[10px]">
                              <tbody>
                                {r.evidence
                                  .slice()
                                  .sort((a, b) => b.pct * b.weight - a.pct * a.weight)
                                  .map((e) => (
                                    <tr
                                      key={e.wbsCode}
                                      className={cn(
                                        e.pct === 0 && "text-muted-foreground/60",
                                      )}
                                    >
                                      <td className="pr-2 font-mono">{e.wbsCode}</td>
                                      <td className="pr-2">{e.taskName}</td>
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
                                    </tr>
                                  ))}
                              </tbody>
                            </table>
                          )}
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
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-4 text-center text-muted-foreground">
                    Nothing to bill: no forecast entries queued up, no schedule
                    progress detected.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {hidden.length > 0 && (
          <details className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
            <summary className="cursor-pointer font-medium text-amber-800">
              {hidden.length} forecast{hidden.length === 1 ? "" : "s"} hidden - schedule shows no progress on{" "}
              {hidden.length === 1 ? "this item" : "these items"}
            </summary>
            <p className="mt-2 text-[10px] text-muted-foreground">
              Forecast rows where the linked schedule tasks all read 0% progress.
              If work IS happening but the schedule is stale, update the task
              status / pct_complete on the Schedule page or via a DPR.
            </p>
            <table className="mt-2 w-full">
              <thead className="text-muted-foreground">
                <tr className="border-b border-amber-500/20">
                  <th className="py-1 pr-2 text-left font-medium">Item</th>
                  <th className="py-1 pr-2 text-left font-medium">Period</th>
                  <th className="py-1 pr-2 text-right font-medium">Amount</th>
                  <th className="py-1 pr-2 text-left font-medium">Reason</th>
                </tr>
              </thead>
              <tbody>
                {hidden.map((h, i) => (
                  <tr key={i} className="border-b border-amber-500/10 last:border-0">
                    <td className="py-1 pr-2">
                      {h.itemNumber} {h.description}
                    </td>
                    <td className="py-1 pr-2">
                      {shortMonthLabel(h.periodMonth)}
                    </td>
                    <td className="py-1 pr-2 text-right">
                      {formatCurrency(h.amount)}
                    </td>
                    <td className="py-1 pr-2 text-muted-foreground">
                      {h.reason}
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
