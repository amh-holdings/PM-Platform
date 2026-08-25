"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  MILESTONE_FIELDS,
  dimensionDate,
  shortDay,
  type ContractorRow,
  type Derived,
  type EquipmentRow,
} from "@/lib/weekly-report";
import type { WeeklyReportView } from "@/lib/weekly-report-load";

import {
  issueWeeklyReport,
  reopenWeeklyReport,
  saveWeeklyReport,
} from "./weekly-report-actions";

type Props = {
  view: WeeklyReportView;
  canIssue: boolean;
  /** Boxes whose live derivation has moved since the report was issued. */
  drift?: string[];
};

// The working surface for the Dimension weekly report.
//
// The organising idea: every box shows what the platform derived and WHY, and
// editing is opting out of that derivation for this one field. A box you never
// touch keeps tracking the field record. So the affordance is not "fill in the
// form", it is "read what we already know and correct what is wrong" - which
// is a five-minute job instead of an hour of re-keying.
//
// Narrative boxes keep their raw evidence visible in a panel beside them. The
// rewrite Dimension wants (prose grouped by discipline) is genuinely writing,
// and writing it while hunting back through seven days of field reports in
// another tab is how the box ends up written from memory.

export function WeeklyReportForm({ view, canIssue, drift = [] }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const saved = view.saved;
  const issued = view.status === "issued";

  const [periodStart, setPeriodStart] = useState(view.period.start);
  const [periodEnd, setPeriodEnd] = useState(view.period.end);
  const [dimensionCm, setDimensionCm] = useState(view.header.dimensionCm);
  const [epcManager, setEpcManager] = useState(view.header.epcReportingManager);
  const [epcTeam, setEpcTeam] = useState(view.header.epcTeam);

  const [environment, setEnvironment] = useState(
    saved?.environment_concerns ?? view.environment.value,
  );
  const [security, setSecurity] = useState(saved?.security_concerns ?? view.security.value);
  const [safety, setSafety] = useState(saved?.safety_summary ?? view.safety.value);
  const [positionNote, setPositionNote] = useState(saved?.position_note ?? view.positionText);
  const [photoNote, setPhotoNote] = useState(saved?.photo_note ?? "");
  const [weather, setWeather] = useState(saved?.weather_summary ?? view.weather.value);
  const [swppp, setSwppp] = useState(saved?.swppp_inspection_date ?? view.swppp.value ?? "");
  const [work, setWork] = useState(saved?.work_this_week ?? view.workThisWeek.value);
  const [lookaheadNote, setLookaheadNote] = useState(saved?.lookahead_note ?? "");
  const [risks, setRisks] = useState(saved?.schedule_risks ?? view.risks.value);

  const [milestones, setMilestones] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const f of MILESTONE_FIELDS) out[f.key] = view.milestones[f.key]?.value ?? "";
    return out;
  });

  const [contractors, setContractors] = useState<ContractorRow[]>(view.contractors);
  const [equipment, setEquipment] = useState<EquipmentRow[]>(view.equipment);

  const printHref = `/projects/${view.projectId}/reports/weekly-progress/print?week=${view.weekEnding}`;

  function save(then?: () => void) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const res = await saveWeeklyReport({
        projectId: view.projectId,
        weekEnding: view.weekEnding,
        periodStart,
        periodEnd,
        dimensionCm,
        epcReportingManager: epcManager,
        epcTeam,
        environmentConcerns: environment,
        securityConcerns: security,
        safetySummary: safety,
        positionNote,
        photoNote,
        weatherSummary: weather,
        workThisWeek: work,
        lookaheadNote,
        scheduleRisks: risks,
        swpppInspectionDate: swppp,
        milestones,
        contractors,
        equipment,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setMessage("Saved.");
      router.refresh();
      then?.();
    });
  }

  function issue() {
    startTransition(async () => {
      const res = await issueWeeklyReport({
        projectId: view.projectId,
        weekEnding: view.weekEnding,
      });
      if (!res.ok) setError(res.error);
      else {
        setMessage("Issued. The figures are frozen as sent.");
        router.refresh();
      }
    });
  }

  function reopen() {
    startTransition(async () => {
      const res = await reopenWeeklyReport({
        projectId: view.projectId,
        weekEnding: view.weekEnding,
      });
      if (!res.ok) setError(res.error);
      else router.refresh();
    });
  }

  return (
    <div className="space-y-5">
      {view.storageMissing && (
        <Banner tone="warn">
          <p className="font-medium">Migration 0041 has not been applied.</p>
          <p className="mt-1">
            Everything below is derived live and is safe to read, but nothing can
            be saved or issued until{" "}
            <code>db/migrations/0041_weekly_progress_reports.sql</code> is run in
            the Supabase SQL editor.
          </p>
        </Banner>
      )}

      {view.gaps.length > 0 && (
        <Banner tone="warn">
          <p className="font-medium">
            {view.gaps.length} working day{view.gaps.length === 1 ? "" : "s"} in
            this period have no field report and no CM log.
          </p>
          <p className="mt-1">
            {view.gaps.map(shortDay).join(", ")}. Anything that happened on those
            days is missing from every box below. Weekends and calendar holidays
            are not counted.
          </p>
        </Banner>
      )}

      {view.unapproved.length > 0 && (
        <Banner tone="warn">
          <p className="font-medium">
            {view.unapproved.length} field report
            {view.unapproved.length === 1 ? "" : "s"} in this period{" "}
            {view.unapproved.length === 1 ? "is" : "are"} not approved, and
            feed nothing below.
          </p>
          <p className="mt-1">
            {view.unapproved
              .map((u) => `${shortDay(u.day)} ${u.who} (${u.status})`)
              .join(", ")}
            . This is an outbound document to the owner, so only approved
            reports are read. Approve them in Field Reports and this page picks
            them up.
          </p>
        </Banner>
      )}

      {!view.scheduleFlagsAvailable && (
        <Banner tone="warn">
          <p className="font-medium">
            The schedule&apos;s milestone and at-risk columns are missing.
          </p>
          <p className="mt-1">
            Milestone dates fall back to last week&apos;s report and no task can
            be reported as at risk until the schedule migration is applied.
          </p>
        </Banner>
      )}

      {drift.length > 0 && (
        <Banner tone="warn">
          <p className="font-medium">
            The field record has changed since this report was issued.
          </p>
          <p className="mt-1">
            {drift.join(", ")} now derive differently. The print sheet still
            reproduces exactly what Dimension was sent. Reopen and re-issue only
            if you intend to send a correction.
          </p>
        </Banner>
      )}

      {issued && (
        <Banner tone="ok">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p>
              Issued {view.issuedAt ? new Date(view.issuedAt).toLocaleString() : ""}.
              The figures are frozen as sent.
            </p>
            <Button size="sm" variant="outline" onClick={reopen} disabled={pending}>
              Reopen
            </Button>
          </div>
        </Banner>
      )}

      {/* ---- Sticky action bar ---- */}
      <div className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-2 border-b bg-background/95 px-1 py-2 backdrop-blur">
        <Button size="sm" onClick={() => save()} disabled={pending || issued || view.storageMissing}>
          {pending ? "Saving..." : "Save draft"}
        </Button>
        <Button size="sm" variant="outline" asChild>
          <a href={printHref} target="_blank" rel="noreferrer">
            Preview / print
          </a>
        </Button>
        {canIssue && !issued && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => save(issue)}
            disabled={pending || view.storageMissing}
          >
            Save and issue
          </Button>
        )}
        {message && <span className="text-xs text-muted-foreground">{message}</span>}
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>

      {/* ---- Overview ---- */}
      <Section title="Overview">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Week ending (on the form)">
            <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
              {dimensionDate(view.weekEnding)}
            </p>
          </Field>
          <Field
            label="Period covered"
            hint="The seven days the figures are read from. Sweet Springs files on a Monday for the week that ended the Friday before, so this is not the same as the week-ending date."
          >
            <div className="flex items-center gap-2">
              <Input
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
                disabled={issued}
              />
              <span className="text-xs text-muted-foreground">to</span>
              <Input
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                disabled={issued}
              />
            </div>
          </Field>
          <Field label="Dimension Construction Manager">
            <Input
              value={dimensionCm}
              onChange={(e) => setDimensionCm(e.target.value)}
              disabled={issued}
              placeholder="Matt Clark"
            />
          </Field>
          <Field label="EPC Reporting Manager">
            <Input
              value={epcManager}
              onChange={(e) => setEpcManager(e.target.value)}
              disabled={issued}
              placeholder="Phil Horwitch"
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="EPC team members and roles">
              <textarea
                value={epcTeam}
                onChange={(e) => setEpcTeam(e.target.value)}
                rows={2}
                disabled={issued}
                className="w-full rounded-md border bg-background p-2 text-sm"
                placeholder="Project Manager: Mark Wooley"
              />
            </Field>
          </div>
        </div>
        {view.header.carriedFrom && (
          <p className="mt-2 text-xs text-muted-foreground">
            Names carried forward from the report for week ending{" "}
            {dimensionDate(view.header.carriedFrom)}.
          </p>
        )}
      </Section>

      {/* ---- Site resources ---- */}
      <Section
        title="Site resources"
        note="Headcount and last-date-onsite are read off the field reports. Equipment is one row per machine - the field spellings folded into each row are listed under its name, so check the merges. End date is the one column the platform cannot know: it is a commercial date, so type it once and it carries."
      >
        <ContractorTable
          rows={contractors}
          disabled={issued}
          onChange={setContractors}
        />
        <div className="mt-5">
          <EquipmentTable rows={equipment} disabled={issued} onChange={setEquipment} />
        </div>
        <div className="mt-5 rounded-md border bg-muted/30 p-3">
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <p className="text-sm">
              <span className="font-medium">
                {view.manHours.value.week.toLocaleString()}
              </span>{" "}
              <span className="text-muted-foreground">man-hours this week</span>
            </p>
            <p className="text-sm">
              <span className="font-medium">
                {view.manHours.value.cumulative.toLocaleString()}
              </span>{" "}
              <span className="text-muted-foreground">to date</span>
            </p>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{view.manHours.basis}</p>
        </div>
      </Section>

      {!view.extraOverridesAvailable && (
        <Banner tone="warn">
          <p className="font-medium">Migration 0042 has not been applied.</p>
          <p className="mt-1">
            Safety, Project position and the photo note are derived and will
            print, but edits to those three boxes cannot be saved until{" "}
            <code>db/migrations/0042_weekly_report_safety_and_photos.sql</code>{" "}
            is run in the Supabase SQL editor.
          </p>
        </Banner>
      )}

      {/* ---- Environment, security and safety ---- */}
      <Section
        title="Environment, security and safety"
        note="Three different questions, so three boxes. Weather is not an environmental concern and lives with the weather; a recordable injury is not a security matter and lives under safety."
      >
        <DerivedBox
          label="Environment concerns"
          derived={view.environment}
          value={environment}
          onChange={setEnvironment}
          disabled={issued}
          rows={5}
        />
        <DerivedBox
          label="Security concerns"
          derived={view.security}
          value={security}
          onChange={setSecurity}
          disabled={issued}
          rows={3}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Date of most recent SWPPP inspection"
            hint={view.swppp.basis}
          >
            <Input
              type="date"
              value={swppp}
              onChange={(e) => setSwppp(e.target.value)}
              disabled={issued}
            />
          </Field>
          <div>
            <DerivedBox
              label="Weather this week"
              derived={view.weather}
              value={weather}
              onChange={setWeather}
              disabled={issued}
              rows={3}
            />
          </div>
        </div>
        <DerivedBox
          label="Safety"
          derived={view.safety}
          value={safety}
          onChange={setSafety}
          disabled={issued}
          rows={4}
        />
      </Section>

      {/* ---- Progress ---- */}
      <Section title="Progress">
        <DerivedBox
          label="Project position"
          derived={{ value: view.positionText, basis: view.position.basis, sources: [] }}
          value={positionNote}
          onChange={setPositionNote}
          disabled={issued}
          rows={5}
        />
        <PositionPanel view={view} />

        <Field
          label="Milestone tracking"
          hint="Dates expected by EPC. Matched to schedule milestones by name where one exists, otherwise carried forward from last week."
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {MILESTONE_FIELDS.map((f) => {
              const d = view.milestones[f.key];
              return (
                <div key={f.key} className="space-y-1">
                  <Label className="text-xs">{f.label}</Label>
                  <Input
                    type="date"
                    value={milestones[f.key] ?? ""}
                    onChange={(e) =>
                      setMilestones((m) => ({ ...m, [f.key]: e.target.value }))
                    }
                    disabled={issued}
                  />
                  <p className="text-[11px] leading-tight text-muted-foreground">{d?.basis}</p>
                </div>
              );
            })}
          </div>
        </Field>

        <DerivedBox
          label="Work this week"
          derived={view.workThisWeek}
          value={work}
          onChange={setWork}
          disabled={issued}
          rows={9}
          evidence={view.evidence}
        />

        <Field
          label="3 week look ahead"
          hint="Built from the schedule for the three weeks after this period and printed in full in its own box on the report. Anything typed here prints above the table as a note - leave it empty unless there is something to say about what is coming."
        >
          <textarea
            value={lookaheadNote}
            onChange={(e) => setLookaheadNote(e.target.value)}
            rows={2}
            disabled={issued}
            className="w-full rounded-md border bg-background p-2 text-sm"
            placeholder="Optional note, e.g. Panel delivery confirmed for the week of 7-Sep."
          />
          <LookaheadPreview view={view} />
        </Field>

        <DerivedBox
          label="Open schedule risks"
          derived={view.risks}
          value={risks}
          onChange={setRisks}
          disabled={issued}
          rows={5}
        />
      </Section>

      {/* ---- Photos ---- */}
      <Section
        title="Photos"
        note="Every photo on the period's approved field reports, printed on its own page. Dimension's form asks for them and the platform has been holding them all along."
      >
        {view.photos.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No photos on this period&apos;s approved field reports, so no photo
            page will print. Photos uploaded against a field report appear here
            once that report is approved.
          </p>
        ) : (
          <>
            <Field
              label="Note at the top of the photo page"
              hint="Optional. Leave empty and the page prints as a plain photo sheet."
            >
              <textarea
                value={photoNote}
                onChange={(e) => setPhotoNote(e.target.value)}
                rows={2}
                disabled={issued}
                className="w-full rounded-md border bg-background p-2 text-sm"
                placeholder="Front entrance culvert installation, 20-21 Aug."
              />
            </Field>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {view.photos.map((ph) => (
                <figure key={ph.id} className="overflow-hidden rounded-md border">
                  {ph.url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={ph.url}
                      alt={ph.caption ?? "Site photo"}
                      className="h-24 w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-24 items-center justify-center text-xs text-muted-foreground">
                      unavailable
                    </div>
                  )}
                  <figcaption className="border-t px-1 py-0.5 text-[10px] leading-tight text-muted-foreground">
                    {shortDay(ph.day)}
                    {ph.caption ? ` - ${ph.caption}` : ""}
                  </figcaption>
                </figure>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              {view.photos.length} photo{view.photos.length === 1 ? "" : "s"} will
              print, two to a row.
            </p>
          </>
        )}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border bg-card">
      <div className="border-b px-4 py-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide">{title}</h2>
        {note && <p className="mt-1 text-xs text-muted-foreground">{note}</p>}
      </div>
      <div className="space-y-4 p-4">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm">{label}</Label>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {children}
    </div>
  );
}

function Banner({
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
          ? "border-amber-500/40 bg-amber-500/10"
          : "border-emerald-500/40 bg-emerald-500/10",
      )}
    >
      {children}
    </div>
  );
}

/**
 * A narrative box with its derivation attached.
 *
 * `Reset to derived` is the important control and the reason the diff exists:
 * it clears the override so the box goes back to tracking the field record.
 * Without it there would be no way back from a typo except editing the database.
 */
function DerivedBox({
  label,
  derived,
  value,
  onChange,
  disabled,
  rows,
  evidence,
}: {
  label: string;
  derived: Derived<string>;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  rows: number;
  evidence?: WeeklyReportView["evidence"];
}) {
  const edited = value.trim() !== derived.value.trim();
  const [showEvidence, setShowEvidence] = useState(false);

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label className="text-sm">{label}</Label>
        <div className="flex items-center gap-2">
          {edited && (
            <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide">
              Edited
            </span>
          )}
          {evidence && evidence.length > 0 && (
            <button
              type="button"
              onClick={() => setShowEvidence((s) => !s)}
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              {showEvidence ? "Hide" : "Show"} the {evidence.length} source entries
            </button>
          )}
          {edited && !disabled && (
            <button
              type="button"
              onClick={() => onChange(derived.value)}
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              Reset to derived
            </button>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{derived.basis}</p>
      <div className={cn("grid gap-3", showEvidence && "lg:grid-cols-2")}>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={rows}
          disabled={disabled}
          className="w-full rounded-md border bg-background p-2 font-mono text-xs leading-relaxed"
        />
        {showEvidence && evidence && (
          <div className="max-h-[28rem] space-y-2 overflow-y-auto rounded-md border bg-muted/30 p-2">
            {evidence.map((e, i) => (
              <div key={`${e.day}-${e.who}-${i}`} className="rounded border bg-background p-2 text-xs">
                <p className="font-medium">
                  {shortDay(e.day)} - {e.who}
                  {e.crew != null && (
                    <span className="ml-1 font-normal text-muted-foreground">
                      ({e.crew} crew)
                    </span>
                  )}
                  {e.status && e.status !== "approved" && (
                    <span className="ml-1 font-normal text-amber-600">[{e.status}]</span>
                  )}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                  {e.narrative || "(no narrative)"}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ContractorTable({
  rows,
  disabled,
  onChange,
}: {
  rows: ContractorRow[];
  disabled: boolean;
  onChange: (rows: ContractorRow[]) => void;
}) {
  function set(i: number, patch: Partial<ContractorRow>) {
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <Label className="text-sm">Contractors</Label>
        {!disabled && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              onChange([
                ...rows,
                {
                  key: `manual:${Date.now()}`,
                  name: "",
                  scope: "",
                  headcount: null,
                  lastOnsite: null,
                  endDate: null,
                  overridden: [],
                  basis: "Added by hand.",
                },
              ])
            }
          >
            Add row
          </Button>
        )}
      </div>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full min-w-[42rem] text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 text-left font-medium">Contractor</th>
              <th className="px-2 py-1.5 text-left font-medium">Scope</th>
              <th className="px-2 py-1.5 text-left font-medium">Headcount</th>
              <th className="px-2 py-1.5 text-left font-medium">Last onsite</th>
              <th className="px-2 py-1.5 text-left font-medium">End date</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.key} className="border-t align-top">
                <td className="px-2 py-1.5">
                  {row.key.startsWith("manual:") ? (
                    <Input
                      value={row.name}
                      onChange={(e) => set(i, { name: e.target.value })}
                      disabled={disabled}
                      className="h-8"
                    />
                  ) : (
                    <>
                      <span className="font-medium">{row.name}</span>
                      <p className="text-[11px] leading-tight text-muted-foreground">
                        {row.basis}
                      </p>
                    </>
                  )}
                </td>
                <td className="px-2 py-1.5">
                  <Input
                    value={row.scope}
                    onChange={(e) => set(i, { scope: e.target.value })}
                    disabled={disabled}
                    className="h-8"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <Input
                    type="number"
                    min={0}
                    value={row.headcount ?? ""}
                    onChange={(e) =>
                      set(i, {
                        headcount: e.target.value === "" ? null : Number(e.target.value),
                      })
                    }
                    disabled={disabled}
                    className="h-8 w-20"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <Input
                    type="date"
                    value={row.lastOnsite ?? ""}
                    onChange={(e) => set(i, { lastOnsite: e.target.value || null })}
                    disabled={disabled}
                    className="h-8"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <Input
                    type="date"
                    value={row.endDate ?? ""}
                    onChange={(e) => set(i, { endDate: e.target.value || null })}
                    disabled={disabled}
                    className="h-8"
                  />
                </td>
                <td className="px-2 py-1.5">
                  {!disabled && (
                    <button
                      type="button"
                      aria-label={`Remove ${row.name || "row"}`}
                      onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      ×
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-2 py-3 text-sm text-muted-foreground">
                  No active subcontractors on this project.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EquipmentTable({
  rows,
  disabled,
  onChange,
}: {
  rows: EquipmentRow[];
  disabled: boolean;
  onChange: (rows: EquipmentRow[]) => void;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <Label className="text-sm">Equipment</Label>
        {!disabled && (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              onChange([
                ...rows,
                {
                  key: `manual:${Date.now()}`,
                  name: "",
                  quantity: null,
                  overridden: [],
                  basis: "Added by hand.",
                },
              ])
            }
          >
            Add row
          </Button>
        )}
      </div>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full min-w-[24rem] text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 text-left font-medium">Equipment type</th>
              <th className="px-2 py-1.5 text-left font-medium">Quantity</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.key} className="border-t align-top">
                <td className="px-2 py-1.5">
                  {row.key.startsWith("manual:") ? (
                    <Input
                      value={row.name}
                      onChange={(e) =>
                        onChange(rows.map((r, x) => (x === i ? { ...r, name: e.target.value } : r)))
                      }
                      disabled={disabled}
                      className="h-8"
                    />
                  ) : (
                    <>
                      <span className="font-medium">{row.name}</span>
                      <p className="text-[11px] leading-tight text-muted-foreground">
                        {row.basis}
                      </p>
                    </>
                  )}
                </td>
                <td className="px-2 py-1.5">
                  <Input
                    type="number"
                    min={0}
                    value={row.quantity ?? ""}
                    onChange={(e) =>
                      onChange(
                        rows.map((r, x) =>
                          x === i
                            ? {
                                ...r,
                                quantity: e.target.value === "" ? null : Number(e.target.value),
                              }
                            : r,
                        ),
                      )
                    }
                    disabled={disabled}
                    className="h-8 w-20"
                  />
                </td>
                <td className="px-2 py-1.5">
                  {!disabled && (
                    <button
                      type="button"
                      aria-label={`Remove ${row.name || "row"}`}
                      onClick={() => onChange(rows.filter((_, x) => x !== i))}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      ×
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={3} className="px-2 py-3 text-sm text-muted-foreground">
                  No equipment logged on the field reports in this period.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The numbers behind the Project Position box, so the sentence is checkable. */
function PositionPanel({ view }: { view: WeeklyReportView }) {
  const p = view.position.value;
  if (p.pctComplete == null && p.commodities.length === 0) return null;
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <div className="rounded-md border bg-muted/30 p-2">
        <p className="text-xs text-muted-foreground">Schedule complete</p>
        <p className="text-lg font-medium">
          {p.pctComplete != null ? `${p.pctComplete}%` : "N/A"}
        </p>
        <p className="text-[11px] leading-tight text-muted-foreground">
          {p.tasksComplete} of {p.tasksTotal} activities finished, weighted by
          duration
        </p>
      </div>
      <div className="rounded-md border bg-muted/30 p-2">
        <p className="text-xs text-muted-foreground">Projected finish</p>
        <p className="text-lg font-medium">
          {p.projectedFinish ? dimensionDate(p.projectedFinish) : "N/A"}
        </p>
        <p
          className={cn(
            "text-[11px] leading-tight",
            p.slipDays > 0 ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {p.slipDays > 0
            ? `${p.slipDays} day${p.slipDays === 1 ? "" : "s"} behind plan`
            : p.slipDays < 0
              ? `${Math.abs(p.slipDays)} day${Math.abs(p.slipDays) === 1 ? "" : "s"} ahead of plan`
              : "On plan"}
        </p>
      </div>
      <div className="rounded-md border bg-muted/30 p-2">
        <p className="text-xs text-muted-foreground">Quantities to date</p>
        {p.commodities.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">Nothing confirmed yet</p>
        ) : (
          <ul className="mt-0.5 space-y-0.5">
            {p.commodities.slice(0, 4).map((c) => (
              <li key={c.label} className="text-[11px] leading-tight">
                {c.label}: {c.toDate.toLocaleString()} {c.uom}
                {c.pct != null && (
                  <span className="text-muted-foreground">
                    {" "}
                    ({c.pct}%{c.provisional ? ", provisional" : ""})
                  </span>
                )}
              </li>
            ))}
            {p.commodities.length > 4 && (
              <li className="text-[11px] text-muted-foreground">
                +{p.commodities.length - 4} more
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

function LookaheadPreview({ view }: { view: WeeklyReportView }) {
  const total = useMemo(
    () => view.lookahead.reduce((n, w) => n + w.tasks.length, 0),
    [view.lookahead],
  );
  if (!total) {
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        The schedule has no work projected in the three weeks after this period.
        Nothing will print on the look-ahead page.
      </p>
    );
  }
  return (
    <div className="mt-2 grid gap-2 sm:grid-cols-3">
      {view.lookahead.map((w) => (
        <div key={w.weekStart} className="rounded-md border bg-muted/30 p-2">
          <p className="text-xs font-medium">{w.label}</p>
          <ul className="mt-1 space-y-0.5">
            {w.tasks.slice(0, 6).map((t) => (
              <li key={t.wbs} className="text-[11px] leading-tight text-muted-foreground">
                {t.name}
                {t.critical && <span className="ml-1 text-destructive">critical</span>}
              </li>
            ))}
            {w.tasks.length > 6 && (
              <li className="text-[11px] text-muted-foreground">
                +{w.tasks.length - 6} more
              </li>
            )}
            {w.tasks.length === 0 && (
              <li className="text-[11px] text-muted-foreground">No scheduled work</li>
            )}
          </ul>
        </div>
      ))}
    </div>
  );
}
