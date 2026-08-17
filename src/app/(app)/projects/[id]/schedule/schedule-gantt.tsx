"use client";

import { useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import { parseIso, toIso, todayIso } from "@/lib/schedule-calendar";
import type { CpmOutput } from "@/lib/schedule-cpm";

const DAY_MS = 86_400_000;

export type GanttTask = {
  id: string;
  wbs_code: string;
  task_name: string;
  start_date: string | null;
  end_date: string | null;
  baseline_start?: string | null;
  baseline_end?: string | null;
  pct_complete: number | null;
  status: string | null;
  level_code: number | null;
  is_at_risk: boolean | null;
};

type Props = {
  tasks: GanttTask[];
  cpm: CpmOutput;
};

const ZOOMS = [
  { label: "Fit", px: 0 },
  { label: "Month", px: 3 },
  { label: "Week", px: 9 },
  { label: "Day", px: 26 },
] as const;

function monthLabel(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  });
}

function shortDate(iso: string | null): string {
  if (!iso) return "-";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function ScheduleGantt({ tasks, cpm }: Props) {
  const [zoom, setZoom] = useState(1);
  const [hover, setHover] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const today = todayIso();

  // Span every date the chart has to show, including projected finishes, which
  // reach past the planned dates whenever the job is running late.
  const { min, max, days } = useMemo(() => {
    const all: number[] = [];
    for (const t of tasks) {
      for (const d of [t.start_date, t.end_date, t.baseline_start, t.baseline_end])
        if (d) all.push(parseIso(d));
      const c = cpm.byWbs.get(t.wbs_code);
      if (c) { all.push(parseIso(c.projectedStart)); all.push(parseIso(c.projectedEnd)); }
    }
    all.push(parseIso(today));
    if (!all.length) return { min: 0, max: 0, days: 1 };
    const lo = Math.min(...all) - 3 * DAY_MS;
    const hi = Math.max(...all) + 3 * DAY_MS;
    return { min: lo, max: hi, days: Math.round((hi - lo) / DAY_MS) + 1 };
  }, [tasks, cpm, today]);

  // "Fit" divides the available width across the span instead of using a fixed
  // per-day size, so a 13-month schedule and a 3-week one both land on screen.
  const dayPx = ZOOMS[zoom].px || Math.max(1.5, 900 / Math.max(days, 1));
  const width = Math.max(600, days * dayPx);

  const xOf = (iso: string) => ((parseIso(iso) - min) / DAY_MS) * dayPx;
  const wOf = (a: string, b: string) =>
    Math.max(dayPx * 0.8, ((parseIso(b) - parseIso(a)) / DAY_MS + 1) * dayPx);

  // Month boundaries for the header and the vertical rules behind the bars.
  const months = useMemo(() => {
    const out: { iso: string; x: number; label: string }[] = [];
    if (!min) return out;
    const d = new Date(min);
    let cur = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    while (cur <= max) {
      const iso = toIso(cur);
      out.push({ iso, x: xOf(iso), label: monthLabel(iso) });
      const nd = new Date(cur);
      cur = Date.UTC(nd.getUTCFullYear(), nd.getUTCMonth() + 1, 1);
    }
    return out;
  }, [min, max, dayPx]); // eslint-disable-line react-hooks/exhaustive-deps

  const rowH = 30;
  const todayX = xOf(today);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 rounded-md border bg-card p-1">
          {ZOOMS.map((z, i) => (
            <button
              key={z.label}
              onClick={() => setZoom(i)}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium",
                zoom === i ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
              )}
            >
              {z.label}
            </button>
          ))}
        </div>
        <Legend />
      </div>

      <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
        <div className="flex">
          {/* Task names stay put while the timeline scrolls. */}
          <div className="w-64 shrink-0 border-r bg-card">
            <div className="h-9 border-b bg-muted/40 px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Task
            </div>
            {tasks.map((t) => {
              const c = cpm.byWbs.get(t.wbs_code);
              return (
                <div
                  key={t.id}
                  onMouseEnter={() => setHover(t.wbs_code)}
                  onMouseLeave={() => setHover(null)}
                  className={cn(
                    "flex items-center gap-2 border-b px-3 text-xs",
                    hover === t.wbs_code && "bg-muted/40",
                  )}
                  style={{ height: rowH }}
                >
                  <span
                    className="truncate"
                    style={{ paddingLeft: Math.max(0, (t.level_code ?? 1) - 1) * 10 }}
                    title={`${t.wbs_code} ${t.task_name}`}
                  >
                    <span className={cn(!c && "font-semibold text-muted-foreground")}>
                      {t.task_name}
                    </span>
                  </span>
                  {c?.critical && (
                    <span className="ml-auto shrink-0 rounded bg-destructive/10 px-1 text-[10px] font-medium text-destructive">
                      CP
                    </span>
                  )}
                  {!c?.critical && c?.nearCritical && (
                    <span
                      className="ml-auto shrink-0 rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-900"
                      title={`${c.totalFloat} working days of float`}
                    >
                      {c.totalFloat}d
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          <div ref={scrollRef} className="flex-1 overflow-x-auto">
            <div style={{ width }}>
              {/* Month header */}
              <div className="relative h-9 border-b bg-muted/40">
                {months.map((m) => (
                  <div
                    key={m.iso}
                    className="absolute top-0 h-full border-l border-border/60 px-1.5 py-2 text-[11px] font-medium text-muted-foreground"
                    style={{ left: m.x }}
                  >
                    {m.label}
                  </div>
                ))}
              </div>

              <div className="relative">
                {months.map((m) => (
                  <div
                    key={m.iso}
                    className="absolute top-0 bottom-0 w-px bg-border/50"
                    style={{ left: m.x }}
                  />
                ))}
                {todayX >= 0 && todayX <= width && (
                  <div
                    className="absolute top-0 bottom-0 z-20 w-px bg-blue-500"
                    style={{ left: todayX }}
                    title={`Today ${today}`}
                  >
                    <div className="absolute -top-0 -left-[3px] h-1.5 w-1.5 rounded-full bg-blue-500" />
                  </div>
                )}

                {tasks.map((t) => {
                  const c = cpm.byWbs.get(t.wbs_code);
                  const isSummary = !c;
                  const start = t.start_date;
                  const end = t.end_date;
                  const pct = Math.max(0, Math.min(100, Number(t.pct_complete ?? 0)));
                  // A projected finish beyond the planned one is drawn as an
                  // amber tail so the slip is visible without reading a number.
                  const slipTail =
                    c && end && parseIso(c.projectedEnd) > parseIso(end)
                      ? { from: end, to: c.projectedEnd }
                      : null;

                  return (
                    <div
                      key={t.id}
                      onMouseEnter={() => setHover(t.wbs_code)}
                      onMouseLeave={() => setHover(null)}
                      className={cn(
                        "relative border-b",
                        hover === t.wbs_code && "bg-muted/40",
                      )}
                      style={{ height: rowH }}
                    >
                      {t.baseline_start && t.baseline_end && (
                        <div
                          className="absolute rounded-sm bg-muted-foreground/30"
                          style={{
                            left: xOf(t.baseline_start),
                            width: wOf(t.baseline_start, t.baseline_end),
                            top: rowH - 8,
                            height: 3,
                          }}
                          title={`Baseline ${shortDate(t.baseline_start)} - ${shortDate(t.baseline_end)}`}
                        />
                      )}

                      {slipTail && (
                        <div
                          className="absolute rounded-r-sm bg-amber-400/70"
                          style={{
                            left: xOf(slipTail.from),
                            width: wOf(slipTail.from, slipTail.to),
                            top: 8,
                            height: 11,
                          }}
                          title={`Projected finish ${shortDate(slipTail.to)} (${c!.slipDays} working days late)`}
                        />
                      )}

                      {/* A milestone marks an instant, so it is drawn as a
                          diamond rather than a bar of arbitrary width. A
                          one-day-wide rectangle reads as work. */}
                      {start && c?.isMilestone && (
                        <div
                          className={cn(
                            "absolute rotate-45",
                            c.critical ? "bg-destructive" : "bg-foreground/80",
                          )}
                          style={{
                            left: xOf(start) - 4,
                            width: 9,
                            height: 9,
                            top: rowH / 2 - 5,
                          }}
                          title={`${t.wbs_code} ${t.task_name}\nMilestone ${shortDate(start)}${c ? `\nFloat ${c.totalFloat}d` : ""}`}
                        />
                      )}

                      {start && end && !c?.isMilestone && (
                        <div
                          className={cn(
                            "absolute overflow-hidden rounded-sm",
                            isSummary
                              ? "bg-foreground/70"
                              : c?.critical
                                ? "bg-destructive/80"
                                : c?.nearCritical
                                  ? "bg-amber-500/80"
                                  : "bg-blue-500/80",
                          )}
                          style={{
                            left: xOf(start),
                            width: wOf(start, end),
                            top: isSummary ? 11 : 8,
                            height: isSummary ? 6 : 11,
                          }}
                          title={`${t.wbs_code} ${t.task_name}\n${shortDate(start)} - ${shortDate(end)}${c ? `\nFloat ${c.totalFloat}d total, ${c.freeFloat}d free${c.critical ? " (critical)" : c.nearCritical ? " (near critical)" : ""}` : ""}`}
                        >
                          {!isSummary && pct > 0 && (
                            <div
                              className="h-full bg-emerald-500"
                              style={{ width: `${pct}%` }}
                            />
                          )}
                        </div>
                      )}

                      {!start && !end && c && (
                        <div
                          className="absolute rounded-sm border border-dashed border-amber-500 bg-amber-100/50"
                          style={{
                            left: xOf(c.projectedStart),
                            width: wOf(c.projectedStart, c.projectedEnd),
                            top: 8,
                            height: 11,
                          }}
                          title="No planned dates - showing projection only"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Legend() {
  const items = [
    { cls: "bg-blue-500/80", label: "Planned" },
    { cls: "bg-emerald-500", label: "Complete" },
    { cls: "bg-destructive/80", label: "Critical path" },
    { cls: "bg-amber-500/80", label: "Near critical" },
    { cls: "bg-amber-400/70", label: "Projected slip" },
    { cls: "bg-muted-foreground/30", label: "Baseline" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          <span className={cn("inline-block h-2 w-4 rounded-sm", i.cls)} />
          {i.label}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rotate-45 bg-foreground/80" />
        Milestone
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-3 w-px bg-blue-500" />
        Today
      </span>
    </div>
  );
}
