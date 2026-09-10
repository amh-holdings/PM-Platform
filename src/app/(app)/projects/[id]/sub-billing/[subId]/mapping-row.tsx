"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

import { removeSovLine, updateLineMapping, updateSovLine } from "../actions";

type Line = {
  id: string;
  item_number: string;
  description: string;
  scheduled_value: number;
  section_name: string | null;
  quantity: number | null;
  unit: string | null;
  is_change_order: boolean;
  change_order_ref: string | null;
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
  canEditLine: boolean;
  methodLabel: string;
  tasks: { wbs_code: string; task_name: string }[];
  commodities: { id: string; label: string }[];
};

const METHODS = [
  ["schedule", "Schedule tasks - percent comes from linked task progress"],
  ["commodity", "Commodity quantities - percent comes from installed vs planned"],
  ["milestone", "Milestone - 100% when one task completes, 0% before"],
  ["on_site", "On site - 100% once the sub has filed a field report (mobilization)"],
  ["time", "Time-based - straight line across the linked task dates"],
  ["manual", "CM sign-off - the CM enters the percent each period"],
  ["unmapped", "Not mapped - reported as unverifiable on every bill"],
] as const;

const field = "w-full rounded-md border bg-background px-2 py-1.5 text-sm";

export function MappingRow({
  projectId,
  line,
  billedToDate,
  showDollars,
  canEditLine,
  methodLabel,
  tasks,
  commodities,
}: Props) {
  const [open, setOpen] = useState<"none" | "map" | "line">("none");
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, startTransition] = useTransition();

  const evidence =
    line.verification_method === "milestone"
      ? line.milestone_task_wbs_code ?? "(no task set)"
      : line.verification_method === "on_site"
        ? "First field report on the job"
        : line.verification_method === "commodity"
          ? commodities
              .filter((c) => line.linked_commodity_ids.includes(c.id))
              .map((c) => c.label)
              .join(", ") || "(none)"
          : line.linked_task_wbs_codes.join(", ") || "(none)";

  const toggle = (panel: "map" | "line") => {
    setError(null);
    setConfirmDelete(false);
    setOpen((v) => (v === panel ? "none" : panel));
  };

  const colSpan = showDollars ? 7 : 5;

  return (
    <>
      <tr className={cn(line.verification_method === "unmapped" && "bg-amber-50/60")}>
        <td className="px-3 py-2 tabular-nums align-top">{line.item_number}</td>
        <td className="px-3 py-2 align-top">
          {line.description}
          {line.is_change_order && (
            <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-900">
              {line.change_order_ref ?? "CO"}
            </span>
          )}
        </td>
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
          <div className="flex justify-end gap-3">
            {canEditLine && (
              <button
                type="button"
                onClick={() => toggle("line")}
                className="text-xs underline underline-offset-2 hover:no-underline"
              >
                {open === "line" ? "Cancel" : "Edit line"}
              </button>
            )}
            <button
              type="button"
              onClick={() => toggle("map")}
              className="text-xs underline underline-offset-2 hover:no-underline"
            >
              {open === "map" ? "Cancel" : line.verification_method === "unmapped" ? "Map" : "Edit mapping"}
            </button>
          </div>
        </td>
      </tr>

      {open === "line" && (
        <tr className="bg-muted/30">
          <td colSpan={colSpan} className="px-3 py-3">
            <form
              action={(fd) => {
                setError(null);
                startTransition(async () => {
                  const res = await updateSovLine(projectId, line.id, fd);
                  if (!res.ok) setError(res.error);
                  else setOpen("none");
                });
              }}
              className="space-y-3"
            >
              <div className="grid gap-3 md:grid-cols-4">
                <label className="block space-y-1">
                  <span className="text-xs font-medium">Item number</span>
                  <input name="item_number" required defaultValue={line.item_number} className={field} />
                </label>
                <label className="block space-y-1 md:col-span-2">
                  <span className="text-xs font-medium">Description</span>
                  <input name="description" required defaultValue={line.description} className={field} />
                </label>
                <label className="block space-y-1">
                  <span className="text-xs font-medium">Scheduled value</span>
                  <input
                    name="scheduled_value"
                    required
                    inputMode="decimal"
                    defaultValue={line.scheduled_value}
                    className={field}
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-xs font-medium">Section</span>
                  <input name="section_name" defaultValue={line.section_name ?? ""} className={field} />
                </label>
                <label className="block space-y-1">
                  <span className="text-xs font-medium">Quantity</span>
                  <input
                    name="quantity"
                    inputMode="decimal"
                    defaultValue={line.quantity ?? ""}
                    className={field}
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-xs font-medium">Unit</span>
                  <input name="unit" defaultValue={line.unit ?? ""} className={field} />
                </label>
                <label className="block space-y-1">
                  <span className="text-xs font-medium">Change order ref</span>
                  <input
                    name="change_order_ref"
                    defaultValue={line.change_order_ref ?? ""}
                    className={field}
                  />
                </label>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="is_change_order" defaultChecked={line.is_change_order} />
                This line came in on a change order
              </label>

              {billedToDate > 0 && (
                <p className="text-xs text-amber-800">
                  {formatCurrency(billedToDate)} has already been billed against this line.
                  Its item number is locked; changing the scheduled value re-prices every
                  percentage that reads off it.
                </p>
              )}
              {error && <p className="text-xs text-destructive">{error}</p>}

              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" size="sm" disabled={pending}>
                  {pending ? "Saving..." : "Save line"}
                </Button>
                {confirmDelete ? (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      disabled={pending}
                      onClick={() => {
                        setError(null);
                        startTransition(async () => {
                          const res = await removeSovLine(projectId, line.id);
                          if (!res.ok) setError(res.error);
                        });
                      }}
                    >
                      Confirm remove
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      {billedToDate > 0
                        ? "Already billed, so the line is retired rather than deleted."
                        : "This line has never been billed and will be deleted."}
                    </span>
                  </>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setConfirmDelete(true)}
                  >
                    Remove line
                  </Button>
                )}
              </div>
            </form>
          </td>
        </tr>
      )}

      {open === "map" && (
        <tr className="bg-muted/30">
          <td colSpan={colSpan} className="px-3 py-3">
            <form
              action={(fd) => {
                setError(null);
                startTransition(async () => {
                  const res = await updateLineMapping(projectId, line.id, fd);
                  if (!res.ok) setError(res.error);
                  else setOpen("none");
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
                    className={field}
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
                    className={field}
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
                    className={field}
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
                  className={field}
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
