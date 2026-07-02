import Link from "next/link";
import { notFound } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/format";
import {
  canReview,
  isInspectionApprover,
  type InspectionStatus,
} from "@/lib/inspection-status";
import { cn } from "@/lib/utils";

import { FieldReportReview, type ReviewPin } from "./field-report-review";

type Params = { id: string; dprId: string };

const DPR_TONE: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  submitted: "bg-amber-100 text-amber-900",
  approved: "bg-emerald-100 text-emerald-900",
  returned: "bg-destructive/10 text-destructive",
};

export default async function FieldReportDetailPage({
  params,
}: {
  params: Params;
}) {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = user
    ? await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .maybeSingle()
    : { data: null };
  const role = profile?.role ?? "";

  const { data: dpr } = await supabase
    .from("dprs")
    .select(
      "id, project_id, report_date, status, submitted_at, work_narrative, crew_count, total_man_hours, weather_conditions, safety_incident, near_miss, safety_narrative, subcontractor_id",
    )
    .eq("id", params.dprId)
    .eq("project_id", params.id)
    .maybeSingle();

  if (!dpr) notFound();

  const [{ data: pins }, { data: sub }] = await Promise.all([
    supabase
      .from("inspections")
      .select(
        "id, title, status, origin, basemap_key, pin_x, pin_y, inspection_type, notes",
      )
      .eq("dpr_id", dpr.id)
      .order("origin")
      .order("created_at"),
    dpr.subcontractor_id
      ? supabase
          .from("subcontractors")
          .select("company_name")
          .eq("id", dpr.subcontractor_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const reviewPins: ReviewPin[] = (pins ?? []).map((p) => ({
    id: p.id,
    title: p.title,
    status: p.status as InspectionStatus,
    origin: p.origin ?? "sub",
    basemapKey: p.basemap_key,
    pinX: p.pin_x,
    pinY: p.pin_y,
    inspectionType: p.inspection_type,
    notes: p.notes,
  }));

  return (
    <div className="space-y-5">
      <div>
        <Link
          href={`/projects/${params.id}/field-reports`}
          className="text-xs text-muted-foreground hover:underline"
        >
          &larr; Field Reports
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold">
            {formatDate(dpr.report_date)}
          </h2>
          <span
            className={cn(
              "inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize",
              DPR_TONE[dpr.status ?? ""] ?? "bg-muted",
            )}
          >
            {dpr.status}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {sub?.company_name ?? "Unassigned sub"} · submitted{" "}
          {dpr.submitted_at ? formatDate(dpr.submitted_at) : "-"}
        </p>
      </div>

      {/* Daily report summary */}
      <div className="rounded-lg border bg-card p-4 text-sm">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Crew">{dpr.crew_count ?? "-"}</Field>
          <Field label="Man-hours">{dpr.total_man_hours ?? "-"}</Field>
          <Field label="Weather">{dpr.weather_conditions ?? "-"}</Field>
          <Field label="Safety">
            {dpr.safety_incident
              ? "Incident"
              : dpr.near_miss
                ? "Near miss"
                : "OK"}
          </Field>
        </div>
        {dpr.work_narrative && (
          <p className="mt-3 whitespace-pre-wrap">{dpr.work_narrative}</p>
        )}
        {dpr.safety_narrative && (
          <p className="mt-2 text-xs text-muted-foreground">
            Safety: {dpr.safety_narrative}
          </p>
        )}
      </div>

      {/* Map review: sub work pins + CM own checks */}
      <div>
        <h3 className="mb-2 text-sm font-semibold">Work on the map</h3>
        <FieldReportReview
          projectId={params.id}
          dprId={dpr.id}
          subcontractorId={dpr.subcontractor_id}
          pins={reviewPins}
          canReview={canReview(role)}
          canDecide={isInspectionApprover({ role })}
        />
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="tabular-nums">{children}</dd>
    </div>
  );
}
