import Link from "next/link";
import { notFound } from "next/navigation";

import { guardCapability } from "@/lib/roles-server";
import { loadCeoReport } from "@/lib/ceo-report-load";
import { formatDate } from "@/lib/format";

import { PrintButton } from "./print-button";

type Params = { id: string };
type Search = { asOf?: string; photos?: string };

const isIso = (s: string | undefined): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

const pct = (n: number | null, dp = 1) => (n == null ? "-" : `${n.toFixed(dp)}%`);

/**
 * Three photographs, filling exactly one row of the three-column grid.
 *
 * A status report is read for its numbers; the pictures are there to make the
 * percentage feel like a real site, and three do that as well as six while
 * keeping the whole thing to one page. Three also keeps the file small enough
 * to email without thinking about it - the PDF writer rasterizes each
 * photograph rather than passing the JPEG through, so the count is the main
 * thing that moves the size.
 */
const DEFAULT_PHOTOS = 3;

/** How many photographs to print, from `?photos=`. */
const photoCount = (raw: string | undefined): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(12, Math.floor(n)) : DEFAULT_PHOTOS;
};

// The sheet that goes to the CEO.
//
// Black on white with hard borders rather than the app's theme, for the same
// reason the weekly report does it: this is printed, and a muted-foreground
// grey that reads fine on a screen prints as illegible.
//
// It renders `loadCeoReport` - the same call the screen makes - so the page
// that was reviewed and the PDF that gets sent cannot diverge.
//
// Three photographs in one row is the default. This is a one-page read with a
// strip of pictures under it, not an album - the photographs are there to make
// the percentage feel like a real site, and past a handful the reader stops
// looking. `?photos=` overrides it when a month genuinely has more to show.
export default async function CeoReportPrintPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  await guardCapability("viewSchedule");

  const today = new Date().toISOString().slice(0, 10);
  const asOf = isIso(searchParams.asOf) ? searchParams.asOf : today;

  const r = await loadCeoReport(params.id, asOf, photoCount(searchParams.photos));
  if (!r) notFound();

  const { progress: p, dates: d } = r;
  const keyDates = [...d.contract, ...d.milestones];

  return (
    <div className="mx-auto max-w-4xl bg-white p-2 text-black [print-color-adjust:exact] print:p-0">
      <div className="mb-3 flex items-center justify-between print:hidden">
        <Link
          href={`/projects/${params.id}/reports/ceo?asOf=${asOf}`}
          className="text-sm text-blue-700 underline"
        >
          &larr; Back to the report
        </Link>
        <PrintButton />
      </div>

      <div className="border border-neutral-400 text-[11px] leading-snug">
        <div className="border-b border-neutral-400 px-2 py-1.5 text-center">
          <h1 className="text-sm font-bold">{r.project.name} - Project Status</h1>
          <p className="text-[10px]">
            {r.project.client ? `${r.project.client} - ` : ""}
            As of {formatDate(r.asOf)}
          </p>
        </div>

        <Band>Summary</Band>
        <div className="border-b border-neutral-400 px-2 py-1.5">{r.headline}</div>

        <Band>Where we are against the plan</Band>
        <div className="border-b border-neutral-400 px-2 py-2">
          <div className="flex items-end justify-between">
            <div>
              <p className="text-[9px] uppercase tracking-wide">Complete</p>
              <p className="text-2xl font-bold tabular-nums">{pct(p.actualPct)}</p>
            </div>
            <div className="text-center">
              <p className="text-[9px] uppercase tracking-wide">Against plan</p>
              <p className="text-2xl font-bold tabular-nums">
                {p.variance == null ? "-" : `${p.variance > 0 ? "+" : ""}${p.variance.toFixed(1)} pts`}
              </p>
              <p className="text-[9px]">
                {p.daysOffPlan == null
                  ? ""
                  : `${Math.abs(p.daysOffPlan)} days ${p.daysOffPlan < 0 ? "behind" : "ahead of"} the pace`}
              </p>
            </div>
            <div className="text-right">
              <p className="text-[9px] uppercase tracking-wide">Should be</p>
              <p className="text-2xl font-bold tabular-nums">{pct(p.plannedPct)}</p>
            </div>
          </div>

          {/* Printed bar. Solid fill for work done, a hard rule for the plan.
              neutral-700, not a lighter grey: on paper a 40% grey against white
              is close enough to the empty track that the bar stops reading as a
              measurement at all. */}
          <div className="relative mt-2 h-3 w-full border border-neutral-500 bg-white">
            <div
              className="h-full bg-neutral-700"
              style={{ width: `${Math.max(0, Math.min(100, p.actualPct))}%` }}
            />
            {p.plannedPct != null && (
              <div
                className="absolute top-[-3px] h-[18px] w-[2px] bg-black"
                style={{ left: `${Math.max(0, Math.min(100, p.plannedPct))}%` }}
              />
            )}
          </div>
          <p className="mt-0.5 text-[9px]">
            Shaded bar is work complete. The vertical rule is where the plan says the job should be
            today{p.againstBaseline ? " (measured against the baseline)." : " (measured against the current schedule - no baseline is set)."}
          </p>
        </div>

        <Band>Progress by area</Band>
        <table className="w-full border-collapse">
          <thead>
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
              <tr key={a.area}>
                <Td className="text-left font-bold">{a.area}</Td>
                <Td className="text-right tabular-nums">{pct(a.actualPct)}</Td>
                <Td className="text-right tabular-nums">{pct(a.plannedPct)}</Td>
                <Td className="text-right tabular-nums font-bold">
                  {a.variance == null ? "-" : `${a.variance > 0 ? "+" : ""}${a.variance.toFixed(1)}`}
                </Td>
                <Td className="text-right tabular-nums">{a.complete}/{a.taskCount}</Td>
                <Td className="text-right tabular-nums">{formatDate(a.finish)}</Td>
              </tr>
            ))}
          </tbody>
        </table>

        <Band>Dates</Band>
        <Grid>
          <Fig label="Started" value={formatDate(d.start)} />
          <Fig
            label="Finishes"
            value={formatDate(d.finish)}
            sub={d.daysRemaining == null ? undefined : `${Math.abs(d.daysRemaining)} days ${d.daysRemaining < 0 ? "past" : "away"}`}
          />
          <Fig label="Time elapsed" value={pct(d.timeElapsedPct)} sub="of the scheduled window" />
          <Fig
            label="Finish vs baseline"
            value={d.finishSlipDays == null ? "No baseline" : `${d.finishSlipDays > 0 ? "+" : ""}${d.finishSlipDays} days`}
            sub={d.baselineFinish ? `baseline ${formatDate(d.baselineFinish)}` : "none set to compare"}
          />
          <Fig label="Tasks complete" value={`${p.complete} of ${p.leafCount}`} sub={`${p.inProgress} under way`} />
          <Fig label="Past finish date" value={String(p.late.length)} sub={p.late.length > 0 ? `oldest ${p.late[0].daysLate} days` : "none"} />
        </Grid>

        {/* Completion milestones sit under Dates rather than in a band of
            their own: they are dates, and the comparison that matters is
            against the scheduled finish in the grid above. */}
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <Th className="text-left">Completion milestone</Th>
              <Th className="text-right">Date</Th>
              <Th className="text-right">Away</Th>
              <Th className="text-right">vs work finish</Th>
              <Th className="text-right">Status</Th>
            </tr>
          </thead>
          <tbody>
            {keyDates.map((k) => (
              <tr key={`${k.source}-${k.label}`}>
                <Td className="text-left font-bold">{k.label}</Td>
                <Td className="text-right tabular-nums">{k.date ? formatDate(k.date) : "Not set"}</Td>
                <Td className="text-right tabular-nums">
                  {k.daysAway == null
                    ? "-"
                    : `${Math.abs(k.daysAway)} days ${k.daysAway < 0 ? "ago" : ""}`}
                </Td>
                <Td className="text-right tabular-nums font-bold">
                  {k.vsWorkFinish == null
                    ? "-"
                    : k.vsWorkFinish > 0
                      ? `${k.vsWorkFinish} days late`
                      : `${Math.abs(k.vsWorkFinish)} days early`}
                </Td>
                <Td className="text-right">
                  {!k.date
                    ? "Not set"
                    : k.done
                      ? "Met"
                      : k.vsWorkFinish != null && k.vsWorkFinish > 0
                        ? "AT RISK"
                        : "On track"}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="border-b border-neutral-400 px-2 py-1 text-[9px]">
          {d.workFinish
            ? `Compared against ${formatDate(d.workFinish)}, the last of the scheduled work with milestones excluded.`
            : "No scheduled work to compare these against yet."}
        </p>

        {p.late.length > 0 && (
          <>
            <Band>Past their finish date</Band>
            <table className="w-full border-collapse">
              <thead>
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
                  <tr key={t.wbs}>
                    <Td className="text-left tabular-nums">{t.wbs}</Td>
                    <Td className="text-left">{t.name}</Td>
                    <Td className="text-right tabular-nums">{t.actualPct}%</Td>
                    <Td className="text-right tabular-nums">{formatDate(t.finish)}</Td>
                    <Td className="text-right tabular-nums font-bold">{t.daysLate}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {r.photos.length > 0 && (
          <>
            <Band>The work on the ground</Band>
            {/* break-inside-avoid so a caption never splits from its photo. */}
            <div className="grid grid-cols-3 gap-1.5 p-2">
              {r.photos.map((ph) => (
                <figure key={ph.key} className="break-inside-avoid border border-neutral-400">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={ph.url ?? ""}
                    alt={ph.caption ?? ph.who}
                    className="aspect-[4/3] w-full object-cover"
                  />
                  <figcaption className="border-t border-neutral-400 px-1 py-0.5 text-[8px] leading-tight">
                    <span className="font-bold">{ph.who}</span>
                    <br />
                    {formatDate(ph.day)}
                    {ph.caption ? ` - ${ph.caption}` : ""}
                  </figcaption>
                </figure>
              ))}
            </div>
          </>
        )}

        {r.checks.length > 0 && (
          <>
            <Band>Notes on these figures</Band>
            <div className="px-2 py-1.5">
              <ul className="list-disc space-y-1 pl-4">
                {r.checks.map((c) => (
                  <li key={c.id}>
                    <span className="font-bold">{c.label}.</span> {c.detail}
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </div>

      <p className="mt-2 text-[9px] text-neutral-600">
        Derived from the platform record at {formatDate(r.asOf)}. Figures change as field reports and
        schedule updates are added; regenerate before circulating.
      </p>
    </div>
  );
}

function Band({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b border-neutral-400 bg-neutral-200 px-2 py-0.5 text-center text-[11px] font-bold uppercase tracking-wide">
      {children}
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-3 border-b border-neutral-400">{children}</div>;
}

function Fig({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border-r border-neutral-400 px-2 py-1 last:border-r-0">
      <p className="text-[9px] uppercase tracking-wide">{label}</p>
      <p className="text-[13px] font-bold tabular-nums">{value}</p>
      {sub && <p className="text-[9px]">{sub}</p>}
    </div>
  );
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={`border border-neutral-500 px-1 py-0.5 text-center font-bold ${className ?? ""}`}>
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <td className={`border border-neutral-500 px-1 py-0.5 text-center ${className ?? ""}`}>
      {children}
    </td>
  );
}
