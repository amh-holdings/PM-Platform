
import { createClient } from "@/lib/supabase/server";
import { guardCapability, getEffectiveRole } from "@/lib/roles-server";
import { can } from "@/lib/roles";
import { syncProductionFromReports } from "@/lib/production-proposal-run";

import { ProductionGrid } from "./production-grid";

type Params = { id: string };
type Search = { from?: string; to?: string };

// Default window: the last 14 days ending today. Wide enough to catch up after
// a few missed days, short enough to stay readable on one screen.
function defaultRange(): { from: string; to: string } {
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - 13);
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { from: iso(start), to: iso(today) };
}

function isIsoDate(s: string | undefined): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  const cur = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  // Guard against an inverted or absurd range producing a runaway loop.
  let guard = 0;
  while (cur <= end && guard < 400) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
    guard += 1;
  }
  return out;
}

export default async function ProductionPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  await guardCapability("viewDailyProduction");
  const { effective } = await getEffectiveRole();
  const canEdit = can(effective, "enterDailyProduction");

  const supabase = createClient();

  // The default window reaches back far enough to include the oldest approved
  // report that still has nothing on the tracker. A fixed 14 days quietly hid
  // the problem this page was built to surface: when the tracker had gone weeks
  // without an entry, the untouched days were off the bottom of the range and it
  // looked idle rather than behind. An explicit ?from/?to always wins.
  const fallback = defaultRange();
  let defaultFrom = fallback.from;
  if (!isIsoDate(searchParams.from)) {
    const [{ data: oldestApproved }, { data: filedDates }] = await Promise.all([
      supabase
        .from("dprs")
        .select("report_date")
        .eq("project_id", params.id)
        .eq("status", "approved")
        .lt("report_date", defaultFrom)
        .order("report_date", { ascending: true })
        .limit(60),
      supabase
        .from("daily_production")
        .select("production_date")
        .eq("project_id", params.id)
        .lt("production_date", defaultFrom),
    ]);
    const filed = new Set((filedDates ?? []).map((r) => r.production_date));
    const firstGap = (oldestApproved ?? [])
      .map((r) => r.report_date)
      .find((d) => !filed.has(d));
    if (firstGap && firstGap < defaultFrom) defaultFrom = firstGap;
  }

  const from = isIsoDate(searchParams.from) ? searchParams.from : defaultFrom;
  const to = isIsoDate(searchParams.to) ? searchParams.to : fallback.to;
  const range = from <= to ? { from, to } : { from: to, to: from };

  // OPENING THE REPORT BRINGS IT UP TO DATE.
  //
  // Every approved day in the window that has nothing on it gets filled from
  // its Field Report before the page reads anything, so what renders below is
  // current as of this click rather than as of the last time the approval hook
  // happened to work. See syncProductionFromReports for why the tracker pulls
  // as well as being pushed to.
  //
  // Runs on Phil's own session - he is the only role that may write production
  // (migration 0036), and he is the only one who sees this page in edit mode.
  // A viewer who cannot write simply reads what is already filed.
  const sync = canEdit
    ? await syncProductionFromReports(supabase, {
        projectId: params.id,
        from: range.from,
        to: range.to,
      })
    : null;

  const [commoditiesRes, productionRes, dprRes, cmLogRes] = await Promise.all([
    supabase
      .from("commodities")
      .select("id, key, label, category, uom, total_quantity, total_verified")
      .eq("project_id", params.id)
      .eq("active", true)
      .order("sort_order", { ascending: true }),
    supabase
      .from("daily_production")
      .select(
        "production_date, commodity_id, quantity, source, synced_at, confirmed_at, proposal_basis",
      )
      .eq("project_id", params.id)
      .gte("production_date", range.from)
      .lte("production_date", range.to),
    // The evidence Phil reads the quantities off: the sub's report for the day.
    supabase
      .from("dprs")
      .select("report_date, work_narrative, crew_count, status")
      .eq("project_id", params.id)
      .gte("report_date", range.from)
      .lte("report_date", range.to),
    supabase
      .from("cm_daily_logs")
      .select("log_date, progress_summary")
      .eq("project_id", params.id)
      .gte("log_date", range.from)
      .lte("log_date", range.to),
  ]);

  if (commoditiesRes.error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        Failed to load commodities: {commoditiesRes.error.message}
      </div>
    );
  }

  const commodities = (commoditiesRes.data ?? []).map((c) => ({
    id: c.id,
    key: c.key,
    label: c.label,
    category: c.category as "civil" | "electrical" | "mechanical",
    uom: c.uom,
    totalQuantity: c.total_quantity == null ? null : Number(c.total_quantity),
    totalVerified: c.total_verified,
  }));

  if (commodities.length === 0) {
    return (
      <div className="rounded-md border bg-card p-4 text-sm">
        <p className="font-medium">No commodities configured for this project.</p>
        <p className="mt-1 text-muted-foreground">
          Run <code>npm run commodity:seed -- --project-id {params.id}</code> to
          set up the tracked commodity list.
        </p>
      </div>
    );
  }

  const keyById = new Map(commodities.map((c) => [c.id, c.key]));
  const values: Record<string, Record<string, number>> = {};
  // How each auto-filled figure was reached. These rows are filed production
  // like any other - this map is the reasoning behind them, surfaced so a
  // number can be judged rather than just read, not a queue awaiting sign-off.
  const autoBasis: Record<string, Record<string, string>> = {};
  let syncedCount = 0;
  let autoFilledCount = 0;
  for (const row of productionRes.data ?? []) {
    const key = keyById.get(row.commodity_id);
    if (!key) continue;
    values[row.production_date] ??= {};
    values[row.production_date][key] = Number(row.quantity);
    if (row.synced_at) syncedCount += 1;
    if (row.source === "field_report") {
      autoBasis[row.production_date] ??= {};
      autoBasis[row.production_date][key] =
        row.proposal_basis ?? "Filled from the day's approved Field Report.";
      autoFilledCount += 1;
    }
  }

  const blankEvidence = () => ({
    sub: null as string | null,
    cm: null as string | null,
    crew: null as number | null,
    reportStatus: null as string | null,
  });
  const evidence: Record<string, ReturnType<typeof blankEvidence>> = {};
  for (const d of dprRes.data ?? []) {
    evidence[d.report_date] ??= blankEvidence();
    evidence[d.report_date].sub = d.work_narrative;
    evidence[d.report_date].crew = d.crew_count;
    evidence[d.report_date].reportStatus = d.status;
  }
  for (const l of cmLogRes.data ?? []) {
    evidence[l.log_date] ??= blankEvidence();
    evidence[l.log_date].cm = l.progress_summary;
  }

  const dates = eachDate(range.from, range.to);

  // Cumulative totals across the WHOLE project, not just this window, so the
  // percent scopes show true progress rather than a slice of it.
  const { data: allRows } = await supabase
    .from("daily_production")
    .select("commodity_id, quantity")
    .eq("project_id", params.id);
  // One total. Every row on the tracker is filed production, so the percent the
  // owner sees is the percent this page shows - there is no second figure held
  // back behind it.
  const projectTotals: Record<string, number> = {};
  for (const row of allRows ?? []) {
    const key = keyById.get(row.commodity_id);
    if (!key) continue;
    projectTotals[key] = (projectTotals[key] ?? 0) + Number(row.quantity);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs text-muted-foreground">
            The owner&apos;s deliverable. Daily quantities, not running totals.
            Approved field reports fill themselves in here every time you open
            this page. Pull the dates you need, correct anything the report got
            wrong, and save.
          </p>
        </div>
      </div>

      {/* What opening the page just did. Silence here used to be ambiguous -
          a blank day looked the same whether nobody worked or the fill had
          failed. Now the page says which it was. */}
      {sync?.error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <p className="font-medium">
            Could not bring the tracker up to date.
          </p>
          <p className="mt-1">
            {sync.error}. The days below are whatever was already filed, so
            treat this report as stale until this clears.
          </p>
        </div>
      )}

      {sync && sync.daysFilled.length > 0 && (
        <div className="rounded-md border border-primary/40 bg-primary/5 p-3 text-sm">
          <p className="font-medium">
            Brought up to date: filled {sync.rowsWritten}{" "}
            {sync.rowsWritten === 1 ? "figure" : "figures"} across{" "}
            {sync.daysFilled.length}{" "}
            {sync.daysFilled.length === 1 ? "day" : "days"} from approved field
            reports.
          </p>
          <p className="mt-1 text-muted-foreground">
            {sync.daysFilled.join(", ")}. Hover a filled cell to see how the
            number was reached, and correct anything the report got wrong.
          </p>
        </div>
      )}

      {sync && sync.daysUnfilled.length > 0 && (
        <div className="rounded-md border bg-card p-3 text-sm">
          <p className="font-medium">
            {sync.daysUnfilled.length}{" "}
            {sync.daysUnfilled.length === 1
              ? "approved day is"
              : "approved days are"}{" "}
            still blank.
          </p>
          <ul className="mt-1 space-y-1 text-muted-foreground">
            {sync.daysUnfilled.map((d) => (
              <li key={d.date}>
                <span className="font-medium text-foreground">{d.date}</span> -{" "}
                {d.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <ProductionGrid
        projectId={params.id}
        commodities={commodities}
        dates={dates}
        initialValues={values}
        autoBasis={autoBasis}
        evidence={evidence}
        projectTotals={projectTotals}
        range={range}
        canEdit={canEdit}
        syncedCount={syncedCount}
        autoFilledCount={autoFilledCount}
      />
    </div>
  );
}
