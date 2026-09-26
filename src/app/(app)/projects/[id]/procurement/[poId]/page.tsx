import Link from "next/link";
import { notFound } from "next/navigation";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { defaultAfpAmountForPo } from "@/lib/billing-progress";
import { createClient } from "@/lib/supabase/server";
import { formatCurrency, formatDate } from "@/lib/format";
import {
  describeMilestoneDate,
  forecastMilestoneDate,
  lineLabel,
  resolveNetTerms,
  scheduleDrivesDate,
} from "@/lib/po-payment-forecast";
import { syncScheduleDates } from "@/lib/schedule-sync-server";

import { AfpStanding } from "./afp-standing";
import { PoLineEditor } from "./po-line-editor";
import { PoLineDeliveries } from "./po-line-deliveries";
import { getPoAfpStanding, getPoLines } from "../../procurement-actions";
import type { PoAfpStanding } from "@/lib/afp-po-staging";
import { BillingAllocations } from "./billing-allocations";
import { DeliveryTaskLink, type DeliveryTaskOption } from "./delivery-task-link";
import { ExtractPoMilestones } from "./extract-po-milestones";
import { MilestoneEditor } from "./milestone-editor";
import { PoSignToggle } from "./sign-toggle";
import { UploadSignedPo } from "./upload-signed-po";

type Params = { id: string; poId: string };

const STATUS_TONE: Record<string, string> = {
  active: "bg-amber-100 text-amber-900",
  complete: "bg-emerald-100 text-emerald-900",
  cancelled: "bg-muted text-muted-foreground",
  delivered: "bg-blue-100 text-blue-900",
};

export default async function ProcurementDetailPage({
  params,
}: {
  params: Params;
}) {
  const supabase = createClient();

  const [
    { data: po, error },
    { data: payments },
    { data: deliveryTasks },
    { data: allocations },
    { data: billingLines },
  ] = await Promise.all([
    supabase
      .from("procurement_orders")
      // "*" rather than a named list: net_terms_days arrives with migration
      // 0063, and PostgREST errors the whole request when a NAMED column is
      // missing while "*" simply returns what exists. This page must not go
      // blank between a deploy and a migration.
      .select("*")
      .eq("id", params.poId)
      .maybeSingle(),
    supabase
      .from("procurement_payments")
      .select("*")
      .eq("procurement_order_id", params.poId)
      .order("sort_order", { ascending: true, nullsFirst: false })
      .order("expected_date", { ascending: true, nullsFirst: false }),
    supabase
      .from("schedule_tasks")
      .select("wbs_code, task_name, start_date, end_date, parent_wbs_code")
      .eq("project_id", params.id)
      .ilike("task_name", "%delivery%")
      .order("wbs_code"),
    supabase
      .from("procurement_order_billing_allocations")
      .select("id, billing_line_id, amount, description, sort_order")
      .eq("procurement_order_id", params.poId)
      .order("sort_order", { ascending: true, nullsFirst: false }),
    supabase
      .from("billing_lines")
      .select("id, item_number, description, scheduled_value, sort_order")
      .eq("project_id", params.id)
      .order("sort_order", { ascending: true, nullsFirst: false })
      .order("item_number"),
  ]);
  if (error || !po) notFound();

  // Build the delivery task options. Use the parent task name (e.g.
  // "Maddox 1500kVA") as the display label since "Delivery" alone isn't
  // useful for picking. Parent name is looked up by parent_wbs_code.
  let deliveryOptions: DeliveryTaskOption[] = [];
  if (deliveryTasks && deliveryTasks.length > 0) {
    const parentCodes = Array.from(
      new Set(deliveryTasks.map((t) => t.parent_wbs_code).filter(Boolean)),
    ) as string[];
    const { data: parents } = parentCodes.length
      ? await supabase
          .from("schedule_tasks")
          .select("wbs_code, task_name")
          .eq("project_id", params.id)
          .in("wbs_code", parentCodes)
      : { data: [] };
    const parentByCode = new Map(
      (parents ?? []).map((p) => [p.wbs_code, p.task_name]),
    );
    deliveryOptions = deliveryTasks.map((t) => ({
      wbsCode: t.wbs_code,
      name: t.task_name,
      startDate: t.start_date,
      endDate: t.end_date,
      parentName: t.parent_wbs_code
        ? (parentByCode.get(t.parent_wbs_code) ?? null)
        : null,
    }));
  }

  // Start and Finish ARE the live forecast, and the column holds whatever the
  // last sync left there. The schedule page and the dashboard both sync before
  // reading; this page did not, so a delivery date here could disagree with
  // the same task on the schedule until somebody opened the schedule. Zarina:
  // "the source of truth should always be the schedule. The forecast does not
  // match what's in the schedule." Sync first, like everywhere else that reads
  // these dates.
  await syncScheduleDates(supabase, params.id);

  // The linked delivery task, read directly rather than picked out of the
  // options above: that list is filtered on the task name containing
  // "delivery", and a PO can be linked to a task called something else.
  let linkedTask: { wbs_code: string; task_name: string | null; end_date: string | null } | null =
    null;
  if (po.linked_delivery_task_wbs_code) {
    const { data } = await supabase
      .from("schedule_tasks")
      .select("wbs_code, task_name, end_date")
      .eq("project_id", params.id)
      .eq("wbs_code", po.linked_delivery_task_wbs_code)
      .maybeSingle();
    linkedTask = data ?? null;
  }

  // Read before the task lookup below, which needs to know which schedule
  // rows the individual items point at.
  const linesRes = await getPoLines(po.id);
  const poLines = linesRes.ok && linesRes.available ? linesRes.lines : [];
  const forecastLines = poLines.map((l) => ({
    id: l.id,
    line_no: l.lineNo,
    description: l.description,
    linked_delivery_task_wbs_code: l.linkedDeliveryTaskWbsCode,
  }));

  // Every schedule row any part of this PO is delivered against: the order's
  // own link, plus one per line for a PO with more than one delivery.
  const lineLinkCodes = Array.from(
    new Set(
      poLines
        .map((l) => l.linkedDeliveryTaskWbsCode)
        .filter((c): c is string => !!c),
    ),
  );
  const taskByWbs = new Map<string, { wbs_code: string; task_name: string | null; end_date: string | null }>();
  if (linkedTask) taskByWbs.set(linkedTask.wbs_code, linkedTask);
  const unresolved = lineLinkCodes.filter((c) => !taskByWbs.has(c));
  if (unresolved.length > 0) {
    const { data } = await supabase
      .from("schedule_tasks")
      .select("wbs_code, task_name, end_date")
      .eq("project_id", params.id)
      .in("wbs_code", unresolved);
    for (const t of data ?? []) taskByWbs.set(t.wbs_code, t);
  }

  let linkedDoc: { file_name: string } | null = null;
  if (po.document_id) {
    const { data } = await supabase
      .from("project_documents")
      .select("file_name")
      .eq("id", po.document_id)
      .maybeSingle();
    linkedDoc = data ?? null;
  }

  // One schedule on the PO: what we pay the vendor. What the OWNER is billed
  // is a different agreement, and rather than recording it a second time here
  // it is typed straight onto the pay application by Add to AFP.
  const milestones = payments ?? [];
  const totalPlanned = milestones.reduce(
    (s, m) => s + Number(m.amount ?? 0),
    0,
  );
  const totalPaid = milestones.reduce(
    (s, m) => s + Number(m.paid_amount ?? 0),
    0,
  );
  const poValue = Number(po.total_value ?? 0);
  // Whether this PO is already on a pay application. Read here rather than
  // inside the button, so the page never renders Add over money that is
  // already staged and then correct itself a moment later.
  const standingRes = await getPoAfpStanding(po.id, params.id);
  const afpStanding: PoAfpStanding = standingRes.ok
    ? standingRes.standing
    : { state: "none" };
  // Share of the PO the schedule covers, taken from the AMOUNTS rather than
  // from pct_of_total. A milestone can carry either, and CAB Solar's carries
  // one of each: 50% on the deposit, a flat $4,985.24 on delivery. Summing
  // only the percentages said "50% of PO" next to "total $8,960.49 of
  // $8,960.49", which reads as half the money being unscheduled when the two
  // milestones cover all of it.
  // Numerics come back from the driver as strings.
  const asEditorRow = (m: (typeof milestones)[number]) => ({
    id: m.id,
    milestone_name: m.milestone_name,
    pct_of_total: m.pct_of_total == null ? null : Number(m.pct_of_total),
    trigger_event: m.trigger_event,
    expected_date: m.expected_date,
    amount: m.amount == null ? null : Number(m.amount),
    paid_at: m.paid_at,
    paid_amount: m.paid_amount == null ? null : Number(m.paid_amount),
    sort_order: m.sort_order,
    notes: m.notes,
    // Read off the row rather than the generated type: the column arrives
    // with migration 0062 and the types are generated from the live database,
    // so until Phil runs it this is simply absent and every milestone pays
    // for the whole order, which is what they all did before.
    procurement_order_line_id:
      (m as { procurement_order_line_id?: string | null })
        .procurement_order_line_id ?? null,
    // Same reasoning, one migration later: net_terms_days arrives with 0064,
    // and until it runs every milestone reads blank and falls back to the
    // PO's number, which is exactly what they all did before.
    net_terms_days:
      (m as { net_terms_days?: number | null }).net_terms_days ?? null,
    // What date this row actually runs on, and where it came from. When the
    // schedule supplies it, it IS the Expected value and the typed date is
    // demoted - see scheduleDrivesDate. Printing the typed date as the
    // headline with the real one in grey underneath left the reader to pick.
    forecast: (() => {
      const at = forecastMilestoneDate({
        milestone: m,
        po,
        deliveryTask: linkedTask,
        // A PO with more than one delivery links each item to its own
        // schedule row, and a milestone says which item it pays for.
        lines: forecastLines,
        taskOf: (wbs) => taskByWbs.get(wbs) ?? null,
      });
      return {
        date: at.date,
        drives: scheduleDrivesDate(at),
        note: describeMilestoneDate(at, linkedTask?.task_name ?? null),
      };
    })(),
  });

  const totalPct = poValue > 0 ? (totalPlanned / poValue) * 100 : 0;
  const drift = poValue > 0 ? totalPlanned - poValue : 0;

  return (
    <div className="space-y-4">
      <div>
        <Link
          href={`/projects/${params.id}/procurement`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          &larr; Procurement
        </Link>
        <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{po.vendor_name}</h2>
            {po.description && (
              <p className="text-xs text-muted-foreground">{po.description}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                STATUS_TONE[po.status ?? ""] ?? "bg-muted",
              )}
            >
              {po.status}
            </span>
            <AfpStanding
              poId={po.id}
              projectId={params.id}
              poTotalValue={Number(po.total_value ?? 0)}
              standing={afpStanding}
              variant="outline"
            />
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${params.id}/procurement/${po.id}/edit`}>
                Edit
              </Link>
            </Button>
          </div>
        </div>
      </div>

      <PoSignToggle
        poId={po.id}
        projectId={params.id}
        signedAt={po.signed_at}
      />

      <UploadSignedPo
        poId={po.id}
        projectId={params.id}
        hasExistingDoc={Boolean(po.document_id)}
        isSigned={Boolean(po.signed_at)}
      />

      <DeliveryTaskLink
        poId={po.id}
        projectId={params.id}
        currentWbs={po.linked_delivery_task_wbs_code}
        currentEndDate={po.expected_delivery_date}
        options={deliveryOptions}
      />

      <section className="grid gap-3 sm:grid-cols-4">
        <SmallCell label="PO #" value={po.po_number ?? "-"} mono />
        <SmallCell label="PO value" value={formatCurrency(poValue)} mono />
        <SmallCell
          label="Expected delivery"
          value={po.expected_delivery_date ? formatDate(po.expected_delivery_date) : "-"}
        />
        <SmallCell
          label="Actual delivery"
          value={po.actual_delivery_date ? formatDate(po.actual_delivery_date) : "-"}
        />
      </section>

      {po.payment_terms_summary && (
        <section className="rounded-lg border bg-muted/30 p-3 text-sm">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Payment terms (summary)
          </div>
          <p className="mt-1">{po.payment_terms_summary}</p>
        </section>
      )}

      {linkedDoc && (
        <section className="rounded-lg border bg-card p-3 text-xs">
          <span className="font-medium">Linked contract: </span>
          <Link
            href={`/projects/${params.id}/documents`}
            className="text-blue-600 underline-offset-2 hover:underline"
          >
            {linkedDoc.file_name}
          </Link>
        </section>
      )}

      {/* What the PO buys, line by line. Above the payment terms because the
          scope is what the terms are terms ON, which is the order the paper
          form puts them in too. */}
      <PoLineEditor
        poId={po.id}
        projectId={params.id}
        poValue={poValue}
        lines={linesRes.ok ? linesRes.lines : []}
        salesTax={linesRes.ok ? linesRes.salesTax : null}
        freight={linesRes.ok ? linesRes.freight : null}
        available={linesRes.ok ? linesRes.available : false}
      />

      {/* Directly under the items, because it is a column on the same table
          that would not fit on it. Zarina: "there are POs that has multiple
          deliveries on it. And each item inside a PO can be linked to a line
          in the schedule." */}
      <PoLineDeliveries
        poId={po.id}
        projectId={params.id}
        lines={poLines}
        options={deliveryOptions}
        poTaskWbs={po.linked_delivery_task_wbs_code ?? null}
      />

      <section className="rounded-lg border bg-card shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
          <div>
            <h3 className="text-sm font-semibold">Vendor payment terms</h3>
            <p className="text-xs text-muted-foreground">
              {milestones.length} milestone{milestones.length === 1 ? "" : "s"}
              {" - "}
              total {formatCurrency(totalPlanned)} of {formatCurrency(poValue)}
              {totalPct > 0 && ` (${totalPct.toFixed(0)}% of PO)`}
              {Math.abs(drift) > 1 && (
                <span className="ml-2 text-amber-600">
                  drift {drift > 0 ? "+" : ""}
                  {formatCurrency(drift)}
                </span>
              )}
            </p>
          </div>
          <div className="text-right text-xs">
            <div className="text-muted-foreground">Paid to date</div>
            <div className="font-semibold text-emerald-700">
              {formatCurrency(totalPaid)}
            </div>
          </div>
        </div>

        <ExtractPoMilestones
          poId={params.poId}
          projectId={params.id}
          poTotalValue={poValue}
          hasLinkedDocument={Boolean(po.document_id)}
        />

        <MilestoneEditor
          projectId={params.id}
          poId={params.poId}
          poTotalValue={poValue}
          // What the PO says, for the rows that say nothing themselves. Net
          // terms moved onto the milestone with 0064; this is the fallback
          // the forecast uses and the number a new row opens on.
          poNetTerms={resolveNetTerms(po)}
          milestones={milestones.map(asEditorRow)}
          lines={poLines.map((l) => ({
            id: l.id,
            label: lineLabel({ line_no: l.lineNo, description: l.description }),
          }))}
        />
      </section>

      {/* The button is also in the header, where somebody who knows it exists
          will look for it. Nobody found it there: this page runs several
          screens and the header scrolls away long before the money does.
          Zarina, on the header-only version: "I do not see any buttons."

          So it is here too, in the flow, directly under what we pay the vendor
          and directly above what the owner is billed against. Two entry points
          to one dialog. */}
      <section className="rounded-lg border-2 border-emerald-300 bg-emerald-50/60 p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-emerald-900">
              Bill the owner for this PO
            </h3>
            <p className="mt-1 max-w-xl text-xs text-emerald-900/80">
              The vendor terms above are what we pay. This is what goes on the
              pay application, and it does not have to match.
              {afpStanding.state === "none" ? (
                <>
                  {" "}Opens on{" "}
                  <span className="font-mono font-medium">
                    {formatCurrency(defaultAfpAmountForPo(poValue))}
                  </span>
                  , half the PO, and you can change it.
                </>
              ) : (
                <>
                  {" "}This PO is already on one, so there is nothing to add
                  until it comes back off.
                </>
              )}
            </p>
          </div>
          <AfpStanding
            poId={po.id}
            projectId={params.id}
            poTotalValue={poValue}
            standing={afpStanding}
            size="default"
          />
        </div>
      </section>

      <BillingAllocations
        poId={po.id}
        projectId={params.id}
        poTotalValue={poValue}
        poDescription={po.description}
        allocations={(allocations ?? []).map((a) => ({
          id: a.id,
          billingLineId: a.billing_line_id,
          amount: Number(a.amount),
          description: a.description,
          sortOrder: a.sort_order,
        }))}
        billingLines={(billingLines ?? []).map((l) => ({
          id: l.id,
          itemNumber: l.item_number,
          description: l.description,
          totalValue: Number(l.scheduled_value ?? 0),
        }))}
      />

      {po.notes && (
        <section className="rounded-lg border bg-muted/30 p-3 text-sm">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Notes
          </div>
          <p className="mt-1 whitespace-pre-wrap">{po.notes}</p>
        </section>
      )}
    </div>
  );
}

function SmallCell({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className={cn("mt-1 text-sm", mono && "font-mono")}>{value}</div>
    </div>
  );
}
