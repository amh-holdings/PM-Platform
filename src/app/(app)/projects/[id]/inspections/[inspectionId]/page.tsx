import Link from "next/link";
import { notFound } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/format";
import {
  isInspectionApprover,
  canReview,
  STATUS_STYLE,
  statusLabel,
  type InspectionStatus,
} from "@/lib/inspection-status";
import { cn } from "@/lib/utils";
import { InspectionMap } from "../inspection-map";
import { ReviewPanel } from "./review-panel";

type Params = { id: string; inspectionId: string };

export default async function InspectionDetailPage({
  params,
}: {
  params: Params;
}) {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = user
    ? await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle()
    : { data: null };
  const role = profile?.role ?? "";

  const { data: insp } = await supabase
    .from("inspections")
    .select(
      "id, project_id, title, status, inspection_type, notes, quantity, unit_of_measure, basemap_key, pin_x, pin_y, gps_lat, gps_lng, inspector_name, submitted_at, ahc_notes, decision_notes, decided_at, sub_acknowledged_at, subcontractor_id",
    )
    .eq("id", params.inspectionId)
    .eq("project_id", params.id)
    .maybeSingle();

  if (!insp) notFound();

  const [{ data: photos }, { data: sub }] = await Promise.all([
    supabase
      .from("inspection_photos")
      .select("id, side, storage_path, caption, gps_lat, gps_lng, taken_at")
      .eq("inspection_id", insp.id)
      .order("created_at"),
    insp.subcontractor_id
      ? supabase
          .from("subcontractors")
          .select("company_name")
          .eq("id", insp.subcontractor_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const status = insp.status as InspectionStatus;
  const subPhotos = (photos ?? []).filter((p) => p.side === "sub");
  const ahcPhotos = (photos ?? []).filter((p) => p.side === "ahc");
  const canDecide = isInspectionApprover({ role });
  const reviewer = canReview(role);

  return (
    <div className="space-y-5">
      <div>
        <Link
          href={`/projects/${params.id}/inspections`}
          className="text-xs text-muted-foreground hover:underline"
        >
          ← Back to inspections
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold">{insp.title}</h2>
          <span
            className={cn(
              "inline-flex rounded-full border px-2 py-0.5 text-xs font-medium",
              STATUS_STYLE[status].chip,
            )}
          >
            {statusLabel(status)}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {sub?.company_name ?? "Unknown sub"}
          {insp.inspection_type ? ` · ${insp.inspection_type}` : ""} · submitted{" "}
          {insp.submitted_at ? formatDate(insp.submitted_at) : "-"}
          {insp.inspector_name ? ` by ${insp.inspector_name}` : ""}
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-2">
          <InspectionMap
            basemapKey={insp.basemap_key}
            pins={[
              {
                id: insp.id,
                pinX: insp.pin_x,
                pinY: insp.pin_y,
                status,
                title: insp.title,
              },
            ]}
            activeId={insp.id}
          />
          <div className="rounded-md border bg-card p-3 text-sm">
            <dl className="grid grid-cols-2 gap-2">
              <Field label="Quantity">
                {insp.quantity != null
                  ? `${insp.quantity} ${insp.unit_of_measure ?? ""}`
                  : "-"}
              </Field>
              <Field label="GPS (record)">
                {insp.gps_lat != null && insp.gps_lng != null
                  ? `${insp.gps_lat}, ${insp.gps_lng}`
                  : "-"}
              </Field>
            </dl>
            {insp.notes && (
              <p className="mt-2 whitespace-pre-wrap text-sm">{insp.notes}</p>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <PhotoSet title="Sub submission photos" photos={subPhotos} />
          <PhotoSet title="AHC verification photos" photos={ahcPhotos} />
          {insp.ahc_notes && (
            <div className="rounded-md border bg-blue-50 p-3 text-sm">
              <div className="text-xs font-medium text-blue-800">AHC notes</div>
              {insp.ahc_notes}
            </div>
          )}
          {insp.decision_notes && (
            <div className="rounded-md border bg-muted p-3 text-sm">
              <div className="text-xs font-medium text-muted-foreground">
                Decision note
              </div>
              {insp.decision_notes}
            </div>
          )}
          {insp.sub_acknowledged_at && (
            <p className="text-xs text-green-700">
              Sub acknowledged the verified record on{" "}
              {formatDate(insp.sub_acknowledged_at)}.
            </p>
          )}
        </div>
      </div>

      {reviewer && (
        <ReviewPanel
          projectId={params.id}
          inspectionId={insp.id}
          status={status}
          canDecide={canDecide}
        />
      )}
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

function PhotoSet({
  title,
  photos,
}: {
  title: string;
  photos: Array<{
    id: string;
    storage_path: string;
    caption: string | null;
    gps_lat: number | null;
    gps_lng: number | null;
  }>;
}) {
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title} ({photos.length})
      </div>
      {photos.length === 0 ? (
        <p className="text-xs text-muted-foreground">None yet.</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {photos.map((p) => (
            <li key={p.id} className="flex justify-between gap-2">
              <span className="truncate font-mono">{p.storage_path}</span>
              {p.gps_lat != null && p.gps_lng != null && (
                <span className="shrink-0 text-muted-foreground">
                  {p.gps_lat.toFixed(4)}, {p.gps_lng.toFixed(4)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
