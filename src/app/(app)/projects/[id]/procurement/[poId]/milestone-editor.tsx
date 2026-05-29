"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  addMilestone,
  deleteMilestone,
  markMilestonePaid,
  updateMilestone,
} from "../../procurement-actions";
import { formatCurrency, formatDate } from "@/lib/format";

type Milestone = {
  id: string;
  milestone_name: string;
  pct_of_total: number | null;
  trigger_event: string | null;
  expected_date: string | null;
  amount: number | null;
  paid_at: string | null;
  paid_amount: number | null;
  sort_order: number | null;
  notes: string | null;
};

type Props = {
  projectId: string;
  poId: string;
  poTotalValue: number;
  milestones: Milestone[];
};

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function MilestoneEditor({ projectId, poId, poTotalValue, milestones }: Props) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function onAdd(formData: FormData) {
    setBusy(true);
    setError(null);
    const res = await addMilestone(poId, projectId, formData);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setAdding(false);
    startTransition(() => router.refresh());
  }

  async function onUpdate(formData: FormData, mid: string) {
    setBusy(true);
    setError(null);
    const res = await updateMilestone(mid, poId, projectId, formData);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setEditId(null);
    startTransition(() => router.refresh());
  }

  async function onMarkPaid(mid: string, amount: number) {
    if (!confirm("Mark this milestone as paid today?")) return;
    setBusy(true);
    const res = await markMilestonePaid(mid, poId, projectId, todayIso(), amount);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    startTransition(() => router.refresh());
  }

  async function onDelete(mid: string) {
    if (!confirm("Delete this milestone?")) return;
    setBusy(true);
    const res = await deleteMilestone(mid, poId, projectId);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <div>
      {error && (
        <div className="border-b bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-muted/30 text-muted-foreground">
            <tr className="border-b">
              <th className="px-2 py-2 text-left font-medium">Milestone</th>
              <th className="px-2 py-2 text-left font-medium">Trigger</th>
              <th className="px-2 py-2 text-right font-medium">%</th>
              <th className="px-2 py-2 text-right font-medium">Amount</th>
              <th className="px-2 py-2 text-left font-medium">Expected</th>
              <th className="px-2 py-2 text-left font-medium">Paid</th>
              <th className="px-2 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {milestones.map((m) =>
              editId === m.id ? (
                <EditRow
                  key={m.id}
                  m={m}
                  onCancel={() => setEditId(null)}
                  onSubmit={(fd) => onUpdate(fd, m.id)}
                  busy={busy}
                />
              ) : (
                <tr key={m.id} className="border-b last:border-0">
                  <td className="px-2 py-1.5">
                    <div className="font-medium">{m.milestone_name}</div>
                    {m.notes && (
                      <div className="text-[10px] text-muted-foreground">
                        {m.notes}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-muted-foreground">
                    {m.trigger_event ?? "-"}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {m.pct_of_total != null ? `${m.pct_of_total.toFixed(0)}%` : "-"}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-mono">
                    {formatCurrency(Number(m.amount ?? 0))}
                  </td>
                  <td className="px-2 py-1.5 text-muted-foreground">
                    {m.expected_date ? formatDate(m.expected_date) : "-"}
                  </td>
                  <td className="px-2 py-1.5">
                    {m.paid_at ? (
                      <div>
                        <div className="text-emerald-700">
                          {formatCurrency(Number(m.paid_amount ?? m.amount ?? 0))}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {formatDate(m.paid_at)}
                        </div>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <div className="flex justify-end gap-1">
                      {!m.paid_at && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            onMarkPaid(m.id, Number(m.amount ?? 0))
                          }
                        >
                          Mark paid
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => setEditId(m.id)}
                      >
                        Edit
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => onDelete(m.id)}
                      >
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ),
            )}
            {milestones.length === 0 && !adding && (
              <tr>
                <td
                  colSpan={7}
                  className="px-2 py-4 text-center text-muted-foreground"
                >
                  No milestones yet. Add a deposit, delivery, and any
                  commissioning milestones below.
                </td>
              </tr>
            )}

            {adding && (
              <AddRow
                poTotalValue={poTotalValue}
                onCancel={() => setAdding(false)}
                onSubmit={onAdd}
                busy={busy}
              />
            )}
          </tbody>
        </table>
      </div>

      {!adding && (
        <div className="border-t bg-muted/20 px-3 py-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setAdding(true)}
          >
            Add milestone
          </Button>
        </div>
      )}
    </div>
  );
}

function AddRow({
  poTotalValue,
  onCancel,
  onSubmit,
  busy,
}: {
  poTotalValue: number;
  onCancel: () => void;
  onSubmit: (fd: FormData) => void;
  busy: boolean;
}) {
  const [pct, setPct] = useState("");
  const computedAmount =
    pct && Number(pct) > 0 ? (poTotalValue * Number(pct)) / 100 : null;
  return (
    <tr className="border-b bg-emerald-500/5">
      <td colSpan={7} className="p-3">
        <form action={onSubmit} className="grid gap-2 sm:grid-cols-[1fr_140px_100px_140px_140px_auto]">
          <div>
            <Label htmlFor="m-name" className="text-[10px]">Milestone name *</Label>
            <Input id="m-name" name="milestone_name" placeholder="Deposit / Delivery / Commissioning" required />
          </div>
          <div>
            <Label htmlFor="m-trigger" className="text-[10px]">Trigger</Label>
            <Input id="m-trigger" name="trigger_event" placeholder="PO signed / Delivered" />
          </div>
          <div>
            <Label htmlFor="m-pct" className="text-[10px]">% of PO</Label>
            <Input
              id="m-pct"
              name="pct_of_total"
              type="number"
              step="0.01"
              value={pct}
              onChange={(e) => setPct(e.target.value)}
              placeholder="10"
            />
          </div>
          <div>
            <Label htmlFor="m-amount" className="text-[10px]">Amount</Label>
            <Input
              id="m-amount"
              name="amount"
              type="number"
              step="0.01"
              placeholder={computedAmount != null ? computedAmount.toFixed(2) : ""}
            />
          </div>
          <div>
            <Label htmlFor="m-expected" className="text-[10px]">Expected date</Label>
            <Input id="m-expected" name="expected_date" type="date" />
          </div>
          <div className="flex items-end justify-end gap-1">
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              Add
            </Button>
          </div>
          <div className="sm:col-span-6">
            <Input name="notes" placeholder="Notes (optional)" />
          </div>
        </form>
      </td>
    </tr>
  );
}

function EditRow({
  m,
  onCancel,
  onSubmit,
  busy,
}: {
  m: Milestone;
  onCancel: () => void;
  onSubmit: (fd: FormData) => void;
  busy: boolean;
}) {
  return (
    <tr className="border-b bg-amber-500/5">
      <td colSpan={7} className="p-3">
        <form
          action={onSubmit}
          className="grid gap-2 sm:grid-cols-[1fr_140px_100px_140px_140px_auto]"
        >
          <div>
            <Label htmlFor={`mn-${m.id}`} className="text-[10px]">Milestone name</Label>
            <Input id={`mn-${m.id}`} name="milestone_name" defaultValue={m.milestone_name} required />
          </div>
          <div>
            <Label htmlFor={`mt-${m.id}`} className="text-[10px]">Trigger</Label>
            <Input id={`mt-${m.id}`} name="trigger_event" defaultValue={m.trigger_event ?? ""} />
          </div>
          <div>
            <Label htmlFor={`mp-${m.id}`} className="text-[10px]">%</Label>
            <Input
              id={`mp-${m.id}`}
              name="pct_of_total"
              type="number"
              step="0.01"
              defaultValue={m.pct_of_total ?? ""}
            />
          </div>
          <div>
            <Label htmlFor={`ma-${m.id}`} className="text-[10px]">Amount</Label>
            <Input
              id={`ma-${m.id}`}
              name="amount"
              type="number"
              step="0.01"
              defaultValue={m.amount ?? ""}
            />
          </div>
          <div>
            <Label htmlFor={`me-${m.id}`} className="text-[10px]">Expected</Label>
            <Input
              id={`me-${m.id}`}
              name="expected_date"
              type="date"
              defaultValue={m.expected_date ?? ""}
            />
          </div>
          <div className="flex items-end justify-end gap-1">
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              Save
            </Button>
          </div>
          <div className="sm:col-span-6">
            <Input
              name="notes"
              defaultValue={m.notes ?? ""}
              placeholder="Notes (optional)"
            />
          </div>
        </form>
      </td>
    </tr>
  );
}
