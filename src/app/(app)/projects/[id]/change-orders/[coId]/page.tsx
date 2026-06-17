import Link from "next/link";
import { notFound } from "next/navigation";

import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/server";
import { formatCurrency, formatDate } from "@/lib/format";

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
        "id, project_id, co_number, description, co_value, schedule_impact_days, status, submitted_at, approved_at, notes",
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

  const linesTotal = (lines ?? []).reduce(
    (s, l) => s + Number(l.scheduled_value ?? 0),
    0,
  );
  const drift = Number(co.co_value ?? 0) - linesTotal;

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

      <section className="grid gap-3 sm:grid-cols-4">
        <SmallCell label="CO value (billable)" value={formatCurrency(Number(co.co_value ?? 0))} mono />
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
        coValue={Number(co.co_value ?? 0)}
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
