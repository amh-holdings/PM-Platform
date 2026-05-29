import Link from "next/link";
import { notFound } from "next/navigation";

import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/server";
import { formatCurrency, formatDate } from "@/lib/format";

import { PayAppStatusActions } from "./pay-app-status-actions";

type Params = { id: string; appId: string };

const STATUS_TONE: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  submitted: "bg-amber-100 text-amber-900",
  approved: "bg-emerald-100 text-emerald-900",
  paid: "bg-blue-100 text-blue-900",
};

export default async function PayAppDetailPage({ params }: { params: Params }) {
  const supabase = createClient();

  const [{ data: app, error }, { data: lines }, { data: project }] = await Promise.all([
    supabase
      .from("pay_applications")
      .select(
        "id, project_id, app_number, period_start, period_end, status, total_completed, total_retainage, previous_billings, amount_due, submitted_at, approved_at, paid_at, notes",
      )
      .eq("id", params.appId)
      .maybeSingle(),
    supabase
      .from("pay_application_lines")
      .select(
        "id, item_number, description, scheduled_value, work_completed_previous, work_completed_this_period, materials_stored, total_completed_and_stored, pct_complete, balance_to_finish, retainage_amount, sort_order",
      )
      .eq("pay_application_id", params.appId)
      .order("sort_order", { ascending: true, nullsFirst: false })
      .order("item_number"),
    supabase
      .from("projects")
      .select("name, client")
      .eq("id", params.id)
      .maybeSingle(),
  ]);

  if (error || !app) notFound();

  const rows = lines ?? [];
  // Subtotals for the footer
  const totals = rows.reduce(
    (acc, r) => {
      acc.scheduled += Number(r.scheduled_value ?? 0);
      acc.previous += Number(r.work_completed_previous ?? 0);
      acc.thisPeriod += Number(r.work_completed_this_period ?? 0);
      acc.stored += Number(r.materials_stored ?? 0);
      acc.completed += Number(r.total_completed_and_stored ?? 0);
      acc.balance += Number(r.balance_to_finish ?? 0);
      acc.retainage += Number(r.retainage_amount ?? 0);
      return acc;
    },
    {
      scheduled: 0, previous: 0, thisPeriod: 0, stored: 0,
      completed: 0, balance: 0, retainage: 0,
    },
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 print:hidden">
        <div>
          <Link
            href={`/projects/${params.id}/pay-apps`}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            &larr; Pay applications
          </Link>
          <div className="mt-1 flex flex-wrap items-baseline gap-3">
            <h2 className="text-lg font-semibold">Pay application {app.app_number}</h2>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                STATUS_TONE[app.status ?? ""] ?? "bg-muted",
              )}
            >
              {app.status}
            </span>
          </div>
        </div>
        <PayAppStatusActions
          payAppId={app.id}
          projectId={params.id}
          status={app.status ?? "draft"}
        />
      </div>

      {/* G702-style cover */}
      <section className="rounded-lg border bg-card p-6 shadow-sm print:shadow-none print:border-0">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2 border-b pb-2">
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Application for payment
            </div>
            <div className="text-base font-semibold">{project?.name ?? ""}</div>
            <div className="text-xs text-muted-foreground">
              Client: {project?.client ?? ""}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              Pay app
            </div>
            <div className="text-base font-semibold">{app.app_number}</div>
            <div className="text-xs text-muted-foreground">
              {formatDate(app.period_start)} - {formatDate(app.period_end)}
            </div>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <CoverCell label="Original contract sum" value={formatCurrency(totals.scheduled)} />
          <CoverCell
            label="Total completed this period"
            value={formatCurrency(Number(app.total_completed ?? 0))}
            tone="positive"
          />
          <CoverCell
            label="Less retainage"
            value={formatCurrency(Number(app.total_retainage ?? 0))}
            tone="negative"
          />
          <CoverCell
            label="Total previous billings"
            value={formatCurrency(Number(app.previous_billings ?? 0))}
          />
          <CoverCell
            label="Amount due this application"
            value={formatCurrency(Number(app.amount_due ?? 0))}
            big
            tone="positive"
          />
          <CoverCell
            label="Balance to finish"
            value={formatCurrency(totals.balance)}
          />
        </div>
      </section>

      {/* G703 detail */}
      <section className="rounded-lg border bg-card shadow-sm print:shadow-none print:border-0">
        <div className="border-b p-3">
          <h3 className="text-sm font-semibold">Schedule of values (G703)</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr className="border-b">
                <th className="px-2 py-2 text-left font-medium">Item</th>
                <th className="px-2 py-2 text-left font-medium">Description</th>
                <th className="px-2 py-2 text-right font-medium">Sched. value</th>
                <th className="px-2 py-2 text-right font-medium">Previous</th>
                <th className="px-2 py-2 text-right font-medium">This period</th>
                <th className="px-2 py-2 text-right font-medium">Stored</th>
                <th className="px-2 py-2 text-right font-medium">Total + stored</th>
                <th className="px-2 py-2 text-right font-medium">%</th>
                <th className="px-2 py-2 text-right font-medium">Balance</th>
                <th className="px-2 py-2 text-right font-medium">Retainage</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0">
                  <td className="px-2 py-1.5 font-mono">{r.item_number}</td>
                  <td className="px-2 py-1.5">{r.description}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {formatCurrency(Number(r.scheduled_value ?? 0))}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                    {formatCurrency(Number(r.work_completed_previous ?? 0))}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-semibold">
                    {formatCurrency(Number(r.work_completed_this_period ?? 0))}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                    {formatCurrency(Number(r.materials_stored ?? 0))}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {formatCurrency(Number(r.total_completed_and_stored ?? 0))}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {Number(r.pct_complete ?? 0).toFixed(0)}%
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                    {formatCurrency(Number(r.balance_to_finish ?? 0))}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {formatCurrency(Number(r.retainage_amount ?? 0))}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={10}
                    className="px-2 py-6 text-center text-xs text-muted-foreground"
                  >
                    No SOV lines on this pay application.
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot className="bg-muted/30 text-xs font-semibold">
              <tr>
                <td colSpan={2} className="px-2 py-2 text-right uppercase">
                  Total
                </td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {formatCurrency(totals.scheduled)}
                </td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {formatCurrency(totals.previous)}
                </td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {formatCurrency(totals.thisPeriod)}
                </td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {formatCurrency(totals.stored)}
                </td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {formatCurrency(totals.completed)}
                </td>
                <td className="px-2 py-2"></td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {formatCurrency(totals.balance)}
                </td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {formatCurrency(totals.retainage)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      {app.notes && (
        <section className="rounded-lg border bg-muted/30 p-4 print:hidden">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Notes
          </h3>
          <p className="mt-2 whitespace-pre-wrap text-sm">{app.notes}</p>
        </section>
      )}
    </div>
  );
}

function CoverCell({
  label,
  value,
  tone,
  big,
}: {
  label: string;
  value: string;
  tone?: "positive" | "negative";
  big?: boolean;
}) {
  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          big ? "text-2xl" : "text-base",
          "mt-1 font-semibold tabular-nums",
          tone === "positive" && "text-emerald-700",
          tone === "negative" && "text-destructive",
        )}
      >
        {value}
      </div>
    </div>
  );
}
