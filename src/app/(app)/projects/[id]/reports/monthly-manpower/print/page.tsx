import Link from "next/link";

import { guardCapability } from "@/lib/roles-server";
import { loadMonthlyManpower } from "@/lib/monthly-manpower-load";
import {
  defaultPeriodMonth,
  incidentTypeLabel,
  periodLabel,
  formDate,
  shortDate,
} from "@/lib/monthly-manpower";

import { PrintButton } from "./print-button";

type Params = { id: string };
type Search = { month?: string };

const isMonth = (s: string | undefined): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-01$/.test(s);

// The backup sheet behind the owner's submission.
//
// The owner's form itself takes five values and keeps none of the working. This
// page is the working: the exact submissions that were keyed, then every day
// and every sub that adds up to the hours figure, then the incidents as
// classified, then what was missing at the time.
//
// That last section is the reason this page exists rather than being a nicer
// copy of the form. A manhours figure is quoted back in safety statistics for
// the life of the project, and "why is September 140 hours lighter than
// August" is asked long after everyone has forgotten that a sub missed three
// DPRs. The gaps are printed with the number, not filed separately.
//
// Deliberately black on white with hard borders rather than the app's theme:
// this is printed, and a muted-foreground grey that reads fine on screen prints
// as illegible.
export default async function MonthlyManpowerPrintPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  await guardCapability("viewDailyProduction");

  const today = new Date().toISOString().slice(0, 10);
  const periodMonth = isMonth(searchParams.month) ? searchParams.month : defaultPeriodMonth(today);
  const view = await loadMonthlyManpower(params.id, periodMonth);
  const incidents = view.incidents.filter((i) => !i.hidden);

  return (
    <div className="mx-auto max-w-[8.5in] bg-white p-6 text-black print:p-0">
      <div className="mb-4 flex items-center justify-between print:hidden">
        <Link
          href={`/projects/${params.id}/reports/monthly-manpower?month=${periodMonth}`}
          className="text-sm underline"
        >
          ← Back to the report
        </Link>
        <PrintButton />
      </div>

      <header className="border-b-2 border-black pb-2">
        <h1 className="text-lg font-bold">Monthly Manpower and Incident Report</h1>
        <p className="text-sm">
          {view.projectName} - {periodLabel(periodMonth)}
        </p>
        <p className="text-xs">
          Period {formDate(view.period.start)} to {formDate(view.period.end)}
          {view.status === "submitted" && view.submittedAt
            ? ` - filed ${formDate(view.submittedAt.slice(0, 10))}`
            : " - draft"}
        </p>
      </header>

      <Section title="Submitted to the owner">
        <table className="w-full border border-black text-xs">
          <tbody>
            {view.submissions.map((s, i) => (
              <tr key={i} className="border-b border-black last:border-0 align-top">
                <th className="w-40 border-r border-black p-1.5 text-left">{s.title}</th>
                <td className="p-1.5">
                  {s.fields.map((f) => (
                    <div key={f.label} className="flex gap-2">
                      <span className="w-44 shrink-0">{f.label}</span>
                      <span className="font-medium">{f.value || "-"}</span>
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="How the hours were arrived at">
        <p className="mb-2 text-xs">{view.hours.basis}</p>
        {view.hours.overridden && (
          <p className="mb-2 border border-black p-1.5 text-xs">
            <strong>Reported {view.hours.reported.toLocaleString()}</strong>, against{" "}
            {view.hours.derived.total.toLocaleString()} derived from the field record.
            {view.hours.note ? ` ${view.hours.note}` : " No reason was recorded."}
          </p>
        )}

        <table className="w-full border border-black text-xs">
          <thead>
            <tr className="border-b border-black text-left">
              <th className="border-r border-black p-1.5">Subcontractor</th>
              <th className="w-20 border-r border-black p-1.5 text-right">Days</th>
              <th className="w-24 p-1.5 text-right">Hours</th>
            </tr>
          </thead>
          <tbody>
            {view.hours.derived.bySub.map((s) => (
              <tr key={s.subcontractorId ?? s.name} className="border-b border-black last:border-0">
                <td className="border-r border-black p-1.5">
                  {s.name}
                  {s.estimated && " (includes an estimated day)"}
                </td>
                <td className="border-r border-black p-1.5 text-right">{s.days}</td>
                <td className="p-1.5 text-right">{s.hours.toLocaleString()}</td>
              </tr>
            ))}
            <tr className="border-t border-black">
              <td className="border-r border-black p-1.5">AHC staff (CM daily log)</td>
              <td className="border-r border-black p-1.5 text-right">
                {view.hours.derived.ahcRecordedDays || "-"}
              </td>
              <td className="p-1.5 text-right">
                {!view.ahcColumnsAvailable
                  ? "not captured"
                  : view.hours.derived.ahcRecordedDays === 0
                    ? "none recorded"
                    : view.hours.derived.ahcHours.toLocaleString()}
              </td>
            </tr>
            <tr className="border-t-2 border-black font-bold">
              <td className="border-r border-black p-1.5">Total</td>
              <td className="border-r border-black p-1.5 text-right">
                {view.hours.derived.daysWorked}
              </td>
              <td className="p-1.5 text-right">{view.hours.derived.total.toLocaleString()}</td>
            </tr>
          </tbody>
        </table>
      </Section>

      <Section title="Day by day">
        <table className="w-full border border-black text-xs">
          <thead>
            <tr className="border-b border-black text-left">
              <th className="w-28 border-r border-black p-1.5">Date</th>
              <th className="border-r border-black p-1.5 text-right">Subs</th>
              <th className="border-r border-black p-1.5 text-right">AHC</th>
              <th className="p-1.5 text-right">Day total</th>
            </tr>
          </thead>
          <tbody>
            {view.hours.derived.perDay.map((d) => (
              <tr key={d.day} className="border-b border-black last:border-0">
                <td className="border-r border-black p-1.5">{shortDate(d.day)}</td>
                <td className="border-r border-black p-1.5 text-right">
                  {d.sub.toLocaleString()}
                </td>
                <td className="border-r border-black p-1.5 text-right">
                  {d.ahcRecorded ? d.ahc.toLocaleString() : "-"}
                </td>
                <td className="p-1.5 text-right">
                  {(d.sub + d.ahc).toLocaleString()}
                  {!d.ahcRecorded && " +"}
                </td>
              </tr>
            ))}
            {view.hours.derived.perDay.length === 0 && (
              <tr>
                <td className="p-1.5" colSpan={4}>
                  No day in the period recorded hours.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {view.hours.derived.perDay.some((d) => !d.ahcRecorded) && (
          <p className="mt-1 text-[10px]">
            A dash in the AHC column means nobody recorded our own hours for that
            day, which is not the same as nobody working. Days marked + are at
            least the figure shown.
          </p>
        )}
      </Section>

      <Section title={`Incidents (${incidents.length})`}>
        {incidents.length === 0 ? (
          <p className="text-xs">
            No incident was flagged on a field report and nothing in the
            period&apos;s notes reads as one.
          </p>
        ) : (
          <table className="w-full border border-black text-xs">
            <thead>
              <tr className="border-b border-black text-left">
                <th className="w-24 border-r border-black p-1.5">Date</th>
                <th className="w-40 border-r border-black p-1.5">Type</th>
                <th className="border-r border-black p-1.5">Description</th>
                <th className="w-40 p-1.5">Source</th>
              </tr>
            </thead>
            <tbody>
              {incidents.map((i) => (
                <tr key={i.key} className="border-b border-black align-top last:border-0">
                  <td className="border-r border-black p-1.5">{shortDate(i.occurredOn)}</td>
                  <td className="border-r border-black p-1.5">
                    {i.types.length
                      ? i.types.map(incidentTypeLabel).join(", ")
                      : "NOT CLASSIFIED"}
                  </td>
                  <td className="border-r border-black p-1.5">{i.description || "-"}</td>
                  <td className="p-1.5">{i.sourceLabel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {(view.hours.gaps.length > 0 || view.excluded.length > 0 || !view.ready) && (
        <Section title="What was missing when this was filed">
          <ul className="list-disc space-y-1 pl-4 text-xs">
            {view.hours.gaps.map((g, i) => (
              <li key={`gap-${i}`}>
                {g.scope === "period" ? "All month" : shortDate(g.day)} - {g.issue}
              </li>
            ))}
            {view.excluded.map((e, i) => (
              <li key={`ex-${i}`}>
                {shortDate(e.day)} - a field report sits at &quot;{e.status}&quot; and was
                excluded, so its hours are not in the total.
              </li>
            ))}
            {!view.ready &&
              view.blockers.map((b, i) => <li key={`bl-${i}`}>{b}</li>)}
          </ul>
        </Section>
      )}

      {view.note && (
        <Section title="Note">
          <p className="whitespace-pre-wrap text-xs">{view.note}</p>
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-4 break-inside-avoid">
      <h2 className="mb-1.5 border-b border-black text-sm font-bold">{title}</h2>
      {children}
    </section>
  );
}
