"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

import { decideBill, recommendBill, runVerification } from "../../actions";

type Line = {
  id: string;
  item_number: string;
  description: string;
  scheduled_value: number;
  from_previous: number;
  this_period: number;
  total_completed: number;
  pct_billed: number | null;
  verified_pct: number | null;
  verified_amount: number | null;
  verification_detail: string | null;
  verification_source: string | null;
  variance_amount: number | null;
  flag_level: string | null;
  flagLabel: string | null;
  flagTone: string;
  approved_this_period: number | null;
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
  retainagePct: number;
  cmNotes: string | null;
  approvalNotes: string | null;
  lines: Line[];
};

export function ReviewForm({
  projectId,
  appId,
  status,
  decided,
  showDollars,
  canRecommend,
  canApprove,
  retainagePct,
  cmNotes,
  approvalNotes,
  lines,
}: Props) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Only lines with activity this period need a decision. The rest are shown
  // for context but never asked about.
  const active = lines.filter((l) => l.this_period !== 0);

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
          <h3 className="text-sm font-semibold">Line detail</h3>
          <span className="text-xs text-muted-foreground">
            {active.length} of {lines.length} lines billed this period
          </span>
        </div>

        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2">Description</th>
                <th className="px-3 py-2 text-right">Billed %</th>
                {showDollars && <th className="px-3 py-2 text-right">Billed this period</th>}
                <th className="px-3 py-2 text-right">Verified %</th>
                {showDollars && <th className="px-3 py-2 text-right">Variance</th>}
                <th className="px-3 py-2">Evidence</th>
                {(canRecommend || canApprove) && <th className="px-3 py-2 text-right">Certify %</th>}
                {canApprove && showDollars && <th className="px-3 py-2 text-right">Approve $</th>}
              </tr>
            </thead>
            <tbody className="divide-y">
              {lines.map((l) => {
                const isActive = l.this_period !== 0;
                return (
                  <tr
                    key={l.id}
                    className={cn(
                      !isActive && "text-muted-foreground",
                      l.flag_level === "flag" && "bg-red-50/60",
                      l.flag_level === "review" && "bg-amber-50/50",
                    )}
                  >
                    <td className="px-3 py-2 align-top tabular-nums">{l.item_number}</td>
                    <td className="px-3 py-2 align-top">
                      <div>{l.description}</div>
                      {l.flagLabel && isActive && (
                        <span className={cn("mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium", l.flagTone)}>
                          {l.flagLabel}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right align-top tabular-nums">
                      {l.pct_billed != null ? `${(l.pct_billed * 100).toFixed(1)}%` : "-"}
                    </td>
                    {showDollars && (
                      <td className="px-3 py-2 text-right align-top tabular-nums">
                        {isActive ? formatCurrency(l.this_period) : "-"}
                      </td>
                    )}
                    <td className="px-3 py-2 text-right align-top tabular-nums">
                      {l.verified_pct != null ? (
                        `${(l.verified_pct * 100).toFixed(1)}%`
                      ) : (
                        <span className="text-xs text-muted-foreground">no evidence</span>
                      )}
                    </td>
                    {showDollars && (
                      <td
                        className={cn(
                          "px-3 py-2 text-right align-top tabular-nums",
                          (l.variance_amount ?? 0) > 0 && "font-medium text-red-700",
                        )}
                      >
                        {l.variance_amount != null && isActive ? formatCurrency(l.variance_amount) : "-"}
                      </td>
                    )}
                    <td className="px-3 py-2 align-top text-xs text-muted-foreground">
                      {l.verification_detail ?? "-"}
                    </td>
                    {(canRecommend || canApprove) && (
                      <td className="px-3 py-2 align-top text-right">
                        {isActive ? (
                          <>
                            <input
                              name={`verified_pct__${l.item_number}`}
                              defaultValue={
                                l.verified_pct != null ? (l.verified_pct * 100).toFixed(1) : ""
                              }
                              placeholder={l.pct_billed != null ? (l.pct_billed * 100).toFixed(1) : ""}
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
                    {canApprove && showDollars && (
                      <td className="px-3 py-2 align-top text-right">
                        {isActive ? (
                          <input
                            name={`approved__${l.item_number}`}
                            defaultValue={
                              l.approved_this_period != null ? l.approved_this_period.toFixed(2) : ""
                            }
                            placeholder={l.this_period.toFixed(2)}
                            inputMode="decimal"
                            className="w-28 rounded-md border bg-background px-2 py-1 text-right text-sm"
                          />
                        ) : (
                          "-"
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          Certify % is what the field record actually supports for the line as a
          whole, cumulative. Leaving it blank keeps the engine&apos;s figure.
          {showDollars && " Approve $ defaults to the certified amount less prior billings."}
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
            <span className="text-xs font-medium">
              {canApprove ? "Approval notes" : "Verification notes"}
            </span>
            <textarea
              name={canApprove ? "approval_notes" : "cm_notes"}
              rows={2}
              defaultValue={canApprove ? approvalNotes ?? "" : cmNotes ?? ""}
              placeholder={
                canApprove
                  ? "What was adjusted and why"
                  : "What you saw in the field that supports or contradicts this bill"
              }
              className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
            />
          </label>

          <div className="flex flex-wrap items-center gap-2">
            {canRecommend && !canApprove && (
              <Button type="submit" disabled={pending}>
                {pending ? "Saving..." : "Submit verification"}
              </Button>
            )}
            {canApprove && (
              <>
                <Button type="submit" name="_intent" value="approve" disabled={pending}>
                  {pending ? "Working..." : "Approve for payment"}
                </Button>
                <Button
                  type="submit"
                  name="_intent"
                  value="reject"
                  variant="outline"
                  disabled={pending}
                >
                  Reject
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      const res = await runVerification(projectId, appId);
                      if (!res.ok) setError(res.error ?? "Verification failed");
                    })
                  }
                >
                  Re-run checks
                </Button>
              </>
            )}
            <span className="text-xs text-muted-foreground">
              Retainage {retainagePct}% is applied to the approved total.
            </span>
          </div>
        </div>
      )}
    </form>
  );
}
