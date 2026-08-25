import { Fragment } from "react";
import Link from "next/link";

import { guardCapability } from "@/lib/roles-server";
import { loadWeeklyReport, weeklySheet } from "@/lib/weekly-report-load";
import {
  MILESTONE_FIELDS,
  defaultWeekEnding,
  dimensionDate,
} from "@/lib/weekly-report";

import { PrintButton } from "./print-button";

type Params = { id: string };
type Search = { week?: string };

const isIso = (s: string | undefined): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

// The sheet that goes to Dimension.
//
// Laid out to match their spreadsheet section for section - Overview, Site
// Resources, Environment and Security, Progress - so the person receiving it
// can read it without relearning where anything is. Deliberately black on
// white with hard borders rather than the app's theme: this is printed, and a
// muted-foreground grey that reads fine on screen prints as illegible.
//
// The look-ahead is printed in its own box on this page rather than on a page
// of its own. The platform builds it from the schedule now, so there is nothing
// left to point somebody at: a box that says "see the following page" is a box
// that made sense when a human was pasting a Primavera export in behind.
//
// An ISSUED report prints from its frozen payload, not from a live derivation -
// see `weeklySheet`. What was sent has to stay what was sent.
export default async function WeeklyProgressPrintPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  await guardCapability("viewDailyProduction");

  const today = new Date().toISOString().slice(0, 10);
  const weekEnding = isIso(searchParams.week) ? searchParams.week : defaultWeekEnding(today);
  const view = await loadWeeklyReport(params.id, weekEnding);
  const r = weeklySheet(view);

  const milestones = MILESTONE_FIELDS.map((f) => ({
    label: f.label,
    date: r.milestones[f.key] ?? null,
  }));
  const lookaheadTotal = r.lookahead.reduce((n, w) => n + w.tasks.length, 0);

  return (
    <div className="mx-auto max-w-4xl bg-white p-2 text-black [print-color-adjust:exact] print:p-0">
      <div className="mb-3 flex items-center justify-between print:hidden">
        <Link
          href={`/projects/${params.id}/reports/weekly-progress?week=${weekEnding}`}
          className="text-sm text-blue-700 underline"
        >
          ← Back to the editor
        </Link>
        <PrintButton />
      </div>

      {view.status !== "issued" ? (
        <p className="mb-2 border border-amber-500 bg-amber-50 px-2 py-1 text-[11px] print:hidden">
          This is a draft, derived live. Issue it from the editor to freeze the
          figures as sent.
        </p>
      ) : (
        <p className="mb-2 border border-neutral-400 bg-neutral-50 px-2 py-1 text-[11px] print:hidden">
          Issued copy. Every figure below is read back from the snapshot taken
          when this was issued, so it reproduces exactly what Dimension was
          sent - even if a field report has been corrected since.
        </p>
      )}

      <div className="border border-neutral-400 text-[11px] leading-snug">
        <h1 className="border-b border-neutral-400 py-1 text-center text-sm font-bold">
          {view.projectName} Weekly Report
        </h1>

        <Band>Overview</Band>
        <Row label="Week Ending" value={dimensionDate(view.weekEnding)} boxed>
          <RowPair
            label="Dimension Construction Manager"
            value={r.header.dimensionCm}
          />
        </Row>
        <Row label="Period covered" value={`${dimensionDate(view.period.start)} to ${dimensionDate(view.period.end)}`}>
          <RowPair label="EPC Reporting Manager" value={r.header.epcReportingManager} />
        </Row>
        <Row label="EPC Team Members and roles" value={r.header.epcTeam} wide />

        <Band>Site Resources</Band>
        <div className="flex border-b border-neutral-400">
          <Cell head>Contractors:</Cell>
          <div className="flex-1 p-1">
            <table className="w-full text-[10px]">
              <thead>
                <tr className="text-center font-bold">
                  <th className="px-1 py-0.5">Contractor Name</th>
                  <th className="px-1 py-0.5">Scope</th>
                  <th className="px-1 py-0.5">Headcount This Week</th>
                  <th className="px-1 py-0.5">Last Date Onsite</th>
                  <th className="px-1 py-0.5">End Date</th>
                </tr>
              </thead>
              <tbody>
                {r.contractors.map((c) => (
                  <tr key={c.key} className="text-center">
                    <td className="px-1 py-0.5 text-left">{c.name}</td>
                    <td className="px-1 py-0.5">{c.scope || "N/A"}</td>
                    <td className="border border-neutral-400 px-1 py-0.5">
                      {c.headcount ?? "N/A"}
                    </td>
                    <td className="border border-neutral-400 px-1 py-0.5">
                      {c.lastOnsite ? dimensionDate(c.lastOnsite) : "N/A"}
                    </td>
                    <td className="border border-neutral-400 px-1 py-0.5">
                      {c.endDate ? dimensionDate(c.endDate) : "N/A"}
                    </td>
                  </tr>
                ))}
                {r.contractors.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-1 py-0.5 text-left">
                      N/A
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <p className="mt-0.5 text-[8.5px] text-neutral-600">
              Headcount is the peak day on site during the period. Total effort
              for the week is reported as man-hours below.
            </p>
          </div>
        </div>

        <div className="flex border-b border-neutral-400">
          <Cell head>Equipment:</Cell>
          <div className="flex-1 p-1">
            <table className="w-[60%] text-[10px]">
              <thead>
                <tr className="text-center font-bold">
                  <th className="px-1 py-0.5">Equipment Type</th>
                  <th className="px-1 py-0.5">Quantity</th>
                </tr>
              </thead>
              <tbody>
                {r.equipment.map((e) => (
                  <tr key={e.key} className="text-center">
                    <td className="px-1 py-0.5 text-left">{e.name}</td>
                    <td className="border border-neutral-400 px-1 py-0.5">
                      {e.quantity ?? "N/A"}
                    </td>
                  </tr>
                ))}
                {r.equipment.length === 0 && (
                  <tr>
                    <td colSpan={2} className="px-1 py-0.5 text-left">
                      N/A
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <Row
          label="Man-hours"
          value={`${r.manHours.week.toLocaleString()} this week`}
          boxed
        >
          <RowPair
            label="Man-hours to Date"
            value={r.manHours.cumulative ? r.manHours.cumulative.toLocaleString() : "N/A"}
          />
        </Row>

        <Band>Environment, Security and Safety</Band>
        <Row label="Environment Concerns" value={r.environment || "N/A"} wide multiline />
        <Row label="Security Concerns" value={r.security || "N/A"} wide multiline />
        <Row label="Safety" value={r.safety || "N/A"} wide multiline />
        <Row
          label="Date of Most Recent SWPPP Inspection"
          value={r.swppp ? dimensionDate(r.swppp) : "N/A"}
          boxed
        >
          <RowPair label="Weather This Week" value={r.weather || "N/A"} />
        </Row>

        <Band>Progress</Band>
        <Row label="Project Position" value={r.position || "N/A"} wide multiline />
        <div className="flex border-b border-neutral-400">
          <Cell head>Milestone Tracking:</Cell>
          <div className="flex-1 p-1">
            <table className="text-[10px]">
              <tbody>
                {milestones.map((m) => (
                  <tr key={m.label}>
                    <td className="px-1 py-0.5 text-right">{m.label}</td>
                    <td className="px-2 py-0.5">Date expected by EPC:</td>
                    <td className="border border-neutral-400 px-2 py-0.5 text-center">
                      {m.date ? dimensionDate(m.date) : "N/A"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <Row label="Work This Week" value={r.workThisWeek || "N/A"} wide multiline />

        <div className="border-b border-neutral-400">
          <div className="flex">
            <Cell head>3 Week Look Ahead:</Cell>
            <div className="flex-1 px-2 py-1">
              {r.lookaheadNote ? (
                <p className="whitespace-pre-wrap">{r.lookaheadNote}</p>
              ) : (
                <p className="text-neutral-600">
                  Activities scheduled for the three weeks following this
                  reporting period, from the project schedule.
                </p>
              )}
            </div>
          </div>

          {lookaheadTotal === 0 ? (
            <p className="px-2 pb-1 text-[10px]">
              No work is projected in the three weeks after this period.
            </p>
          ) : (
            <div className="px-2 pb-2">
              <table className="w-full border-collapse text-[9.5px]">
                <thead>
                  <tr className="bg-[#1f4e79] text-white [print-color-adjust:exact]">
                    <Th className="w-14">WBS</Th>
                    <Th>Activity</Th>
                    <Th className="w-28">Responsible</Th>
                    <Th className="w-20">Start</Th>
                    <Th className="w-20">Finish</Th>
                    <Th className="w-16">% Comp</Th>
                    <Th className="w-24">Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {r.lookahead.map((w) => (
                    <Fragment key={w.weekStart}>
                      <tr className="bg-[#bdd7ee] [print-color-adjust:exact]">
                        <td
                          colSpan={7}
                          className="border border-neutral-500 px-1 py-0.5 font-bold uppercase tracking-wide"
                        >
                          {w.label}
                        </td>
                      </tr>
                      {w.tasks.length === 0 ? (
                        <tr>
                          <td
                            colSpan={7}
                            className="border border-neutral-500 px-1 py-0.5 italic"
                          >
                            No scheduled work.
                          </td>
                        </tr>
                      ) : (
                        w.tasks.map((t) => (
                          <tr key={t.wbs} className="align-top">
                            <Td>{t.wbs}</Td>
                            <Td className="text-left">{t.name}</Td>
                            <Td className="text-left">{t.assignedTo ?? "-"}</Td>
                            <Td>{dimensionDate(t.start)}</Td>
                            <Td>{dimensionDate(t.end)}</Td>
                            <Td>{t.pctComplete != null ? `${t.pctComplete}%` : "-"}</Td>
                            <Td className={t.critical ? "font-bold" : undefined}>
                              {[
                                t.critical ? "Critical" : null,
                                t.finishing ? "Completes" : null,
                                t.continuing ? "Continuing" : null,
                              ]
                                .filter(Boolean)
                                .join(", ") || "Scheduled"}
                            </Td>
                          </tr>
                        ))
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
              <p className="mt-0.5 text-[8.5px] text-neutral-600">
                Critical = on the schedule&apos;s critical path. Completes = the
                activity finishes within that week.
              </p>
            </div>
          )}
        </div>

        <Row label="Open Schedule Risks" value={r.risks || "N/A"} wide multiline />
      </div>

      <p className="mt-1 text-[10px]">
        {view.photos.length > 0
          ? `Photos on the following page${view.photos.length > 6 ? "s" : ""}. Complete all fields above. Put N/A as needed.`
          : "Complete all fields above. Put N/A as needed."}
      </p>

      {/* ---- Photos, from the period's approved field reports ---- */}
      {view.photos.length > 0 && (
        <div className="mt-6 break-before-page border border-neutral-400 print:mt-0">
          <h2 className="border-b border-neutral-400 py-1 text-center text-sm font-bold">
            {view.projectName} - Progress Photos
          </h2>
          {r.photoNote && (
            <p className="border-b border-neutral-400 px-2 py-1 text-[11px] whitespace-pre-wrap">
              {r.photoNote}
            </p>
          )}
          <div className="grid grid-cols-2 gap-2 p-2">
            {view.photos.map((ph) => (
              <figure key={ph.key} className="break-inside-avoid border border-neutral-300">
                {ph.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={ph.url}
                    alt={ph.caption ?? `Site photo ${dimensionDate(ph.day)}`}
                    className="h-56 w-full object-cover"
                  />
                ) : (
                  <div className="flex h-56 w-full items-center justify-center text-[10px]">
                    Photo unavailable
                  </div>
                )}
                <figcaption className="border-t border-neutral-300 px-1 py-0.5 text-[9px]">
                  {dimensionDate(ph.day)} - {ph.who}
                  {ph.caption ? ` - ${ph.caption}` : ""}
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      )}

      <footer className="mt-2 text-[9px] text-neutral-500">
        {view.projectName}
        {view.client ? ` - ${view.client}` : ""} - week ending{" "}
        {dimensionDate(view.weekEnding)} - generated by the AHC PM Platform
        {view.status === "issued" && view.issuedAt
          ? ` - issued ${new Date(view.issuedAt).toLocaleDateString()}`
          : " - DRAFT"}
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout primitives. Dimension's form is a label column against a value
// column, banded by section, so that is what these are - kept local because
// nothing else in the app has this shape.

function Band({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b border-neutral-400 bg-[#bdd7ee] py-0.5 text-center text-[11px] font-bold uppercase [print-color-adjust:exact]">
      {children}
    </div>
  );
}

function Cell({ head, children }: { head?: boolean; children: React.ReactNode }) {
  return (
    <div
      className={
        head
          ? "w-44 shrink-0 px-2 py-1 text-right font-bold"
          : "flex-1 px-2 py-1"
      }
    >
      {children}
    </div>
  );
}

function Row({
  label,
  value,
  children,
  wide,
  boxed,
  multiline,
}: {
  label: string;
  value: string;
  children?: React.ReactNode;
  wide?: boolean;
  boxed?: boolean;
  multiline?: boolean;
}) {
  return (
    <div className="flex border-b border-neutral-400">
      <Cell head>{label}:</Cell>
      <div
        className={
          wide
            ? "flex-1 whitespace-pre-wrap px-2 py-1"
            : boxed
              ? "w-52 border border-neutral-400 px-2 py-1 text-center font-bold"
              : "w-52 px-2 py-1 text-center"
        }
      >
        {multiline ? value : value || "N/A"}
      </div>
      {children}
    </div>
  );
}

function Th({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`border border-neutral-500 px-1 py-0.5 text-center font-bold ${className ?? ""}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td className={`border border-neutral-500 px-1 py-0.5 text-center ${className ?? ""}`}>
      {children}
    </td>
  );
}

function RowPair({ label, value }: { label: string; value: string }) {
  return (
    <>
      <div className="w-52 shrink-0 px-2 py-1 text-right font-bold">{label}:</div>
      <div className="flex-1 border border-neutral-400 px-2 py-1 text-center">
        {value || "N/A"}
      </div>
    </>
  );
}
