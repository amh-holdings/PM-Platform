import Link from "next/link";
import { notFound } from "next/navigation";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/server";
import { formatCurrency, formatDate } from "@/lib/format";

import { ExtractPoMilestones } from "./extract-po-milestones";
import { MilestoneEditor } from "./milestone-editor";
import { PoSignToggle } from "./sign-toggle";

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

  const [{ data: po, error }, { data: payments }] = await Promise.all([
    supabase
      .from("procurement_orders")
      .select(
        "id, project_id, vendor_name, po_number, description, total_value, ordered_date, expected_delivery_date, actual_delivery_date, status, payment_terms_summary, document_id, notes, signed_at",
      )
      .eq("id", params.poId)
      .maybeSingle(),
    supabase
      .from("procurement_payments")
      .select(
        "id, milestone_name, pct_of_total, trigger_event, expected_date, amount, paid_at, paid_amount, sort_order, notes",
      )
      .eq("procurement_order_id", params.poId)
      .order("sort_order", { ascending: true, nullsFirst: false })
      .order("expected_date", { ascending: true, nullsFirst: false }),
  ]);
  if (error || !po) notFound();

  let linkedDoc: { file_name: string } | null = null;
  if (po.document_id) {
    const { data } = await supabase
      .from("project_documents")
      .select("file_name")
      .eq("id", po.document_id)
      .maybeSingle();
    linkedDoc = data ?? null;
  }

  const milestones = payments ?? [];
  const totalPlanned = milestones.reduce(
    (s, m) => s + Number(m.amount ?? 0),
    0,
  );
  const totalPaid = milestones.reduce(
    (s, m) => s + Number(m.paid_amount ?? 0),
    0,
  );
  const totalPct = milestones.reduce(
    (s, m) => s + Number(m.pct_of_total ?? 0),
    0,
  );
  const poValue = Number(po.total_value ?? 0);
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

      <section className="rounded-lg border bg-card shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
          <div>
            <h3 className="text-sm font-semibold">Milestone payment schedule</h3>
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
          milestones={milestones.map((m) => ({
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
          }))}
        />
      </section>

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
