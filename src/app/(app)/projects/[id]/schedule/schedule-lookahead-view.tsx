"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { buildLookahead, lookaheadToText } from "@/lib/schedule-lookahead";
import type { CalendarLike } from "@/lib/schedule-calendar";
import type { CpmOutput } from "@/lib/schedule-cpm";
import type { TaskConstraintState } from "@/lib/schedule-constraints";

type Task = {
  wbs_code: string;
  task_name: string;
  assigned_to: string | null;
  pct_complete: number | null;
  status: string | null;
};

type Props = {
  tasks: Task[];
  cpm: CpmOutput;
  projectName: string;
  calendar: CalendarLike;
  constraintState: Map<string, TaskConstraintState>;
};

export function ScheduleLookaheadView({
  tasks,
  cpm,
  projectName,
  calendar,
  constraintState,
}: Props) {
  const [weeks, setWeeks] = useState(3);
  const [copied, setCopied] = useState(false);

  const lookahead = useMemo(
    () => buildLookahead(tasks, cpm, { weeks, calendar, dataDate: cpm.dataDate }),
    [tasks, cpm, weeks, calendar],
  );

  const text = useMemo(
    () => lookaheadToText(lookahead, projectName),
    [lookahead, projectName],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 rounded-md border bg-card p-1">
          {[2, 3, 4, 6].map((w) => (
            <button
              key={w}
              onClick={() => setWeeks(w)}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium",
                weeks === w ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
              )}
            >
              {w} week
            </button>
          ))}
        </div>
        <Button variant="outline" size="sm" onClick={copy}>
          {copied ? "Copied" : "Copy as text"}
        </Button>
        <span className="text-xs text-muted-foreground">
          Built from projected dates, so work shows in the week it will actually happen.
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {lookahead.map((w, i) => (
          <div key={w.weekStart} className="rounded-lg border bg-card shadow-sm">
            <div className="border-b bg-muted/40 px-3 py-2">
              <div className="text-sm font-semibold">{w.label}</div>
              <div className="text-[11px] text-muted-foreground">
                {i === 0 ? "This week" : `Week ${i + 1}`} - {w.workingDays.length} working days
              </div>
            </div>
            <div className="divide-y">
              {w.tasks.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  No scheduled work
                </div>
              ) : (
                w.tasks.map((t) => {
                  const blocked = constraintState.get(t.wbs);
                  return (
                  <div key={t.wbs} className="px-3 py-2.5">
                    <div className="flex flex-wrap items-start gap-2">
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {t.wbs}
                      </span>
                      {t.critical && (
                        <span className="rounded bg-destructive/10 px-1 text-[10px] font-medium text-destructive">
                          CRITICAL
                        </span>
                      )}
                      {!t.critical && t.totalFloat > 0 && t.totalFloat <= 5 && (
                        <span className="rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-900">
                          NEAR
                        </span>
                      )}
                      {/* A task in the look-ahead with an open constraint is
                          the one to talk about in the meeting: it is planned
                          for this week and something is in its way. */}
                      {blocked && blocked.open > 0 && (
                        <span
                          className={cn(
                            "rounded px-1 text-[10px] font-medium",
                            blocked.overdue > 0
                              ? "bg-destructive/10 text-destructive"
                              : "bg-amber-100 text-amber-900",
                          )}
                          title={
                            blocked.nextNeedBy
                              ? `${blocked.open} open, next needed by ${blocked.nextNeedBy}`
                              : `${blocked.open} open constraint${blocked.open === 1 ? "" : "s"}`
                          }
                        >
                          BLOCKED {blocked.open}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-sm font-medium leading-tight">{t.name}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                      {t.assignedTo && <span>{t.assignedTo}</span>}
                      {t.pctComplete != null && (
                        <span className="text-emerald-700">at {t.pctComplete}%</span>
                      )}
                      {t.continuing && <span>continuing</span>}
                      {t.finishing && (
                        <span className="font-medium text-blue-700">finishes this week</span>
                      )}
                      {t.slipDays > 0 && (
                        <span className="text-amber-700">{t.slipDays}d late</span>
                      )}
                    </div>
                  </div>
                  );
                })
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
