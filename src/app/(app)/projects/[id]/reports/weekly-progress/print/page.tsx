import Link from "next/link";

import { guardCapability } from "@/lib/roles-server";
import { loadWeeklyReport, resolveWeekly } from "@/lib/weekly-report-load";
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
// The look-ahead gets page 2 on its own, which is what the form's "See 3-week
// look ahead on page 3" note has always been pointing at.
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
  const r = resolveWeekly(view);

  const milestones = MILESTONE_FIELDS.map((f) => ({
    label: f.label,
    date: view.saved?.milestones?.[f.key] ?? view.milestones[f.key]?.value ?? null,
  }));

  return (
    <div className="mx-auto max-w-4xl bg-white p-2 text-black print:p-0">
      <div className="mb-3 flex items-center justify-between print:hidden">
        <Link
          href={`/projects/${params.id}/reports/weekly-progress?week=${weekEnding}`}
          className="text-sm text-blue-700 underline"
        >
          ← Back to the editor
        </Link>
        <PrintButton />
      </div>

      {view.status !== "issued" && (
        <p className="mb-2 border border-amber-500 bg-amber-50 px-2 py-1 text-[11px] print:hidden">
          This is a draft. Issue it from the editor to freeze the figures as sent.
        </p>
      )}

      {/* ---------------- Page 1 ---------------- */}
      <div className="border border-neutral-400 text-[11px] leading-snug">
        <h1 className="border-b border-neutral-400 py-1 text-center text-sm font-bold">
          {view.projectName} Weekly Report
        </h1>

        <Band>Overview</Band>
        <Row label="Week Ending" value={dimensionDate(view.weekEnding)} boxed>
          <RowPair
            label="Dimension Construction Manager"
            value={view.header.dimensionCm}
          />
        </Row>
        <Row label="Period covered" value={`${dimensionDate(view.period.start)} to ${dimensionDate(view.period.end)}`}>
          <RowPair label="EPC Reporting Manager" value={view.header.epcReportingManager} />
        </Row>
        <Row label="EPC Team Members and roles" value={view.header.epcTeam} wide />

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
                {view.contractors.map((c) => (
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
                {view.contractors.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-1 py-0.5 text-left">
                      N/A
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
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
                {view.equipment.map((e) => (
                  <tr key={e.key} className="text-center">
                    <td className="px-1 py-0.5 text-left">{e.name}</td>
                    <td className="border border-neutral-400 px-1 py-0.5">
                      {e.quantity ?? "N/A"}
                    </td>
                  </tr>
                ))}
                {view.equipment.length === 0 && (
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

        <Band>Environment and Security</Band>
        <Row label="Environment Concerns" value={r.environment || "N/A"} wide multiline />
        <Row label="Security Concerns" value={r.security || "N/A"} wide multiline />
        <Row
          label="Date of Most Recent SWPPP Inspection"
          value={r.swppp ? dimensionDate(r.swppp) : "N/A"}
          boxed
        >
          <RowPair label="Weather This Week" value={r.weather || "N/A"} />
        </Row>

        <Band>Progress</Band>
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
        <Row
          label="3 Week Look Ahead"
          value={r.lookaheadNote || "See 3-week look ahead on the following page."}
          wide
          multiline
        />
        <Row label="Open Schedule Risks" value={r.risks || "N/A"} wide multiline />
      </div>

      <p className="mt-1 text-[10px]">
        Include clear photos attached to this report in 8.5x11&quot; format.
        Complete all fields above. Put N/A as needed.
      </p>

      {/* ---------------- Page 2: look-ahead ---------------- */}
      <div className="mt-6 break-before-page border border-neutral-400 text-[11px] print:mt-0">
        <h2 className="border-b border-neutral-400 py-1 text-center text-sm font-bold">
          {view.projectName} - 3 Week Look Ahead
        </h2>
        {view.lookahead.map((w) => (
          <div key={w.weekStart} className="border-b border-neutral-400 last:border-b-0">
            <p className="bg-neutral-100 px-2 py-0.5 text-[11px] font-bold">{w.label}</p>
            {w.tasks.length === 0 ? (
              <p className="px-2 py-1 text-[10px]">No scheduled work.</p>
            ) : (
              <table className="w-full text-[10px]">
                <thead>
                  <tr className="text-left">
                    <th className="px-2 py-0.5 font-bold">WBS</th>
                    <th className="px-2 py-0.5 font-bold">Activity</th>
                    <th className="px-2 py-0.5 font-bold">Responsible</th>
                    <th className="px-2 py-0.5 font-bold">Start</th>
                    <th className="px-2 py-0.5 font-bold">Finish</th>
                    <th className="px-2 py-0.5 font-bold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {w.tasks.map((t) => (
                    <tr key={t.wbs} className="border-t border-neutral-200">
                      <td className="px-2 py-0.5">{t.wbs}</td>
                      <td className="px-2 py-0.5">{t.name}</td>
                      <td className="px-2 py-0.5">{t.assignedTo ?? ""}</td>
                      <td className="px-2 py-0.5">{dimensionDate(t.start)}</td>
                      <td className="px-2 py-0.5">{dimensionDate(t.end)}</td>
                      <td className="px-2 py-0.5">
                        {[
                          t.continuing ? "continuing" : null,
                          t.finishing ? "completes this week" : null,
                          t.critical ? "critical" : null,
                          t.pctComplete != null ? `${t.pctComplete}%` : null,
                        ]
                          .filter(Boolean)
                          .join(", ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </div>

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
    <div className="border-b border-neutral-400 bg-[#bdd7ee] py-0.5 text-center text-[11px] font-bold uppercase">
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
