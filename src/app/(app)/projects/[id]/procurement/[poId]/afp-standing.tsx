"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/format";
import {
  canAddToAfp,
  canUndoFromPo,
  describePoAfpStanding,
  type PoAfpStanding,
} from "@/lib/afp-po-staging";

import { AddToAfpButton } from "./add-to-afp-button";
import { unstagePoAmountFromAfp } from "../../procurement-actions";

function monthLabel(periodMonth: string): string {
  const [y, m] = periodMonth.split("-").map(Number);
  if (!y || !m) return periodMonth;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Add to AFP, or what this PO already put on one.
 *
 * Zarina: "I already added this to AFP. should say added and I would not be
 * able to add again unless I undo. So once add, there should be an undo
 * button."
 *
 * The panel offered Add whether or not the money was already staged, and the
 * two clicks looked identical. Now the button is only there when there is
 * nothing on the application, and when there is, the figure and the line it
 * sits on are on the page with the way back.
 *
 * This is the one PO page every PO uses, so it behaves the same on all of
 * them.
 */
export function AfpStanding({
  poId,
  projectId,
  poTotalValue,
  standing,
  size = "sm",
  variant,
}: {
  poId: string;
  projectId: string;
  poTotalValue: number;
  standing: PoAfpStanding;
  size?: "sm" | "default";
  variant?: "outline";
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function undo() {
    setBusy(true);
    setError(null);
    const res = await unstagePoAmountFromAfp(poId, projectId);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    startTransition(() => router.refresh());
  }

  if (standing.state === "none" || canAddToAfp(standing)) {
    return (
      <AddToAfpButton
        poId={poId}
        projectId={projectId}
        poTotalValue={poTotalValue}
        size={size}
        variant={variant}
      />
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white">
          Added to AFP {formatCurrency(standing.amount)}
        </span>
        {canUndoFromPo(standing) && (
          <Button
            type="button"
            size={size}
            variant="outline"
            disabled={busy}
            onClick={() => void undo()}
          >
            {busy ? "Undoing..." : "Undo"}
          </Button>
        )}
      </div>
      <p className="max-w-md text-right text-[11px] text-muted-foreground">
        {describePoAfpStanding(standing, formatCurrency, monthLabel)}
      </p>
      {error && <p className="text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
