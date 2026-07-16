import Link from "next/link";
import { notFound } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  STATUS_STYLE,
  statusLabel,
  type InspectionStatus,
} from "@/lib/inspection-status";
import { INSPECTION_BUCKET } from "../../../inspections/inspection-constants";
import { PrintButton } from "./print-button";

type Params = { id: string; dprId: string };

type PrintPhoto = { url: string; side: string; caption: string | null };

// A print-friendly, single-page record of one field report: the daily summary
// plus every work item with its status, the CM's reason (if rejected) and both
// the sub's and CM's photos. Built to be saved as a PDF from the browser for
// owner/lender submittals and the QA/QC archive.
export default async function FieldReportPrintPage({
  params,
}: {
  params: Params;
}) {
  const supabase = createClient();

  const { data: dpr } = await supabase
    .from("dprs")
    .select(
      "id, project_id, report_date, status, submitted_at, work_narrative, crew_count, total_man_hours, weather_conditions, safety_incident, near_miss, safety_narrative, subcontractor_id, review_notes",
    )
    .eq("id", params.dprId)
    .eq("project_id", params.id)
    .maybeSingle();

  if (!dpr) notFound();

  const [{ data: project }, { data: pins }, { data: sub }, { data: tasks }] =
    await Promise.all([
      supabase
        .from("projects")
        .select("name, client")
        .eq("id", params.id)
        .maybeSingle(),
      supabase
        .from("inspections")
        .select(
          "id, title, status, origin, inspection_type, notes, decision_notes, schedule_task_id, task_new_status, task_new_pct, quantity, unit_of_measure",
        )
        .eq("dpr_id", dpr.id)
        .eq("origin", "sub")
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
        .eq("project_id", params.id),
    ]);

  // Sign short-lived URLs for every work-item photo (private bucket).
  const pinIds = (pins ?? []).map((p) => p.id);
  const photosByPin = new Map<string, PrintPhoto[]>();
  if (pinIds.length > 0) {
    const { data: photoRows } = await supabase
      .from("inspection_photos")
      .select("inspection_id, side, storage_path, caption")
      .in("inspection_id", pinIds)
      .order("created_at");
    const paths = (photoRows ?? []).map((r) => r.storage_path);
    const { data: signed } = paths.length
      ? await supabase.storage
          .from(INSPECTION_BUCKET)
          .createSignedUrls(paths, 3600)
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

  const taskLabel = new Map(
    (tasks ?? []).map((t) => [t.id, `${t.wbs_code} ${t.task_name}`]),
  );

  const items = (pins ?? []).map((p) => {
    const photos = photosByPin.get(p.id) ?? [];
    return {
      id: p.id,
      title: p.title,
      status: p.status as InspectionStatus,
      inspectionType: p.inspection_type,
      notes: p.notes,
      decisionNotes: p.decision_notes,
      wbsLabel: p.schedule_task_id
        ? taskLabel.get(p.schedule_task_id) ?? null
        : null,
      progress:
        [
          p.task_new_status,
          p.task_new_pct != null ? `${p.task_new_pct}%` : null,
          p.quantity != null
            ? `${p.quantity} ${p.unit_of_measure ?? ""}`.trim()
            : null,
        ]
          .filter(Boolean)
          .join(" · ") || null,
      subPhotos: photos.filter((ph) => ph.side !== "ahc"),
      cmPhotos: photos.filter((ph) => ph.side === "ahc"),
    };
  });

  return (
    <div className="mx-auto max-w-3xl space-y-5 bg-white p-2 text-black print:p-0">
      {/* Screen-only toolbar */}
      <div className="flex items-center justify-between print:hidden">
        <Link
          href={`/projects/${params.id}/field-reports/${dpr.id}`}
          className="text-xs text-muted-foreground hover:underline"
        >
          &larr; Back to report
        </Link>
        <PrintButton />
      </div>

      {/* Letterhead */}
      <header className="border-b pb-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold">Daily Field Report</h1>
            <p className="text-sm">
              {project?.name ?? "Project"}
              {project?.client ? ` · ${project.client}` : ""}
            </p>
          </div>
          <div className="text-right text-sm">
            <p className="font-semibold">{formatDate(dpr.report_date)}</p>
            <p className="capitalize text-neutral-600">{dpr.status}</p>
          </div>
        </div>
        <p className="mt-1 text-xs text-neutral-600">
          {sub?.company_name ?? "Unassigned sub"} · submitted{" "}
          {dpr.submitted_at ? formatDate(dpr.submitted_at) : "-"}
        </p>
      </header>

      {/* Daily summary */}
      <section className="grid grid-cols-4 gap-3 text-sm">
        <Cell label="Crew">{dpr.crew_count ?? "-"}</Cell>
        <Cell label="Man-hours">{dpr.total_man_hours ?? "-"}</Cell>
        <Cell label="Weather">{dpr.weather_conditions ?? "-"}</Cell>
        <Cell label="Safety">
          {dpr.safety_incident
            ? "⚠ Incident"
            : dpr.near_miss
              ? "Near miss"
              : "OK"}
        </Cell>
      </section>

      {dpr.work_narrative && (
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Work narrative
          </h2>
          <p className="mt-1 whitespace-pre-wrap text-sm">
            {dpr.work_narrative}
          </p>
        </section>
      )}

      {dpr.safety_narrative && (
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Safety
          </h2>
          <p className="mt-1 whitespace-pre-wrap text-sm">
            {dpr.safety_narrative}
          </p>
        </section>
      )}

      {/* Work items */}
      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Work items ({items.length})
        </h2>
        <div className="space-y-3">
          {items.map((it, i) => (
            <div
              key={it.id}
              className="break-inside-avoid rounded-md border p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-sm font-semibold">
                  {i + 1}. {it.title}
                </h3>
                <span
                  className={cn(
                    "shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium",
                    STATUS_STYLE[it.status].chip,
                  )}
                >
                  {statusLabel(it.status)}
                </span>
              </div>
              {it.wbsLabel && (
                <p className="mt-0.5 text-xs text-neutral-600">{it.wbsLabel}</p>
              )}
              {it.progress && (
                <p className="text-xs text-neutral-600">Applied: {it.progress}</p>
              )}
              {it.notes && (
                <p className="mt-1 whitespace-pre-wrap text-sm">{it.notes}</p>
              )}
              {it.status === "rejected" && it.decisionNotes && (
                <p className="mt-1 rounded bg-red-50 px-2 py-1 text-xs text-red-800">
                  <span className="font-medium">Rejection reason:</span>{" "}
                  {it.decisionNotes}
                </p>
              )}
              <PhotoRow label="Sub photos" photos={it.subPhotos} />
              <PhotoRow label="CM verification photos" photos={it.cmPhotos} />
            </div>
          ))}
          {items.length === 0 && (
            <p className="text-sm text-neutral-500">
              No work items on this report.
            </p>
          )}
        </div>
      </section>

      <footer className="border-t pt-2 text-[10px] text-neutral-400 print:fixed print:bottom-2">
        Generated from the AHC PM Platform · {project?.name ?? ""} ·{" "}
        {formatDate(dpr.report_date)}
      </footer>
    </div>
  );
}

function Cell({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border p-2">
      <p className="text-[10px] uppercase tracking-wide text-neutral-500">
        {label}
      </p>
      <p className="tabular-nums">{children}</p>
    </div>
  );
}

function PhotoRow({ label, photos }: { label: string; photos: PrintPhoto[] }) {
  if (photos.length === 0) return null;
  return (
    <div className="mt-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
        {label}
      </p>
      <div className="mt-1 flex flex-wrap gap-2">
        {photos.map((p, i) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={`${p.url}-${i}`}
            src={p.url}
            alt={p.caption ?? label}
            className="h-24 w-24 break-inside-avoid rounded border object-cover"
          />
        ))}
      </div>
    </div>
  );
}
