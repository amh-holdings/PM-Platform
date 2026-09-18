import Link from "next/link";
import { notFound } from "next/navigation";

import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/server";
import { formatCurrency } from "@/lib/format";
import { can } from "@/lib/roles";
import { getEffectiveRole, guardCapability } from "@/lib/roles-server";
import { coClient } from "@/lib/database.types.co";
import { loadChangeOrder } from "@/lib/change-order-load";
import {
  CO_STATUS_LABELS,
  CONTRACT_MARKUP_PCT,
  coApprovalBlocker,
  type CoStatus,
} from "@/lib/change-order-pricing";

import { compareItemNumbers } from "@/lib/project-financials";

import { DOCUMENT_BUCKET } from "../../documents-constants";
import { CoLineEditor } from "./co-line-editor";
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

  const [
    { data: projectRow },
    { data: sovLines },
    { data: allSovLines },
    { data: coNumbers },
  ] = await Promise.all([
    coClient(supabase)
      .from("projects")
      // "*" so this page still renders on a database where migration 0052
      // has not run. PostgREST errors on a named column it cannot find.
      .select("*")
      .eq("id", params.id)
      .maybeSingle(),
    supabase
      .from("billing_lines")
      .select("id, item_number, description, scheduled_value, sort_order")
      .eq("change_order_id", params.coId)
      .order("sort_order", { ascending: true, nullsFirst: false })
      .order("item_number"),
    // EVERY SOV line on the project, not only the unlinked ones.
    //
    // A CO billed on paper before the app existed already has its line on the
    // sheet - what is missing is the link, not the money, and adding a second
    // line is how the SOV outgrows the contract. So the picker offers the
    // unlinked lines.
    //
    // But a line missing from that list has two very different explanations -
    // it does not exist, or it is already linked to another change order - and
    // an absence cannot tell you which. Showing the linked ones too, greyed and
    // naming the CO that holds them, turns "14.00 is missing" into "14.00 is on
    // CO-04".
    //
    // Ordered in JS, not here. Postgres sorts item_number as text, which puts
    // "10.00" before "9.00". See compareItemNumbers.
    supabase
      .from("billing_lines")
      .select("id, item_number, description, scheduled_value, change_order_id")
      .eq("project_id", params.id)
      .limit(2000),
    supabase
      .from("change_orders")
      .select("id, co_number")
      .eq("project_id", params.id),
  ]);

  // The whole SOV, each line saying whether a change order already holds it.
  const coNumberById = new Map((coNumbers ?? []).map((c) => [c.id, c.co_number]));
  const sovPicker = (allSovLines ?? [])
    .map((l) => ({
      id: l.id,
      itemNumber: l.item_number,
      description: l.description,
      scheduledValue: Number(l.scheduled_value ?? 0),
      // null on this CO's own lines too: they are already in the table above,
      // so offering them again would be noise.
      linkedTo:
        l.change_order_id == null
          ? null
          : coNumberById.get(l.change_order_id) ?? "another change order",
    }))
    .sort((a, b) => compareItemNumbers(a.itemNumber, b.itemNumber));

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

  // A legacy-priced CO reports the numbers it was executed with, never the
  // buildup's. Its lines are reference detail entered after the fact, and
  // re-deriving a contract price from them would contradict a signed form.
  const useBuildupTotals = !co.legacyPricing && buildup.lines.length > 0;
  const ownerValue = useBuildupTotals ? buildup.billable : co.coValue;

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
        coNumber={co.coNumber}
        approvalBlocker={coApprovalBlocker({
          hasCostLines: buildup.lines.length > 0,
          coValue: co.coValue,
          mechCompletionDeltaDays: co.mechCompletionDeltaDays,
          substCompletionDeltaDays: co.substCompletionDeltaDays,
        })}
        linesMissingBackup={linesMissingBackup}
      />

      {co.legacyPricing && showCosts && (
        <div className="rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
          Priced before the app, under the old per-line markup. Its value of{" "}
          {formatCurrency(co.coValue)} is the executed number and is frozen - editing the buildup
          below records cost detail but will not re-price the change order or its SOV line.
          Change orders priced in the app carry one {CONTRACT_MARKUP_PCT}% markup on the cost
          total, per the contract.
        </div>
      )}

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
              value={formatCurrency(useBuildupTotals ? buildup.totalCost : (co.costAmount ?? 0))}
              sub={
                co.legacyPricing
                  ? "As executed"
                  : buildup.lines.length > 0
                    ? `${buildup.lines.length} cost lines`
                    : "Entered as a lump sum"
              }
            />
          )}
          {showCosts && (
            <PricingCell
              label="Profit"
              value={
                useBuildupTotals
                  ? `${formatCurrency(buildup.profit)}${buildup.effectiveMarginPct != null ? ` (${buildup.effectiveMarginPct}%)` : ""}`
                  : co.costAmount != null
                    ? formatCurrency(co.coValue - co.costAmount)
                    : "-"
              }
              sub={co.legacyPricing ? "As executed" : "Markup on total cost"}
              tone="emerald"
            />
          )}
          <PricingCell
            label="Billable (owner)"
            value={formatCurrency(ownerValue)}
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
          markupPct={co.profitPct}
          bondPct={co.bondPct}
          taxPct={co.taxPct}
          legacyPricing={co.legacyPricing}
          locked={locked}
          lockReason={lockReason}
        />
      )}

      <ExhibitHPanel
        exhibitH={exhibitH}
        coId={co.id}
        projectId={params.id}
        mechDeltaDays={co.mechCompletionDeltaDays}
        pisDeltaDays={co.pisCompletionDeltaDays}
        substDeltaDays={co.substCompletionDeltaDays}
        originalContractValue={
          projectRow?.original_contract_value == null
            ? null
            : Number(projectRow.original_contract_value)
        }
        agreementDate={projectRow?.agreement_date ?? null}
        guaranteedMechanicalDate={projectRow?.guaranteed_mechanical_completion_date ?? null}
        guaranteedPlacedInServiceDate={
          (projectRow as { guaranteed_placed_in_service_date?: string | null } | null)
            ?.guaranteed_placed_in_service_date ?? null
        }
        guaranteedSubstantialDate={projectRow?.guaranteed_substantial_completion_date ?? null}
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
        coValue={ownerValue}
        lines={(sovLines ?? []).map((l) => ({
          id: l.id,
          itemNumber: l.item_number,
          description: l.description,
          scheduledValue: Number(l.scheduled_value ?? 0),
        }))}
        linesTotal={linesTotal}
        drift={ownerValue - linesTotal}
        linkable={sovPicker}
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
