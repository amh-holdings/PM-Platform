"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

import { updateLineMapping } from "../actions";

type Line = {
  id: string;
  item_number: string;
  description: string;
  scheduled_value: number;
  verification_method: string;
  linked_task_wbs_codes: string[];
  linked_commodity_ids: string[];
  milestone_task_wbs_code: string | null;
  mapping_notes: string | null;
  mapping_confirmed_at: string | null;
};

type Props = {
  projectId: string;
  line: Line;
  billedToDate: number;
  showDollars: boolean;
  methodLabel: string;
  tasks: { wbs_code: string; task_name: string }[];
  commodities: { id: string; label: string }[];
};

const METHODS = [
  ["schedule", "Schedule tasks - percent comes from linked task progress"],
  ["commodity", "Commodity quantities - percent comes from installed vs planned"],
  ["milestone", "Milestone - 100% when one task completes, 0% before"],
  ["time", "Time-based - straight line across the linked task dates"],
  ["manual", "CM sign-off - the CM enters the percent each period"],
  ["unmapped", "Not mapped - reported as unverifiable on every bill"],
] as const;

export function MappingRow({
  projectId,
  line,
  billedToDate,
  showDollars,
  methodLabel,
  tasks,
  commodities,
}: Props) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const evidence =
    line.verification_method === "milestone"
      ? line.milestone_task_wbs_code ?? "(no task set)"
      : line.verification_method === "commodity"
        ? commodities
            .filter((c) => line.linked_commodity_ids.includes(c.id))
            .map((c) => c.label)
            .join(", ") || "(none)"
        : line.linked_task_wbs_codes.join(", ") || "(none)";

  return (
    <>
      <tr className={cn(line.verification_method === "unmapped" && "bg-amber-50/60")}>
        <td className="px-3 py-2 tabular-nums align-top">{line.item_number}</td>
        <td className="px-3 py-2 align-top">{line.description}</td>
        {showDollars && (
          <td className="px-3 py-2 text-right tabular-nums align-top">
            {formatCurrency(line.scheduled_value)}
          </td>
        )}
        {showDollars && (
          <td className="px-3 py-2 text-right tabular-nums align-top text-muted-foreground">
            {billedToDate > 0 ? formatCurrency(billedToDate) : "-"}
          </td>
        )}
        <td className="px-3 py-2 align-top">
          <span
            className={cn(
              "rounded px-2 py-0.5 text-xs font-medium",
              line.verification_method === "unmapped"
                ? "bg-amber-100 text-amber-900"
                : "bg-emerald-100 text-emerald-900",
            )}
          >
            {methodLabel}
          </span>
        </td>
        <td className="px-3 py-2 align-top text-xs text-muted-foreground">
          {line.verification_method === "unmapped" ? "-" : evidence}
        </td>
        <td className="px-3 py-2 align-top text-right">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-xs underline underline-offset-2 hover:no-underline"
          >
            {open ? "Cancel" : line.verification_method === "unmapped" ? "Map" : "Edit"}
          </button>
        </td>
      </tr>

      {open && (
        <tr className="bg-muted/30">
          <td colSpan={showDollars ? 7 : 5} className="px-3 py-3">
            <form
              action={(fd) => {
                setError(null);
                startTransition(async () => {
                  const res = await updateLineMapping(projectId, line.id, fd);
                  if (!res.ok) setError(res.error);
                  else setOpen(false);
                });
              }}
              className="space-y-3"
            >
              <div className="grid gap-3 md:grid-cols-2">
                <label className="block space-y-1">
                  <span className="text-xs font-medium">How is this line proven?</span>
                  <select
                    name="verification_method"
                    defaultValue={line.verification_method}
                    className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                  >
                    {METHODS.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block space-y-1">
                  <span className="text-xs font-medium">
                    Schedule task WBS codes (comma separated)
                  </span>
                  <input
                    name="linked_task_wbs_codes"
                    defaultValue={line.linked_task_wbs_codes.join(", ")}
                    placeholder="5.1.3.1, 5.1.1.3"
                    className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                    list={`tasks-${line.id}`}
                  />
                  <datalist id={`tasks-${line.id}`}>
                    {tasks.map((t) => (
                      <option key={t.wbs_code} value={t.wbs_code}>
                        {t.task_name}
                      </option>
                    ))}
                  </datalist>
                </label>

                <label className="block space-y-1">
                  <span className="text-xs font-medium">Milestone task WBS code</span>
                  <input
                    name="milestone_task_wbs_code"
                    defaultValue={line.milestone_task_wbs_code ?? ""}
                    placeholder="Used only by the milestone method"
                    className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                  />
                </label>

                <fieldset className="space-y-1">
                  <legend className="text-xs font-medium">Commodities</legend>
                  <div className="max-h-28 space-y-1 overflow-y-auto rounded-md border bg-background p-2">
                    {commodities.map((c) => (
                      <label key={c.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          name="linked_commodity_ids"
                          value={c.id}
                          defaultChecked={line.linked_commodity_ids.includes(c.id)}
                        />
                        {c.label}
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>

              <label className="block space-y-1">
                <span className="text-xs font-medium">Notes</span>
                <input
                  name="mapping_notes"
                  defaultValue={line.mapping_notes ?? ""}
                  placeholder="Why this evidence proves this line"
                  className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                />
              </label>

              {error && <p className="text-xs text-destructive">{error}</p>}

              <div className="flex items-center gap-2">
                <Button type="submit" size="sm" disabled={pending}>
                  {pending ? "Saving..." : "Save mapping"}
                </Button>
                {line.mapping_confirmed_at && (
                  <span className="text-xs text-muted-foreground">
                    Last confirmed {new Date(line.mapping_confirmed_at).toLocaleDateString()}
                  </span>
                )}
              </div>
            </form>
          </td>
        </tr>
      )}
    </>
  );
}
