"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  INCIDENT_TYPES,
  buildSubmissions,
  incidentTypeLabel,
  readiness,
  resolveIncidents,
  shortDate,
  type ExtraIncident,
  type IncidentOverride,
  type IncidentType,
} from "@/lib/monthly-manpower";
import type { MonthlyView } from "@/lib/monthly-manpower-load";

import {
  reopenMonthlyManpower,
  saveMonthlyManpower,
  submitMonthlyManpower,
} from "./monthly-manpower-actions";

// The working surface for the owner's Monthly Manpower and Incident Report.
//
// The form itself is four boxes. Almost none of the work is typing them - it is
// arriving at an hours figure you are willing to sign, and deciding what each
// safety event in the month actually was. So this page is organised around
// those two jobs and the keying is last, reduced to a card per submission with
// a copy button on every field.
//
// The recurring idea, same as the weekly report: the platform shows what it
// derived and WHY, and editing is opting out of that derivation for one field.
// A box nobody touches keeps tracking the field record, so a report approved
// late still lands in the month it belongs to.

const MINE = "text-[#b91c1c] dark:text-[#f87171]";

type Props = {
  view: MonthlyView;
  canSubmit: boolean;
};

export function MonthlyManpowerForm({ view, canSubmit }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const filed = view.status === "submitted";
  const locked = filed || view.storageMissing;

  const [periodStart, setPeriodStart] = useState(view.period.start);
  const [periodEnd, setPeriodEnd] = useState(view.period.end);
  const [manhours, setManhours] = useState(
    view.hours.overridden ? String(view.hours.reported) : "",
  );
  const [manhoursNote, setManhoursNote] = useState(view.hours.note);
  const [note, setNote] = useState(view.note);

  // Seeded from what is stored, NOT from the suggestions. A suggested type is a
  // keyword hint; pre-ticking it would put an OSHA determination in the hands
  // of a substring match and then save it as though a human had agreed.
  const [overrides, setOverrides] = useState<Record<string, IncidentOverride>>(
    () => structuredClone(view.overrides),
  );
  const [extras, setExtras] = useState<ExtraIncident[]>(() => structuredClone(view.extras));

  // Everything below re-derives from local state, so the readiness banner and
  // the submission cards move as the incidents are classified rather than only
  // after a save.
  const incidents = useMemo(
    () => resolveIncidents(view.candidates, overrides, extras),
    [view.candidates, overrides, extras],
  );
  const reportedHours = manhours.trim() === "" ? view.hours.derived.total : Number(manhours);
  const overridden =
    manhours.trim() !== "" && Number(manhours) !== view.hours.derived.total;

  const submissions = useMemo(
    () =>
      buildSubmissions({
        projectName: view.projectName,
        period: { start: periodStart, end: periodEnd },
        hours: Number.isFinite(reportedHours) ? reportedHours : 0,
        hoursDerived: view.hours.derived.total,
        hoursOverridden: overridden,
        hoursNote: manhoursNote,
        gaps: view.hours.gaps,
        incidents,
      }),
    [
      view.projectName,
      view.hours.derived.total,
      view.hours.gaps,
      periodStart,
      periodEnd,
      reportedHours,
      overridden,
      manhoursNote,
      incidents,
    ],
  );
  const { ready, blockers } = useMemo(() => readiness(submissions), [submissions]);

  function patch(key: string, next: Partial<IncidentOverride>) {
    setOverrides((prev) => ({ ...prev, [key]: { ...prev[key], ...next } }));
  }

  function toggleType(key: string, type: IncidentType, on: boolean) {
    const current = new Set(
      (overrides[key]?.types ?? []) as IncidentType[],
    );
    if (on) current.add(type);
    else current.delete(type);
    patch(key, {
      types: INCIDENT_TYPES.map((t) => t.value).filter((v) => current.has(v)),
    });
  }

  function toggleExtraType(idx: number, type: IncidentType, on: boolean) {
    setExtras((prev) =>
      prev.map((e, i) => {
        if (i !== idx) return e;
        const set = new Set(e.types as IncidentType[]);
        if (on) set.add(type);
        else set.delete(type);
        return { ...e, types: INCIDENT_TYPES.map((t) => t.value).filter((v) => set.has(v)) };
      }),
    );
  }

  async function copy(id: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1200);
    } catch {
      setError("The browser would not give access to the clipboard - copy by hand.");
    }
  }

  function formInput() {
    return {
      projectId: view.projectId,
      periodMonth: view.periodMonth,
      periodStart,
      periodEnd,
      manhoursOverride: manhours,
      manhoursNote,
      incidents: overrides,
      extras,
      note,
    };
  }

  function save(after?: () => void) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const res = await saveMonthlyManpower(formInput());
      if (!res.ok) return setError(res.error);
      setMessage("Saved.");
      router.refresh();
      after?.();
    });
  }

  function file(force: boolean) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const saveRes = await saveMonthlyManpower(formInput());
      if (!saveRes.ok) return setError(saveRes.error);
      const res = await submitMonthlyManpower({
        projectId: view.projectId,
        periodMonth: view.periodMonth,
        force,
      });
      if (!res.ok) return setError(res.error);
      setMessage("Marked as filed with the owner.");
      router.refresh();
    });
  }

  function reopen() {
    setError(null);
    startTransition(async () => {
      const res = await reopenMonthlyManpower({
        projectId: view.projectId,
        periodMonth: view.periodMonth,
      });
      if (!res.ok) return setError(res.error);
      setMessage("Reopened.");
      router.refresh();
    });
  }

  const live = incidents.filter((i) => !i.hidden);

  return (
    <div className="space-y-4">
      {view.storageMissing && (
        <Panel tone="warn">
          <p className="font-medium">This report cannot be saved yet.</p>
          <p className="mt-1">
            Migration <code>0045_monthly_manpower_report.sql</code> has not been
            applied to Supabase. Everything below is derived live and can be
            copied into the owner&apos;s form by hand - only the classifications
            and the override have nowhere to be stored.
          </p>
        </Panel>
      )}

      {!view.ahcColumnsAvailable && !view.storageMissing && (
        <Panel tone="warn">
          <p className="font-medium">AHC&apos;s own hours are not in this total.</p>
          <p className="mt-1">
            The CM daily log has no hours columns yet, so the figure below covers
            the subcontractors only and reads low by whatever our own people
            worked. Migration 0045 adds them.
          </p>
        </Panel>
      )}

      {filed && (
        <Panel tone="ok">
          <p className="font-medium">
            Filed with the owner{view.submittedAt ? ` on ${shortDate(view.submittedAt.slice(0, 10))}` : ""}.
          </p>
          <p className="mt-1">
            The figures are frozen as submitted, so this page reproduces exactly
            what was filed even after the field reports behind it are corrected.
            Reopen only to correct something that was actually sent wrong.
          </p>
          {canSubmit && (
            <Button size="sm" variant="secondary" className="mt-2" disabled={pending} onClick={reopen}>
              Reopen
            </Button>
          )}
        </Panel>
      )}

      {/* ---------------- Man-hours ---------------- */}
      <section className="space-y-3 rounded-md border bg-card p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Man-hours</h2>
          <p className="text-xs text-muted-foreground">{view.hours.basis}</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-4">
          <Stat label="Subcontractors" value={view.hours.derived.subHours} />
          {/* A dash, not a 0, when nobody entered any. "AHC worked no hours"
              and "nobody recorded AHC's hours" are different claims and the
              card must not make the first one on the evidence for the second. */}
          <Stat
            label="AHC staff"
            value={
              !view.ahcColumnsAvailable || view.hours.derived.ahcRecordedDays === 0
                ? null
                : view.hours.derived.ahcHours
            }
            hint={
              !view.ahcColumnsAvailable
                ? "not captured"
                : view.hours.derived.ahcRecordedDays === 0
                  ? "none recorded"
                  : `across ${view.hours.derived.ahcRecordedDays} days`
            }
          />
          <Stat label="Derived total" value={view.hours.derived.total} strong />
          <div>
            <Label className={cn("text-xs", overridden && MINE)}>
              On the form {overridden && "(typed)"}
            </Label>
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              step="0.5"
              disabled={locked}
              value={manhours}
              onChange={(e) => setManhours(e.target.value)}
              placeholder={String(view.hours.derived.total)}
              className={cn("mt-1", overridden && "border-[#b91c1c]/50 dark:border-[#f87171]/50")}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Blank keeps the derived total and lets a late report improve it.
            </p>
          </div>
        </div>

        {overridden && (
          <div>
            <Label className={cn("text-xs", MINE)}>
              Why the total differs from the field record
            </Label>
            <textarea
              disabled={locked}
              value={manhoursNote}
              onChange={(e) => setManhoursNote(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded-md border bg-background p-2 text-sm"
              placeholder="A number that disagrees with the field record gets quoted back at us. Say why."
            />
          </div>
        )}

        {view.hours.gaps.length > 0 && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
            <p className="font-medium">
              {view.hours.gaps.filter((g) => g.kind === "missing").length} day
              {view.hours.gaps.filter((g) => g.kind === "missing").length === 1 ? "" : "s"} missing
              hours, {view.hours.gaps.filter((g) => g.kind === "estimated").length} estimated
            </p>
            <ul className="mt-1.5 space-y-1">
              {view.hours.gaps.map((g, i) => (
                <li key={`${g.day}-${i}`} className="flex gap-2">
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {g.scope === "period" ? "All month" : shortDate(g.day)}
                  </span>
                  <span>{g.issue}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {view.hours.derived.bySub.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-1.5 font-medium">Subcontractor</th>
                  <th className="py-1.5 text-right font-medium">Days</th>
                  <th className="py-1.5 text-right font-medium">Hours</th>
                </tr>
              </thead>
              <tbody>
                {view.hours.derived.bySub.map((s) => (
                  <tr key={s.subcontractorId ?? s.name} className="border-b last:border-0">
                    <td className="py-1.5">
                      {s.name}
                      {s.estimated && (
                        <span className="ml-2 text-xs text-amber-600 dark:text-amber-400">
                          includes an estimated day
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{s.days}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {s.hours.toLocaleString()}
                    </td>
                  </tr>
                ))}
                {view.ahcColumnsAvailable && view.hours.derived.ahcHours > 0 && (
                  <tr className="border-b last:border-0">
                    <td className="py-1.5">AHC staff (CM daily log)</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {view.hours.derived.perDay.filter((d) => d.ahc > 0).length}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {view.hours.derived.ahcHours.toLocaleString()}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {view.excluded.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {view.excluded.length} field report
            {view.excluded.length === 1 ? "" : "s"} in the period
            {view.excluded.length === 1 ? " is" : " are"} not approved and
            contribute nothing:{" "}
            {view.excluded.map((e) => `${shortDate(e.day)} (${e.status})`).join(", ")}.
          </p>
        )}
      </section>

      {/* ---------------- Incidents ---------------- */}
      <section className="space-y-3 rounded-md border bg-card p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">
            Incidents{live.length > 0 && ` (${live.length} to file)`}
          </h2>
          <p className="max-w-xl text-xs text-muted-foreground">{view.candidateBasis}</p>
        </div>

        {incidents.length === 0 && (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            Nothing in the month reads as an incident. If one happened that never
            reached a field report or the CM log, add it below - the owner&apos;s
            form is filed per incident, so an unrecorded one is simply not filed.
          </p>
        )}

        {incidents
          .filter((i) => i.origin !== "manual")
          .map((inc) => {
            const ticked = new Set(inc.types);
            return (
              <div
                key={inc.key}
                className={cn(
                  "rounded-md border p-3",
                  inc.hidden && "opacity-50",
                  !inc.hidden && !inc.classified && "border-amber-500/50",
                )}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-medium">
                    {shortDate(inc.occurredOn)} - {inc.sourceLabel}
                  </p>
                  <div className="flex items-center gap-2 text-xs">
                    <span
                      className={cn(
                        "rounded-full border px-2 py-0.5",
                        inc.flagged
                          ? "border-foreground/30"
                          : "border-amber-500/50 text-amber-700 dark:text-amber-400",
                      )}
                    >
                      {inc.flagged ? "Flagged on the report" : "Found in the wording"}
                    </span>
                    <button
                      type="button"
                      disabled={locked}
                      onClick={() => patch(inc.key, { hidden: !inc.hidden })}
                      className="rounded-md border px-2 py-0.5 hover:bg-accent disabled:opacity-50"
                    >
                      {inc.hidden ? "Restore" : "Not an incident"}
                    </button>
                  </div>
                </div>

                {inc.narrative && (
                  <p className="mt-1.5 whitespace-pre-wrap rounded bg-muted/50 p-2 text-xs text-muted-foreground">
                    {inc.narrative}
                  </p>
                )}

                {!inc.hidden && (
                  <>
                    <div className="mt-2">
                      <Label className="text-xs">Incident Type</Label>
                      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1.5">
                        {INCIDENT_TYPES.map((t) => (
                          <label key={t.value} className="flex items-center gap-1.5 text-sm">
                            <input
                              type="checkbox"
                              disabled={locked}
                              checked={ticked.has(t.value)}
                              onChange={(e) => toggleType(inc.key, t.value, e.target.checked)}
                              className="h-3.5 w-3.5"
                            />
                            <span>{t.label}</span>
                            {inc.suggestedTypes.includes(t.value) && !ticked.has(t.value) && (
                              <span className="text-[11px] text-muted-foreground">
                                (wording suggests)
                              </span>
                            )}
                          </label>
                        ))}
                      </div>
                      {!inc.classified && (
                        <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
                          The form cannot be submitted without a type. A suggestion
                          is a keyword match, not a determination - tick it yourself.
                        </p>
                      )}
                    </div>

                    <div className="mt-2">
                      <Label className="text-xs">Description on the form</Label>
                      <textarea
                        disabled={locked}
                        value={overrides[inc.key]?.description ?? inc.description}
                        onChange={(e) => patch(inc.key, { description: e.target.value })}
                        rows={2}
                        className="mt-1 w-full rounded-md border bg-background p-2 text-sm"
                      />
                    </div>
                  </>
                )}
              </div>
            );
          })}

        {extras.map((e, idx) => {
          const ticked = new Set(e.types as IncidentType[]);
          return (
            <div key={e.key ?? idx} className="rounded-md border border-dashed p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className={cn("text-sm font-medium", MINE)}>Added by hand</p>
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => setExtras((prev) => prev.filter((_, i) => i !== idx))}
                  className="rounded-md border px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-50"
                >
                  Remove
                </button>
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <div>
                  <Label className="text-xs">Date</Label>
                  <Input
                    type="date"
                    disabled={locked}
                    value={e.occurredOn}
                    min={periodStart}
                    max={periodEnd}
                    onChange={(ev) =>
                      setExtras((prev) =>
                        prev.map((x, i) => (i === idx ? { ...x, occurredOn: ev.target.value } : x)),
                      )
                    }
                  />
                </div>
                <div>
                  <Label className="text-xs">Reported by (optional)</Label>
                  <Input
                    disabled={locked}
                    value={e.reportedBy ?? ""}
                    onChange={(ev) =>
                      setExtras((prev) =>
                        prev.map((x, i) => (i === idx ? { ...x, reportedBy: ev.target.value } : x)),
                      )
                    }
                  />
                </div>
              </div>
              <div className="mt-2">
                <Label className="text-xs">Incident Type</Label>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1.5">
                  {INCIDENT_TYPES.map((t) => (
                    <label key={t.value} className="flex items-center gap-1.5 text-sm">
                      <input
                        type="checkbox"
                        disabled={locked}
                        checked={ticked.has(t.value)}
                        onChange={(ev) => toggleExtraType(idx, t.value, ev.target.checked)}
                        className="h-3.5 w-3.5"
                      />
                      {t.label}
                    </label>
                  ))}
                </div>
              </div>
              <div className="mt-2">
                <Label className="text-xs">Description on the form</Label>
                <textarea
                  disabled={locked}
                  value={e.description}
                  onChange={(ev) =>
                    setExtras((prev) =>
                      prev.map((x, i) => (i === idx ? { ...x, description: ev.target.value } : x)),
                    )
                  }
                  rows={2}
                  className="mt-1 w-full rounded-md border bg-background p-2 text-sm"
                />
              </div>
            </div>
          );
        })}

        <Button
          size="sm"
          variant="secondary"
          disabled={locked}
          onClick={() =>
            setExtras((prev) => [
              ...prev,
              {
                key: `manual:${periodEnd}:${prev.length}`,
                occurredOn: periodEnd,
                types: [],
                description: "",
              },
            ])
          }
        >
          Add an incident
        </Button>
      </section>

      {/* ---------------- What to key into the form ---------------- */}
      <section className="space-y-3 rounded-md border bg-card p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">
            {submissions.length} submission{submissions.length === 1 ? "" : "s"} to file
          </h2>
          <p className="text-xs text-muted-foreground">
            The owner&apos;s form is filed once for the hours and once per incident.
          </p>
        </div>

        {!ready && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
            <p className="font-medium">Not ready to file</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {blockers.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid gap-3 lg:grid-cols-2">
          {submissions.map((s, i) => (
            <div key={`${s.kind}-${i}`} className="rounded-md border p-3">
              <p className="text-sm font-medium">{s.title}</p>
              <dl className="mt-2 space-y-1.5">
                {s.fields.map((f) => {
                  const id = `${i}-${f.label}`;
                  return (
                    <div key={f.label} className="flex items-start gap-2 text-sm">
                      <dt className="w-40 shrink-0 pt-0.5 text-xs text-muted-foreground">
                        {f.label}
                      </dt>
                      <dd className="flex-1 break-words">{f.value || "-"}</dd>
                      {!f.readOnly && f.value && (
                        <button
                          type="button"
                          onClick={() => copy(id, f.value)}
                          className="shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] hover:bg-accent"
                        >
                          {copied === id ? "Copied" : "Copy"}
                        </button>
                      )}
                    </div>
                  );
                })}
              </dl>
              {s.blockers.length > 0 && (
                <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-400">
                  {s.blockers.join(" ")}
                </p>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ---------------- Period, note, actions ---------------- */}
      <section className="space-y-3 rounded-md border bg-card p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label className="text-xs">Report Period Start Date</Label>
            <Input
              type="date"
              disabled={locked}
              value={periodStart}
              onChange={(e) => setPeriodStart(e.target.value)}
            />
          </div>
          <div>
            <Label className="text-xs">Report Period Finish Date</Label>
            <Input
              type="date"
              disabled={locked}
              value={periodEnd}
              onChange={(e) => setPeriodEnd(e.target.value)}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Defaults to the calendar month. Change it only if the owner&apos;s period
          genuinely runs to a different cutoff - the window drives every figure
          on this page.
        </p>

        <div>
          <Label className="text-xs">Note for the backup sheet</Label>
          <textarea
            disabled={locked}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded-md border bg-background p-2 text-sm"
            placeholder="Anything the printed backup should carry. Does not go on the owner's form."
          />
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}
        {message && !error && <p className="text-xs text-muted-foreground">{message}</p>}

        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={pending || locked} onClick={() => save()}>
            {pending ? "Saving…" : "Save draft"}
          </Button>
          {canSubmit && !filed && (
            <Button
              size="sm"
              variant={ready ? "default" : "secondary"}
              disabled={pending || view.storageMissing}
              onClick={() => file(!ready)}
            >
              {ready ? "Mark filed with owner" : "File anyway, with the gaps"}
            </Button>
          )}
        </div>
        {!ready && canSubmit && !filed && (
          <p className="text-[11px] text-muted-foreground">
            Filing over the gaps records them alongside the report, so a short
            month can be explained later rather than discovered.
          </p>
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  strong,
  hint,
}: {
  label: string;
  value: number | null;
  strong?: boolean;
  hint?: string;
}) {
  return (
    <div className="rounded-md border bg-background p-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("tabular-nums", strong ? "text-xl font-semibold" : "text-lg")}>
        {value == null ? "-" : value.toLocaleString()}
      </p>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Panel({
  tone,
  children,
}: {
  tone: "warn" | "ok";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-md border p-3 text-sm",
        tone === "warn"
          ? "border-amber-500/40 bg-amber-500/5"
          : "border-emerald-500/40 bg-emerald-500/5",
      )}
    >
      {children}
    </div>
  );
}

export { incidentTypeLabel };
