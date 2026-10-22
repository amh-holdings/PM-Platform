"use client";

import { useMemo, useRef } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  buildPrintRows,
  printSheetStamp,
  printSheetTitle,
  rangeSelect,
  selectedPrintRows,
  type PrintCpmLike,
  type PrintableTask,
} from "@/lib/schedule-print";

export type PrintSelection = ReadonlySet<string> | null;

type SheetProps = {
  projectName: string;
  /** Null when the filter is on All scopes. */
  scope: string | null;
  /** Already narrowed by the scope filter. */
  tasks: PrintableTask[];
  cpmByWbs: ReadonlyMap<string, PrintCpmLike>;
  dataDate?: string | null;
  selection: PrintSelection;
};

// The chooser needs the rows and the scope label, not the sheet's header
// material. Narrowing it keeps the call site honest about what it is for.
type DialogProps = Pick<SheetProps, "scope" | "tasks" | "cpmByWbs" | "selection"> & {
  open: boolean;
  setOpen: (open: boolean) => void;
  setSelection: (next: PrintSelection) => void;
};

/**
 * The sheet itself. Hidden on screen, and the only thing left standing when
 * the page prints: the nav, the rail and the workspace all carry print:hidden.
 *
 * It is a sibling of the workspace rather than a child of the dialog, because a
 * dialog that has to stay mounted to print is a dialog that covers the sheet.
 */
export function SchedulePrintSheet({
  projectName,
  scope,
  tasks,
  cpmByWbs,
  dataDate,
  selection,
}: SheetProps) {
  const rows = useMemo(() => buildPrintRows(tasks, cpmByWbs), [tasks, cpmByWbs]);
  const printing = useMemo(() => selectedPrintRows(rows, selection), [rows, selection]);

  return (
    <div className="sp-sheet hidden print:block">
      <h1 className="sp-title">
        {printSheetTitle(projectName, scope, printing.length, rows.length)}
      </h1>
      <p className="sp-stamp">
        {printSheetStamp(dataDate, new Date().toISOString().slice(0, 10))}
      </p>
      <table className="sp-table">
        <thead>
          <tr>
            <th>WBS</th>
            <th>Task</th>
            <th>Start</th>
            <th>Finish</th>
            <th>Days</th>
            <th>%</th>
            <th>Status</th>
            <th>Slip</th>
          </tr>
        </thead>
        <tbody>
          {printing.map((r) => (
            <tr key={r.wbs} className={r.critical ? "sp-critical" : undefined}>
              <td className="sp-wbs">{r.wbs}</td>
              <td>
                {r.name}
                {r.milestone ? " (milestone)" : ""}
              </td>
              <td>{r.start}</td>
              <td>{r.finish}</td>
              <td className="sp-num">{r.days}</td>
              <td className="sp-num">{r.pct}</td>
              <td>{r.status}</td>
              <td className="sp-num">{r.slip}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The button, and the row chooser behind it. */
export function SchedulePrintDialog({
  scope,
  tasks,
  cpmByWbs,
  selection,
  open,
  setOpen,
  setSelection,
}: DialogProps) {
  const rows = useMemo(() => buildPrintRows(tasks, cpmByWbs), [tasks, cpmByWbs]);
  const printing = useMemo(() => selectedPrintRows(rows, selection), [rows, selection]);
  const allOn = selection === null || selection.size === rows.length;

  // The last box clicked, which shift-click ranges from. A ref rather than
  // state: moving the anchor must not re-render the list mid-click.
  const anchor = useRef<string | null>(null);

  function clickRow(e: React.MouseEvent<HTMLInputElement>, wbs: string) {
    setSelection(rangeSelect(rows, selection, anchor.current, wbs, e.shiftKey));
    anchor.current = wbs;
  }

  function print() {
    if (printing.length === 0) return;
    // Close first. The overlay is fixed-position and would otherwise be what
    // the browser renders over the sheet.
    setOpen(false);
    requestAnimationFrame(() => window.print());
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        title="Print the tasks currently in scope, or a selection of them"
      >
        Print
      </Button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 print:hidden"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-lg bg-background p-6 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold">Print schedule</h3>
                <p className="text-xs text-muted-foreground">
                  {scope ? `${scope} scope` : "All scopes"} - {rows.length} task
                  {rows.length === 1 ? "" : "s"}. Untick anything you do not want
                  on the sheet. Shift-click to carry one box across a run of
                  rows.
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

            <div className="mt-3 flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSelection(null)}
                disabled={allOn}
              >
                Select all
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSelection(new Set())}
                disabled={selection !== null && selection.size === 0}
              >
                Clear
              </Button>
              <span className="ml-auto text-xs text-muted-foreground">
                {printing.length} of {rows.length} will print
              </span>
            </div>

            <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-md border">
              <table className="w-full text-xs">
                <tbody>
                  {rows.map((r) => {
                    const on = selection === null || selection.has(r.wbs);
                    return (
                      <tr
                        key={r.wbs}
                        className={cn(
                          "select-none border-b last:border-b-0",
                          !on && "opacity-45",
                        )}
                      >
                        <td className="w-8 py-1.5 pl-3">
                          <input
                            type="checkbox"
                            checked={on}
                            // onClick, not onChange: a React change event on a
                            // checkbox carries no shiftKey. onChange stays as a
                            // no-op so the controlled input does not warn.
                            onClick={(e) => clickRow(e, r.wbs)}
                            onChange={() => {}}
                            aria-label={`Print ${r.wbs} ${r.name}`}
                          />
                        </td>
                        <td className="py-1.5 pr-2 font-mono text-[11px]">{r.wbs}</td>
                        <td className="py-1.5 pr-2">{r.name}</td>
                        <td className="py-1.5 pr-2 whitespace-nowrap text-muted-foreground">
                          {r.start} to {r.finish}
                        </td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{r.pct}</td>
                      </tr>
                    );
                  })}
                  {rows.length === 0 && (
                    <tr>
                      <td className="p-4 text-center text-muted-foreground">
                        Nothing in this scope to print.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <span className="mr-auto text-xs text-muted-foreground">
                Prints landscape. Planned dates, with slip against the projection
                beside them.
              </span>
              <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={print} disabled={printing.length === 0}>
                Print {printing.length} row{printing.length === 1 ? "" : "s"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
