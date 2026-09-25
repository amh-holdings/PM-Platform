"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/format";
import { describeRetainageRate, parseRetainageRate } from "@/lib/retainage-rate";

import { setSubRetainagePct } from "../actions";

/**
 * The retainage rate, set where the SOV is worked.
 *
 * Zarina: "Can you add option to add retainage to subs SOVs."
 *
 * It sits with the schedule of values rather than in a settings dialog because
 * the rate is priced against the SOV, and the line under the box says what it
 * costs on this subcontract rather than leaving a bare percentage to be
 * multiplied in somebody's head.
 *
 * The rate governs the next bill and the cash flow. Applications already
 * written keep the rate they captured, the same as everywhere else in the app
 * that captures a rate at creation.
 */
export function SubRetainage({
  projectId,
  subcontractorId,
  pct,
  sovTotal,
  showDollars,
}: {
  projectId: string;
  subcontractorId: string;
  pct: number;
  sovTotal: number;
  showDollars: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [value, setValue] = useState(String(pct));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const parsed = parseRetainageRate(value);
  const dirty = parsed !== "invalid" && parsed !== null && parsed !== pct;

  // What it will hold once saved, so the consequence is on screen before the
  // click rather than after it.
  const preview =
    parsed === "invalid" || parsed === null
      ? describeRetainageRate(pct, showDollars ? sovTotal : 0, formatCurrency)
      : describeRetainageRate(parsed, showDollars ? sovTotal : 0, formatCurrency);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const res = await setSubRetainagePct(projectId, subcontractorId, value);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setSaved(true);
    startTransition(() => router.refresh());
  }

  return (
    <div className="rounded-md border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="sub-retainage" className="text-xs font-medium">
          Retainage
        </label>
        <div className="flex items-center gap-1">
          <Input
            id="sub-retainage"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setSaved(false);
            }}
            inputMode="decimal"
            className="h-8 w-20 text-right text-xs"
            aria-label="Retainage percent"
          />
          <span className="text-xs text-muted-foreground">%</span>
        </div>
        <Button size="sm" disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? "Saving" : "Save"}
        </Button>
        {saved && !dirty && (
          <span className="text-xs text-emerald-700">Saved</span>
        )}
      </div>

      <p className="mt-1.5 text-[11px] text-muted-foreground">
        {preview} Applies to the next bill and the cash flow. Applications
        already written keep the rate they were created with.
      </p>

      {parsed === "invalid" && (
        <p className="mt-1 text-[11px] text-destructive">
          Enter a number from 0 to 100.
        </p>
      )}
      {error && <p className="mt-1 text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
