"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/format";
import type { EvidenceSummary } from "@/lib/sub-billing";
import { cn } from "@/lib/utils";

import { decideBill, recommendBill, runVerification } from "../../actions";

type Line = {
  id: string;
  item_number: string;
  description: string;
  scheduled_value: number;
  from_previous: number;
  this_period: number;
  pct_billed: number | null;
  /** Field record to date at the period end, as a fraction and in dollars. */
  built_pct: number | null;
  built_amount: number | null;
  /** What the system says this period should be (a set figure, else the engine default). */
  should: number;
  evidence: EvidenceSummary | null;
  cm_note: string | null;
};

type Props = {
  projectId: string;
  appId: string;
  status: string;
  decided: boolean;
  showDollars: boolean;
  canRecommend: boolean;
  canApprove: boolean;
  cmNotes: string | null;
  approvalNotes: string | null;
  lines: Line[];
};

const pct = (v: number | null) => (v == null ? "-" : `${(v * 100).toFixed(1)}%`);
const round2 = (v: number) => Math.round(v * 100) / 100;

// Per SOV line, read left to right the way a G703 is: scheduled value, billed
// to date on prior applications, what the sub wants this period, and what the
// system says to bill - with the field record's built-to-date percent under
// it, since that is the reason for the figure. The CM, who does not see
// dollars, gets the same rows in percent with a box to certify.
export function ReviewForm({
  projectId,
  appId,
  status,
  decided,
  showDollars,
  canRecommend,
  canApprove,
  cmNotes,
  approvalNotes,
  lines,
}: Props) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const cmMode = canRecommend && !canApprove;
  const [showAll, setShowAll] = useState(false);

  const visible = showAll ? lines : lines.filter((l) => l.this_period !== 0);
  const totals = lines.reduce(
    (t, l) => ({
      sv: t.sv + l.scheduled_value,
      prev: t.prev + l.from_previous,
      billed: t.billed + l.this_period,
      should: t.should + (l.this_period !== 0 ? l.should : 0),
    }),
    { sv: 0, prev: 0, billed: 0, should: 0 },
  );

  function submit(fn: (fd: FormData) => Promise<{ ok: boolean; error?: string }>) {
    return (fd: FormData) => {
      setError(null);
      startTransition(async () => {
        const res = await fn(fd);
        if (!res.ok) setError(res.error ?? "Something went wrong");
      });
    };
  }

  return (
    <form
      action={submit((fd) =>
        canApprove && fd.get("_intent") === "approve"
          ? decideBill(projectId, appId, "approved", fd)
          : canApprove && fd.get("_intent") === "reject"
            ? decideBill(projectId, appId, "rejected", fd)
            : recommendBill(projectId, appId, fd),
      )}
      className="space-y-4"
    >
      <section className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">Schedule of values</h3>
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            {showAll ? "Show billed lines only" : `Show all ${lines.length} lines`}
          </button>
        </div>

        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2">Description and field record</th>
                {showDollars ? (
                  <>
                    <th className="px-3 py-2 text-right">Scheduled value</th>
                    <th className="px-3 py-2 text-right">Billed to date</th>
                    <th className="px-3 py-2 text-right">Requested this period</th>
                    <th className="px-3 py-2 text-right">System says to bill</th>
                    <th className="px-3 py-2 text-right">Difference</th>
                  </>
                ) : (
                  <>
                    <th className="px-3 py-2 text-right">Built to date</th>
                    <th className="px-3 py-2 text-right">Sub billed to date</th>
                  </>
                )}
                {cmMode && <th className="px-3 py-2 text-right">Certify %</th>}
              </tr>
            </thead>
            <tbody className="divide-y">
              {visible.map((l) => {
                const active = l.this_period !== 0;
                const diff = active ? round2(l.this_period - l.should) : 0;
                return (
                  <tr key={l.id} className={cn(!active && "text-muted-foreground", diff > 0.004 && "bg-red-50/60")}>
                    <td className="px-3 py-2 align-top tabular-nums">{l.item_number}</td>
                    <td className="px-3 py-2 align-top">
                      <div className="font-medium">{l.description}</div>
                      {l.evidence && (
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {l.evidence.headline}
                          {l.evidence.open.length > 0 && (
                            <>
                              . Open: {l.evidence.open.join(", ")}
                              {l.evidence.more > 0 && `, +${l.evidence.more} more`}
                            </>
                          )}
                        </div>
                      )}
                    </td>
                    {showDollars ? (
                      <>
                        <td className="px-3 py-2 text-right align-top tabular-nums">{formatCurrency(l.scheduled_value)}</td>
                        <td className="px-3 py-2 text-right align-top tabular-nums">
                          <div>{formatCurrency(l.from_previous)}</div>
                          <div className="text-xs text-muted-foreground">
                            {pct(l.scheduled_value > 0 ? l.from_previous / l.scheduled_value : null)}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right align-top tabular-nums">
                          <div>{active ? formatCurrency(l.this_period) : "-"}</div>
                          {active && <div className="text-xs text-muted-foreground">takes it to {pct(l.pct_billed)}</div>}
                        </td>
                        <td className="px-3 py-2 text-right align-top tabular-nums">
                          {!active ? (
                            "-"
                          ) : canApprove ? (
                            <input
                              name={`approved__${l.item_number}`}
                              defaultValue={l.should.toFixed(2)}
                              inputMode="decimal"
                              className="w-28 rounded-md border bg-background px-2 py-1 text-right text-sm"
                            />
                          ) : (
                            formatCurrency(l.should)
                          )}
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {l.built_pct == null ? "CM to certify" : `${pct(l.built_pct)} built`}
                          </div>
                        </td>
                        <td
                          className={cn(
                            "px-3 py-2 text-right align-top tabular-nums",
                            diff > 0.004 && "font-semibold text-red-700",
                          )}
                        >
                          {diff > 0.004 ? `Hold ${formatCurrency(diff)}` : active ? "-" : ""}
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="px-3 py-2 text-right align-top tabular-nums">
                          {l.built_pct == null ? <span className="text-xs text-muted-foreground">CM to certify</span> : pct(l.built_pct)}
                        </td>
                        <td className="px-3 py-2 text-right align-top tabular-nums">{pct(l.pct_billed)}</td>
                      </>
                    )}
                    {cmMode && (
                      <td className="px-3 py-2 text-right align-top">
                        {active ? (
                          <>
                            <input
                              name={`verified_pct__${l.item_number}`}
                              defaultValue={l.built_pct != null ? (l.built_pct * 100).toFixed(1) : ""}
                              inputMode="decimal"
                              className="w-20 rounded-md border bg-background px-2 py-1 text-right text-sm"
                            />
                            <input
                              name={`cm_note__${l.item_number}`}
                              defaultValue={l.cm_note ?? ""}
                              placeholder="note"
                              className="mt-1 w-full rounded-md border bg-background px-2 py-1 text-xs"
                            />
                          </>
                        ) : (
                          "-"
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
            {showDollars && (
              <tfoot className="border-t-2 bg-muted/30 font-medium">
                <tr>
                  <td className="px-3 py-2" colSpan={2}>
                    Total
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(round2(totals.sv))}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(round2(totals.prev))}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(round2(totals.billed))}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(round2(totals.should))}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-red-700">
                    {totals.billed - totals.should > 0.004
                      ? `Hold ${formatCurrency(round2(totals.billed - totals.should))}`
                      : ""}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          Billed to date is what prior applications billed. Built is what the daily reports and schedule show as of the period end.
          {showDollars &&
            " System says to bill is what the field record supports this period: the request as-is when the line is within tolerance, otherwise built less billed to date, never more than the sub asked for."}
        </p>
      </section>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {decided ? (
        <div className="rounded-md border bg-muted/30 p-3 text-sm">
          <div className="font-medium">This application is {status}.</div>
          {cmNotes && <p className="mt-1 text-xs text-muted-foreground">CM: {cmNotes}</p>}
          {approvalNotes && <p className="mt-1 text-xs text-muted-foreground">Approval: {approvalNotes}</p>}
        </div>
      ) : (
        <div className="space-y-3 rounded-md border bg-card p-4">
          <label className="block space-y-1">
            <span className="text-xs font-medium">{canApprove ? "Approval notes" : "Verification notes"}</span>
            <textarea
              name={canApprove ? "approval_notes" : "cm_notes"}
              rows={2}
              defaultValue={canApprove ? approvalNotes ?? "" : cmNotes ?? ""}
              placeholder={
                canApprove
                  ? "What was held and why - this goes back to the sub"
                  : "What you saw in the field that supports or contradicts this bill"
              }
              className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
            />
          </label>

          <div className="flex flex-wrap items-center gap-2">
            {cmMode && (
              <Button type="submit" disabled={pending}>
                {pending ? "Saving..." : "Submit verification"}
              </Button>
            )}
            {canApprove && (
              <>
                <Button type="submit" name="_intent" value="approve" disabled={pending}>
                  {pending ? "Working..." : "Approve for payment"}
                </Button>
                <Button type="submit" name="_intent" value="reject" variant="outline" disabled={pending}>
                  Reject
                </Button>
              </>
            )}
            {(canApprove || canRecommend) && (
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const res = await runVerification(projectId, appId);
                    if (!res.ok) setError(res.error ?? "Analysis failed");
                  })
                }
              >
                Analyze bill
              </Button>
            )}
          </div>
        </div>
      )}
    </form>
  );
}
