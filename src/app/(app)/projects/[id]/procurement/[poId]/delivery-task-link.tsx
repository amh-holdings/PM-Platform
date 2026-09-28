"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { formatDate } from "@/lib/format";

import { setProcurementDeliveryTaskLink } from "../../procurement-actions";

export type DeliveryTaskOption = {
  wbsCode: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
  parentName: string | null;
};

/**
 * One schedule row, written the same way everywhere it is offered.
 *
 * The date is in the label rather than a column, because this used to be a
 * table with an End date column and dropping it would have lost the one piece
 * of information that decides which row is the right one.
 */
export function deliveryOptionLabel(o: DeliveryTaskOption): string {
  const who = o.parentName ? `${o.parentName} ` : "";
  const when = o.endDate ? ` - ${formatDate(o.endDate)}` : "";
  return `${o.wbsCode} ${who}${o.name}${when}`;
}

type Props = {
  poId: string;
  projectId: string;
  currentWbs: string | null;
  currentEndDate: string | null;
  options: DeliveryTaskOption[];
  /** The per-item picker, rendered inside this card. */
  children?: ReactNode;
};

/**
 * Which schedule row this PO is delivered against.
 *
 * Zarina: "I need this to be like the other one selection before which is a
 * dropdown and should be able to pick per line item as some PO contains
 * multiple equipments and should be link to different schedule."
 *
 * Two changes, and they are the same change. The picker was a scrolling table
 * of 14 rows with a Pick button on each, so choosing a delivery row meant
 * hunting through a list that was taller than the card. It is a dropdown now,
 * with the end date in the option text so the column it replaces is not lost.
 *
 * And the per-item picker lives in this card rather than in one of its own
 * further down the page. They were always one decision - does the whole order
 * land together, or does each item land on its own row - and splitting it
 * across two cards is what made it read as two competing links. She has
 * reported that twice as "double linking".
 *
 * Selecting a row updates procurement_orders.linked_delivery_task_wbs_code and
 * copies the task's end date into expected_delivery_date, so the AI extraction
 * and the cash projection both see the same number.
 */
export function DeliveryTaskLink({
  poId,
  projectId,
  currentWbs,
  currentEndDate,
  options,
  children,
}: Props) {
  const router = useRouter();
  const [busy, startBusy] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const current = options.find((o) => o.wbsCode === currentWbs);
  // A row that is linked but no longer in the list. The options come from a
  // name search for "delivery", so renaming a schedule row drops it out. In a
  // table that only looked wrong; in a select it would read as Not linked and
  // the next change would overwrite a real link without anyone deciding to.
  const orphaned = currentWbs != null && current === undefined;

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
      <div>
        <h3 className="text-sm font-semibold">Schedule delivery</h3>
        <p className="text-xs text-muted-foreground">
          Point the PO at the schedule row it lands on. The date comes from the
          schedule, and net terms run from it.
        </p>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label
          htmlFor="po-delivery-task"
          className="text-xs font-medium text-muted-foreground"
        >
          Whole order
        </label>
        <select
          id="po-delivery-task"
          value={currentWbs ?? ""}
          disabled={busy || options.length === 0}
          onChange={(e) => handlePick(e.target.value || null)}
          className="h-9 w-full max-w-xl rounded-md border border-input bg-background px-2 text-xs"
        >
          <option value="">
            {options.length === 0
              ? "No delivery tasks in the schedule"
              : "Not linked - no schedule row"}
          </option>
          {options.map((o) => (
            <option key={o.wbsCode} value={o.wbsCode}>
              {deliveryOptionLabel(o)}
            </option>
          ))}
          {orphaned && (
            <option value={currentWbs as string}>
              {currentWbs} - not in the schedule&apos;s delivery rows any more
            </option>
          )}
        </select>
      </div>

      {/* The consequence of the choice, under the box that makes it. The old
          card printed the WBS, the window and the synced date on three lines;
          the row is named in the dropdown itself now, so only what it did to
          the PO is left to say. */}
      {orphaned ? (
        <p className="mt-1.5 text-xs text-amber-700">
          {currentWbs} is linked but is not one of the schedule&apos;s delivery
          rows. Either it was renamed, or it was deleted. Pick the right row, or
          rename it back on the schedule.
        </p>
      ) : current ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          Plans to land{" "}
          <span className="font-medium text-foreground">
            {current.endDate ? formatDate(current.endDate) : "on no dated row"}
          </span>
          {currentEndDate && (
            <>, so expected delivery reads {formatDate(currentEndDate)}</>
          )}
          .
        </p>
      ) : (
        <p className="mt-1.5 text-xs text-amber-700">
          Nothing linked, so delivery dates fall back to whatever the PDF says
          rather than the project schedule.
        </p>
      )}

      {error && (
        <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
          {error}
        </p>
      )}

      {children}
    </section>
  );
}
