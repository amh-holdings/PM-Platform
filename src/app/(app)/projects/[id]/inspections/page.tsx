import Link from "next/link";

import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";
import {
  INSPECTION_STATUSES,
  type InspectionStatus,
} from "@/lib/inspection-status";
import { InspectionsBoard } from "./inspections-board";
import { SecureLinkManager } from "./secure-link-manager";

type Params = { id: string };

export default async function ProjectInspectionsPage({
  params,
}: {
  params: Params;
}) {
  const supabase = createClient();

  const [{ data: inspections, error }, { data: subs }, { data: links }] =
    await Promise.all([
      supabase
        .from("inspections")
        .select(
          "id, title, status, inspection_type, basemap_key, pin_x, pin_y, subcontractor_id, inspector_name, submitted_at, quantity, unit_of_measure",
        )
        .eq("project_id", params.id)
        .order("submitted_at", { ascending: false }),
      supabase
        .from("subcontractors")
        .select("id, company_name")
        .eq("project_id", params.id)
        .order("company_name"),
      supabase
        .from("inspection_secure_links")
        .select("id, subcontractor_id, label, token, active, expires_at, last_used_at")
        .eq("project_id", params.id),
    ]);

  if (error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        Failed to load inspections: {error.message}
      </div>
    );
  }

  const rows = inspections ?? [];
  const subList = subs ?? [];
  const subName = new Map(subList.map((s) => [s.id, s.company_name]));

  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">QA/QC Field Inspections</h2>
          <p className="text-xs text-muted-foreground">
            Spatial, two-sided inspections tied to the site plan. Subs submit
            pinned records; AHC verifies; Mark Wooley approves or rejects.
          </p>
        </div>
        <Button asChild>
          <Link href={`/projects/${params.id}/inspections/new`}>
            New inspection
          </Link>
        </Button>
      </div>

      <div className="grid gap-2 sm:grid-cols-4">
        {INSPECTION_STATUSES.map((s) => (
          <div key={s} className="rounded-md border bg-card p-3">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              {s.replace("_", " ")}
            </div>
            <div className="mt-1 text-2xl font-semibold">{counts[s] ?? 0}</div>
          </div>
        ))}
      </div>

      <InspectionsBoard
        projectId={params.id}
        inspections={rows.map((r) => ({
          id: r.id,
          title: r.title,
          status: r.status as InspectionStatus,
          inspectionType: r.inspection_type,
          basemapKey: r.basemap_key,
          pinX: r.pin_x,
          pinY: r.pin_y,
          subName: r.subcontractor_id
            ? subName.get(r.subcontractor_id) ?? null
            : null,
          inspectorName: r.inspector_name,
          submittedAt: r.submitted_at,
          quantity: r.quantity,
          unit: r.unit_of_measure,
        }))}
      />

      <SecureLinkManager
        projectId={params.id}
        subs={subList}
        links={(links ?? []).map((l) => ({
          ...l,
          subName: subName.get(l.subcontractor_id) ?? "Unknown",
        }))}
      />
    </div>
  );
}
