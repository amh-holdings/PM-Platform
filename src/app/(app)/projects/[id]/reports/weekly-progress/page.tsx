import Link from "next/link";

import { guardCapability, getEffectiveRole } from "@/lib/roles-server";
import { can } from "@/lib/roles";
import { createClient } from "@/lib/supabase/server";
import { loadWeeklyReport } from "@/lib/weekly-report-load";
import { addDays, defaultWeekEnding, dimensionDate } from "@/lib/weekly-report";

import { WeeklyReportForm } from "./weekly-report-form";

type Params = { id: string };
type Search = { week?: string };

const isIso = (s: string | undefined): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

export default async function WeeklyProgressPage({
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

  const today = new Date().toISOString().slice(0, 10);
  const weekEnding = isIso(searchParams.week) ? searchParams.week : defaultWeekEnding(today);

  const view = await loadWeeklyReport(params.id, weekEnding);

  // The weeks either side, so stepping through the record is two clicks rather
  // than a date picker each time.
  const prevWeek = addDays(weekEnding, -7);
  const nextWeek = addDays(weekEnding, 7);
  const href = (w: string) => `/projects/${params.id}/reports/weekly-progress?week=${w}`;

  // Which weeks already have a saved report, for the jump list. Skipped when
  // the table is not there yet.
  let history: { week_ending: string; status: string }[] = [];
  if (!view.storageMissing) {
    const supabase = createClient();
    const { data } = await supabase
      .from("weekly_progress_reports")
      .select("week_ending, status")
      .eq("project_id", params.id)
      .order("week_ending", { ascending: false })
      .limit(12);
    history = data ?? [];
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-card px-3 py-2">
        <div className="flex items-center gap-2">
          <Link
            href={href(prevWeek)}
            className="rounded-md border px-2 py-1 text-sm hover:bg-accent"
          >
            ← {dimensionDate(prevWeek)}
          </Link>
          <span className="px-1 text-sm font-medium">
            Week ending {dimensionDate(weekEnding)}
          </span>
          <Link
            href={href(nextWeek)}
            className="rounded-md border px-2 py-1 text-sm hover:bg-accent"
          >
            {dimensionDate(nextWeek)} →
          </Link>
        </div>
        <p className="text-xs text-muted-foreground">
          Covering {dimensionDate(view.period.start)} to {dimensionDate(view.period.end)}
        </p>
      </div>

      {history.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">Saved:</span>
          {history.map((h) => (
            <Link
              key={h.week_ending}
              href={href(h.week_ending)}
              className={
                h.week_ending === weekEnding
                  ? "rounded-full bg-foreground px-2 py-0.5 text-background"
                  : "rounded-full border px-2 py-0.5 hover:bg-accent"
              }
            >
              {dimensionDate(h.week_ending)}
              {h.status === "issued" && " ✓"}
            </Link>
          ))}
        </div>
      )}

      <WeeklyReportForm view={view} canIssue={can(effective, "enterDailyProduction")} />
    </div>
  );
}
