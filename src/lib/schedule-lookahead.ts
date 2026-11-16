// Three-week look-ahead, generated from the schedule.
//
// This is the artifact the field actually runs on. Dennis Brookman writes his
// by hand in Outlook every week; the schedule already holds everything it needs
// to produce one, so it should come out of the system and go back to the sub
// rather than arriving as prose that somebody re-keys.
//
// Weeks run Monday to Sunday and are built from PROJECTED dates, not planned
// ones. A look-ahead that shows work in the week it was originally supposed to
// happen, rather than the week it will actually happen, is worse than none.

import {
  isWorkingDay,
  parseIso,
  toIso,
  todayIso,
  type CalendarLike,
} from "@/lib/schedule-calendar";
import type { CpmOutput } from "@/lib/schedule-cpm";
import { compareWbs } from "@/lib/schedule-edit";
import { scopeOf, type TaskScope } from "@/lib/schedule-scope";
import { nearestNamedAncestor } from "@/lib/schedule-task-search";

const DAY_MS = 86_400_000;

export type LookaheadTask = {
  wbs: string;
  name: string;
  /**
   * The branch this sits under, named.
   *
   * Zarina: "Can you add the Parent's name as well as there are the same lead
   * times but different parent rows." A look-ahead week is twelve cards all
   * reading "Lead Time", told apart only by a WBS code in 10px grey. The
   * parent is what says which piece of equipment it is.
   */
  parent: string | null;
  /**
   * The top-level WBS section, as "<code> <name>" ("4 Procurement"), or the
   * bare code when the schedule has no row for it.
   *
   * Phil: the look-ahead "should be grouped by the overall WBS code so they
   * stay in the correct order." Optional because issued weekly reports froze
   * look-ahead weeks before this existed.
   */
  section?: string | null;
  /** Set on look-ahead rows: the first week with work in it. See whenLabel. */
  firstWeek?: number;
  assignedTo: string | null;
  /**
   * Discipline, derived the same way the schedule grid's scope filter derives
   * it. Carried on the card so the weekly report can print one discipline on
   * its own: Dennis runs civil and does not need three weeks of mechanical
   * lead times in the sheet he works from.
   *
   * Zarina: "Can we only print the civil portion of the schedule through the
   * weekly progress report 3 week look ahead."
   */
  scope: TaskScope;
  start: string;
  end: string;
  pctComplete: number | null;
  critical: boolean;
  totalFloat: number;
  slipDays: number;
  // True when the task is already under way as of the first week.
  continuing: boolean;
  // True when its finish falls inside this week - the commitment that matters.
  finishing: boolean;
};

export type LookaheadWeek = {
  weekStart: string;
  weekEnd: string;
  label: string;
  workingDays: string[];
  tasks: LookaheadTask[];
};

export function mondayOf(iso: string): string {
  const ms = parseIso(iso);
  const dow = new Date(ms).getUTCDay();
  const back = dow === 0 ? 6 : dow - 1;
  return toIso(ms - back * DAY_MS);
}

function weekLabel(start: string, end: string): string {
  const f = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  };
  return `${f(start)} - ${f(end)}`;
}

/**
 * The nearest ancestor that exists, named.
 *
 * Walks the WBS up rather than following a parent column, because the code IS
 * the hierarchy. A level with no row of its own is skipped rather than
 * invented - an imported sheet can jump from 4.4 to 4.4.4.1 with nothing
 * between - so this answers "which branch" rather than "which code".
 */
export function parentLabel(
  wbs: string,
  nameByWbs: ReadonlyMap<string, string>,
): string | null {
  const at = nearestNamedAncestor(wbs, nameByWbs);
  return at ? `${at.wbs} ${at.name}` : null;
}

/**
 * Whether a task has no work left to plan, so it stays off the look-ahead.
 *
 * Phil, 2026-11-16, on Sussex: "the LNTP for equipment was rejected by
 * Dimension. Shouldn't that not show up on the three week look ahead?" The
 * look-ahead only skipped Complete, so the rejected review and the "LNTP
 * Executed" it was meant to produce were both shown as this week's work.
 *
 * Closed means Complete, Approved (finished, as statusTintBeatsCriticality
 * already treats it) or Rejected (dead - whatever replaces it is a new row),
 * matched loosely because imports put "Completed" and "COMPLETE" in the
 * column. Anything at 100% is finished whatever its status says.
 */
export function isClosedForLookahead(
  status: string | null | undefined,
  pctComplete?: number | null,
): boolean {
  if (Number(pctComplete ?? 0) >= 100) return true;
  const st = (status ?? "").trim().toLowerCase();
  return st === "complete" || st === "completed" || st === "approved" || st === "rejected";
}

/** The top-level section a code sits in: "4 Procurement" for 4.4.4.1. */
export function sectionLabel(
  wbs: string,
  nameByWbs: ReadonlyMap<string, string>,
): string {
  const top = wbs.split(".")[0];
  const name = nameByWbs.get(top);
  return name ? `${top} ${name}` : top;
}

export type LookaheadSection<T> = {
  /** "4 Procurement", or just "4" when the schedule has no row for it. */
  label: string;
  code: string;
  tasks: T[];
};

/**
 * A week's tasks gathered under their top-level WBS section, sections and
 * tasks both in schedule order.
 *
 * Works on frozen weekly-report weeks too: a task without `section` falls back
 * to its first WBS segment, so old payloads still group, just without a name.
 */
export function groupBySection<T extends { wbs: string; section?: string | null }>(
  tasks: readonly T[],
): LookaheadSection<T>[] {
  const sorted = [...tasks].sort((a, b) => compareWbs(a.wbs, b.wbs));
  const out: LookaheadSection<T>[] = [];
  for (const t of sorted) {
    const code = t.wbs.split(".")[0];
    const last = out[out.length - 1];
    if (last && last.code === code) {
      last.tasks.push(t);
      continue;
    }
    out.push({ code, label: t.section || code, tasks: [t] });
  }
  return out;
}

export function buildLookahead(
  tasks: {
    wbs_code: string;
    task_name: string;
    assigned_to: string | null;
    pct_complete: number | null;
    status: string | null;
    /** Only used for the scopes the WBS does not encode. May be absent on a
     *  snapshot taken before phase was selected. */
    phase?: string | null;
  }[],
  cpm: CpmOutput,
  opts: {
    weeks?: number;
    /** As-of date. Falls back to the CPM data date, then to today. */
    dataDate?: string;
    calendar?: CalendarLike;
  } = {},
): LookaheadWeek[] {
  // One lookup for every card in every week.
  const nameByWbs = new Map(tasks.map((t) => [t.wbs_code, t.task_name]));
  const weeks = opts.weeks ?? 3;
  const dataDate = opts.dataDate ?? cpm.dataDate ?? todayIso();
  const calendar = opts.calendar ?? 5;
  const first = mondayOf(dataDate);

  const out: LookaheadWeek[] = [];
  for (let w = 0; w < weeks; w++) {
    const startMs = parseIso(first) + w * 7 * DAY_MS;
    const weekStart = toIso(startMs);
    const weekEnd = toIso(startMs + 6 * DAY_MS);

    const workingDays: string[] = [];
    for (let d = 0; d < 7; d++) {
      const day = toIso(startMs + d * DAY_MS);
      if (isWorkingDay(day, calendar)) workingDays.push(day);
    }

    const inWeek: LookaheadTask[] = [];
    for (const t of tasks) {
      const c = cpm.byWbs.get(t.wbs_code);
      if (!c) continue; // summary rows are not work
      if (isClosedForLookahead(t.status, t.pct_complete)) continue;

      // Overlap test against the projected window, not the planned one.
      const s = parseIso(c.projectedStart);
      const e = parseIso(c.projectedEnd);
      if (e < startMs || s > startMs + 6 * DAY_MS) continue;

      inWeek.push({
        wbs: t.wbs_code,
        name: t.task_name,
        parent: parentLabel(t.wbs_code, nameByWbs),
        section: sectionLabel(t.wbs_code, nameByWbs),
        assignedTo: t.assigned_to,
        scope: scopeOf(t, nameByWbs),
        start: c.projectedStart,
        end: c.projectedEnd,
        pctComplete: t.pct_complete,
        critical: c.critical,
        totalFloat: c.totalFloat,
        slipDays: c.slipDays,
        continuing: s < startMs,
        finishing: e >= startMs && e <= startMs + 6 * DAY_MS,
      });
    }

    // Schedule order. This used to be critical first, then finishing, then by
    // start, which scattered a branch across the week and put 5.1 above 4.4.
    // The tags on each card still say what is critical or finishing; the order
    // now says where it sits in the schedule.
    inWeek.sort((a, b) => compareWbs(a.wbs, b.wbs));

    out.push({
      weekStart,
      weekEnd,
      label: weekLabel(weekStart, weekEnd),
      workingDays,
      tasks: inWeek,
    });
  }
  return out;
}

/**
 * One discipline's look-ahead, weeks and all.
 *
 * The weeks are kept even when a discipline has nothing in them. A week that
 * disappears reads as a shorter look-ahead; a week that says "no scheduled
 * work" reads as the fact it is.
 *
 * `scope` null means every discipline, which is the default and what the
 * report has always printed.
 *
 * The fallback matters: a report issued before scope existed has a frozen
 * look-ahead whose cards carry no `scope` field, and those still have to
 * filter correctly rather than vanishing. The WBS alone answers for the
 * construction branch, which is the only place a discipline filter is asked
 * for, so deriving from it is enough to keep an old sheet readable.
 */
export function filterLookahead(
  weeks: LookaheadWeek[],
  scope: TaskScope | null,
): LookaheadWeek[] {
  if (!scope) return weeks;
  return weeks.map((w) => ({
    ...w,
    tasks: w.tasks.filter(
      (t) => (t.scope ?? scopeOf({ wbs_code: t.wbs })) === scope,
    ),
  }));
}

/** How many activities a look-ahead holds, across its weeks. */
export function lookaheadCount(weeks: LookaheadWeek[]): number {
  return weeks.reduce((n, w) => n + w.tasks.length, 0);
}

// Plain-text look-ahead, formatted the way the subs already write them so it
// can be pasted straight into an email without anyone reformatting it.
export function lookaheadToText(
  weeks: LookaheadWeek[],
  projectName: string,
): string {
  const lines: string[] = [`${projectName} - ${weeks.length}-week look-ahead`, ""];
  for (const w of weeks) {
    lines.push(`*${w.label}`);
    if (!w.tasks.length) {
      lines.push("  (no scheduled work)");
    } else {
      for (const sec of groupBySection(w.tasks)) {
        lines.push(`  ${sec.label}`);
        for (const t of sec.tasks) {
          const bits: string[] = [];
          if (t.continuing) bits.push("continuing");
          if (t.finishing) bits.push("complete this week");
          if (t.critical) bits.push("critical");
          if (t.pctComplete != null) bits.push(`at ${t.pctComplete}%`);
          // The parent goes in the pasted text too. This is what gets read out
          // in the Monday meeting, where six identical "Lead Time" lines are
          // worse than on screen: there is no code column to squint at.
          lines.push(
            `    ${t.wbs}  ${t.parent ? `${t.parent} / ` : ""}${t.name}${bits.length ? ` (${bits.join(", ")})` : ""}`,
          );
        }
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The look-ahead as one row per task.
//
// The week-column cards repeated a three-week task three times, once per
// column, which is most of why the page read as a pile. The schedule tab now
// shows each task once, in WBS order, with a bar across the days it runs.
// Everything below is the data side of that, kept pure so it can be tested.
// ---------------------------------------------------------------------------

/** What a row is flagged for. The chips at the top count and filter these. */
export type LookaheadFlag = "now" | "critical" | "blocked" | "late" | "finishing";

/**
 * Which week a row first has work in: 0 is this week (including work already
 * under way), 1 next week, and so on.
 *
 * Phil, 2026-11-16: procurement three weeks out "could be seen that it's
 * needed now if you're making a quick look." The bar's position said when, but
 * only to someone reading the grid; every row's text looked the same. This is
 * what the When label and the dimming hang off.
 */
export function whenLabel(firstWeek: number): string {
  return firstWeek <= 0 ? "This week" : firstWeek === 1 ? "Next week" : `Week ${firstWeek + 1}`;
}

/**
 * Every task in the window, once, in WBS order.
 *
 * `continuing` means it started before the window opened; `finishing` means it
 * finishes in the first week. Both are recomputed against the whole window,
 * because the per-week values only meant something inside their own column.
 */
export function lookaheadRows(weeks: readonly LookaheadWeek[]): LookaheadTask[] {
  if (!weeks.length) return [];
  const windowStart = weeks[0].weekStart;
  const firstEnd = weeks[0].weekEnd;
  const seen = new Map<string, LookaheadTask>();
  weeks.forEach((w, i) => {
    for (const t of w.tasks) {
      if (seen.has(t.wbs)) continue;
      seen.set(t.wbs, {
        ...t,
        firstWeek: i,
        continuing: t.start < windowStart,
        finishing: t.end >= windowStart && t.end <= firstEnd,
      });
    }
  });
  return Array.from(seen.values()).sort((a, b) => compareWbs(a.wbs, b.wbs));
}

/** The same weeks with only the tasks that pass, for copy and print. */
export function filterWeeks(
  weeks: readonly LookaheadWeek[],
  keep: (t: LookaheadTask) => boolean,
): LookaheadWeek[] {
  return weeks.map((w) => ({ ...w, tasks: w.tasks.filter(keep) }));
}

/** Who the work is assigned to, for the filter. Unassigned is its own entry. */
export const UNASSIGNED = "__unassigned__";
export function lookaheadAssignees(rows: readonly LookaheadTask[]): string[] {
  const names = new Set<string>();
  let blank = false;
  for (const r of rows) {
    const a = r.assignedTo?.trim();
    if (a) names.add(a);
    else blank = true;
  }
  const out = Array.from(names).sort((a, b) => a.localeCompare(b));
  if (blank) out.push(UNASSIGNED);
  return out;
}

export function matchesAssignee(t: LookaheadTask, assignee: string): boolean {
  if (!assignee) return true;
  const a = t.assignedTo?.trim() ?? "";
  return assignee === UNASSIGNED ? a === "" : a === assignee;
}

/**
 * Calendar days the schedule's data date sits behind today.
 *
 * The look-ahead now starts at today's week. The bars still come from the
 * projection, which was last run as of the data date, so a stale data date
 * means the bars are guesses the field has already moved past.
 */
export function staleDays(dataDate: string | null | undefined, today: string): number {
  if (!dataDate) return 0;
  return Math.max(0, Math.round((parseIso(today) - parseIso(dataDate)) / DAY_MS));
}

export const STALE_AFTER_DAYS = 7;

export function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A printable look-ahead: one landscape page per sheet, grouped by WBS
 * section, with the same day grid as the screen. Written as a standalone
 * document so it prints without the app's sidebar and chrome, and so "Save as
 * PDF" from the print dialog gives something a sub can be sent.
 */
export function lookaheadToPrintHtml(
  weeks: readonly LookaheadWeek[],
  opts: { projectName: string; subtitle?: string; generated: string },
): string {
  const rows = lookaheadRows(weeks);
  const days = weeks.flatMap((w, i) => w.workingDays.map((d) => ({ d, week: i })));
  const head1 = weeks
    .map(
      (w) =>
        `<th class="wk" colspan="${Math.max(1, w.workingDays.length)}">${esc(w.label)}</th>`,
    )
    .join("");
  const head2 = days
    .map(({ d }, i) => {
      const dow = new Date(parseIso(d)).toLocaleDateString("en-US", {
        weekday: "narrow",
        timeZone: "UTC",
      });
      const startsWeek = i > 0 && days[i - 1].week !== days[i].week;
      return `<th class="day${startsWeek ? " wb" : ""}${days[i].week === 0 ? " tw" : ""}">${dow}<br>${Number(d.slice(8))}</th>`;
    })
    .join("");
  const cols = 6 + days.length;

  const body = rows.length
    ? groupBySection(rows)
        .map((sec) => {
          const head = `<tr class="sec"><td colspan="${cols}">${esc(sec.label)} <span class="n">(${sec.tasks.length})</span></td></tr>`;
          const lines = sec.tasks
            .map((t) => {
              const tags = [
                t.critical ? "critical" : "",
                t.slipDays > 0 ? `${t.slipDays}d late` : "",
                t.pctComplete != null ? `${t.pctComplete}%` : "",
              ].filter(Boolean);
              const cells = days
                .map(({ d }, i) => {
                  const on = d >= t.start && d <= t.end;
                  const startsWeek = i > 0 && days[i - 1].week !== days[i].week;
                  return `<td class="day${startsWeek ? " wb" : ""}${days[i].week === 0 ? " tw" : ""}">${on ? `<div class="bar${t.critical ? " crit" : ""}"></div>` : ""}</td>`;
                })
                .join("");
              const fw = t.firstWeek ?? 0;
              return `<tr class="${fw > 0 ? "later" : ""}"><td class="when w${Math.min(fw, 2)}">${whenLabel(fw)}</td><td class="mono">${esc(t.wbs)}</td><td class="act">${t.parent ? `<div class="par">${esc(t.parent)}</div>` : ""}<div>${esc(t.name)}${tags.length ? ` <span class="tag">${esc(tags.join(", "))}</span>` : ""}</div></td><td>${esc(t.assignedTo ?? "-")}</td><td>${shortDate(t.start)}</td><td>${shortDate(t.end)}</td>${cells}</tr>`;
            })
            .join("");
          return head + lines;
        })
        .join("")
    : `<tr><td colspan="${cols}" class="empty">No scheduled work.</td></tr>`;

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(opts.projectName)} look-ahead</title>
<style>
@page{size:landscape;margin:10mm}
body{font:10px/1.3 -apple-system,Segoe UI,Arial,sans-serif;color:#111;margin:0}
h1{font-size:14px;margin:0}
.sub{color:#555;margin:2px 0 8px}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #999;padding:2px 4px;vertical-align:top;text-align:left}
th{background:#1f4e79;color:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
th.wk{text-align:center}
th.day,td.day{width:18px;padding:1px;text-align:center;font-weight:normal}
th.w-when{width:58px}th.w-wbs{width:56px}th.w-who{width:120px}th.w-d{width:44px}
.wb{border-left:2px solid #333}
td.tw{background:#eef4fb;-webkit-print-color-adjust:exact;print-color-adjust:exact}
tr.sec td{background:#bdd7ee;font-weight:bold;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.n{font-weight:normal;color:#333}
.mono{font-family:ui-monospace,Menlo,monospace;white-space:nowrap}
.act{min-width:180px}
.par{color:#666;font-size:9px}
.tag{color:#a40000;font-size:9px}
.bar{height:8px;background:#4a7ab0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.bar.crit{background:#c0392b}
.empty{font-style:italic}
.when{white-space:nowrap;font-weight:bold;font-size:9px}.w0{color:#fff;background:#1f4e79;-webkit-print-color-adjust:exact;print-color-adjust:exact}.w1{background:#fde9c8;-webkit-print-color-adjust:exact;print-color-adjust:exact}.w2{color:#555}
tr.later td.act{color:#555}
tr{page-break-inside:avoid}
</style></head><body>
<h1>${esc(opts.projectName)} - ${weeks.length}-week look-ahead</h1>
<div class="sub">${opts.subtitle ? `${esc(opts.subtitle)} - ` : ""}Generated ${esc(opts.generated)}</div>
<table><thead><tr><th rowspan="2" class="w-when">When</th><th rowspan="2" class="w-wbs">WBS</th><th rowspan="2">Activity</th><th rowspan="2" class="w-who">Responsible</th><th rowspan="2" class="w-d">Start</th><th rowspan="2" class="w-d">Finish</th>${head1}</tr><tr>${head2}</tr></thead>
<tbody>${body}</tbody></table>
</body></html>`;
}
