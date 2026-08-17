"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { isStandardHoliday } from "@/lib/schedule-calendar";
import {
  deleteCalendarException,
  setProjectWorkWeek,
  upsertCalendarException,
} from "../schedule-actions";

export type CalendarExceptionRow = {
  id: string;
  exception_date: string;
  kind: "nonworking" | "working";
  reason: string | null;
};

type Props = {
  projectId: string;
  workWeek: 5 | 6;
  exceptions: CalendarExceptionRow[];
  available: boolean;
  trigger: React.ReactNode;
};

function fmt(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "2-digit",
    timeZone: "UTC",
  });
}

export function CalendarDialog({
  projectId,
  workWeek,
  exceptions,
  available,
  trigger,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState("");
  const [kind, setKind] = useState<"nonworking" | "working">("nonworking");
  const [reason, setReason] = useState("");

  function add() {
    if (!date) return;
    setError(null);
    startTransition(async () => {
      const res = await upsertCalendarException(
        projectId,
        date,
        kind,
        reason.trim() || null,
      );
      if (!res.ok) { setError(res.error); return; }
      setDate("");
      setReason("");
      router.refresh();
    });
  }

  return (
    <>
      <span onClick={() => setOpen(true)} className="inline-block">{trigger}</span>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-background p-6 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold">Project calendar</h3>
                <p className="text-xs text-muted-foreground">
                  Every duration on the schedule is counted in these days.
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

            {!available ? (
              <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                Apply migration 0033 to enable the project calendar. Until then
                the engine uses a 5-day week and the built-in holiday list, and
                rain days cannot be recorded.
              </div>
            ) : (
              <div className="mt-4 space-y-6">
                <div>
                  <Label>Work week</Label>
                  <div className="mt-2 flex gap-2">
                    {([5, 6] as const).map((w) => (
                      <button
                        key={w}
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          startTransition(async () => {
                            const res = await setProjectWorkWeek(projectId, w);
                            if (!res.ok) setError(res.error);
                            router.refresh();
                          })
                        }
                        className={cn(
                          "rounded-md border px-3 py-1.5 text-sm",
                          workWeek === w
                            ? "border-foreground bg-muted font-medium"
                            : "text-muted-foreground hover:bg-muted",
                        )}
                      >
                        {w === 5 ? "Monday to Friday" : "Monday to Saturday"}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    New Year&rsquo;s Day, Memorial Day, Independence Day, Labor
                    Day, Thanksgiving and the Friday after, and Christmas are
                    already excluded. Columbus Day and Veterans Day are not -
                    crews generally work them. Override either way below.
                  </p>
                </div>

                <div className="border-t pt-4">
                  <Label>Record a day</Label>
                  <div className="mt-2 grid gap-3 sm:grid-cols-[auto_1fr_auto]">
                    <Input
                      type="date"
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                      className="w-auto"
                    />
                    <Input
                      placeholder="Reason - rain, shutdown, recovery Saturday"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                    <Button onClick={add} disabled={pending || !date}>
                      Add
                    </Button>
                  </div>
                  <div className="mt-2 flex gap-2">
                    {(
                      [
                        ["nonworking", "Not worked"],
                        ["working", "Worked"],
                      ] as const
                    ).map(([v, label]) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setKind(v)}
                        className={cn(
                          "rounded-md border px-3 py-1 text-xs",
                          kind === v
                            ? "border-foreground bg-muted font-medium"
                            : "text-muted-foreground",
                        )}
                      >
                        {label}
                      </button>
                    ))}
                    {date && kind === "working" && isStandardHoliday(date) && (
                      <span className="self-center text-[11px] text-amber-700">
                        This is a built-in holiday - marking it worked overrides that.
                      </span>
                    )}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    A day not worked pushes every downstream task by one working
                    day, which is the point: a week of rain in September should
                    show up in the October finish date rather than being absorbed
                    quietly.
                  </p>
                </div>

                {error && (
                  <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                    {error}
                  </div>
                )}

                <div className="border-t pt-4">
                  <Label>
                    Recorded days{exceptions.length ? ` (${exceptions.length})` : ""}
                  </Label>
                  {!exceptions.length ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Nothing recorded. The schedule is running on the standard
                      calendar.
                    </p>
                  ) : (
                    <ul className="mt-2 divide-y rounded-md border">
                      {exceptions.map((e) => (
                        <li
                          key={e.id}
                          className="flex items-center gap-3 px-3 py-2 text-sm"
                        >
                          <span
                            className={cn(
                              "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                              e.kind === "nonworking"
                                ? "bg-destructive/10 text-destructive"
                                : "bg-emerald-100 text-emerald-900",
                            )}
                          >
                            {e.kind === "nonworking" ? "Not worked" : "Worked"}
                          </span>
                          <span className="font-medium">{fmt(e.exception_date)}</span>
                          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                            {e.reason ?? ""}
                          </span>
                          <button
                            className="shrink-0 text-xs text-muted-foreground hover:text-destructive"
                            disabled={pending}
                            onClick={() =>
                              startTransition(async () => {
                                await deleteCalendarException(projectId, e.exception_date);
                                router.refresh();
                              })
                            }
                          >
                            Remove
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
