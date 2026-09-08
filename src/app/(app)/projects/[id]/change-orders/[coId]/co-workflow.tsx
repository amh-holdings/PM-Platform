"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";
import {
  CO_STATUSES,
  CO_STATUS_LABELS,
  CO_TRANSITIONS,
  type CoStatus,
} from "@/lib/change-order-pricing";
import type { CoEvent } from "@/lib/change-order-load";
import { transitionCoStatus } from "../../change-orders-actions";

type Props = {
  projectId: string;
  changeOrderId: string;
  status: string;
  events: CoEvent[];
  /** Blocks approval until the CO actually has priced scope. */
  hasLines: boolean;
  linesMissingBackup: number;
};

// The happy path, shown as a progress rail. rejected and void sit off it.
const RAIL: CoStatus[] = ["draft", "internal_review", "submitted", "approved"];

export function CoWorkflow({
  projectId,
  changeOrderId,
  status,
  events,
  hasLines,
  linesMissingBackup,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const current = status as CoStatus;
  const next = CO_TRANSITIONS[current] ?? [];
  const railIndex = RAIL.indexOf(current);

  async function move(to: CoStatus) {
    setError(null);
    setWarning(null);

    if (to === "submitted" && linesMissingBackup > 0) {
      const ok = confirm(
        `${linesMissingBackup} cost line${linesMissingBackup > 1 ? "s have" : " has"} no backup attached. ` +
          `The owner will ask for it. Submit anyway?`,
      );
      if (!ok) return;
    }

    const note = to === "rejected" || to === "void" ? prompt(`Reason for ${CO_STATUS_LABELS[to]}?`) : null;
    if ((to === "rejected" || to === "void") && note === null) return;

    setBusy(true);
    const res = await transitionCoStatus(changeOrderId, projectId, to, note);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (res.warning) setWarning(res.warning);
    router.refresh();
  }

  return (
    <section className="rounded-lg border bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          {RAIL.map((s, i) => (
            <span key={s} className="flex items-center gap-1.5">
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-xs font-medium",
                  i < railIndex && "bg-emerald-50 text-emerald-800",
                  i === railIndex && "bg-emerald-600 text-white",
                  i > railIndex && "bg-muted text-muted-foreground",
                )}
              >
                {CO_STATUS_LABELS[s]}
              </span>
              {i < RAIL.length - 1 && <span className="text-muted-foreground">&rarr;</span>}
            </span>
          ))}
          {(current === "rejected" || current === "void") && (
            <span className="ml-2 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
              {CO_STATUS_LABELS[current]}
            </span>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {next.map((s) => {
            const blocked = s === "approved" && !hasLines;
            return (
              <button
                key={s}
                type="button"
                disabled={busy || blocked}
                title={blocked ? "Add at least one cost line before approving" : undefined}
                onClick={() => move(s)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-40",
                  s === "approved" && "bg-emerald-600 text-white hover:bg-emerald-700",
                  s === "submitted" && "bg-primary text-primary-foreground hover:opacity-90",
                  s !== "approved" && s !== "submitted" && "border bg-background hover:bg-muted",
                )}
              >
                {labelForAction(current, s)}
              </button>
            );
          })}
        </div>
      </div>

      {current === "approved" && (
        <p className="border-b bg-emerald-50 px-4 py-2 text-xs text-emerald-900">
          Approved. This change order now has its own line on the schedule of values and will bill
          on the next AFP.
        </p>
      )}

      {error && (
        <p className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {warning && (
        <p className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-900">
          {warning}
        </p>
      )}

      {events.length > 0 && (
        <ol className="divide-y text-xs">
          {events.map((e) => (
            <li key={e.id} className="flex flex-wrap items-baseline gap-2 px-4 py-2">
              <span className="font-medium">
                {e.fromStatus ? `${labelOf(e.fromStatus)} → ` : ""}
                {labelOf(e.toStatus)}
              </span>
              <span className="text-muted-foreground">
                {e.actorName ?? "Unknown"}
                {e.createdAt ? ` on ${formatDate(e.createdAt)}` : ""}
              </span>
              {e.note && <span className="w-full italic text-muted-foreground">{e.note}</span>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function labelOf(s: string): string {
  return CO_STATUS_LABELS[s as CoStatus] ?? s;
}

function labelForAction(from: CoStatus, to: CoStatus): string {
  if (to === "internal_review" && from === "draft") return "Send to internal review";
  if (to === "internal_review" && from === "approved") return "Reopen";
  if (to === "internal_review") return "Back to internal review";
  if (to === "draft") return "Back to draft";
  if (to === "submitted") return "Mark submitted to owner";
  if (to === "approved") return "Mark approved by owner";
  if (to === "rejected") return "Mark rejected";
  if (to === "void") return "Void";
  return CO_STATUS_LABELS[to];
}

export { CO_STATUSES };
