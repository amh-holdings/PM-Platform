import Link from "next/link";

import { guardCapability, getEffectiveRole } from "@/lib/roles-server";
import { can } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { loadMonthlyManpower } from "@/lib/monthly-manpower-load";
import { defaultPeriodMonth, periodLabel, shortDate, stepMonth } from "@/lib/monthly-manpower";

import { MonthlyManpowerForm } from "./monthly-manpower-form";

type Params = { id: string };
type Search = { month?: string };

const isMonth = (s: string | undefined): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-01$/.test(s);

export default async function MonthlyManpowerPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  // Same gate as the Reports hub. This is an outbound owner document, so it is
  // AHC-only in RLS as well as here.
  await guardCapability("viewDailyProduction");
  const { effective } = await getEffectiveRole();

  // Defaults to the month just finished, not the current one. A monthly report
  // is filed for a month that is over; opening on a half-finished month shows a
  // figure that is short by the rest of it and invites filing it.
  const today = new Date().toISOString().slice(0, 10);
  const periodMonth = isMonth(searchParams.month) ? searchParams.month : defaultPeriodMonth(today);

  const view = await loadMonthlyManpower(params.id, periodMonth);

  const href = (m: string) => `/projects/${params.id}/reports/monthly-manpower?month=${m}`;

  let history: { period_month: string; status: string | null }[] = [];
  if (!view.storageMissing) {
    const supabase = createClient();
    const { data } = await supabase
      .from("monthly_manpower_reports")
      .select("period_month, status")
      .eq("project_id", params.id)
      .order("period_month", { ascending: false })
      .limit(12);
    history = data ?? [];
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-card px-3 py-2">
        <div className="flex items-center gap-2">
          <Link
            href={href(stepMonth(periodMonth, -1))}
            className="rounded-md border px-2 py-1 text-sm hover:bg-accent"
          >
            ← {periodLabel(stepMonth(periodMonth, -1))}
          </Link>
          <span className="px-1 text-sm font-medium">{periodLabel(periodMonth)}</span>
          <Link
            href={href(stepMonth(periodMonth, 1))}
            className="rounded-md border px-2 py-1 text-sm hover:bg-accent"
          >
            {periodLabel(stepMonth(periodMonth, 1))} →
          </Link>
        </div>
        <div className="flex items-center gap-3">
          <p className="text-xs text-muted-foreground">
            Covering {shortDate(view.period.start)} to {shortDate(view.period.end)}
          </p>
          <Link
            href={`/projects/${params.id}/reports/monthly-manpower/print?month=${periodMonth}`}
            className="rounded-md border px-2 py-1 text-xs hover:bg-accent"
          >
            Backup sheet
          </Link>
        </div>
      </div>

      {history.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">Saved:</span>
          {history.map((h) => (
            <Link
              key={h.period_month}
              href={href(h.period_month)}
              className={
                h.period_month === periodMonth
                  ? "rounded-full bg-foreground px-2 py-0.5 text-background"
                  : "rounded-full border px-2 py-0.5 hover:bg-accent"
              }
            >
              {periodLabel(h.period_month)}
              {h.status === "submitted" && " ✓"}
            </Link>
          ))}
        </div>
      )}

      <MonthlyManpowerForm
        view={view}
        canSubmit={can(effective, "enterDailyProduction")}
      />
    </div>
  );
}
