import Link from "next/link";
import { notFound } from "next/navigation";

import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/server";
import { formatCurrency } from "@/lib/format";
import { can } from "@/lib/roles";
import { getEffectiveRole, guardCapability } from "@/lib/roles-server";
import { loadChangeOrder } from "@/lib/change-order-load";
import { CO_STATUS_LABELS, type CoStatus } from "@/lib/change-order-pricing";

import { DOCUMENT_BUCKET } from "../../documents-constants";
import { CoLineEditor } from "./co-line-editor";
import { CoAttachments } from "./co-attachments";
import { CoBuildupEditor } from "./co-buildup-editor";
import { CoHeaderEdit } from "./co-header-edit";
import { CoWorkflow } from "./co-workflow";
import { ExhibitHPanel } from "./exhibit-h-panel";
import { ResyncTotalsButton } from "./resync-totals-button";

type Params = { id: string; coId: string };

const STATUS_TONE: Record<string, string> = {
  approved: "bg-emerald-100 text-emerald-900",
  submitted: "bg-amber-100 text-amber-900",
  internal_review: "bg-sky-100 text-sky-900",
  rejected: "bg-destructive/10 text-destructive",
  void: "bg-muted text-muted-foreground line-through",
  draft: "bg-muted text-muted-foreground",
};

export default async function ChangeOrderDetailPage({ params }: { params: Params }) {
  await guardCapability("viewChangeOrders");
  const supabase = createClient();

  const data = await loadChangeOrder(supabase, params.coId);
  if (!data) notFound();
  const { co, buildup, exhibitH, events, totalsOutOfSync } = data;

  // CM sees the change order but not AHC's internal cost / profit margin, and
  // not the buildup that exposes what each sub charged.
  const { effective } = await getEffectiveRole();
  const showCosts = can(effective, "viewCosts");

  const { data: sovLines } = await supabase
    .from("billing_lines")
    .select("id, item_number, description, scheduled_value, sort_order")
    .eq("change_order_id", params.coId)
    .order("sort_order", { ascending: true, nullsFirst: false })
    .order("item_number");

  // Backup files live in a private bucket, so hand the client short-lived
  // signed links rather than raw paths.
  const paths = data.attachments.map((a) => a.storagePath);
  const signed =
    paths.length > 0
      ? await supabase.storage.from(DOCUMENT_BUCKET).createSignedUrls(paths, 3600)
      : { data: null };
  const urlByPath = new Map<string, string>();
  (signed.data ?? []).forEach((s, i) => {
    if (s.signedUrl) urlByPath.set(paths[i], s.signedUrl);
  });
  const attachments = data.attachments.map((a) => ({
    ...a,
    signedUrl: urlByPath.get(a.storagePath) ?? null,
  }));
  const coLevelAttachments = attachments.filter((a) => !a.costLineId);

  // A CO is locked once the owner has it, because editing priced scope out
  // from under a submitted number is how the SOV and the signed form drift
  // apart. Locked is not read-only though: every CO on a live job is already
  // approved and most predate the buildup, so the editor offers an explicit
  // unlock rather than making their costs impossible to enter.
  const locked = ["submitted", "approved", "void"].includes(co.status);
  const lockReason = CO_STATUS_LABELS[co.status as CoStatus]?.toLowerCase() ?? co.status;

  const linesWithBackup = new Set(attachments.filter((a) => a.costLineId).map((a) => a.costLineId));
  const linesMissingBackup = buildup.lines.filter((l) => !linesWithBackup.has(l.id)).length;

  const linesTotal = (sovLines ?? []).reduce((s, l) => s + Number(l.scheduled_value ?? 0), 0);

  return (
    <div className="space-y-4">
      <div>
        <Link
          href={`/projects/${params.id}/change-orders`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          &larr; Change orders
        </Link>
        <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{co.coNumber}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {co.description ?? "No description yet"}
            </p>
          </div>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-xs font-medium",
              STATUS_TONE[co.status] ?? "bg-muted",
            )}
          >
            {CO_STATUS_LABELS[co.status as CoStatus] ?? co.status}
          </span>
        </div>
        {showCosts && (
          <div className="mt-2">
            <CoHeaderEdit
              coId={co.id}
              projectId={params.id}
              coNumber={co.coNumber}
              description={co.description}
              dateOfChangeOrder={co.dateOfChangeOrder}
            />
          </div>
        )}
      </div>

      <CoWorkflow
        projectId={params.id}
        changeOrderId={params.coId}
        status={co.status}
        events={events}
        hasLines={buildup.lines.length > 0 || co.coValue > 0}
        linesMissingBackup={linesMissingBackup}
      />

      {totalsOutOfSync && showCosts && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          <span>
            The stored change order value ({formatCurrency(co.coValue)}) does not match the cost
            buildup ({formatCurrency(buildup.billable)}). The buildup is the source of truth.
          </span>
          <ResyncTotalsButton projectId={params.id} changeOrderId={params.coId} />
        </div>
      )}

      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h3 className="text-sm font-semibold">Pricing</h3>
        <div className={cn("mt-3 grid gap-3", showCosts ? "sm:grid-cols-3" : "sm:grid-cols-1")}>
          {showCosts && (
            <PricingCell
              label="Cost (AHC)"
              value={formatCurrency(buildup.lines.length > 0 ? buildup.totalCost : (co.costAmount ?? 0))}
              sub={buildup.lines.length > 0 ? `${buildup.lines.length} cost lines` : "Entered as a lump sum"}
            />
          )}
          {showCosts && (
            <PricingCell
              label="Profit"
              value={
                buildup.lines.length > 0
                  ? `${formatCurrency(buildup.profit)}${buildup.effectiveMarginPct != null ? ` (${buildup.effectiveMarginPct}%)` : ""}`
                  : co.costAmount != null
                    ? formatCurrency(co.coValue - co.costAmount)
                    : "-"
              }
              sub="Markup on cost"
              tone="emerald"
            />
          )}
          <PricingCell
            label="Billable (owner)"
            value={formatCurrency(buildup.lines.length > 0 ? buildup.billable : co.coValue)}
            sub={co.status === "approved" ? "On the SOV, bills next AFP" : "Not yet approved"}
            tone="emerald"
          />
        </div>
      </section>

      {showCosts && (
        <CoBuildupEditor
          projectId={params.id}
          changeOrderId={params.coId}
          lines={buildup.lines}
          attachments={attachments}
          defaultMarkupPct={co.profitPct}
          bondPct={co.bondPct}
          taxPct={co.taxPct}
          locked={locked}
          lockReason={lockReason}
        />
      )}

      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h3 className="text-sm font-semibold">Change order level backup</h3>
        <p className="mb-2 mt-0.5 text-xs text-muted-foreground">
          Owner directives, RFIs, and cover documents that back the whole change order rather than
          one cost line.
        </p>
        <CoAttachments
          projectId={params.id}
          changeOrderId={params.coId}
          costLineId={null}
          attachments={coLevelAttachments}
          defaultKind="directive"
        />
      </section>

      <ExhibitHPanel
        exhibitH={exhibitH}
        coId={co.id}
        projectId={params.id}
        mechDeltaDays={co.mechCompletionDeltaDays}
        substDeltaDays={co.substCompletionDeltaDays}
      />

      {co.notes && (
        <section className="rounded-lg border bg-muted/30 p-3 text-sm">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Notes</div>
          <p className="mt-1 whitespace-pre-wrap">{co.notes}</p>
        </section>
      )}

      <CoLineEditor
        projectId={params.id}
        changeOrderId={params.coId}
        coValue={buildup.lines.length > 0 ? buildup.billable : co.coValue}
        lines={(sovLines ?? []).map((l) => ({
          id: l.id,
          itemNumber: l.item_number,
          description: l.description,
          scheduledValue: Number(l.scheduled_value ?? 0),
        }))}
        linesTotal={linesTotal}
        drift={(buildup.lines.length > 0 ? buildup.billable : co.coValue) - linesTotal}
      />
    </div>
  );
}

function PricingCell({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "emerald";
}) {
  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-0.5 text-xl font-semibold tabular-nums",
          tone === "emerald" && "text-emerald-700",
        )}
      >
        {value}
      </div>
      <div className="text-[10px] text-muted-foreground">{sub}</div>
    </div>
  );
}
