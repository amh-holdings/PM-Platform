"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/format";

import { setProcurementDeliveryTaskLink } from "../../procurement-actions";

export type DeliveryTaskOption = {
  wbsCode: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
  parentName: string | null;
};

type Props = {
  poId: string;
  projectId: string;
  currentWbs: string | null;
  currentEndDate: string | null;
  options: DeliveryTaskOption[];
};

// Picker that links a PO to a schedule delivery task. Selecting one
// updates procurement_orders.linked_delivery_task_wbs_code AND copies
// the task's end_date into expected_delivery_date so the AI extraction
// and cash projection both see the same number.
export function DeliveryTaskLink({
  poId,
  projectId,
  currentWbs,
  currentEndDate,
  options,
}: Props) {
  const router = useRouter();
  const [busy, startBusy] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const current = options.find((o) => o.wbsCode === currentWbs);

  function handlePick(wbs: string | null) {
    setError(null);
    startBusy(async () => {
      const result = await setProcurementDeliveryTaskLink(poId, projectId, wbs);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <section className="rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Schedule delivery task</h3>
          <p className="text-xs text-muted-foreground">
            Linking the PO to its delivery task auto-fills expected delivery
            date and lets Net X math fire off the schedule.
          </p>
        </div>
      </div>

      {current ? (
        <div className="mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs">
          <div className="font-medium text-emerald-700">
            Linked: {current.wbsCode} {current.name}
          </div>
          <div className="mt-0.5 text-muted-foreground">
            Delivery window: {current.startDate ? formatDate(current.startDate) : "?"} -{" "}
            {current.endDate ? formatDate(current.endDate) : "?"}
          </div>
          <div className="mt-1 text-muted-foreground">
            expected_delivery_date sync&apos;d to {currentEndDate ? formatDate(currentEndDate) : "(unset)"}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handlePick(null)}
              disabled={busy}
              className="h-6 px-2 text-[10px]"
            >
              {busy ? "..." : "Unlink"}
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-3 text-xs text-amber-700">
          No schedule task linked. AI date estimates will fall back to PDF
          shipping boilerplate instead of the project schedule.
        </p>
      )}

      {error && (
        <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="mt-3">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          Pick delivery task ({options.length} available)
        </div>
        <div className="max-h-60 overflow-y-auto rounded-md border">
          <table className="w-full text-xs">
            <thead className="bg-muted/30 text-muted-foreground">
              <tr className="border-b">
                <th className="px-2 py-1 text-left font-medium">WBS</th>
                <th className="px-2 py-1 text-left font-medium">Equipment / Vendor</th>
                <th className="px-2 py-1 text-left font-medium">End date</th>
                <th className="px-2 py-1 text-left font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {options.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-2 py-2 text-center text-muted-foreground">
                    No delivery tasks in schedule
                  </td>
                </tr>
              )}
              {options.map((o) => {
                const isCurrent = o.wbsCode === currentWbs;
                return (
                  <tr
                    key={o.wbsCode}
                    className={cn(
                      "border-b last:border-0",
                      isCurrent && "bg-emerald-500/5",
                    )}
                  >
                    <td className="px-2 py-1 font-mono">{o.wbsCode}</td>
                    <td className="px-2 py-1">
                      <div>{o.parentName ?? "-"}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {o.name}
                      </div>
                    </td>
                    <td className="px-2 py-1 text-muted-foreground">
                      {o.endDate ? formatDate(o.endDate) : "-"}
                    </td>
                    <td className="px-2 py-1 text-right">
                      {isCurrent ? (
                        <span className="text-[10px] text-emerald-700">linked</span>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handlePick(o.wbsCode)}
                          disabled={busy}
                          className="h-6 px-2 text-[10px]"
                        >
                          Pick
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
