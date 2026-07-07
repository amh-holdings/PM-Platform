import Link from "next/link";
import { notFound } from "next/navigation";

import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/server";
import { formatCurrency, formatDate } from "@/lib/format";
import { can } from "@/lib/roles";
import { getEffectiveRole } from "@/lib/roles-server";

import { CoLineEditor } from "./co-line-editor";

type Params = { id: string; coId: string };

const STATUS_TONE: Record<string, string> = {
  approved: "bg-emerald-100 text-emerald-900",
  submitted: "bg-amber-100 text-amber-900",
  rejected: "bg-destructive/10 text-destructive",
  draft: "bg-muted text-muted-foreground",
};

export default async function ChangeOrderDetailPage({
  params,
}: {
  params: Params;
}) {
  const supabase = createClient();
  const [{ data: co, error }, { data: lines }] = await Promise.all([
    supabase
      .from("change_orders")
      .select(
        "id, project_id, co_number, description, co_value, cost_amount, profit_pct, schedule_impact_days, status, submitted_at, approved_at, notes",
      )
      .eq("id", params.coId)
      .maybeSingle(),
    supabase
      .from("billing_lines")
      .select("id, item_number, description, scheduled_value, sort_order")
      .eq("change_order_id", params.coId)
      .order("sort_order", { ascending: true, nullsFirst: false })
      .order("item_number"),
  ]);
  if (error || !co) notFound();

  // CM sees the change order but not AHC's internal cost / profit margin.
  const { effective } = await getEffectiveRole();
  const showCosts = can(effective, "viewCosts");

  const billable = Number(co.co_value ?? 0);
  const cost = co.cost_amount != null ? Number(co.cost_amount) : null;
  const profitPct = co.profit_pct != null ? Number(co.profit_pct) : null;
  const profitDollars = cost != null ? billable - cost : null;

  const linesTotal = (lines ?? []).reduce(
    (s, l) => s + Number(l.scheduled_value ?? 0),
    0,
  );
  const drift = billable - linesTotal;

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
            <h2 className="text-lg font-semibold">{co.co_number}</h2>
            {co.description && (
              <p className="mt-1 text-xs text-muted-foreground">{co.description}</p>
            )}
          </div>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-xs font-medium capitalize",
              STATUS_TONE[co.status ?? ""] ?? "bg-muted",
            )}
          >
            {co.status}
          </span>
        </div>
      </div>

      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h3 className="text-sm font-semibold">Pricing</h3>
        <div className={cn("mt-3 grid gap-3", showCosts ? "sm:grid-cols-3" : "sm:grid-cols-1")}>
          {showCosts && (
            <PricingCell
              label="Cost (AHC)"
              value={cost != null ? formatCurrency(cost) : "-"}
              sub={cost != null ? "Bare cost to deliver" : "Not tracked"}
            />
          )}
          {showCosts && (
            <PricingCell
              label="Profit"
              value={
                profitDollars != null
                  ? `${formatCurrency(profitDollars)}${profitPct != null ? ` (${profitPct}%)` : ""}`
                  : profitPct != null
                    ? `${profitPct}%`
                    : "-"
              }
              sub="Markup on cost"
              tone="emerald"
            />
          )}
          <PricingCell
            label="Billable (owner)"
            value={formatCurrency(billable)}
            sub="What Dimension pays AHC"
            tone="emerald"
          />
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        <SmallCell
          label="Schedule impact"
          value={
            co.schedule_impact_days != null ? `${co.schedule_impact_days} days` : "-"
          }
        />
        <SmallCell label="Submitted" value={co.submitted_at ? formatDate(co.submitted_at) : "-"} />
        <SmallCell label="Approved" value={co.approved_at ? formatDate(co.approved_at) : "-"} />
      </section>

      {co.notes && (
        <section className="rounded-lg border bg-muted/30 p-3 text-sm">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Notes</div>
          <p className="mt-1 whitespace-pre-wrap">{co.notes}</p>
        </section>
      )}

      <CoLineEditor
        projectId={params.id}
        changeOrderId={params.coId}
        coValue={billable}
        lines={(lines ?? []).map((l) => ({
          id: l.id,
          itemNumber: l.item_number,
          description: l.description,
          scheduledValue: Number(l.scheduled_value ?? 0),
        }))}
        linesTotal={linesTotal}
        drift={drift}
      />
    </div>
  );
}

function SmallCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-sm">{value}</div>
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
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
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
