// Printing part of a schedule.
//
// The scope filter on the schedule page already narrows what is on screen, but
// there was no way to get the narrowed result onto paper. The only Print button
// in the section sat on the Health tab and was a bare window.print(), so it put
// the nav and the page chrome on the sheet alongside the findings.
//
// Two things decide what prints: the scope filter, which is already applied by
// the time these rows are built, and an explicit row selection on top of it.
// The selection is the one Zarina asked for - a civil schedule going to a sub
// is rarely every civil task, it is the eleven that are actually theirs.
//
// Dates are the task's own planned dates, because that is what a reader means
// by "the schedule". Where the projection disagrees the slip is printed beside
// them rather than silently replacing them: a sheet that quietly swaps planned
// for forecast is a sheet nobody can reconcile against the baseline.

import { compareWbs } from "@/lib/schedule-edit";
import { formatDate } from "@/lib/format";

export type PrintableTask = {
  wbs_code: string;
  task_name: string;
  status?: string | null;
  pct_complete?: number | null;
  duration_days?: number | null;
  start_date?: string | null;
  end_date?: string | null;
  is_milestone?: boolean | null;
};

/** Only the fields the sheet reads, so the whole CPM does not have to be here. */
export type PrintCpmLike = {
  slipDays?: number | null;
  critical?: boolean | null;
};

export type PrintRow = {
  wbs: string;
  name: string;
  start: string;
  finish: string;
  /** Blank rather than "0" on a milestone - a milestone has no duration. */
  days: string;
  pct: string;
  status: string;
  /** "-" when the projection agrees with the plan. */
  slip: string;
  critical: boolean;
  milestone: boolean;
};

export function buildPrintRows(
  tasks: readonly PrintableTask[],
  cpmByWbs?: ReadonlyMap<string, PrintCpmLike> | null,
): PrintRow[] {
  return [...tasks]
    .sort((a, b) => compareWbs(a.wbs_code ?? "", b.wbs_code ?? ""))
    .map((t) => {
      const c = cpmByWbs?.get(t.wbs_code);
      const milestone = t.is_milestone === true;
      const slip = Number(c?.slipDays ?? 0);
      const pct = t.pct_complete;
      return {
        wbs: t.wbs_code ?? "",
        name: t.task_name ?? "",
        start: formatDate(t.start_date),
        finish: formatDate(t.end_date),
        days:
          milestone || t.duration_days == null
            ? ""
            : String(Number(t.duration_days)),
        // A null percent is not zero percent. Zero is a measurement, null is
        // nobody having said, and a sub reading a printed 0% treats it as the
        // first and plans around it.
        pct:
          pct == null || !Number.isFinite(Number(pct))
            ? "-"
            : `${Math.round(Number(pct))}%`,
        status: (t.status ?? "").trim() || "-",
        slip: Number.isFinite(slip) && slip > 0 ? `+${slip}d` : "-",
        critical: c?.critical === true,
        milestone,
      };
    });
}

/**
 * The rows that actually print.
 *
 * `null` means no selection has been made, which prints everything in scope.
 * An EMPTY set is not the same thing: it means every box was unticked, and the
 * sheet is then genuinely empty rather than quietly reverting to all.
 */
export function selectedPrintRows(
  rows: readonly PrintRow[],
  selected: ReadonlySet<string> | null,
): PrintRow[] {
  if (!selected) return [...rows];
  return rows.filter((r) => selected.has(r.wbs));
}

/**
 * The line across the top of the sheet.
 *
 * It has to say what was filtered out, because a printed page carries no
 * dropdown. Somebody handed eleven civil rows with no header cannot tell
 * whether that is the whole civil scope or a cut of it.
 */
export function printSheetTitle(
  projectName: string,
  scope: string | null,
  shown: number,
  inScope: number,
): string {
  const where = scope ? `${scope} scope` : "All scopes";
  const count =
    shown === inScope
      ? `${inScope} task${inScope === 1 ? "" : "s"}`
      : `${shown} of ${inScope} task${inScope === 1 ? "" : "s"} selected`;
  return `${projectName} - ${where} - ${count}`;
}

/** Printed under the title so a sheet found on a desk can be dated. */
export function printSheetStamp(
  dataDate: string | null | undefined,
  printedOn: string,
): string {
  const printed = `Printed ${formatDate(printedOn)}`;
  return dataDate ? `Data date ${formatDate(dataDate)} - ${printed}` : printed;
}

// ---------------------------------------------------------------------------
// Range selection
// ---------------------------------------------------------------------------
//
// Unticking 180 of 204 boxes one at a time is not a feature, it is a chore the
// chooser handed back. Shift-click takes the anchor (the last box clicked) and
// the box just clicked and applies ONE state across everything between them.
//
// The state applied is the one the click itself produces, not a blind toggle.
// Toggling each row in the range independently is the obvious implementation
// and the wrong one: on a mixed range it inverts the pattern instead of
// flattening it, so a second shift-click does not undo the first and the
// person is left worse off than before they tried.

export function rangeSelect(
  rows: readonly { wbs: string }[],
  selected: ReadonlySet<string> | null,
  anchorWbs: string | null,
  clickedWbs: string,
  shift: boolean,
): Set<string> {
  // A null selection means everything in scope is on. Materialise it before
  // the first untick, or the set would start empty and read as "all cleared".
  const next = new Set(selected ?? rows.map((r) => r.wbs));
  const target = !next.has(clickedWbs);

  const from = anchorWbs == null ? -1 : rows.findIndex((r) => r.wbs === anchorWbs);
  const to = rows.findIndex((r) => r.wbs === clickedWbs);

  // No shift, no anchor, an anchor that scrolled out of the current scope, or
  // a click on the anchor itself: this is an ordinary one-row toggle.
  if (!shift || from < 0 || to < 0 || from === to) {
    if (to < 0) return next;
    if (target) next.add(clickedWbs);
    else next.delete(clickedWbs);
    return next;
  }

  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  for (let i = lo; i <= hi; i++) {
    if (target) next.add(rows[i].wbs);
    else next.delete(rows[i].wbs);
  }
  return next;
}
