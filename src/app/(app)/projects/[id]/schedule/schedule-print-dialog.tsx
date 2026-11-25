"use client";

import { useMemo, useRef } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  buildPrintRows,
  printRowClass,
  selectedPrintRows,
  type PrintCpmLike,
  type PrintableTask,
} from "@/lib/schedule-print";
import { rangeSelect } from "@/lib/range-select";

export type PrintSelection = ReadonlySet<string> | null;
export type PrintOrientation = "landscape" | "portrait";

const longDate = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });

type SheetProps = {
  projectName: string;
  /** Null when the filter is on All scopes. */
  scope: string | null;
  /** Already narrowed by the scope filter. */
  tasks: PrintableTask[];
  cpmByWbs: ReadonlyMap<string, PrintCpmLike>;
  dataDate?: string | null;
  selection: PrintSelection;
  orientation: PrintOrientation;
  /** The contractor's mark in the header, when the project has one. */
  logo?: { src: string; alt: string } | null;
};

// The chooser needs the rows and the scope label, not the sheet's header
// material. Narrowing it keeps the call site honest about what it is for.
type DialogProps = Pick<SheetProps, "scope" | "tasks" | "cpmByWbs" | "selection" | "orientation"> & {
  setOrientation: (next: PrintOrientation) => void;
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
  orientation,
  logo,
}: SheetProps) {
  const rows = useMemo(() => buildPrintRows(tasks, cpmByWbs), [tasks, cpmByWbs]);
  const printing = useMemo(() => selectedPrintRows(rows, selection), [rows, selection]);
  // A row with a printed child is a summary: bold, shaded, so the branches
  // read as sections rather than one long list.
  const summaries = useMemo(() => {
    const out = new Set<string>();
    for (let i = 0; i < printing.length - 1; i++) {
      if (printing[i + 1].wbs.startsWith(`${printing[i].wbs}.`)) out.add(printing[i].wbs);
    }
    return out;
  }, [printing]);
  const count = printing.length === rows.length
    ? `${rows.length} task${rows.length === 1 ? "" : "s"}`
    : `${printing.length} of ${rows.length} tasks`;

  return (
    <div className={cn("sp-sheet hidden print:block", orientation === "portrait" ? "sp-portrait" : "sp-landscape")}>
      <header className="sp-head">
        {logo && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logo.src} alt={logo.alt} className="sp-logo" />
        )}
        <div className="sp-head-main">
          <div className="sp-project">{projectName}</div>
          <div className="sp-doc">
            Project Schedule <span className="sp-scope">- {scope ?? "All branches"}</span>
          </div>
        </div>
        <div className="sp-head-meta">
          {dataDate && <div><span>Data date</span> {longDate(dataDate)}</div>}
          <div><span>Printed</span> {longDate(new Date().toISOString())}</div>
          <div><span>Showing</span> {count}</div>
        </div>
      </header>
      <p className="sp-key">
        <span className="k-complete">Complete</span>
        <span className="k-critical">Critical path</span>
        <span className="k-slip">Behind the plan</span>
        <span>Slip is working days against the projection.</span>
      </p>
      <table className="sp-table">
        <colgroup>
          <col className="c-wbs" />
          <col className="c-task" />
          <col className="c-date" />
          <col className="c-date" />
          <col className="c-num" />
          <col className="c-num" />
          <col className="c-status" />
          <col className="c-num" />
        </colgroup>
        <thead>
          <tr>
            <th>WBS</th>
            <th>Task</th>
            <th>Start</th>
            <th>Finish</th>
            <th className="sp-num">Days</th>
            <th className="sp-num">%</th>
            <th>Status</th>
            <th className="sp-num">Slip</th>
          </tr>
        </thead>
        <tbody>
          {printing.map((r) => {
            const depth = Math.max(0, r.wbs.split(".").length - 1);
            return (
              <tr key={r.wbs} className={cn(printRowClass(r), summaries.has(r.wbs) && "sp-row-summary", depth === 0 && "sp-row-top")}>
                <td className="sp-wbs">{r.wbs}</td>
                <td style={{ paddingLeft: `${4 + depth * 9}pt` }}>
                  {r.milestone && <span className="sp-ms">&#9670; </span>}
                  {r.name}
                </td>
                <td className="sp-date">{r.start}</td>
                <td className="sp-date">{r.finish}</td>
                <td className="sp-num">{r.days}</td>
                <td className="sp-num">{r.pct}</td>
                <td className={r.complete ? "sp-done" : undefined}>{r.status}</td>
                <td className="sp-num sp-slipcell">{r.slip}</td>
              </tr>
            );
          })}
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
  orientation,
  setOrientation,
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
    setSelection(
      rangeSelect(
        rows.map((r) => r.wbs),
        selection,
        anchor.current,
        wbs,
        e.shiftKey,
      ),
    );
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
              <div className="mr-auto flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">Page</span>
                {(["landscape", "portrait"] as PrintOrientation[]).map((o) => (
                  <button
                    key={o}
                    type="button"
                    onClick={() => setOrientation(o)}
                    className={cn(
                      "rounded-md border px-2.5 py-1 capitalize",
                      orientation === o ? "bg-foreground text-background" : "bg-card hover:bg-muted",
                    )}
                  >
                    {o}
                  </button>
                ))}
              </div>
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
