"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/format";
import type { CoSovImpact } from "@/lib/sov-amendments";
import {
  allocateCoLineToSovLine,
  removeCoLineAllocation,
} from "../../change-orders-actions";

type ContractLine = {
  id: string;
  itemNumber: string;
  description: string;
  scheduledValue: number;
};

type Props = {
  projectId: string;
  changeOrderId: string;
  coNumber: string;
  impact: CoSovImpact;
  /** Contract lines only - a change order cannot amend another one's line. */
  contractLines: ContractLine[];
  /** True until migration 0054 is applied in Supabase. */
  needsMigration: boolean;
};

/**
 * What this change order does to the schedule of values.
 *
 * Three answers, all of them legitimate. It adds new scope on its own line,
 * it raises the price of lines the sheet already carries, or it moves no
 * money at all. Only the first was visible before; the second showed up as an
 * unexplained gap between the CO value and the SOV, and the third looked like
 * a line somebody had forgotten to add.
 */
export function CoSovImpactPanel({
  projectId,
  changeOrderId,
  coNumber,
  impact,
  contractLines,
  needsMigration,
}: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [baseId, setBaseId] = useState("");
  const [amount, setAmount] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function refresh() {
    startTransition(() => router.refresh());
  }

  async function onAllocate(amendmentLineId: string, remaining: number) {
    setErr(null);
    if (!baseId) {
      setErr("Pick the contract line this money belongs to");
      return;
    }
    const raw = amount.trim();
    const val = raw === "" ? remaining : Number(raw.replace(/[$,\s]/g, ""));
    if (!Number.isFinite(val)) {
      setErr("Amount must be a number");
      return;
    }
    setBusy(true);
    const res = await allocateCoLineToSovLine({
      projectId,
      changeOrderId,
      amendmentLineId,
      baseLineId: baseId,
      amount: val,
    });
    setBusy(false);
    if (!res.ok) {
      setErr(res.error);
      return;
    }
    setOpenFor(null);
    setBaseId("");
    setAmount("");
    refresh();
  }

  async function onRemove(amendmentLineId: string, base: string) {
    setErr(null);
    const res = await removeCoLineAllocation(
      amendmentLineId,
      base,
      changeOrderId,
      projectId,
    );
    if (!res.ok) {
      setErr(res.error);
      return;
    }
    refresh();
  }

  const headline =
    impact.kind === "none"
      ? "Moves no money. Nothing on the schedule of values changes."
      : impact.kind === "amends"
        ? "Raises the price of scope already on the schedule of values."
        : impact.kind === "adds"
          ? "Adds new scope on its own line."
          : "Part new scope, part an increase to lines already on the sheet.";

  return (
    <section className="rounded-lg border bg-card shadow-sm">
      <div className="border-b p-3">
        <h3 className="text-sm font-semibold">What {coNumber} changes</h3>
        <p className="text-xs text-muted-foreground">{headline}</p>
      </div>

      {needsMigration && (
        <div className="border-b bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
          <p className="font-medium">
            Linking is switched off until migration 0054 is applied.
          </p>
          <p className="mt-1">
            Run <code>db/migrations/0054_billing_line_amendments.sql</code> in
            the Supabase SQL editor, then reload this page. That is the only
            reason the button below is greyed out. Everything else here works
            as before.
          </p>
          <p className="mt-1">
            Already ran it and still seeing this? PostgREST serves from a
            cached copy of the schema and has not picked the table up yet. Run{" "}
            <code>notify pgrst, &apos;reload schema&apos;;</code> on its own, or
            just run the migration file again - it now ends with that line.
          </p>
        </div>
      )}

      {impact.kind === "none" && !needsMigration && (
        <p className="p-3 text-xs text-muted-foreground">
          A change order that only moves dates or obligations belongs here with
          nothing under it. This is a complete answer, not a missing one.
        </p>
      )}

      {impact.amends.length > 0 && (
        <div className="border-b">
          <p className="px-3 pt-3 text-xs font-medium">
            Contract lines this increases
          </p>
          <table className="w-full text-xs">
            <tbody>
              {impact.amends.map((a) => (
                <tr
                  key={`${a.fromLineId}-${a.baseLineId}`}
                  className="border-b last:border-0"
                >
                  <td className="px-3 py-2 font-mono">{a.itemNumber}</td>
                  <td className="px-3 py-2">
                    {a.description}
                    <span className="block text-[10px] text-muted-foreground">
                      from this CO&apos;s line {a.fromItemNumber}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    +{formatCurrency(a.amount)}
                  </td>
                  <td className="w-20 px-3 py-2 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => onRemove(a.fromLineId, a.baseLineId)}
                    >
                      Unlink
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {impact.lines.map((l) => (
        <div key={l.lineId} className="border-b p-3 last:border-0">
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
            <span>
              <span className="font-mono">{l.itemNumber}</span> {l.description}
            </span>
            <span className="font-mono tabular-nums">
              {formatCurrency(l.scheduledValue)}
            </span>
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {l.allocated === 0
              ? "All new scope. Nothing allocated to an existing contract line."
              : `${formatCurrency(l.allocated)} allocated to contract lines · ${formatCurrency(l.newScope)} new scope`}
          </p>

          {openFor === l.lineId ? (
            <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_140px_auto]">
              <select
                className="h-9 rounded-md border bg-background px-2 text-xs"
                value={baseId}
                onChange={(e) => setBaseId(e.target.value)}
                aria-label="Contract line to increase"
              >
                <option value="">Pick the contract line this increases</option>
                {contractLines.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.itemNumber} {c.description} ({formatCurrency(c.scheduledValue)})
                  </option>
                ))}
              </select>
              <Input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={formatCurrency(l.newScope)}
                inputMode="decimal"
                className="text-right"
                aria-label="Amount to allocate"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => onAllocate(l.lineId, l.newScope)}
                >
                  {busy ? "Linking..." : "Link"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setOpenFor(null);
                    setErr(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground sm:col-span-3">
                Leave the amount blank to allocate everything still unassigned
                on this line. Both lines stay on the sheet - the contract line
                keeps its original value and this one keeps the change, so the
                executed SOV is still readable.
              </p>
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={needsMigration || contractLines.length === 0}
              // A greyed button with no reason on it sends people hunting for
              // a bug. The two reasons are different problems, so name them.
              title={
                needsMigration
                  ? "Needs migration 0054_billing_line_amendments.sql applied in Supabase"
                  : contractLines.length === 0
                    ? "This project has no contract lines to link to - every SOV line already belongs to a change order"
                    : undefined
              }
              onClick={() => {
                setOpenFor(l.lineId);
                setBaseId("");
                setAmount("");
                setErr(null);
              }}
            >
              Link to a contract line
            </Button>
            {needsMigration ? (
              <span className="text-[10px] text-muted-foreground">
                waiting on migration 0054
              </span>
            ) : contractLines.length === 0 ? (
              <span className="text-[10px] text-muted-foreground">
                no contract lines on this project to link to
              </span>
            ) : null}
            </div>
          )}
        </div>
      ))}

      {err && <p className="p-3 pt-0 text-xs text-destructive">{err}</p>}
    </section>
  );
}
