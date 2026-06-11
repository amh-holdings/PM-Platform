"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";

import {
  applyExtractedMilestones,
  extractPoPaymentTerms,
  type ExtractedMilestone,
} from "../../procurement-actions";

type Props = {
  poId: string;
  projectId: string;
  poTotalValue: number;
  hasLinkedDocument: boolean;
};

type EditableMilestone = ExtractedMilestone & { include: boolean };

export function ExtractPoMilestones({
  poId,
  projectId,
  poTotalValue,
  hasLinkedDocument,
}: Props) {
  const router = useRouter();
  const [extracting, startExtracting] = useTransition();
  const [applying, startApplying] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [milestones, setMilestones] = useState<EditableMilestone[]>([]);
  const [summary, setSummary] = useState("");
  const [extractionNotes, setExtractionNotes] = useState("");
  const [sourceDoc, setSourceDoc] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [applied, setApplied] = useState(false);

  function handleExtract() {
    setError(null);
    setApplied(false);
    startExtracting(async () => {
      const result = await extractPoPaymentTerms(poId);
      if (!result.ok) {
        setError(result.error);
        setMilestones([]);
        return;
      }
      setMilestones(result.milestones.map((m) => ({ ...m, include: true })));
      setSummary(result.payment_terms_summary);
      setExtractionNotes(result.notes);
      setSourceDoc(result.source_document);
      setElapsed(result.elapsed_ms);
    });
  }

  function handleApply() {
    const selected = milestones.filter((m) => m.include);
    if (selected.length === 0) {
      setError("No milestones selected");
      return;
    }
    setError(null);
    startApplying(async () => {
      const stripped: ExtractedMilestone[] = selected.map((m) => ({
        milestone_name: m.milestone_name,
        pct_of_total: m.pct_of_total,
        amount: m.amount,
        trigger_event: m.trigger_event,
        expected_date: m.expected_date,
        notes: m.notes,
      }));
      const result = await applyExtractedMilestones(poId, projectId, stripped, summary);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setApplied(true);
      setMilestones([]);
      router.refresh();
    });
  }

  function updateMilestone(idx: number, patch: Partial<EditableMilestone>) {
    setMilestones((prev) =>
      prev.map((m, i) => (i === idx ? { ...m, ...patch } : m)),
    );
  }

  const sumPct = milestones
    .filter((m) => m.include)
    .reduce((s, m) => s + Number(m.pct_of_total ?? 0), 0);
  const sumAmt = milestones
    .filter((m) => m.include)
    .reduce((s, m) => s + Number(m.amount ?? 0), 0);

  return (
    <div className="border-b p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Extract milestones from PO PDF
          </h4>
          <p className="text-[10px] text-muted-foreground">
            Reads the linked PO document, asks Claude to extract the payment
            schedule, shows it here for review before insertion.
          </p>
        </div>
        <Button
          onClick={handleExtract}
          disabled={!hasLinkedDocument || extracting || applying}
          size="sm"
          variant="outline"
          className="text-xs"
        >
          {extracting ? "Extracting..." : "Extract from PO"}
        </Button>
      </div>

      {!hasLinkedDocument && (
        <p className="mt-2 text-xs text-amber-700">
          Upload and link a PO document first (via the procurement form) to
          enable extraction.
        </p>
      )}

      {error && (
        <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
          {error}
        </p>
      )}

      {applied && (
        <p className="mt-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-2 text-xs text-emerald-700">
          Milestones applied. Existing milestones for this PO were replaced.
        </p>
      )}

      {milestones.length > 0 && (
        <div className="mt-3 space-y-3">
          <div className="rounded-md border bg-muted/30 p-3 text-xs">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <div className="font-medium">Review extracted milestones</div>
                {summary && (
                  <div className="text-muted-foreground">{summary}</div>
                )}
                {sourceDoc && (
                  <div className="text-[10px] text-muted-foreground">
                    Source: {sourceDoc} ({(elapsed / 1000).toFixed(1)}s)
                  </div>
                )}
              </div>
              <div className="text-right">
                <div className="text-muted-foreground">Selected total</div>
                <div className="font-semibold">
                  {sumPct > 0 && `${sumPct.toFixed(0)}% / `}
                  {formatCurrency(sumAmt)}
                </div>
              </div>
            </div>
            {extractionNotes && (
              <p className="mt-2 text-[10px] text-muted-foreground italic">
                {extractionNotes}
              </p>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  <th className="w-8 py-1.5 text-left font-medium"></th>
                  <th className="py-1.5 pr-2 text-left font-medium">Milestone</th>
                  <th className="py-1.5 pr-2 text-left font-medium">Trigger</th>
                  <th className="py-1.5 pr-2 text-right font-medium">%</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Amount</th>
                  <th className="py-1.5 pr-2 text-left font-medium">Expected date</th>
                </tr>
              </thead>
              <tbody>
                {milestones.map((m, i) => (
                  <tr
                    key={i}
                    className={cn(
                      "border-b last:border-0 align-top",
                      !m.include && "opacity-50",
                    )}
                  >
                    <td className="py-1.5">
                      <input
                        type="checkbox"
                        checked={m.include}
                        onChange={(e) =>
                          updateMilestone(i, { include: e.target.checked })
                        }
                        className="h-3.5 w-3.5 accent-emerald-700"
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <Input
                        value={m.milestone_name}
                        onChange={(e) =>
                          updateMilestone(i, { milestone_name: e.target.value })
                        }
                        className="h-7 text-xs"
                      />
                      {m.notes && (
                        <div className="mt-0.5 text-[10px] text-muted-foreground italic">
                          {m.notes}
                        </div>
                      )}
                    </td>
                    <td className="py-1.5 pr-2">
                      <Input
                        value={m.trigger_event ?? ""}
                        onChange={(e) =>
                          updateMilestone(i, { trigger_event: e.target.value })
                        }
                        className="h-7 text-xs"
                      />
                    </td>
                    <td className="py-1.5 pr-2 text-right">
                      <Input
                        type="number"
                        step="0.01"
                        value={m.pct_of_total ?? ""}
                        onChange={(e) =>
                          updateMilestone(i, {
                            pct_of_total: e.target.value
                              ? Number(e.target.value)
                              : null,
                            amount:
                              e.target.value && poTotalValue
                                ? Math.round(
                                    poTotalValue * (Number(e.target.value) / 100) * 100,
                                  ) / 100
                                : m.amount,
                          })
                        }
                        className="h-7 w-16 text-right text-xs"
                      />
                    </td>
                    <td className="py-1.5 pr-2 text-right">
                      <Input
                        type="number"
                        step="0.01"
                        value={m.amount ?? ""}
                        onChange={(e) =>
                          updateMilestone(i, {
                            amount: e.target.value ? Number(e.target.value) : null,
                          })
                        }
                        className="h-7 w-24 text-right text-xs"
                      />
                    </td>
                    <td className="py-1.5 pr-2">
                      <Input
                        type="date"
                        value={m.expected_date ?? ""}
                        onChange={(e) =>
                          updateMilestone(i, { expected_date: e.target.value || null })
                        }
                        className="h-7 text-xs"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-muted-foreground">
              Applying replaces existing milestones for this PO.
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setMilestones([])}
                disabled={applying}
              >
                Discard
              </Button>
              <Button
                onClick={handleApply}
                disabled={applying || milestones.filter((m) => m.include).length === 0}
                size="sm"
                className="bg-emerald-700 hover:bg-emerald-700/90"
              >
                {applying ? "Applying..." : `Apply ${milestones.filter((m) => m.include).length} milestone${milestones.filter((m) => m.include).length === 1 ? "" : "s"}`}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
