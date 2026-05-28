"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import { deleteCostCode } from "./cost-actions";
import {
  CostCodeFormDialog,
  type CostCodeFormValues,
} from "./cost-form-dialog";
import { CostLinkForm } from "./cost-link-form";

type CostCodeRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  estimated_cost: number | null;
  actual_cost: number | null;
  is_change_order: boolean | null;
  linked_task_wbs_codes: string[] | null;
};

type Props = {
  projectId: string;
  codes: CostCodeRow[];
};

export function CostCodeList({ projectId, codes }: Props) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  if (codes.length === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
        No cost codes yet. Add the first one above.
      </div>
    );
  }

  const handleDelete = async (id: string, label: string) => {
    if (!confirm(`Delete cost code "${label}"?`)) return;
    setPendingId(id);
    setError(null);
    const result = await deleteCostCode(id, projectId);
    setPendingId(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    startTransition(() => router.refresh());
  };

  const baseCodes = codes.filter((c) => !c.is_change_order);
  const changeOrderCodes = codes.filter((c) => c.is_change_order);

  const baseTotals = totals(baseCodes);
  const coTotals = totals(changeOrderCodes);
  const grandTotals = totals(codes);

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
              <th className="px-3 py-3 font-medium">Name</th>
              <th className="px-3 py-3 text-right font-medium">Estimated</th>
              <th className="px-3 py-3 text-right font-medium">Actual</th>
              <th className="px-3 py-3 text-right font-medium">Variance</th>
              <th className="px-3 py-3 font-medium">Linked tasks</th>
              <th className="px-3 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {baseCodes.map((c) => (
              <CostRow
                key={c.id}
                row={c}
                projectId={projectId}
                pendingId={pendingId}
                onDelete={handleDelete}
              />
            ))}
            {baseCodes.length > 0 && (
              <tr className="bg-muted/20 text-sm font-medium">
                <td colSpan={2} className="px-3 py-2 text-right text-xs uppercase tracking-wide text-muted-foreground">
                  Subtotal - base cost
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(baseTotals.estimated)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(baseTotals.actual)}</td>
                <td className={cn("px-3 py-2 text-right tabular-nums", baseTotals.actual > baseTotals.estimated && "text-destructive")}>
                  {formatCurrency(baseTotals.actual - baseTotals.estimated)}
                </td>
                <td />
                <td />
              </tr>
            )}
            {changeOrderCodes.length > 0 && (
              <>
                <tr>
                  <td colSpan={7} className="bg-muted/10 px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Change orders
                  </td>
                </tr>
                {changeOrderCodes.map((c) => (
                  <CostRow
                    key={c.id}
                    row={c}
                    projectId={projectId}
                    pendingId={pendingId}
                    onDelete={handleDelete}
                  />
                ))}
                <tr className="bg-muted/20 text-sm font-medium">
                  <td colSpan={2} className="px-3 py-2 text-right text-xs uppercase tracking-wide text-muted-foreground">
                    Subtotal - change orders
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(coTotals.estimated)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(coTotals.actual)}</td>
                  <td className={cn("px-3 py-2 text-right tabular-nums", coTotals.actual > coTotals.estimated && "text-destructive")}>
                    {formatCurrency(coTotals.actual - coTotals.estimated)}
                  </td>
                  <td />
                  <td />
                </tr>
              </>
            )}
          </tbody>
          <tfoot className="border-t bg-muted/30 text-sm font-semibold">
            <tr>
              <td colSpan={2} className="px-3 py-2 text-right text-xs uppercase tracking-wide text-muted-foreground">
                Total
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(grandTotals.estimated)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(grandTotals.actual)}</td>
              <td className={cn("px-3 py-2 text-right tabular-nums", grandTotals.actual > grandTotals.estimated && "text-destructive")}>
                {formatCurrency(grandTotals.actual - grandTotals.estimated)}
              </td>
              <td />
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function totals(rows: CostCodeRow[]) {
  return rows.reduce(
    (acc, r) => {
      acc.estimated += Number(r.estimated_cost ?? 0);
      acc.actual += Number(r.actual_cost ?? 0);
      return acc;
    },
    { estimated: 0, actual: 0 },
  );
}

function CostRow({
  row,
  projectId,
  pendingId,
  onDelete,
}: {
  row: CostCodeRow;
  projectId: string;
  pendingId: string | null;
  onDelete: (id: string, label: string) => void;
}) {
  const variance = Number(row.actual_cost ?? 0) - Number(row.estimated_cost ?? 0);
  return (
    <tr className="hover:bg-muted/30">
      <td className="px-3 py-2.5 font-mono text-xs">{row.code}</td>
      <td className="px-3 py-2.5">
        <div className="font-medium">{row.name}</div>
        {row.description && (
          <div className="text-xs text-muted-foreground">{row.description}</div>
        )}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
        {formatCurrency(row.estimated_cost)}
      </td>
      <td className="px-3 py-2.5 text-right tabular-nums">
        {formatCurrency(row.actual_cost)}
      </td>
      <td
        className={cn(
          "px-3 py-2.5 text-right tabular-nums",
          variance > 0 && "text-destructive",
          variance < 0 && "text-emerald-700",
        )}
      >
        {row.estimated_cost == null ? "-" : formatCurrency(variance)}
      </td>
      <td className="px-3 py-2.5">
        <CostLinkForm
          costCodeId={row.id}
          projectId={projectId}
          code={row.code}
          name={row.name}
          initialCodes={row.linked_task_wbs_codes ?? []}
        />
      </td>
      <td className="px-3 py-2.5 text-right">
        <div className="flex justify-end gap-1">
          <CostCodeFormDialog
            projectId={projectId}
            initial={toFormValues(row)}
            trigger={
              <Button variant="ghost" size="sm" disabled={pendingId === row.id}>
                Edit
              </Button>
            }
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDelete(row.id, `${row.code} ${row.name}`)}
            disabled={pendingId === row.id}
          >
            Delete
          </Button>
        </div>
      </td>
    </tr>
  );
}

function toFormValues(c: CostCodeRow): CostCodeFormValues {
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    description: c.description,
    estimated_cost: c.estimated_cost,
    actual_cost: c.actual_cost,
    is_change_order: Boolean(c.is_change_order),
  };
}
