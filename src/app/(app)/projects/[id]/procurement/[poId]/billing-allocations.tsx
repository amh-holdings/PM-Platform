"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import {
  addPoBillingAllocation,
  deletePoBillingAllocation,
  updatePoBillingAllocation,
} from "../../procurement-actions";

type BillingLineOption = {
  id: string;
  itemNumber: string;
  description: string;
  totalValue: number;
};

type Allocation = {
  id: string;
  billingLineId: string;
  amount: number;
  description: string | null;
  sortOrder: number | null;
};

type Props = {
  poId: string;
  projectId: string;
  poTotalValue: number;
  poDescription: string | null;
  allocations: Allocation[];
  billingLines: BillingLineOption[];
};

export function BillingAllocations({
  poId,
  projectId,
  poTotalValue,
  poDescription,
  allocations,
  billingLines,
}: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [newLineId, setNewLineId] = useState("");
  const [newAmount, setNewAmount] = useState("");
  const [newDesc, setNewDesc] = useState("");

  const [editLineId, setEditLineId] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editDesc, setEditDesc] = useState("");

  const lineById = new Map(billingLines.map((l) => [l.id, l]));
  const allocatedTotal = allocations.reduce((s, a) => s + Number(a.amount), 0);
  const drift = poTotalValue - allocatedTotal;
  const driftAbs = Math.abs(drift);

  function refresh() {
    startTransition(() => {
      router.refresh();
    });
  }

  async function onAdd() {
    setErr(null);
    const amount = Number(newAmount.replace(/[$,\s]/g, ""));
    if (!newLineId) {
      setErr("Pick an SOV line");
      return;
    }
    if (!(amount > 0)) {
      setErr("Amount must be > 0");
      return;
    }
    const res = await addPoBillingAllocation(poId, projectId, {
      billingLineId: newLineId,
      amount,
      description: newDesc.trim() || null,
    });
    if (!res.ok) {
      setErr(res.error);
      return;
    }
    setNewLineId("");
    setNewAmount("");
    setNewDesc("");
    setAdding(false);
    refresh();
  }

  async function onSaveEdit(allocId: string) {
    setErr(null);
    const amount = Number(editAmount.replace(/[$,\s]/g, ""));
    if (!editLineId || !(amount > 0)) {
      setErr("SOV line + positive amount required");
      return;
    }
    const res = await updatePoBillingAllocation(allocId, poId, projectId, {
      billingLineId: editLineId,
      amount,
      description: editDesc.trim() || null,
    });
    if (!res.ok) {
      setErr(res.error);
      return;
    }
    setEditingId(null);
    refresh();
  }

  async function onDelete(allocId: string) {
    setErr(null);
    const res = await deletePoBillingAllocation(allocId, poId, projectId);
    if (!res.ok) {
      setErr(res.error);
      return;
    }
    refresh();
  }

  function startEdit(a: Allocation) {
    setEditingId(a.id);
    setEditLineId(a.billingLineId);
    setEditAmount(String(a.amount));
    setEditDesc(a.description ?? "");
  }

  return (
    <section className="rounded-lg border bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
        <div>
          <h3 className="text-sm font-semibold">Allocations to SOV lines</h3>
          <p className="text-xs text-muted-foreground">
            Split this PO across the scheduled-value lines it bills against.
            One PO can hit multiple lines (e.g. Recloser + Primary Metering).
          </p>
        </div>
        <div className="text-right text-xs">
          <div className="text-muted-foreground">Allocated</div>
          <div className="font-semibold">
            {formatCurrency(allocatedTotal)} / {formatCurrency(poTotalValue)}
          </div>
          {driftAbs > 1 && (
            <div
              className={cn(
                "text-[10px]",
                drift > 0 ? "text-amber-600" : "text-destructive",
              )}
            >
              {drift > 0
                ? `${formatCurrency(drift)} unallocated`
                : `${formatCurrency(driftAbs)} over PO total`}
            </div>
          )}
        </div>
      </div>

      {billingLines.length === 0 ? (
        <div className="p-4 text-xs text-muted-foreground">
          No SOV lines have been imported for this project yet. Go to the
          project&apos;s Billing tab to import the Schedule of Values before
          allocating this PO.
        </div>
      ) : (
        <>
          {allocations.length > 0 && (
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  <th className="px-3 py-2 text-left font-medium">SOV line</th>
                  <th className="px-3 py-2 text-left font-medium">Item / note</th>
                  <th className="px-3 py-2 text-right font-medium">Allocated</th>
                  <th className="w-32 px-3 py-2 text-right font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {allocations.map((a) => {
                  const line = lineById.get(a.billingLineId);
                  const isEditing = editingId === a.id;
                  if (isEditing) {
                    return (
                      <tr key={a.id} className="border-b bg-muted/30">
                        <td className="px-3 py-2">
                          <select
                            value={editLineId}
                            onChange={(e) => setEditLineId(e.target.value)}
                            className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
                          >
                            {billingLines.map((l) => (
                              <option key={l.id} value={l.id}>
                                {l.itemNumber} {l.description}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-3 py-2">
                          <Input
                            value={editDesc}
                            onChange={(e) => setEditDesc(e.target.value)}
                            placeholder="e.g. Recloser portion"
                            className="h-9"
                          />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Input
                            value={editAmount}
                            onChange={(e) => setEditAmount(e.target.value)}
                            inputMode="decimal"
                            className="h-9 text-right"
                          />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Button size="sm" onClick={() => onSaveEdit(a.id)}>
                            Save
                          </Button>{" "}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditingId(null)}
                          >
                            Cancel
                          </Button>
                        </td>
                      </tr>
                    );
                  }
                  return (
                    <tr key={a.id} className="border-b hover:bg-muted/30">
                      <td className="px-3 py-2">
                        <div className="font-mono text-[10px] text-muted-foreground">
                          {line?.itemNumber ?? "?"}
                        </div>
                        <div>{line?.description ?? "(line removed)"}</div>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {a.description ?? "-"}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">
                        {formatCurrency(Number(a.amount))}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => startEdit(a)}
                        >
                          Edit
                        </Button>{" "}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          onClick={() => onDelete(a.id)}
                        >
                          Remove
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          <div className="border-t p-3">
            {!adding ? (
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  {allocations.length === 0
                    ? "Not allocated yet. The AFP can't pull stored materials from this PO until you split it across SOV lines."
                    : ""}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setAdding(true);
                    setNewDesc(poDescription ?? "");
                  }}
                >
                  Add allocation
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="grid gap-2 sm:grid-cols-[2fr_2fr_120px_auto]">
                  <select
                    value={newLineId}
                    onChange={(e) => setNewLineId(e.target.value)}
                    className="h-9 rounded-md border border-input bg-background px-2 text-xs"
                  >
                    <option value="">- Pick SOV line -</option>
                    {billingLines.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.itemNumber} {l.description}
                        {" - "}
                        {formatCurrency(l.totalValue)}
                      </option>
                    ))}
                  </select>
                  <Input
                    value={newDesc}
                    onChange={(e) => setNewDesc(e.target.value)}
                    placeholder="Item description (e.g. Recloser portion)"
                  />
                  <Input
                    value={newAmount}
                    onChange={(e) => setNewAmount(e.target.value)}
                    placeholder="$ amount"
                    inputMode="decimal"
                    className="text-right"
                  />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={onAdd}>
                      Add
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setAdding(false);
                        setErr(null);
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
                {drift > 0 && (
                  <p className="text-[10px] text-muted-foreground">
                    Hint: {formatCurrency(drift)} of the PO is still
                    unallocated.
                  </p>
                )}
              </div>
            )}
            {err && (
              <p className="mt-2 text-xs text-destructive">{err}</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
