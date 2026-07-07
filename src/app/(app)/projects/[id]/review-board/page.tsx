import { createClient } from "@/lib/supabase/server";
import { guardCapability } from "@/lib/roles-server";
import { finalizeGate } from "@/lib/field-report-status";
import type { InspectionStatus } from "@/lib/inspection-status";

import {
  ReviewBoard,
  type BoardPin,
  type BoardReport,
} from "./review-board";

type Params = { id: string };

const EMPTY_TALLY = (): Record<InspectionStatus, number> => ({
  submitted: 0,
  under_review: 0,
  approved: 0,
  rejected: 0,
});

export default async function ReviewBoardPage({ params }: { params: Params }) {
  // Board is the CM's cross-report queue - subs never see it.
  await guardCapability("viewAllReports");
  const supabase = createClient();

  const [dprsRes, pinsRes, subsRes] = await Promise.all([
    supabase
      .from("dprs")
      .select("id, report_date, status, submitted_at, subcontractor_id")
      .eq("project_id", params.id)
      .order("report_date", { ascending: false })
      .order("submitted_at", { ascending: false }),
    supabase
      .from("inspections")
      .select("id, dpr_id, status, origin, basemap_key, pin_x, pin_y, title")
      .eq("project_id", params.id)
      .not("dpr_id", "is", null),
    supabase
      .from("subcontractors")
      .select("id, company_name")
      .eq("project_id", params.id),
  ]);

  if (dprsRes.error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        Failed to load the review board: {dprsRes.error.message}
      </div>
    );
  }

  const subName = new Map(
    (subsRes.data ?? []).map((s) => [s.id, s.company_name]),
  );

  const pins: BoardPin[] = (pinsRes.data ?? [])
    .filter((p) => p.dpr_id)
    .map((p) => ({
      id: p.id,
      dprId: p.dpr_id as string,
      status: p.status as InspectionStatus,
      origin: p.origin ?? "sub",
      basemapKey: p.basemap_key ?? "C2-01",
      pinX: p.pin_x != null ? Number(p.pin_x) : null,
      pinY: p.pin_y != null ? Number(p.pin_y) : null,
      title: p.title,
    }));

  // Per-report tallies (all pins) and sub-pin statuses (gate the state).
  const tallyByDpr = new Map<string, Record<InspectionStatus, number>>();
  const subStatusesByDpr = new Map<string, InspectionStatus[]>();
  for (const p of pins) {
    const t = tallyByDpr.get(p.dprId) ?? EMPTY_TALLY();
    t[p.status] += 1;
    tallyByDpr.set(p.dprId, t);
    if (p.origin !== "cm") {
      const arr = subStatusesByDpr.get(p.dprId) ?? [];
      arr.push(p.status);
      subStatusesByDpr.set(p.dprId, arr);
    }
  }

  const reports: BoardReport[] = (dprsRes.data ?? []).map((d) => ({
    id: d.id,
    subName: d.subcontractor_id
      ? subName.get(d.subcontractor_id) ?? "Unassigned sub"
      : "Unassigned sub",
    reportDate: d.report_date,
    submittedAt: d.submitted_at,
    state: finalizeGate(d.status, subStatusesByDpr.get(d.id) ?? []).state,
    tally: tallyByDpr.get(d.id) ?? EMPTY_TALLY(),
  }));

  return <ReviewBoard projectId={params.id} pins={pins} reports={reports} />;
}
