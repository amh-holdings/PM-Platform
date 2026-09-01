import Link from "next/link";
import { notFound } from "next/navigation";

import { guardCapability } from "@/lib/roles-server";
import { loadCeoReport } from "@/lib/ceo-report-load";
import { formatDate } from "@/lib/format";
import type { CeoCheck, Progress } from "@/lib/ceo-report";

type Params = { id: string };
type Search = { asOf?: string; photos?: string };

const isIso = (s: string | undefined): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

const pct = (n: number | null, dp = 1) => (n == null ? "-" : `${n.toFixed(dp)}%`);

/** How many photographs to show, from `?photos=`. Carried into the print link. */
const photoCount = (raw: string | undefined): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(12, Math.floor(n)) : DEFAULT_PHOTOS;
};

/** Three photographs: one row on the printed sheet. See the print page. */
const DEFAULT_PHOTOS = 3;

// The CEO Report, on screen.
//
// Progress only - no money. The financial half is built and tested in
// `ceo-report-financials.ts` and deliberately not imported here, so nothing on
// this page or its PDF can carry a dollar figure until that is switched on.
//
// Read-only and derived live: there is no draft/issue lifecycle and no table
// behind it, because nothing here is authored. Every figure already exists in
// the record; this page is the arrangement of it.
export default async function CeoReportPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  // Progress, dates and site photographs - no internal cost - so this sits
  // behind the Schedule gate rather than the Costs one. When the financial
  // half is switched on this moves to `viewCosts`.
  await guardCapability("viewSchedule");

  const today = new Date().toISOString().slice(0, 10);
  const asOf = isIso(searchParams.asOf) ? searchParams.asOf : today;

  const photos = photoCount(searchParams.photos);
  const r = await loadCeoReport(params.id, asOf, photos);
  if (!r) notFound();

  const { progress: p, dates: d } = r;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-card px-3 py-2">
        <div>
          <p className="text-sm font-medium">
            {r.project.name}
            {r.project.client ? ` - ${r.project.client}` : ""}
          </p>
          <p className="text-xs text-muted-foreground">As of {formatDate(r.asOf)}</p>
        </div>
        <Link
          href={`/projects/${params.id}/reports/ceo/print?asOf=${asOf}&photos=${photos}`}
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
        >
          Print / Save as PDF
        </Link>
      </div>

      <section className="rounded-md border bg-card p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          The read
        </h2>
        <p className="mt-2 text-sm leading-relaxed">{r.headline}</p>
      </section>

      <section>
        <SectionTitle>Where we are</SectionTitle>
        <div className="rounded-md border bg-card p-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-xs text-muted-foreground">Complete</p>
              <p className="text-4xl font-semibold tabular-nums">{pct(p.actualPct)}</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-muted-foreground">Should be</p>
              <p className="text-4xl font-semibold tabular-nums text-muted-foreground">
                {pct(p.plannedPct)}
              </p>
            </div>
          </div>

          <PlanBar progress={p} />

          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Stat
              label="Against plan"
              value={
                p.variance == null
                  ? "-"
                  : `${p.variance > 0 ? "+" : ""}${p.variance.toFixed(1)} pts`
              }
              note={p.variance == null ? "No dates to compare" : p.variance < 0 ? "Behind" : "Ahead"}
              emphasis={p.variance != null && p.variance < 0}
            />
            <Stat
              label="Off the pace by"
              value={
                p.daysOffPlan == null
                  ? "-"
                  : `${Math.abs(p.daysOffPlan)} days`
              }
              note={
                p.planReachedActualOn
                  ? `Plan expected this on ${formatDate(p.planReachedActualOn)}`
                  : "Running ahead of the planned finish"
              }
              emphasis={p.daysOffPlan != null && p.daysOffPlan < 0}
            />
            <Stat
              label="Tasks"
              value={`${p.complete} / ${p.leafCount}`}
              note={`${p.inProgress} under way, ${p.notStarted} not started`}
            />
          </div>
        </div>
      </section>

      <section>
        <SectionTitle>Progress by area</SectionTitle>
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <Th className="text-left">Area</Th>
                <Th className="text-right">Complete</Th>
                <Th className="text-right">Should be</Th>
                <Th className="text-right">Against plan</Th>
                <Th className="text-right">Tasks</Th>
                <Th className="text-right">Finishes</Th>
              </tr>
            </thead>
            <tbody>
              {p.areas.map((a) => (
                <tr key={a.area} className="border-t">
                  <Td className="text-left font-medium">{a.area}</Td>
                  <Td className="text-right tabular-nums">{pct(a.actualPct)}</Td>
                  <Td className="text-right tabular-nums text-muted-foreground">{pct(a.plannedPct)}</Td>
                  <Td
                    className={`text-right tabular-nums ${
                      a.variance != null && a.variance < 0 ? "text-amber-700 dark:text-amber-400" : ""
                    }`}
                  >
                    {a.variance == null ? "-" : `${a.variance > 0 ? "+" : ""}${a.variance.toFixed(1)}`}
                  </Td>
                  <Td className="text-right tabular-nums">{a.complete}/{a.taskCount}</Td>
                  <Td className="text-right tabular-nums text-muted-foreground">{formatDate(a.finish)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <SectionTitle>Dates</SectionTitle>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Started" value={formatDate(d.start)} note="First scheduled task" />
          <Stat
            label="Finishes"
            value={formatDate(d.finish)}
            note={d.daysRemaining == null ? "" : `${Math.abs(d.daysRemaining)} days ${d.daysRemaining < 0 ? "past" : "away"}`}
          />
          <Stat
            label="Time elapsed"
            value={pct(d.timeElapsedPct)}
            note="Of the scheduled window"
          />
          <Stat
            label="Finish vs baseline"
            value={d.finishSlipDays == null ? "No baseline" : `${d.finishSlipDays > 0 ? "+" : ""}${d.finishSlipDays} days`}
            note={d.baselineFinish ? `Baseline ${formatDate(d.baselineFinish)}` : "None set to compare against"}
            muted={d.finishSlipDays == null}
            emphasis={d.finishSlipDays != null && d.finishSlipDays > 0}
          />
        </div>


        {/* Completion milestones live INSIDE Dates: they are dates, and the
            useful comparison is against the scheduled finish sitting above. */}
        <div className="mt-3 overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <Th className="text-left">Completion milestone</Th>
                <Th className="text-right">Date</Th>
                <Th className="text-right">Away</Th>
                <Th className="text-right">vs work finish</Th>
                <Th className="text-right">Status</Th>
              </tr>
            </thead>
            <tbody>
              {[...d.contract, ...d.milestones].map((k) => (
                <tr key={`${k.source}-${k.label}`} className="border-t">
                  <Td className="text-left font-medium">{k.label}</Td>
                  <Td className={`text-right tabular-nums ${k.date ? "" : "text-muted-foreground"}`}>
                    {k.date ? formatDate(k.date) : "Not set"}
                  </Td>
                  <Td className="text-right tabular-nums text-muted-foreground">
                    {k.daysAway == null
                      ? "-"
                      : `${Math.abs(k.daysAway)} days ${k.daysAway < 0 ? "ago" : ""}`}
                  </Td>
                  <Td
                    className={`text-right tabular-nums ${
                      k.vsWorkFinish != null && k.vsWorkFinish > 0
                        ? "text-amber-700 dark:text-amber-400"
                        : "text-muted-foreground"
                    }`}
                  >
                    {k.vsWorkFinish == null
                      ? "-"
                      : k.vsWorkFinish > 0
                        ? `${k.vsWorkFinish} days late`
                        : `${Math.abs(k.vsWorkFinish)} days early`}
                  </Td>
                  <Td className={`text-right ${k.date ? "" : "text-muted-foreground"}`}>
                    {!k.date
                      ? "Not set"
                      : k.done
                        ? "Met"
                        : k.vsWorkFinish != null && k.vsWorkFinish > 0
                          ? "At risk"
                          : "On track"}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="border-t px-3 py-2 text-xs text-muted-foreground">
            {d.workFinish
              ? `Compared against ${formatDate(d.workFinish)}, the last of the scheduled work with milestones excluded.`
              : "No scheduled work to compare these against yet."}
          </p>
        </div>
      </section>

      {p.late.length > 0 && (
        <section>
          <SectionTitle>Past their finish date</SectionTitle>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <Th className="text-left">WBS</Th>
                  <Th className="text-left">Task</Th>
                  <Th className="text-right">Complete</Th>
                  <Th className="text-right">Due</Th>
                  <Th className="text-right">Days late</Th>
                </tr>
              </thead>
              <tbody>
                {p.late.map((t) => (
                  <tr key={t.wbs} className="border-t">
                    <Td className="text-left tabular-nums text-muted-foreground">{t.wbs}</Td>
                    <Td className="text-left">{t.name}</Td>
                    <Td className="text-right tabular-nums">{t.actualPct}%</Td>
                    <Td className="text-right tabular-nums">{formatDate(t.finish)}</Td>
                    <Td className="text-right tabular-nums font-medium">{t.daysLate}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section>
        <SectionTitle>
          The work {r.photos.length > 0 && `(${r.photos.length} of ${r.photoCount} photographs)`}
        </SectionTitle>
        {r.photos.length === 0 ? (
          <div className="rounded-md border bg-card p-4 text-sm text-muted-foreground">
            No site photographs are on file for this project up to {formatDate(r.asOf)}.
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {r.photos.map((ph) => (
              <figure key={ph.key} className="overflow-hidden rounded-md border bg-card">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={ph.url ?? ""}
                  alt={ph.caption ?? ph.who}
                  className="aspect-[4/3] w-full object-cover"
                />
                <figcaption className="p-2 text-xs">
                  <p className="font-medium">{ph.who}</p>
                  <p className="text-muted-foreground">
                    {formatDate(ph.day)}
                    {ph.caption ? ` - ${ph.caption}` : ""}
                  </p>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionTitle>Confidence in these figures</SectionTitle>
        <ul className="space-y-2 rounded-md border bg-card p-4">
          {r.checks.length === 0 ? (
            <li className="text-sm text-muted-foreground">
              Nothing to flag - the schedule is baselined, dated and current.
            </li>
          ) : (
            r.checks.map((c) => <CheckRow key={c.id} check={c} />)
          )}
        </ul>
      </section>
    </div>
  );
}

/**
 * Actual against planned on one track.
 *
 * The filled bar is the work done; the tick is where the plan says the job
 * should be today. Putting them on the same axis is the whole point - two
 * numbers side by side make a reader do the subtraction, and a bar that stops
 * short of its marker does not.
 */
function PlanBar({ progress }: { progress: Progress }) {
  const actual = Math.max(0, Math.min(100, progress.actualPct));
  const planned = progress.plannedPct == null ? null : Math.max(0, Math.min(100, progress.plannedPct));
  const behind = progress.variance != null && progress.variance < 0;

  return (
    <div className="mt-4">
      <div className="relative h-3 w-full rounded-full bg-muted">
        <div
          className={`h-3 rounded-full ${behind ? "bg-amber-500" : "bg-emerald-600"}`}
          style={{ width: `${actual}%` }}
        />
        {planned != null && (
          <div
            className="absolute top-[-4px] h-5 w-0.5 bg-foreground"
            style={{ left: `${planned}%` }}
            aria-hidden
          />
        )}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>0%</span>
        {planned != null && <span>| marks the plan at {planned.toFixed(1)}%</span>}
        <span>100%</span>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h2>
  );
}

function Stat({
  label,
  value,
  note,
  emphasis,
  muted,
}: {
  label: string;
  value: string;
  note?: string;
  emphasis?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="rounded-md border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={`mt-1 text-xl font-semibold tabular-nums ${
          emphasis ? "text-amber-700 dark:text-amber-400" : muted ? "text-muted-foreground" : ""
        }`}
      >
        {value}
      </p>
      {note && <p className="mt-1 text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

function CheckRow({ check }: { check: CeoCheck }) {
  const tone =
    check.severity === "blocker"
      ? "border-amber-500 text-amber-700 dark:text-amber-400"
      : check.severity === "warn"
        ? "border-muted-foreground/40 text-muted-foreground"
        : "border-emerald-500/50 text-emerald-700 dark:text-emerald-400";
  const word = check.severity === "blocker" ? "Cannot say" : check.severity === "warn" ? "Check" : "Handled";
  return (
    <li className="flex gap-3 text-sm">
      <span className={`mt-0.5 h-fit shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${tone}`}>
        {word}
      </span>
      <span>
        <span className="font-medium">{check.label}.</span>{" "}
        <span className="text-muted-foreground">{check.detail}</span>
      </span>
    </li>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-3 py-2 font-medium ${className ?? ""}`}>{children}</th>;
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2 ${className ?? ""}`}>{children}</td>;
}
