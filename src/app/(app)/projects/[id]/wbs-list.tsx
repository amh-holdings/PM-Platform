"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import { deleteWbsItem } from "./wbs-actions";
import {
  WbsFormDialog,
  type SubOption,
  type WbsFormValues,
} from "./wbs-form-dialog";

type WbsRow = {
  id: string;
  wbs_code: string;
  description: string;
  trade: string | null;
  subcontractor_id: string | null;
  contract_value: number | null;
  pct_complete_sub: number | null;
  pct_complete_ahc: number | null;
  retainage_pct: number | null;
  billed_to_date: number | null;
};

type Props = {
  projectId: string;
  items: WbsRow[];
  subs: SubOption[];
  subById: Record<string, string>;
};

function fmtPct(value: number | null | undefined): string {
  if (value == null) return "-";
  return `${Number(value).toFixed(1)}%`;
}

export function WbsList({ projectId, items, subs, subById }: Props) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
        No line items yet. Add the first one above.
      </div>
    );
  }

  const handleDelete = async (id: string, label: string) => {
    if (!confirm(`Delete line item "${label}"?`)) return;
    setPendingId(id);
    setError(null);
    const result = await deleteWbsItem(id, projectId);
    setPendingId(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    startTransition(() => router.refresh());
  };

  const totals = items.reduce(
    (acc, it) => {
      const cv = Number(it.contract_value ?? 0);
      const billed = Number(it.billed_to_date ?? 0);
      const earnedAhc = cv * (Number(it.pct_complete_ahc ?? 0) / 100);
      acc.contractValue += cv;
      acc.billed += billed;
      acc.earnedAhc += earnedAhc;
      return acc;
    },
    { contractValue: 0, billed: 0, earnedAhc: 0 },
  );

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}
      <div className="overflow-x-auto rounded-lg border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-3 font-medium">Code</th>
              <th className="px-3 py-3 font-medium">Description</th>
              <th className="px-3 py-3 font-medium">Sub</th>
              <th className="px-3 py-3 text-right font-medium">Contract</th>
              <th className="px-3 py-3 text-right font-medium">Sub %</th>
              <th className="px-3 py-3 text-right font-medium">AHC %</th>
              <th className="px-3 py-3 text-right font-medium">Billed</th>
              <th className="px-3 py-3 text-right font-medium">Remaining</th>
              <th className="px-3 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {items.map((it) => {
              const cv = Number(it.contract_value ?? 0);
              const billed = Number(it.billed_to_date ?? 0);
              const remaining = cv - billed;
              return (
                <tr key={it.id} className="hover:bg-muted/30">
                  <td className="px-3 py-2.5 font-mono text-xs">{it.wbs_code}</td>
                  <td className="px-3 py-2.5">
                    <div className="font-medium">{it.description}</div>
                    {it.trade && (
                      <div className="text-xs text-muted-foreground">{it.trade}</div>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground">
                    {it.subcontractor_id ? subById[it.subcontractor_id] ?? "-" : "-"}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {formatCurrency(it.contract_value)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                    {fmtPct(it.pct_complete_sub)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {fmtPct(it.pct_complete_ahc)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                    {formatCurrency(it.billed_to_date)}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-2.5 text-right tabular-nums",
                      remaining > 0 && "text-muted-foreground",
                    )}
                  >
                    {formatCurrency(remaining)}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <div className="flex justify-end gap-1">
                      <WbsFormDialog
                        projectId={projectId}
                        subs={subs}
                        initial={toFormValues(it)}
                        trigger={
                          <Button variant="ghost" size="sm" disabled={pendingId === it.id}>
                            Edit
                          </Button>
                        }
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(it.id, `${it.wbs_code} ${it.description}`)}
                        disabled={pendingId === it.id}
                      >
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
          {totals.contractValue > 0 && (
            <tfoot className="border-t bg-muted/20 text-sm font-medium">
              <tr>
                <td colSpan={3} className="px-3 py-2 text-right text-xs uppercase tracking-wide text-muted-foreground">
                  Totals
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatCurrency(totals.contractValue)}
                </td>
                <td />
                <td className="px-3 py-2 text-right tabular-nums">
                  {totals.contractValue > 0
                    ? `${((totals.earnedAhc / totals.contractValue) * 100).toFixed(1)}%`
                    : "-"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatCurrency(totals.billed)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatCurrency(totals.contractValue - totals.billed)}
                </td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

function toFormValues(it: WbsRow): WbsFormValues {
  return {
    id: it.id,
    wbs_code: it.wbs_code,
    description: it.description,
    trade: it.trade,
    subcontractor_id: it.subcontractor_id,
    contract_value: it.contract_value,
    pct_complete_sub: it.pct_complete_sub,
    pct_complete_ahc: it.pct_complete_ahc,
    retainage_pct: it.retainage_pct,
    billed_to_date: it.billed_to_date,
  };
}
