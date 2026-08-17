"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { healthToText, type HealthCheck, type HealthResult, type HealthStatus } from "@/lib/schedule-health";
import type { CpmOutput } from "@/lib/schedule-cpm";
import { deleteScheduleUpdate } from "../schedule-actions";

export type ScheduleUpdateRow = {
  id: string;
  data_date: string;
  label: string | null;
  notes: string | null;
  planned_finish: string | null;
  projected_finish: string | null;
  finish_slip_days: number | null;
  task_count: number | null;
  critical_count: number | null;
  health_score: number | null;
  taken_at: string | null;
};

type Props = {
  health: HealthResult;
  cpm: CpmOutput;
  projectName: string;
  projectId: string;
  updates: ScheduleUpdateRow[];
  updatesAvailable: boolean;
  baselineAvailable: boolean;
};

function fmt(iso: string | null): string {
  if (!iso) return "-";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "2-digit",
    timeZone: "UTC",
  });
}

const STATUS_STYLE: Record<HealthStatus, { chip: string; label: string }> = {
  pass: { chip: "bg-emerald-100 text-emerald-900", label: "Pass" },
  warn: { chip: "bg-amber-100 text-amber-900", label: "Watch" },
  fail: { chip: "bg-destructive/10 text-destructive", label: "Fail" },
  na: { chip: "bg-muted text-muted-foreground", label: "n/a" },
};

export function ScheduleHealthView({
  health,
  cpm,
  projectName,
  projectId,
  updates,
  updatesAvailable,
  baselineAvailable,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [expanded, setExpanded] = useState<string | null>(
    health.findings[0]?.id ?? null,
  );
  const [copied, setCopied] = useState(false);

  const text = healthToText(health, projectName);

  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-4">
      {/* Score header */}
      <div className="flex flex-wrap items-center gap-6 rounded-lg border bg-card p-4 shadow-sm">
        <div>
          <div
            className={cn(
              "text-4xl font-semibold tabular-nums",
              health.score >= 80
                ? "text-emerald-700"
                : health.score >= 60
                  ? "text-amber-700"
                  : "text-destructive",
            )}
          >
            {health.score}
            <span className="text-lg font-normal text-muted-foreground">/100</span>
          </div>
          <div className="text-xs text-muted-foreground">
            Grade {health.grade} &middot; data date {fmt(health.dataDate)}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
          <Tally label="Tasks" value={health.taskCount} />
          <Tally label="Links" value={health.relationshipCount} />
          <Tally
            label="Failing"
            value={health.checks.filter((c) => c.status === "fail").length}
            tone="bad"
          />
          <Tally
            label="Watch"
            value={health.checks.filter((c) => c.status === "warn").length}
            tone="warn"
          />
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={copy}>
            {copied ? "Copied" : "Copy report"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => window.print()}>
            Print
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        The DCMA 14-point assessment, run over the whole schedule - the scope
        filter does not apply here, because a logic gap between two disciplines
        is invisible from inside either one. Every finding below names the tasks
        responsible; fix them on the Table tab with Edit.
      </p>

      {/* Findings first - this is a worklist, not a report */}
      {health.findings.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            What to fix, worst first
          </h3>
          {health.findings.map((c) => (
            <CheckRow
              key={c.id}
              check={c}
              open={expanded === c.id}
              onToggle={() => setExpanded(expanded === c.id ? null : c.id)}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
          Every check passes. The schedule is built well enough to be believed.
        </div>
      )}

      {/* Constraint conflicts, which are their own kind of finding */}
      {cpm.constraintViolations.length > 0 && (
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <h3 className="text-sm font-semibold">Date constraints the logic cannot meet</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            A hard date and the network disagree. The engine reports these rather
            than quietly resolving them, because either the date moves or the
            sequence does, and that is not its call.
          </p>
          <ul className="mt-3 space-y-2">
            {cpm.constraintViolations.map((v) => (
              <li key={v.wbs} className="flex gap-2 text-xs">
                <span className="shrink-0 font-mono text-muted-foreground">{v.wbs}</span>
                <span>{v.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* All fourteen, including the passes */}
      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          All fourteen checks
        </h3>
        <div className="overflow-x-auto rounded-lg border bg-card shadow-sm">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-3 font-medium">Check</th>
                <th className="px-3 py-3 font-medium">Asks</th>
                <th className="px-3 py-3 font-medium">Measured</th>
                <th className="px-3 py-3 font-medium">Target</th>
                <th className="px-3 py-3 font-medium">Verdict</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {health.checks.map((c) => (
                <tr
                  key={c.id}
                  className="cursor-pointer hover:bg-muted/30"
                  onClick={() => setExpanded(expanded === c.id ? null : c.id)}
                >
                  <td className="px-3 py-2.5 font-medium">{c.name}</td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">{c.question}</td>
                  <td className="px-3 py-2.5 tabular-nums">{c.display}</td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">{c.threshold}</td>
                  <td className="px-3 py-2.5">
                    <span
                      className={cn(
                        "inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
                        STATUS_STYLE[c.status].chip,
                      )}
                    >
                      {STATUS_STYLE[c.status].label}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {expanded && !health.findings.some((f) => f.id === expanded) && (
          <CheckRow
            check={health.checks.find((c) => c.id === expanded)!}
            open
            onToggle={() => setExpanded(null)}
          />
        )}
      </div>

      {/* Update history */}
      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Update history
        </h3>
        {!updatesAvailable ? (
          <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
            Migration 0033 has not been applied, so schedule updates cannot be
            captured. Until it lands, a re-baseline overwrites the previous dates
            with no surviving copy - which is exactly what happened to the July
            civil dates.
          </p>
        ) : !updates.length ? (
          <p className="rounded-md border bg-card p-3 text-xs text-muted-foreground">
            No updates captured yet. Take one from the toolbar to freeze the
            schedule as it stands - it is the only record of what the schedule
            said on a given date, and the thing a delay claim points at.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border bg-card shadow-sm">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-3 font-medium">Data date</th>
                  <th className="px-3 py-3 font-medium">Label</th>
                  <th className="px-3 py-3 font-medium">Planned</th>
                  <th className="px-3 py-3 font-medium">Projected</th>
                  <th className="px-3 py-3 text-right font-medium">Slip</th>
                  <th className="px-3 py-3 text-right font-medium">Move</th>
                  <th className="px-3 py-3 text-right font-medium">Health</th>
                  <th className="px-3 py-3 text-right font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {updates.map((u, i) => {
                  // Update-over-update movement: the number the monthly meeting
                  // actually asks for. Not "are we late" but "did we get later
                  // since last time".
                  const prev = updates[i + 1];
                  const moved =
                    prev?.projected_finish && u.projected_finish
                      ? Math.round(
                          (Date.parse(u.projected_finish) -
                            Date.parse(prev.projected_finish)) /
                            86_400_000,
                        )
                      : null;
                  return (
                    <tr key={u.id} className="hover:bg-muted/30">
                      <td className="px-3 py-2.5 font-medium">{fmt(u.data_date)}</td>
                      <td className="px-3 py-2.5 text-xs text-muted-foreground">
                        {u.label ?? "-"}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">
                        {fmt(u.planned_finish)}
                      </td>
                      <td className="px-3 py-2.5">{fmt(u.projected_finish)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {u.finish_slip_days == null ? (
                          "-"
                        ) : (
                          <span
                            className={cn(
                              u.finish_slip_days > 0
                                ? "text-destructive"
                                : u.finish_slip_days < 0
                                  ? "text-emerald-700"
                                  : "text-muted-foreground",
                            )}
                          >
                            {u.finish_slip_days > 0 ? `+${u.finish_slip_days}d` : `${u.finish_slip_days}d`}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {moved == null ? (
                          <span className="text-xs text-muted-foreground">-</span>
                        ) : (
                          <span
                            className={cn(
                              "text-xs",
                              moved > 0
                                ? "font-medium text-destructive"
                                : moved < 0
                                  ? "text-emerald-700"
                                  : "text-muted-foreground",
                            )}
                            title="Change in projected finish since the previous update"
                          >
                            {moved > 0 ? `+${moved}d` : moved < 0 ? `${moved}d` : "held"}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">
                        {u.health_score ?? "-"}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <button
                          className="text-xs text-muted-foreground hover:text-destructive"
                          disabled={pending}
                          onClick={() =>
                            startTransition(async () => {
                              await deleteScheduleUpdate(projectId, u.id);
                              router.refresh();
                            })
                          }
                          title="Back out a snapshot taken by mistake"
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!baselineAvailable && (
        <p className="text-xs text-amber-700">
          Two checks - Missed tasks and BEI - need a baseline and are excluded
          from the score until one is set.
        </p>
      )}
    </div>
  );
}

function CheckRow({
  check,
  open,
  onToggle,
}: {
  check: HealthCheck;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border bg-card shadow-sm",
        check.status === "fail" && "border-destructive/40",
        check.status === "warn" && "border-amber-300",
      )}
    >
      <button
        onClick={onToggle}
        className="flex w-full items-start gap-3 p-3 text-left"
      >
        <span
          className={cn(
            "mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
            STATUS_STYLE[check.status].chip,
          )}
        >
          {STATUS_STYLE[check.status].label}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-2">
            <span className="font-medium">{check.name}</span>
            <span className="text-xs tabular-nums text-muted-foreground">
              {check.display} (target {check.threshold})
            </span>
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {check.detail}
          </span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {open ? "Hide" : check.affected.length ? `${check.affected.length} tasks` : "Detail"}
        </span>
      </button>

      {open && (
        <div className="border-t px-3 py-3">
          <p className="text-xs">
            <span className="font-medium">Fix:</span> {check.fix}
          </p>
          {check.affected.length > 0 && (
            <>
              <ul className="mt-2 space-y-1">
                {/* A 288-task schedule imported without logic puts every task
                    on this list. Showing the first 25 keeps it a worklist; the
                    copied report carries the same cap and the count is always
                    honest above. */}
                {check.affected.slice(0, 25).map((a, i) => (
                  <li key={`${a.wbs}-${i}`} className="flex flex-wrap gap-2 text-xs">
                    <span className="font-mono text-muted-foreground">{a.wbs}</span>
                    <span>{a.name}</span>
                    {a.note && (
                      <span className="text-muted-foreground">- {a.note}</span>
                    )}
                  </li>
                ))}
              </ul>
              {check.affected.length > 25 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  and {check.affected.length - 25} more.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Tally({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "bad" | "warn";
}) {
  return (
    <div>
      <div
        className={cn(
          "text-lg font-semibold tabular-nums",
          tone === "bad" && value > 0 && "text-destructive",
          tone === "warn" && value > 0 && "text-amber-700",
        )}
      >
        {value}
      </div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}
