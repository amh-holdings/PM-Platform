"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import { shortMonthLabel } from "@/lib/cashflow";

import { createPayAppFromSelectedEntries } from "../pay-app-actions";

export type UpcomingEntry = {
  id: string;
  afp: string;
  period: string;
  scope: string;
  item: string;
  gross: number;
  retainage: number;
  netCash: number;
  status: string;
};

type Props = {
  projectId: string;
  upcoming: UpcomingEntry[];
  variant: "page" | "widget";
};

export function NextAfpPanelClient({ projectId, upcoming, variant }: Props) {
  // Default selection: just the chronologically first entry (the "next" AFP).
  // PM extends the selection if there are multiple lines for the same AFP.
  const initialFirstId = upcoming[0]?.id ?? "";
  const [selected, setSelected] = useState<Set<string>>(
    new Set(initialFirstId ? [initialFirstId] : []),
  );
  const [appNumber, setAppNumber] = useState(upcoming[0]?.afp ?? "");

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const { selectedCount, selectedGross, selectedNet } = useMemo(() => {
    let count = 0;
    let gross = 0;
    let net = 0;
    for (const a of upcoming) {
      if (selected.has(a.id)) {
        count++;
        gross += a.gross;
        net += a.netCash;
      }
    }
    return { selectedCount: count, selectedGross: gross, selectedNet: net };
  }, [upcoming, selected]);

  const disabled = selectedCount === 0 || !appNumber.trim();

  return (
    <section
      className={cn(
        "rounded-lg border border-emerald-500/40 bg-emerald-500/5",
        variant === "page" ? "p-4 shadow-sm" : "p-3",
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3
            className={cn(
              "font-semibold uppercase tracking-wide text-emerald-700",
              variant === "page" ? "text-sm" : "text-xs",
            )}
          >
            Next AFP to issue
          </h3>
          <p className="text-xs text-muted-foreground">
            Check one or more rows, then create. Period span and totals are
            derived from what&apos;s selected.
          </p>
        </div>
      </div>

      <form
        action={createPayAppFromSelectedEntries}
        className="mt-3 space-y-3"
      >
        <input type="hidden" name="projectId" value={projectId} />

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="border-b border-emerald-500/20">
                <th className="w-8 py-1.5 text-left font-medium"></th>
                <th className="py-1.5 pr-2 text-left font-medium">AFP</th>
                <th className="py-1.5 pr-2 text-left font-medium">Period</th>
                <th className="py-1.5 pr-2 text-left font-medium">Scope</th>
                <th className="py-1.5 pr-2 text-left font-medium">Status</th>
                <th className="py-1.5 pr-2 text-right font-medium">Gross</th>
                <th className="py-1.5 text-right font-medium">Net cash</th>
              </tr>
            </thead>
            <tbody>
              {upcoming.map((a) => {
                const isChecked = selected.has(a.id);
                return (
                  <tr
                    key={a.id}
                    className={cn(
                      "border-b border-emerald-500/10 last:border-0 cursor-pointer hover:bg-emerald-500/5",
                      isChecked && "bg-emerald-500/10",
                    )}
                    onClick={() => toggle(a.id)}
                  >
                    <td className="py-1.5">
                      <input
                        type="checkbox"
                        name="entryIds"
                        value={a.id}
                        checked={isChecked}
                        onChange={() => toggle(a.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="h-3.5 w-3.5 accent-emerald-700"
                      />
                    </td>
                    <td className="py-1.5 pr-2 font-medium">{a.afp}</td>
                    <td className="py-1.5 pr-2">
                      {shortMonthLabel(a.period)}
                    </td>
                    <td className="py-1.5 pr-2 text-muted-foreground">
                      {a.item ? `${a.item} ` : ""}
                      {a.scope}
                    </td>
                    <td className="py-1.5 pr-2 text-muted-foreground">
                      {a.status}
                    </td>
                    <td className="py-1.5 pr-2 text-right">
                      {formatCurrency(a.gross)}
                    </td>
                    <td className="py-1.5 text-right text-emerald-700">
                      {formatCurrency(a.netCash)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-end justify-between gap-3 rounded-md border border-emerald-500/30 bg-card p-3">
          <div className="flex items-end gap-3">
            <div>
              <Label htmlFor="afp-number" className="text-xs">
                AFP number
              </Label>
              <Input
                id="afp-number"
                name="appNumber"
                value={appNumber}
                onChange={(e) => setAppNumber(e.target.value)}
                placeholder="e.g. AFP 3"
                className="mt-1 h-8 w-32 text-xs"
              />
            </div>
            <div className="text-xs">
              <div className="text-muted-foreground">
                {selectedCount} selected
              </div>
              <div className="font-semibold">
                {formatCurrency(selectedGross)} gross
              </div>
              <div className="text-emerald-700">
                {formatCurrency(selectedNet)} net cash
              </div>
            </div>
          </div>
          <Button
            type="submit"
            disabled={disabled}
            className="bg-emerald-700 hover:bg-emerald-700/90"
          >
            Create AFP from selected
          </Button>
        </div>
      </form>
    </section>
  );
}
