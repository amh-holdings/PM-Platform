import Link from "next/link";

import { createClient } from "@/lib/supabase/server";
import { guardCapability, getEffectiveRole } from "@/lib/roles-server";
import { can } from "@/lib/roles";

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

  const fallback = defaultRange();
  const from = isIsoDate(searchParams.from) ? searchParams.from : fallback.from;
  const to = isIsoDate(searchParams.to) ? searchParams.to : fallback.to;
  const range = from <= to ? { from, to } : { from: to, to: from };

  const supabase = createClient();
  const [commoditiesRes, productionRes, dprRes, cmLogRes] = await Promise.all([
    supabase
      .from("commodities")
      .select("id, key, label, category, uom, total_quantity, total_verified")
      .eq("project_id", params.id)
      .eq("active", true)
      .order("sort_order", { ascending: true }),
    supabase
      .from("daily_production")
      .select("production_date, commodity_id, quantity, source, synced_at")
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
  let syncedCount = 0;
  for (const row of productionRes.data ?? []) {
    const key = keyById.get(row.commodity_id);
    if (!key) continue;
    values[row.production_date] ??= {};
    values[row.production_date][key] = Number(row.quantity);
    if (row.synced_at) syncedCount += 1;
  }

  const evidence: Record<string, { sub: string | null; cm: string | null; crew: number | null }> = {};
  for (const d of dprRes.data ?? []) {
    evidence[d.report_date] ??= { sub: null, cm: null, crew: null };
    evidence[d.report_date].sub = d.work_narrative;
    evidence[d.report_date].crew = d.crew_count;
  }
  for (const l of cmLogRes.data ?? []) {
    evidence[l.log_date] ??= { sub: null, cm: null, crew: null };
    evidence[l.log_date].cm = l.progress_summary;
  }

  const dates = eachDate(range.from, range.to);

  // Cumulative totals across the WHOLE project, not just this window, so the
  // percent scopes show true progress rather than a slice of it.
  const { data: allRows } = await supabase
    .from("daily_production")
    .select("commodity_id, quantity")
    .eq("project_id", params.id);
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
          <Link
            href={`/projects/${params.id}`}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            &larr; Project
          </Link>
          <h2 className="mt-1 text-lg font-semibold">Daily production report</h2>
          <p className="text-xs text-muted-foreground">
            The owner&apos;s Commodity Tracker. Daily quantities, not running
            totals. Pull the dates you need, fill them from the field reports
            alongside, and save.
          </p>
        </div>
      </div>

      <ProductionGrid
        projectId={params.id}
        commodities={commodities}
        dates={dates}
        initialValues={values}
        evidence={evidence}
        projectTotals={projectTotals}
        range={range}
        canEdit={canEdit}
        syncedCount={syncedCount}
      />
    </div>
  );
}
