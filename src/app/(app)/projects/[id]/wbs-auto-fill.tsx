"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import {
  bulkInsertWbs,
  extractSov,
  type ExtractedSovItem,
} from "./wbs-actions";

type Props = {
  projectId: string;
};

export function WbsAutoFillButton({ projectId }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<ExtractedSovItem[] | null>(null);
  const [sources, setSources] = useState<string[]>([]);
  const [notes, setNotes] = useState<string>("");
  const [total, setTotal] = useState<number | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [, startTransition] = useTransition();

  const run = async () => {
    setLoading(true);
    setError(null);
    setItems(null);
    setOpen(true);
    const result = await extractSov(projectId);
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setItems(result.items);
    setSources(result.source_documents);
    setNotes(result.notes);
    setTotal(result.total_contract_value);
    const initialSelected: Record<string, boolean> = {};
    for (const it of result.items) initialSelected[it.wbs_code] = true;
    setSelected(initialSelected);
  };

  const applySelected = async () => {
    if (!items) return;
    setLoading(true);
    setError(null);
    const toInsert = items.filter((it) => selected[it.wbs_code]);
    const result = await bulkInsertWbs(projectId, toInsert);
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOpen(false);
    setItems(null);
    startTransition(() => router.refresh());
  };

  const selectedCount = items
    ? items.filter((it) => selected[it.wbs_code]).length
    : 0;

  return (
    <>
      <Button variant="outline" onClick={run} disabled={loading}>
        {loading ? "Extracting..." : "Auto-fill from Exhibit E"}
      </Button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-lg bg-background p-6 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold">Auto-fill WBS / SOV from Exhibit E</h3>
                <p className="text-xs text-muted-foreground">
                  Claude read the SOV in your contract documents and suggested
                  line items. Uncheck any you don&apos;t want, then Apply.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                Close
              </button>
            </div>

            {loading && !items && (
              <div className="my-8 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-current" />
                Reading the SOV...
              </div>
            )}

            {error && (
              <div className="my-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            )}

            {items && (
              <div className="mt-4 space-y-4">
                {sources.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Source: {sources.join(", ")}
                  </p>
                )}

                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">
                    {selectedCount} of {items.length} selected
                  </span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const all: Record<string, boolean> = {};
                        for (const it of items) all[it.wbs_code] = true;
                        setSelected(all);
                      }}
                      className="text-xs underline-offset-4 hover:underline"
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelected({})}
                      className="text-xs underline-offset-4 hover:underline"
                    >
                      Clear
                    </button>
                  </div>
                </div>

                <div className="overflow-hidden rounded-md border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="w-10 px-3 py-2"></th>
                        <th className="px-3 py-2 font-medium">Code</th>
                        <th className="px-3 py-2 font-medium">Description</th>
                        <th className="px-3 py-2 text-right font-medium">Value</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {items.map((it) => (
                        <tr key={it.wbs_code}>
                          <td className="px-3 py-1.5">
                            <input
                              type="checkbox"
                              checked={!!selected[it.wbs_code]}
                              onChange={(e) =>
                                setSelected((prev) => ({
                                  ...prev,
                                  [it.wbs_code]: e.target.checked,
                                }))
                              }
                            />
                          </td>
                          <td className="px-3 py-1.5 font-mono text-xs">{it.wbs_code}</td>
                          <td className="px-3 py-1.5">{it.description}</td>
                          <td
                            className={cn(
                              "px-3 py-1.5 text-right tabular-nums",
                              it.contract_value == null && "text-muted-foreground",
                            )}
                          >
                            {it.contract_value == null ? "-" : formatCurrency(it.contract_value)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    {total !== null && (
                      <tfoot className="border-t bg-muted/20 text-sm font-medium">
                        <tr>
                          <td colSpan={3} className="px-3 py-2 text-right text-xs uppercase tracking-wide text-muted-foreground">
                            Stated total
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {formatCurrency(total)}
                          </td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>

                {notes && (
                  <div className="rounded-md border bg-card p-3 text-xs">
                    <p className="font-medium uppercase tracking-wide text-muted-foreground">
                      Claude&apos;s notes
                    </p>
                    <p className="mt-1 text-sm">{notes}</p>
                  </div>
                )}

                <p className="text-xs text-muted-foreground">
                  Existing line items with the same WBS code will be skipped
                  (safe to re-run).
                </p>

                <div className="flex justify-end gap-2 border-t pt-4">
                  <Button variant="ghost" onClick={() => setOpen(false)} disabled={loading}>
                    Cancel
                  </Button>
                  <Button
                    onClick={applySelected}
                    disabled={loading || selectedCount === 0}
                  >
                    {loading ? "Applying..." : `Add ${selectedCount} item${selectedCount === 1 ? "" : "s"}`}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
