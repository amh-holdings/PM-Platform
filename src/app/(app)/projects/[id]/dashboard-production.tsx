import Link from "next/link";

import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/server";

type Props = {
  projectId: string;
};

// Solar production rollup. Reads the approved installed quantities already on the
// schedule (a field-report pin writes its quantity to schedule_tasks on CM
// approval, holding the latest-dated approved value per task), groups them by
// unit, and turns installed MODULE counts into MW using the project's module
// wattage. Rendered only for projects that actually carry solar data, so
// non-solar jobs never see an empty tile.
export async function DashboardProduction({ projectId }: Props) {
  const supabase = createClient();

  const [{ data: project }, { data: tasks }] = await Promise.all([
    supabase
      .from("projects")
      .select("dc_capacity_mw, module_watts")
      .eq("id", projectId)
      .maybeSingle(),
    supabase
      .from("schedule_tasks")
      .select("installed_quantity, target_quantity, unit_of_measure")
      .eq("project_id", projectId),
  ]);

  const planMw = project?.dc_capacity_mw ?? null;
  const moduleWatts = project?.module_watts ?? null;

  // Sum installed (and planned) quantity per normalized unit.
  const installed: Record<string, number> = {};
  const planned: Record<string, number> = {};
  for (const t of tasks ?? []) {
    const unit = (t.unit_of_measure ?? "").trim().toUpperCase();
    if (!unit) continue;
    const inst = Number(t.installed_quantity ?? 0) || 0;
    const targ = Number(t.target_quantity ?? 0) || 0;
    if (inst) installed[unit] = (installed[unit] ?? 0) + inst;
    if (targ) planned[unit] = (planned[unit] ?? 0) + targ;
  }

  const modules = installed.MODULE ?? 0;
  const directMw = (installed.MW ?? 0) + (installed.MWDC ?? 0);
  const mwFromModules = moduleWatts ? (modules * moduleWatts) / 1_000_000 : 0;
  const mwInstalled = directMw + mwFromModules;

  // Component counters worth surfacing when present.
  const counters = [
    { label: "Piles", installed: installed.PILE ?? 0, planned: planned.PILE ?? 0 },
    {
      label: "Modules",
      installed: modules,
      planned: planned.MODULE ?? 0,
    },
    { label: "Rows", installed: installed.ROW ?? 0, planned: planned.ROW ?? 0 },
    {
      label: "Strings",
      installed: installed.STRING ?? 0,
      planned: planned.STRING ?? 0,
    },
  ].filter((c) => c.installed > 0 || c.planned > 0);

  // No solar signal at all - render nothing.
  if (planMw == null && mwInstalled === 0 && counters.length === 0) {
    return null;
  }

  const pctOfPlan =
    planMw && planMw > 0
      ? Math.min(100, Math.round((mwInstalled / planMw) * 100))
      : null;

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Production installed</h2>
          <p className="text-xs text-muted-foreground">
            Approved field-report quantities, to date
          </p>
        </div>
        <Link
          href={`/projects/${projectId}/schedule`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Schedule &rarr;
        </Link>
      </div>

      <div className="rounded border bg-muted/30 px-3 py-3">
        <div className="flex items-baseline justify-between">
          <div className="text-muted-foreground text-xs">MW installed (DC)</div>
          <div className="text-xs text-muted-foreground">
            {planMw != null ? `of ${formatNum(planMw)} MW nameplate` : "no nameplate set"}
          </div>
        </div>
        <div className="mt-0.5 flex items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums">
            {formatNum(mwInstalled)}
          </span>
          {pctOfPlan != null && (
            <span className="text-sm font-medium text-emerald-600">
              {pctOfPlan}%
            </span>
          )}
        </div>
        {pctOfPlan != null && (
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-emerald-500"
              style={{ width: `${pctOfPlan}%` }}
            />
          </div>
        )}
        {moduleWatts == null && modules > 0 && (
          <p className="mt-1 text-[10px] text-amber-600">
            Set module wattage on the project to convert {formatNum(modules)}{" "}
            installed modules into MW.
          </p>
        )}
      </div>

      {counters.length > 0 && (
        <div
          className={cn(
            "grid gap-2 text-xs",
            counters.length >= 4 ? "grid-cols-4" : "grid-cols-2 sm:grid-cols-4",
          )}
        >
          {counters.map((c) => (
            <div key={c.label} className="rounded border bg-muted/30 px-3 py-2">
              <div className="text-muted-foreground">{c.label}</div>
              <div className="text-base font-semibold tabular-nums">
                {formatNum(c.installed)}
              </div>
              <div className="text-[10px] text-muted-foreground">
                {c.planned > 0 ? `of ${formatNum(c.planned)}` : "installed"}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return "0";
  // Whole numbers for counts; up to 2 decimals for MW.
  return Number.isInteger(n)
    ? n.toLocaleString("en-US")
    : n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
