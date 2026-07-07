import Link from "next/link";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/server";
import { formatCurrency, formatDate } from "@/lib/format";
import { guardCapability } from "@/lib/roles-server";

type Params = { id: string };

const STATUS_TONE: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  submitted: "bg-amber-100 text-amber-900",
  approved: "bg-emerald-100 text-emerald-900",
  paid: "bg-blue-100 text-blue-900",
};

export default async function ProjectPayAppsPage({ params }: { params: Params }) {
  await guardCapability("viewPayApps");
  const supabase = createClient();

  const { data: apps, error } = await supabase
    .from("pay_applications")
    .select(
      "id, app_number, period_start, period_end, status, total_completed, total_retainage, amount_due, submitted_at, approved_at, paid_at",
    )
    .eq("project_id", params.id)
    .order("period_end", { ascending: false });

  if (error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        Failed to load pay applications: {error.message}
      </div>
    );
  }

  const rows = apps ?? [];
  const totalCompleted = rows.reduce(
    (s, r) => s + Number(r.total_completed ?? 0),
    0,
  );
  const totalPaid = rows
    .filter((r) => r.status === "paid")
    .reduce((s, r) => s + Number(r.amount_due ?? 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Pay applications</h2>
          <p className="text-xs text-muted-foreground">
            Monthly G702/G703 billing cycles to the owner. Each pay app
            snapshots the billing schedule at finalization.
          </p>
        </div>
        <Button asChild>
          <Link href={`/projects/${params.id}/pay-apps/new`}>
            New pay application
          </Link>
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-md border bg-card p-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Total pay apps
          </div>
          <div className="mt-1 text-2xl font-semibold">{rows.length}</div>
        </div>
        <div className="rounded-md border bg-card p-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Total completed
          </div>
          <div className="mt-1 text-2xl font-semibold">
            {formatCurrency(totalCompleted)}
          </div>
        </div>
        <div className="rounded-md border bg-card p-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Total paid
          </div>
          <div className="mt-1 text-2xl font-semibold text-emerald-700">
            {formatCurrency(totalPaid)}
          </div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted-foreground">
            <tr className="border-b">
              <th className="px-3 py-2 text-left font-medium">App #</th>
              <th className="px-3 py-2 text-left font-medium">Period</th>
              <th className="px-3 py-2 text-left font-medium">Status</th>
              <th className="px-3 py-2 text-right font-medium">Completed</th>
              <th className="px-3 py-2 text-right font-medium">Retainage</th>
              <th className="px-3 py-2 text-right font-medium">Due</th>
              <th className="px-3 py-2 text-left font-medium">Submitted</th>
              <th className="px-3 py-2 text-left font-medium">Paid</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b last:border-0 hover:bg-muted/30">
                <td className="px-3 py-2 font-mono font-medium">
                  <Link
                    href={`/projects/${params.id}/pay-apps/${r.id}`}
                    className="hover:underline"
                  >
                    {r.app_number}
                  </Link>
                </td>
                <td className="px-3 py-2 text-xs">
                  {formatDate(r.period_start)} - {formatDate(r.period_end)}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={cn(
                      "inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                      STATUS_TONE[r.status ?? ""] ?? "bg-muted",
                    )}
                  >
                    {r.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatCurrency(Number(r.total_completed ?? 0))}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatCurrency(Number(r.total_retainage ?? 0))}
                </td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums">
                  {formatCurrency(Number(r.amount_due ?? 0))}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {r.submitted_at ? formatDate(r.submitted_at) : "-"}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {r.paid_at ? formatDate(r.paid_at) : "-"}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  className="px-3 py-6 text-center text-xs text-muted-foreground"
                >
                  No pay applications yet. Click &quot;New pay application&quot; to draft the first one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
