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
import { INSPECTION_BUCKET } from "../../inspections/inspection-constants";

import { FieldReportReview, type ReviewPin } from "./field-report-review";
import { ResubmitBanner } from "./resubmit-banner";

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
        .select("role, subcontractor_id")
        .eq("id", user.id)
        .maybeSingle()
    : { data: null };
  const role = profile?.role ?? "";

  const { data: dpr } = await supabase
    .from("dprs")
    .select(
      "id, project_id, report_date, status, submitted_at, work_narrative, crew_count, total_man_hours, weather_conditions, safety_incident, near_miss, safety_narrative, subcontractor_id, review_notes",
    )
    .eq("id", params.dprId)
    .eq("project_id", params.id)
    .maybeSingle();

  if (!dpr) notFound();

  const [{ data: pins }, { data: sub }, { data: tasks }] = await Promise.all([
    supabase
      .from("inspections")
      .select(
        "id, title, status, origin, basemap_key, pin_x, pin_y, inspection_type, notes, schedule_task_id, task_new_status, task_new_pct, quantity, unit_of_measure",
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
    supabase
      .from("schedule_tasks")
      .select("id, wbs_code, task_name")
      .eq("project_id", params.id)
      .order("sort_order", { ascending: true, nullsFirst: false })
      .order("wbs_code", { ascending: true }),
  ]);

  // Load every pin's photos and sign short-lived URLs so the reviewer can see
  // the picture for each QC check. The bucket is private, so a signed URL is
  // the only way to render the image in the browser.
  const pinIds = (pins ?? []).map((p) => p.id);
  const photosByPin = new Map<
    string,
    Array<{ url: string; side: string; caption: string | null }>
  >();
  if (pinIds.length > 0) {
    const { data: photoRows } = await supabase
      .from("inspection_photos")
      .select("inspection_id, side, storage_path, caption")
      .in("inspection_id", pinIds)
      .order("created_at");
    const paths = (photoRows ?? []).map((r) => r.storage_path);
    const { data: signed } = paths.length
      ? await supabase.storage.from(INSPECTION_BUCKET).createSignedUrls(paths, 3600)
      : { data: [] };
    const urlByPath = new Map(
      (signed ?? [])
        .filter((s) => s.signedUrl && !s.error)
        .map((s) => [s.path, s.signedUrl]),
    );
    for (const r of photoRows ?? []) {
      const url = urlByPath.get(r.storage_path);
      if (!url) continue;
      const arr = photosByPin.get(r.inspection_id) ?? [];
      arr.push({ url, side: r.side, caption: r.caption });
      photosByPin.set(r.inspection_id, arr);
    }
  }

  const taskList = (tasks ?? []).map((t) => ({
    id: t.id,
    wbsCode: t.wbs_code,
    taskName: t.task_name,
  }));
  const taskLabel = new Map(
    taskList.map((t) => [t.id, `${t.wbsCode} ${t.taskName}`]),
  );

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
    wbsLabel: p.schedule_task_id
      ? taskLabel.get(p.schedule_task_id) ?? null
      : null,
    progress: p.schedule_task_id
      ? [
          p.task_new_status,
          p.task_new_pct != null ? `${p.task_new_pct}%` : null,
          p.quantity != null
            ? `${p.quantity} ${p.unit_of_measure ?? ""}`.trim()
            : null,
        ]
          .filter(Boolean)
          .join(" · ") || null
      : null,
    photos: photosByPin.get(p.id) ?? [],
  }));

  // Rejected sub-pin count drives the resubmit banner on a returned report.
  const rejectedCount = reviewPins
    .filter((p) => p.origin !== "cm")
    .filter((p) => p.status === "rejected").length;

  const canResubmit =
    dpr.status === "returned" &&
    (canReview(role) ||
      (profile?.subcontractor_id != null &&
        dpr.subcontractor_id === profile.subcontractor_id));

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

      {canResubmit && (
        <ResubmitBanner
          projectId={params.id}
          dprId={dpr.id}
          reviewNotes={dpr.review_notes}
          rejectedCount={rejectedCount}
        />
      )}

      {dpr.status === "approved" && dpr.review_notes && (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
          <span className="font-medium">Approved.</span> {dpr.review_notes}
        </p>
      )}

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
