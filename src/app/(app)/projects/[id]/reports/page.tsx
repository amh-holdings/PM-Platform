import Link from "next/link";

import { guardCapability, getEffectiveRole } from "@/lib/roles-server";
import { reportHref, visibleReports } from "@/lib/reports";

type Params = { id: string };

// The Reports hub. Deliberately a thin index over the registry in
// `@/lib/reports` - it holds no report logic of its own, so a new report is
// one registry entry plus its own page, and never an edit here.
export default async function ReportsPage({ params }: { params: Params }) {
  // The hub itself is visible to anyone who can read at least one report.
  // `viewDailyProduction` is the floor today because the tracker is the
  // broadest-access report; each card is gated again by its own capability.
  await guardCapability("viewDailyProduction");
  const { effective } = await getEffectiveRole();
  const reports = visibleReports(effective);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Everything this project has to hand somebody: what the owner gets, what
        the field record supports, and the backup behind a bill. Pick a report.
      </p>

      {reports.length === 0 ? (
        <div className="rounded-md border bg-card p-4 text-sm text-muted-foreground">
          No reports are available to your role on this project.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {reports.map((report) => {
            const Icon = report.icon;
            return (
              <Link
                key={report.key}
                href={reportHref(report, params.id)}
                className="group flex flex-col gap-2 rounded-md border bg-card p-4 transition-colors hover:border-foreground/30 hover:bg-accent/40"
              >
                <div className="flex items-start justify-between gap-2">
                  <Icon className="h-5 w-5 shrink-0 text-muted-foreground group-hover:text-foreground" />
                  <span className="rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {report.kind === "generated" ? "Generated" : "Live"}
                  </span>
                </div>
                <div>
                  <p className="font-medium leading-tight">{report.label}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{report.blurb}</p>
                </div>
                <p className="mt-auto pt-1 text-xs text-muted-foreground">
                  For: {report.audience}
                </p>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
