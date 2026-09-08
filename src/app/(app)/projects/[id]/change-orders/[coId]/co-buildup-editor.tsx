"use client";

import { Fragment, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import {
  CATEGORY_LABELS,
  COST_CATEGORIES,
  priceBuildup,
  type CostCategory,
  type CostLine,
} from "@/lib/change-order-pricing";
import type { CoAttachment } from "@/lib/change-order-load";
import { deleteCostLine, saveCostLine } from "../../change-orders-actions";
import { CoAttachments } from "./co-attachments";

type Draft = {
  category: CostCategory;
  description: string;
  vendorName: string;
  quantity: string;
  unit: string;
  unitCost: string;
  markupPct: string;
  notes: string;
};

type Props = {
  projectId: string;
  changeOrderId: string;
  lines: CostLine[];
  attachments: CoAttachment[];
  defaultMarkupPct: number | null;
  bondPct: number | null;
  taxPct: number | null;
  readOnly: boolean;
};

const EMPTY: Draft = {
  category: "material",
  description: "",
  vendorName: "",
  quantity: "1",
  unit: "ls",
  unitCost: "",
  markupPct: "",
  notes: "",
};

function toNum(s: string): number {
  const n = Number(s.replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function toNumOrNull(s: string): number | null {
  if (!s.trim()) return null;
  const n = Number(s.replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function draftFrom(l: CostLine): Draft {
  return {
    category: l.category,
    description: l.description,
    vendorName: l.vendorName ?? "",
    quantity: String(l.quantity),
    unit: l.unit ?? "",
    unitCost: String(l.unitCost),
    markupPct: l.markupPct == null ? "" : String(l.markupPct),
    notes: l.notes ?? "",
  };
}

export function CoBuildupEditor({
  projectId,
  changeOrderId,
  lines,
  attachments,
  defaultMarkupPct,
  bondPct,
  taxPct,
  readOnly,
}: Props) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [adding, setAdding] = useState(false);
  const [openBackup, setOpenBackup] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buildup = useMemo(
    () => priceBuildup({ lines, defaultMarkupPct, bondPct, taxPct }),
    [lines, defaultMarkupPct, bondPct, taxPct],
  );

  const attachmentsByLine = useMemo(() => {
    const m = new Map<string, CoAttachment[]>();
    for (const a of attachments) {
      if (!a.costLineId) continue;
      if (!m.has(a.costLineId)) m.set(a.costLineId, []);
      m.get(a.costLineId)!.push(a);
    }
    return m;
  }, [attachments]);

  // A line priced with no quote behind it is the thing that gets a CO kicked
  // back by the owner, so surface the count rather than burying it.
  const missingBackup = lines.filter((l) => !attachmentsByLine.has(l.id)).length;

  async function save(lineId?: string) {
    setError(null);
    if (!draft.description.trim()) {
      setError("Description is required");
      return;
    }
    setBusy(true);
    const res = await saveCostLine({
      id: lineId,
      projectId,
      changeOrderId,
      category: draft.category,
      description: draft.description,
      vendorName: draft.vendorName || null,
      quantity: toNum(draft.quantity),
      unit: draft.unit || null,
      unitCost: toNum(draft.unitCost),
      markupPct: toNumOrNull(draft.markupPct),
      costCodeId: null,
      notes: draft.notes || null,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setEditingId(null);
    setAdding(false);
    setDraft(EMPTY);
    router.refresh();
  }

  async function remove(l: CostLine) {
    const count = attachmentsByLine.get(l.id)?.length ?? 0;
    const extra = count > 0 ? ` Its ${count} attached file${count > 1 ? "s" : ""} will be deleted too.` : "";
    if (!confirm(`Delete "${l.description}"?${extra}`)) return;
    setBusy(true);
    const res = await deleteCostLine(l.id, changeOrderId, projectId);
    setBusy(false);
    if (!res.ok) setError(res.error);
    else router.refresh();
  }

  const priced = buildup.lines;

  return (
    <section className="rounded-lg border bg-card shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b p-4">
        <div>
          <h3 className="text-sm font-semibold">Cost buildup</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Every cost that makes up this change order. Attach the quote that backs each line.
          </p>
        </div>
        {missingBackup > 0 && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900">
            {missingBackup} line{missingBackup > 1 ? "s" : ""} with no backup attached
          </span>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[1000px] text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-[10px] uppercase tracking-wide text-muted-foreground">
              <th className="p-2 text-left font-medium">Category</th>
              <th className="p-2 text-left font-medium">Description</th>
              <th className="p-2 text-right font-medium">Qty</th>
              <th className="p-2 text-left font-medium">Unit</th>
              <th className="p-2 text-right font-medium">Unit cost</th>
              <th className="p-2 text-right font-medium">Extended</th>
              <th className="p-2 text-right font-medium">Markup</th>
              <th className="p-2 text-right font-medium">Billable</th>
              <th className="p-2 text-left font-medium">Backup</th>
              <th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {priced.length === 0 && !adding && (
              <tr>
                <td colSpan={10} className="p-6 text-center text-sm text-muted-foreground">
                  No cost lines yet. Add one for each quote, crew, or material package.
                </td>
              </tr>
            )}

            {priced.map((l) => {
              const files = attachmentsByLine.get(l.id) ?? [];
              const isEditing = editingId === l.id;
              const isOpen = openBackup === l.id;
              return (
                <Fragment key={l.id}>
                  {isEditing ? (
                    <tr className="border-b bg-primary/5">
                      <td colSpan={10} className="p-2">
                        <DraftRow
                          draft={draft}
                          setDraft={setDraft}
                          defaultMarkupPct={defaultMarkupPct}
                          busy={busy}
                          onSave={() => save(l.id)}
                          onCancel={() => {
                            setEditingId(null);
                            setDraft(EMPTY);
                          }}
                        />
                      </td>
                    </tr>
                  ) : (
                    <tr className="border-b align-top hover:bg-muted/20">
                      <td className="p-2">
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                          {CATEGORY_LABELS[l.category]}
                        </span>
                      </td>
                      <td className="p-2">
                        <div>{l.description}</div>
                        {l.vendorName && (
                          <div className="text-[11px] text-muted-foreground">{l.vendorName}</div>
                        )}
                        {l.notes && (
                          <div className="text-[11px] italic text-muted-foreground">{l.notes}</div>
                        )}
                      </td>
                      <td className="p-2 text-right tabular-nums">{l.quantity}</td>
                      <td className="p-2 text-muted-foreground">{l.unit ?? ""}</td>
                      <td className="p-2 text-right tabular-nums">{formatCurrency(l.unitCost)}</td>
                      <td className="p-2 text-right tabular-nums">{formatCurrency(l.extendedCost)}</td>
                      <td
                        className={cn(
                          "p-2 text-right tabular-nums",
                          l.markupInherited && "text-muted-foreground",
                        )}
                        title={
                          l.markupInherited
                            ? "Inherited from the change order default"
                            : "Set on this line"
                        }
                      >
                        {l.effectiveMarkupPct}%{l.markupInherited ? "" : " *"}
                      </td>
                      <td className="p-2 text-right font-medium tabular-nums">
                        {formatCurrency(l.billable)}
                      </td>
                      <td className="p-2">
                        <button
                          type="button"
                          onClick={() => setOpenBackup(isOpen ? null : l.id)}
                          className={cn(
                            "rounded px-1.5 py-0.5 text-[11px]",
                            files.length > 0
                              ? "bg-emerald-100 text-emerald-900"
                              : "bg-amber-100 text-amber-900",
                          )}
                        >
                          {files.length > 0 ? `${files.length} file${files.length > 1 ? "s" : ""}` : "None"}
                        </button>
                      </td>
                      <td className="p-2 text-right whitespace-nowrap">
                        {!readOnly && (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingId(l.id);
                                setAdding(false);
                                setDraft(draftFrom(l));
                              }}
                              className="text-[11px] text-muted-foreground hover:text-foreground"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => remove(l)}
                              disabled={busy}
                              className="ml-2 text-[11px] text-muted-foreground hover:text-destructive"
                            >
                              Delete
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  )}

                  {isOpen && (
                    <tr className="border-b bg-muted/20">
                      <td colSpan={10} className="p-3">
                        <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                          Backup for {l.description}
                        </div>
                        <CoAttachments
                          projectId={projectId}
                          changeOrderId={changeOrderId}
                          costLineId={l.id}
                          attachments={files}
                          readOnly={readOnly}
                          compact
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}

            {adding && (
              <tr className="border-b bg-primary/5">
                <td colSpan={10} className="p-2">
                  <DraftRow
                    draft={draft}
                    setDraft={setDraft}
                    defaultMarkupPct={defaultMarkupPct}
                    busy={busy}
                    onSave={() => save()}
                    onCancel={() => {
                      setAdding(false);
                      setDraft(EMPTY);
                    }}
                  />
                </td>
              </tr>
            )}
          </tbody>

          <tfoot className="border-t-2 text-sm">
            <Total label="Direct cost" value={buildup.directCost} />
            <Total
              label={`Markup${defaultMarkupPct != null ? ` (default ${defaultMarkupPct}%)` : ""}`}
              value={buildup.markup}
            />
            <Total label="Subtotal" value={buildup.subtotal} strong />
            {buildup.bond !== 0 && <Total label={`Bond (${bondPct}%)`} value={buildup.bond} />}
            {buildup.tax !== 0 && <Total label={`Tax (${taxPct}%)`} value={buildup.tax} />}
            <Total label="Total to owner" value={buildup.billable} strong accent />
          </tfoot>
        </table>
      </div>

      {error && (
        <div className="border-t border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {!readOnly && !adding && (
        <div className="border-t p-3">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setAdding(true);
              setEditingId(null);
              setDraft(EMPTY);
            }}
          >
            + Add cost line
          </Button>
        </div>
      )}

      <div className="border-t bg-muted/20 px-4 py-2 text-[11px] text-muted-foreground">
        AHC cost {formatCurrency(buildup.totalCost)} &middot; profit{" "}
        {formatCurrency(buildup.profit)}
        {buildup.effectiveMarginPct != null && ` (${buildup.effectiveMarginPct}%)`}. Bond and tax
        are treated as pass-through cost, not margin.
      </div>
    </section>
  );
}

function Total({
  label,
  value,
  strong,
  accent,
}: {
  label: string;
  value: number;
  strong?: boolean;
  accent?: boolean;
}) {
  return (
    <tr className={cn(strong && "border-t")}>
      <td colSpan={7} className="p-2 text-right text-xs text-muted-foreground">
        {label}
      </td>
      <td
        className={cn(
          "p-2 text-right tabular-nums",
          strong && "font-semibold",
          accent && "text-base text-emerald-700",
        )}
      >
        {formatCurrency(value)}
      </td>
      <td colSpan={2} />
    </tr>
  );
}

function DraftRow({
  draft,
  setDraft,
  defaultMarkupPct,
  busy,
  onSave,
  onCancel,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  defaultMarkupPct: number | null;
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const extended = toNum(draft.quantity) * toNum(draft.unitCost);
  const markup = toNumOrNull(draft.markupPct) ?? defaultMarkupPct ?? 0;

  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-12">
        <select
          value={draft.category}
          onChange={(e) => set({ category: e.target.value as CostCategory })}
          className="h-8 rounded border border-input bg-background px-1.5 text-xs sm:col-span-2"
          aria-label="Category"
        >
          {COST_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
        <input
          value={draft.description}
          onChange={(e) => set({ description: e.target.value })}
          placeholder="Description (e.g. Equipment storage - racking)"
          className="h-8 rounded border border-input bg-background px-2 text-xs sm:col-span-4"
        />
        <input
          value={draft.vendorName}
          onChange={(e) => set({ vendorName: e.target.value })}
          placeholder="Vendor / sub"
          className="h-8 rounded border border-input bg-background px-2 text-xs sm:col-span-2"
        />
        <input
          value={draft.quantity}
          onChange={(e) => set({ quantity: e.target.value })}
          placeholder="Qty"
          inputMode="decimal"
          className="h-8 rounded border border-input bg-background px-2 text-right text-xs sm:col-span-1"
        />
        <input
          value={draft.unit}
          onChange={(e) => set({ unit: e.target.value })}
          placeholder="Unit"
          className="h-8 rounded border border-input bg-background px-2 text-xs sm:col-span-1"
        />
        <input
          value={draft.unitCost}
          onChange={(e) => set({ unitCost: e.target.value })}
          placeholder="Unit cost"
          inputMode="decimal"
          className="h-8 rounded border border-input bg-background px-2 text-right text-xs sm:col-span-2"
        />
      </div>
      <div className="grid gap-2 sm:grid-cols-12">
        <input
          value={draft.markupPct}
          onChange={(e) => set({ markupPct: e.target.value })}
          placeholder={
            defaultMarkupPct != null ? `Markup % (default ${defaultMarkupPct})` : "Markup %"
          }
          inputMode="decimal"
          className="h-8 rounded border border-input bg-background px-2 text-right text-xs sm:col-span-2"
        />
        <input
          value={draft.notes}
          onChange={(e) => set({ notes: e.target.value })}
          placeholder="Notes (optional)"
          className="h-8 rounded border border-input bg-background px-2 text-xs sm:col-span-6"
        />
        <div className="flex items-center justify-end gap-3 text-xs sm:col-span-4">
          <span className="tabular-nums text-muted-foreground">
            {formatCurrency(extended)} + {markup}% ={" "}
            <strong className="text-foreground">
              {formatCurrency(extended * (1 + markup / 100))}
            </strong>
          </span>
          <button
            type="button"
            onClick={onCancel}
            className="rounded border px-2 py-1 hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={busy}
            className="rounded bg-primary px-2 py-1 text-primary-foreground disabled:opacity-50"
          >
            {busy ? "Saving..." : "Save line"}
          </button>
        </div>
      </div>
    </div>
  );
}
