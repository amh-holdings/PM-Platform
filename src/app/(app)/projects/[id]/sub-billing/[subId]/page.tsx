import Link from "next/link";
import { notFound } from "next/navigation";

import { Button } from "@/components/ui/button";
import { formatCurrency, formatDate } from "@/lib/format";
import { can } from "@/lib/roles";
import { getEffectiveRole, guardCapability } from "@/lib/roles-server";
import { projectNextBill, type Evidence, type SovLine } from "@/lib/sub-billing";
import { loadEvidence } from "@/lib/sub-billing-run";
import { sovTotals } from "@/lib/sub-sov-totals";
import { describeBasis } from "@/lib/weekly-schedule-basis";
import { dayBefore, resolveRange } from "@/lib/sub-billing-cutoff";
import { subBillingClient } from "@/lib/sub-billing-db";
import { cn } from "@/lib/utils";

import { METHOD_LABEL, STATUS_LABEL, STATUS_TONE } from "../constants";
import { MappingRow } from "./mapping-row";
import { SovEditor } from "./sov-editor";
import { SubRetainage } from "./sub-retainage";

type Params = { id: string; subId: string };
type Search = { from?: string; through?: string };

export default async function SubBillingDetailPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  await guardCapability("verifySubBilling");
  const { effective } = await getEffectiveRole();
  const showDollars = can(effective, "viewSubBillingDollars");
  // The SOV carries scheduled values, so editing it sits with the same
  // capability as entering a bill rather than with percent-only verification.
  const canEditSov = can(effective, "enterSubBill");
  const db = subBillingClient();

  const { data: sub } = await db
    .from("subcontractors")
    .select("id, company_name, trade, contract_value, retainage_pct, payment_terms, payment_terms_days, coi_status, w9_status")
    .eq("id", params.subId)
    .single();
  if (!sub) notFound();

  const [{ data: sovRows }, { data: appRows }, { data: taskRows }, { data: commodityRows }] =
    await Promise.all([
      db.from("sub_sov_lines").select("*").eq("subcontractor_id", params.subId).eq("active", true).order("sort_order"),
      db.from("sub_pay_apps").select("*").eq("subcontractor_id", params.subId).order("app_number", { ascending: false }),
      db.from("schedule_tasks").select("wbs_code, task_name, status, pct_complete, start_date, end_date, duration_days").eq("project_id", params.id).order("wbs_code"),
      db.from("commodities").select("id, label, uom, total_quantity").eq("project_id", params.id).eq("active", true).order("sort_order"),
    ]);

  const sovLines = sovRows ?? [];
  const apps = appRows ?? [];
  const tasks = taskRows ?? [];
  const commodities = commodityRows ?? [];

  // Billed-to-date per line, from the most recent application on record.
  const latest = apps[0];
  let billedByItem = new Map<string, number>();
  if (latest) {
    const { data: latestLines } = await db
      .from("sub_pay_app_lines")
      .select("item_number, total_completed")
      .eq("sub_pay_app_id", latest.id);
    billedByItem = new Map((latestLines ?? []).map((l) => [l.item_number, Number(l.total_completed ?? 0)]));
  }

  // ---- Next-bill projection, as of the chosen cut-off ----
  // loadEvidence is the same function that verifies a recorded bill at its own
  // period end, so what this panel projects and what the review screen checks
  // are computed one way. It sums production only up to the cut-off and reads
  // the schedule from the snapshot saved at the time.
  const todayIso = new Date().toISOString().slice(0, 10);
  const { from, to: through } = resolveRange(
    searchParams.from,
    searchParams.through,
    todayIso,
  );

  const evidence: Evidence = await loadEvidence(db, params.id, through, params.subId);

  // With a window, the table also answers what was earned INSIDE it. That is
  // the figure a sub's bill for a stated period should match, and it is not
  // the same as earned-to-date less already-billed: a bill can cover work the
  // sub has not billed for from an earlier period, and the difference between
  // the two is exactly what a dispute is about.
  //
  // Measured as the day before the window opens, so the first day of the
  // window counts as inside it.
  const openingEvidence = from
    ? await loadEvidence(db, params.id, dayBefore(from), params.subId)
    : null;

  const projection = projectNextBill({
    sovLines: sovLines as unknown as SovLine[],
    billedToDateByItem: billedByItem,
    evidenceAtPeriodEnd: evidence,
    retainagePct: Number(sub.retainage_pct ?? 0),
  });

  // The same projection at the opening of the window. Billed-to-date plays no
  // part in projectedToDate, so an empty map keeps it clear that only the
  // evidence date differs between the two runs.
  const opening = openingEvidence
    ? projectNextBill({
        sovLines: sovLines as unknown as SovLine[],
        billedToDateByItem: new Map<string, number>(),
        evidenceAtPeriodEnd: openingEvidence,
        retainagePct: Number(sub.retainage_pct ?? 0),
      })
    : null;
  const openingByItem = new Map(
    (opening?.lines ?? []).map((l) => [l.itemNumber, l.projectedToDate ?? 0]),
  );
  // Floored at zero. Evidence does not go backwards in any honest reading, and
  // a negative "earned this period" would be a correction to an earlier
  // figure rather than work done in the window.
  const earnedInWindow = (itemNumber: string, toDate: number | null) =>
    Math.max(0, (toDate ?? 0) - (openingByItem.get(itemNumber) ?? 0));
  const windowTotal = from
    ? Math.round(
        projection.lines.reduce(
          (sum, l) => sum + earnedInWindow(l.itemNumber, l.projectedToDate),
          0,
        ) * 100,
      ) / 100
    : 0;
  // Rows worth showing. Expect to bill alone was the wrong filter once a
  // window existed: a line the sub has already billed past hides, even when
  // the field record says work happened inside the window. On Pyramid's AFP 3
  // that silently dropped 2.04 and 3.01, the two lines carrying most of the
  // bill, from the one table meant to explain it.
  const projectedLines = projection.lines.filter(
    (l) =>
      l.projectedThisPeriod > 0 ||
      (from != null && earnedInWindow(l.itemNumber, l.projectedToDate) > 0),
  );
  const unprojectable = projection.lines.filter((l) => l.projectedPctAtPeriodEnd == null);
  // Why a line cannot be projected decides what to do about it, and the two
  // causes need opposite actions. "No evidence source mapped" means go and map
  // it. "CM sign-off" means it is mapped correctly and a person sets the
  // percent at review - there is nothing to fix. Lumping them together sent
  // Zarina looking for four missing mappings on an SOV whose own header says
  // all nineteen lines have a source.
  const methodByItem = new Map(
    sovLines.map((l) => [l.item_number, l.verification_method as string]),
  );
  const needsMapping = unprojectable.filter(
    (l) => methodByItem.get(l.itemNumber) === "unmapped",
  );
  const needsCmPercent = unprojectable.filter(
    (l) => methodByItem.get(l.itemNumber) === "manual",
  );

  const unmapped = sovLines.filter((l) => l.verification_method === "unmapped").length;
  // The SOV is what every percentage is priced against, so a total that does
  // not match the executed contract value is worth saying out loud rather than
  // leaving for someone to notice at approval time.
  //
  // Measured against the BASE lines. A change order raises the contract; it
  // does not break the reconciliation, and before this the first CO line added
  // to a sub tripped the warning for doing exactly what it is for.
  const contractValue = Number(sub.contract_value ?? 0);
  const totals = sovTotals(sovLines, contractValue);
  const sovTotal = totals.revised;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href={`/projects/${params.id}/sub-billing`} className="text-xs text-muted-foreground underline-offset-2 hover:underline">
            Sub billing
          </Link>
          <h2 className="text-lg font-semibold">{sub.company_name}</h2>
          <p className="text-xs text-muted-foreground">
            {sub.trade} · {sub.retainage_pct}% retainage
            {sub.payment_terms ? ` · ${sub.payment_terms}` : ""}
            {sub.payment_terms_days != null &&
              sub.payment_terms &&
              !sub.payment_terms.replace(/\D/g, "").includes(String(sub.payment_terms_days)) && (
                <span className="ml-2 rounded bg-amber-100 px-2 py-0.5 font-medium text-amber-900">
                  Terms conflict: record says Net {sub.payment_terms_days}
                </span>
              )}
          </p>
        </div>
        {can(effective, "enterSubBill") && sovLines.length > 0 && (
          <Button asChild>
            <Link href={`/projects/${params.id}/sub-billing/${params.subId}/new`}>Record a bill</Link>
          </Button>
        )}
      </div>

      {/* ---------------------------- Next bill ---------------------------- */}
      {/* Nothing to project against until an SOV exists, and "no earned work"
          would read as a field-record finding rather than a missing SOV. */}
      {sovLines.length > 0 && (
      <section className="space-y-2 rounded-md border bg-card p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">What we expect on the next bill</h3>
          {/* A plain GET form so the cut-off survives a reload and a shared
              link, and so this works with no client JavaScript on it. Any
              date, because a sub bills through whatever date they bill
              through - Pyramid's app 1 ends on the 13th - and a picker that
              cannot express that cannot check the bill that was sent. */}
          <form method="get" className="flex flex-wrap items-end gap-2">
            {/* From is optional and stays optional. Left empty the table reads
                cumulative to the end date, which is still the right view when
                the question is what the NEXT bill should come to. Filled in,
                it also answers what was earned between the two, which is what
                a bill covering a stated period has to match. */}
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground" htmlFor="from">
                Period from
              </label>
              <input
                type="date"
                id="from"
                name="from"
                defaultValue={from ?? ""}
                max={through}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted-foreground" htmlFor="through">
                {from ? "Period to" : "Evidence as of"}
              </label>
              <input
                type="date"
                id="through"
                name="through"
                defaultValue={through}
                // Nothing to show after today, and a future cut-off would read
                // as a projection of work nobody has reported.
                max={todayIso}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              />
            </div>
            <Button type="submit" variant="outline" size="sm" className="h-8">
              Apply
            </Button>
            {(through !== todayIso || from) && (
              <Link
                href={`/projects/${params.id}/sub-billing/${params.subId}`}
                className="h-8 self-end text-xs text-muted-foreground underline-offset-2 hover:underline"
              >
                Back to today
              </Link>
            )}
          </form>
        </div>

        {/* Production is summed to the cut-off, so a commodity-mapped line is
            exact on any date. The schedule is one column holding today's
            number unless a snapshot was saved, so say which was used rather
            than imply a precision that is not there. */}
        {(through !== todayIso || from) && (
          describeBasis(evidence.scheduleAsOf ?? { kind: "live" }) || from
        ) && (
          <p
            className={cn(
              "rounded-md border px-2 py-1.5 text-xs",
              evidence.scheduleAsOf?.kind === "stale"
                ? "border-amber-300 bg-amber-50 text-amber-800"
                : "border-muted bg-muted/40 text-muted-foreground",
            )}
          >
            {from
              ? `Quantities are counted from ${formatDate(from)} to ${formatDate(through)}.`
              : `Quantities are summed through ${formatDate(through)}.`}{" "}
            {describeBasis(evidence.scheduleAsOf ?? { kind: "live" })}
          </p>
        )}

        {/* Two halves of this table age differently and only one of them said
            so. Earned % is recomputed from the field record on every load, so
            it is always current. Already billed is read from the newest bill
            RECORDED HERE, and a bill the sub has sent that nobody has entered
            makes every Expect to bill figure too high by the amount of it.
            Zarina, looking at the panel: "Is this up to date?" - which the
            page should answer without anyone reading the code. */}
        {latest ? (
          <p className="text-xs text-muted-foreground">
            Already billed is read from app {latest.app_number}
            {latest.period_end ? `, period ending ${formatDate(latest.period_end)}` : ""}
            {latest.invoice_number ? `, invoice ${latest.invoice_number}` : ""}. If{" "}
            {sub.company_name} has billed since, record it first - until then
            Expect to bill counts that work again.
          </p>
        ) : (
          <p className="text-xs text-amber-800">
            No bill has been recorded for {sub.company_name}, so Already billed
            reads zero on every line and Expect to bill is the whole of what the
            field record says is earned.
          </p>
        )}

        {projectedLines.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing is projected. {unmapped > 0
              ? `${unmapped} of ${sovLines.length} SOV lines have no evidence source mapped, so no percentage can be computed for them.`
              : "The field record shows no earned work beyond what has already been billed."}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Item</th>
                    <th className="px-3 py-2">Description</th>
                    <th className="px-3 py-2 text-right">Earned %</th>
                    {/* Only with a window, and placed before the cumulative
                        columns: it is the figure a bill for that period has to
                        match, so it should be the first number read. */}
                    {showDollars && from && (
                      <th className="px-3 py-2 text-right">Earned in period</th>
                    )}
                    {showDollars && <th className="px-3 py-2 text-right">Already billed</th>}
                    {showDollars && <th className="px-3 py-2 text-right">Expect to bill</th>}
                    <th className="px-3 py-2">Basis</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {projectedLines.map((l) => (
                    <tr key={l.itemNumber}>
                      <td className="px-3 py-2 tabular-nums">{l.itemNumber}</td>
                      <td className="px-3 py-2">{l.description}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {((l.projectedPctAtPeriodEnd ?? 0) * 100).toFixed(1)}%
                      </td>
                      {showDollars && from && (
                        <td className="px-3 py-2 text-right font-medium tabular-nums">
                          {formatCurrency(earnedInWindow(l.itemNumber, l.projectedToDate))}
                        </td>
                      )}
                      {showDollars && (
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                          {formatCurrency(l.billedToDate)}
                        </td>
                      )}
                      {showDollars && (
                        <td className="px-3 py-2 text-right font-medium tabular-nums">
                          {formatCurrency(l.projectedThisPeriod)}
                        </td>
                      )}
                      <td className="px-3 py-2 text-xs text-muted-foreground">{l.basis}</td>
                    </tr>
                  ))}
                </tbody>
                {showDollars && (
                  <tfoot className="border-t-2 bg-muted/30 font-medium">
                    {from && (
                      <tr>
                        <td className="px-3 py-2" colSpan={from ? 5 : 4}>
                          Earned {formatDate(from)} to {formatDate(through)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatCurrency(windowTotal)}
                        </td>
                        <td />
                      </tr>
                    )}
                    <tr>
                      <td className="px-3 py-2" colSpan={from ? 5 : 4}>
                        Projected gross
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(projection.grossTotal)}</td>
                      <td />
                    </tr>
                    <tr>
                      <td className="px-3 py-2" colSpan={from ? 5 : 4}>
                        Less {sub.retainage_pct}% retainage
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">({formatCurrency(projection.retainage)})</td>
                      <td />
                    </tr>
                    <tr>
                      <td className="px-3 py-2" colSpan={from ? 5 : 4}>
                        Expected amount due
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(projection.netDue)}</td>
                      <td />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            {needsMapping.length > 0 && (
              <p className="text-xs text-amber-800">
                {needsMapping.length} line{needsMapping.length === 1 ? "" : "s"} could not be
                projected because no evidence source is mapped. Anything the sub bills on
                those lines will arrive unverified.
              </p>
            )}
            {needsCmPercent.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {needsCmPercent.length} line{needsCmPercent.length === 1 ? "" : "s"} are set to
                CM sign-off, so they are not projected here. Nothing to fix - the
                percent is entered when the bill is reviewed.
              </p>
            )}
          </>
        )}
      </section>
      )}

      {/* ------------------------- Bill history --------------------------- */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Bills received</h3>
        {apps.length === 0 ? (
          <p className="text-sm text-muted-foreground">No bills recorded yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">App</th>
                  <th className="px-3 py-2">Period covered</th>
                  <th className="px-3 py-2">Invoice</th>
                  {showDollars && <th className="px-3 py-2 text-right">Billed</th>}
                  {showDollars && <th className="px-3 py-2 text-right">Approved</th>}
                  {showDollars && <th className="px-3 py-2 text-right">Amount due</th>}
                  <th className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {apps.map((a) => (
                  <tr key={a.id} className="hover:bg-muted/30">
                    <td className="px-3 py-2">
                      <Link
                        className="font-medium underline-offset-2 hover:underline"
                        href={`/projects/${params.id}/sub-billing/${params.subId}/${a.id}`}
                      >
                        #{a.app_number}
                      </Link>
                    </td>
                    {/* Both ends, not just the finish. "Period end" alone
                        cannot answer what a bill covers, which is the first
                        thing anyone checks before approving one. period_start
                        is nullable on purpose - these subs bill "through
                        <date>" as often as they bill a calendar month (0038) -
                        so a missing start is said as "through" rather than
                        guessed at. */}
                    <td className="px-3 py-2">
                      {a.period_start
                        ? `${formatDate(a.period_start)} - ${formatDate(a.period_end)}`
                        : `through ${formatDate(a.period_end)}`}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{a.invoice_number ?? "-"}</td>
                    {showDollars && (
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatCurrency(Number(a.billed_this_period ?? 0))}
                      </td>
                    )}
                    {showDollars && (
                      <td className="px-3 py-2 text-right tabular-nums">
                        {a.approved_this_period != null
                          ? formatCurrency(Number(a.approved_this_period))
                          : "-"}
                      </td>
                    )}
                    {showDollars && (
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatCurrency(Number(a.approved_amount_due ?? a.amount_due ?? 0))}
                      </td>
                    )}
                    <td className="px-3 py-2">
                      <span className={cn("rounded px-2 py-0.5 text-xs font-medium", STATUS_TONE[a.status])}>
                        {STATUS_LABEL[a.status] ?? a.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* -------------------- SOV and evidence mapping --------------------- */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">Executed schedule of values</h3>
          <span className="text-xs text-muted-foreground">
            {sovLines.length} lines
            {showDollars
              ? totals.changeOrderCount > 0
                ? ` \u00b7 ${formatCurrency(totals.base)} base + ${formatCurrency(totals.changeOrders)} in ${totals.changeOrderCount} change order${totals.changeOrderCount === 1 ? "" : "s"} = ${formatCurrency(totals.revised)}`
                : ` \u00b7 ${formatCurrency(totals.revised)}`
              : ""}
            {/* "all mapped" meant "every line has an evidence source", and it
                was read as "the cash flow has these". Two different columns
                wear the word mapping: verification_method proves the percent,
                linked_task_wbs_codes gives it a date. Lumina's seven lines
                were mapped for evidence, read all mapped here, and sat outside
                the forecast. The label now says which one it means. */}
            {sovLines.length > 0 &&
              (unmapped > 0
                ? ` \u00b7 ${unmapped} with no evidence source`
                : " \u00b7 all have an evidence source")}
          </span>
        </div>

        {showDollars &&
          sovLines.length > 0 &&
          totals.variance != null &&
          Math.abs(totals.variance) >= 0.01 && (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              The base SOV lines total {formatCurrency(totals.base)} against a contract
              value of {formatCurrency(contractValue)}, a difference of{" "}
              {formatCurrency(Math.abs(totals.variance))}
              {totals.variance > 0 ? " over" : " under"}. Every percentage on this page is
              priced off the SOV, so the two should tie out before a bill is approved.
              {totals.changeOrderCount > 0 &&
                " Change order lines are excluded from this check - they raise the contract rather than break it."}
            </p>
          )}

        {/* The rate is priced against the SOV, so it lives with the SOV
            rather than in a dialog on another page. Zarina: "Can you add
            option to add retainage to subs SOVs." */}
        {canEditSov && (
          <SubRetainage
            projectId={params.id}
            subcontractorId={params.subId}
            pct={Number(sub.retainage_pct ?? 0)}
            sovTotal={sovTotal}
            showDollars={showDollars}
          />
        )}

        {canEditSov && (
          <SovEditor
            projectId={params.id}
            subcontractorId={params.subId}
            hasLines={sovLines.length > 0}
          />
        )}

        {sovLines.length === 0 ? (
          <p className="rounded-md border bg-card p-4 text-sm text-muted-foreground">
            No schedule of values has been loaded for {sub.company_name}.
            {canEditSov
              ? " Paste the executed SOV above, then map each line to the schedule tasks or commodities that prove it. Bills cannot be recorded until the SOV is in."
              : " Bills cannot be recorded against this subcontractor until one is loaded."}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Item</th>
                  <th className="px-3 py-2">Description</th>
                  {showDollars && <th className="px-3 py-2 text-right">Scheduled value</th>}
                  {showDollars && <th className="px-3 py-2 text-right">Billed to date</th>}
                  <th className="px-3 py-2">Verified by</th>
                  <th className="px-3 py-2">Evidence</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {sovLines.map((l) => (
                  <MappingRow
                    key={l.id}
                    projectId={params.id}
                    line={{
                      id: l.id,
                      item_number: l.item_number,
                      description: l.description,
                      scheduled_value: Number(l.scheduled_value ?? 0),
                      section_name: l.section_name,
                      quantity: l.quantity == null ? null : Number(l.quantity),
                      unit: l.unit,
                      is_change_order: l.is_change_order,
                      change_order_ref: l.change_order_ref,
                      verification_method: l.verification_method,
                      linked_task_wbs_codes: l.linked_task_wbs_codes ?? [],
                      linked_commodity_ids: l.linked_commodity_ids ?? [],
                      milestone_task_wbs_code: l.milestone_task_wbs_code,
                      mapping_notes: l.mapping_notes,
                      mapping_confirmed_at: l.mapping_confirmed_at,
                    }}
                    billedToDate={billedByItem.get(l.item_number) ?? 0}
                    showDollars={showDollars}
                    canEditLine={canEditSov}
                    methodLabel={METHOD_LABEL[l.verification_method] ?? l.verification_method}
                    tasks={tasks.map((t) => ({ wbs_code: t.wbs_code, task_name: t.task_name ?? "" }))}
                    commodities={commodities.map((c) => ({ id: c.id, label: c.label ?? "" }))}
                  />
                ))}
              </tbody>
              {showDollars && (
                <tfoot className="border-t-2 bg-muted/30 font-medium">
                  {/* Split only once there is something to split. On a sub
                      with no change orders a single total is the clearer
                      statement. */}
                  {totals.changeOrderCount > 0 && (
                    <>
                      <tr className="font-normal text-muted-foreground">
                        <td className="px-3 py-2" colSpan={2}>
                          Base contract lines
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatCurrency(totals.base)}
                        </td>
                        <td colSpan={4} />
                      </tr>
                      <tr className="font-normal text-muted-foreground">
                        <td className="px-3 py-2" colSpan={2}>
                          Change orders ({totals.changeOrderCount})
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatCurrency(totals.changeOrders)}
                        </td>
                        <td colSpan={4} />
                      </tr>
                    </>
                  )}
                  <tr>
                    <td className="px-3 py-2" colSpan={2}>
                      {totals.changeOrderCount > 0 ? "Revised SOV total" : "SOV total"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(sovTotal)}</td>
                    <td colSpan={4} />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </section>

    </div>
  );
}
