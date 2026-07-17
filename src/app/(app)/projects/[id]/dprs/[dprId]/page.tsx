import Link from "next/link";
import { notFound } from "next/navigation";

import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/format";

import { DprReviewActions } from "./dpr-review-actions";
import { DPR_PHOTO_BUCKET } from "../new/dpr-photo-uploader";

type Params = { id: string; dprId: string };

const STATUS_TONE: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  submitted: "bg-amber-100 text-amber-900",
  approved: "bg-emerald-100 text-emerald-900",
  returned: "bg-destructive/10 text-destructive",
};

export default async function DprDetailPage({ params }: { params: Params }) {
  const supabase = createClient();

  const { data: dpr, error } = await supabase
    .from("dprs")
    .select(
      "id, project_id, report_date, status, work_narrative, crew_count, total_man_hours, weather_conditions, safety_incident, near_miss, safety_narrative, toolbox_topic, toolbox_attendees, submitted_at, reviewed_at, review_notes",
    )
    .eq("id", params.dprId)
    .maybeSingle();
  if (error || !dpr) notFound();

  const [
    updatesRes,
    manpowerRes,
    equipmentRes,
    deliveriesRes,
    delaysRes,
    photosRes,
  ] = await Promise.all([
    supabase
      .from("dpr_task_updates")
      .select(
        "id, schedule_task_id, previous_status, new_status, previous_pct_complete, new_pct_complete, installed_quantity, notes",
      )
      .eq("dpr_id", params.dprId),
    supabase
      .from("dpr_manpower")
      .select("id, subcontractor_id, trade, headcount, regular_hours, ot_hours, notes")
      .eq("dpr_id", params.dprId),
    supabase
      .from("dpr_equipment")
      .select("id, equipment_name, quantity, on_rent, rental_company, operating_hours, idle_hours, notes")
      .eq("dpr_id", params.dprId),
    supabase
      .from("dpr_deliveries")
      .select(
        "id, vendor_name, materials, quantity, unit_of_measure, po_number, procurement_order_id, notes",
      )
      .eq("dpr_id", params.dprId),
    supabase
      .from("dpr_delays")
      .select(
        "id, cause_code, hours_lost, impacted_schedule_task_id, narrative",
      )
      .eq("dpr_id", params.dprId),
    supabase
      .from("photos")
      .select("id, storage_path, caption, photo_type, taken_at")
      .eq("dpr_id", params.dprId)
      .order("taken_at", { ascending: true }),
  ]);

  const updates = updatesRes.data ?? [];
  const manpower = manpowerRes.data ?? [];
  const equipment = equipmentRes.data ?? [];
  const deliveries = deliveriesRes.data ?? [];
  const delays = delaysRes.data ?? [];
  const photos = photosRes.data ?? [];

  // Resolve schedule task labels for both task updates and delay impacted_schedule_task_id
  const taskIds = Array.from(
    new Set([
      ...updates.map((u) => u.schedule_task_id).filter((id): id is string => !!id),
      ...delays
        .map((d) => d.impacted_schedule_task_id)
        .filter((id): id is string => !!id),
    ]),
  );
  const { data: taskRows } = taskIds.length
    ? await supabase
        .from("schedule_tasks")
        .select("id, wbs_code, task_name, phase")
        .in("id", taskIds)
    : { data: [] };
  const taskById = new Map((taskRows ?? []).map((t) => [t.id, t]));

  // Resolve subcontractors for manpower
  const subIds = Array.from(
    new Set(
      manpower
        .map((m) => m.subcontractor_id)
        .filter((id): id is string => !!id),
    ),
  );
  const { data: subRows } = subIds.length
    ? await supabase
        .from("subcontractors")
        .select("id, company_name")
        .in("id", subIds)
    : { data: [] };
  const subById = new Map((subRows ?? []).map((s) => [s.id, s.company_name]));

  // Sign photo URLs server-side. Hour-long expiry; this page is server-rendered.
  const signedPhotos: Array<{
    id: string;
    url: string | null;
    caption: string | null;
    photoType: string | null;
  }> = [];
  if (photos.length > 0) {
    const paths = photos.map((p) => p.storage_path);
    const { data: signed } = await supabase.storage
      .from(DPR_PHOTO_BUCKET)
      .createSignedUrls(paths, 60 * 60);
    const urlByPath = new Map(
      (signed ?? []).map((s) => [s.path ?? "", s.signedUrl]),
    );
    for (const p of photos) {
      signedPhotos.push({
        id: p.id,
        url: urlByPath.get(p.storage_path) ?? null,
        caption: p.caption,
        photoType: p.photo_type,
      });
    }
  }

  // Manpower rollups
  const totalHeadcount = manpower.reduce((sum, m) => sum + (m.headcount ?? 0), 0);
  const totalHours = manpower.reduce(
    (sum, m) => sum + Number(m.regular_hours ?? 0) + Number(m.ot_hours ?? 0),
    0,
  );
  const totalDelayHours = delays.reduce(
    (sum, d) => sum + Number(d.hours_lost ?? 0),
    0,
  );

  return (
    <div className="space-y-4">
      <div>
        <Link
          href={`/projects/${params.id}/dprs`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          &larr; DPRs
        </Link>
        <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-lg font-semibold">
            DPR for {formatDate(dpr.report_date)}
          </h2>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-xs font-medium capitalize",
              STATUS_TONE[dpr.status ?? ""] ?? "bg-muted",
            )}
          >
            {dpr.status}
          </span>
        </div>
      </div>

      <section className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-md border bg-card p-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Crew count
          </div>
          <div className="mt-1 text-base font-semibold">
            {dpr.crew_count ?? "-"}
          </div>
        </div>
        <div className="rounded-md border bg-card p-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Total man-hours
          </div>
          <div className="mt-1 text-base font-semibold">
            {dpr.total_man_hours ?? "-"}
          </div>
        </div>
        <div className="rounded-md border bg-card p-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Weather
          </div>
          <div className="mt-1 text-sm">{dpr.weather_conditions ?? "-"}</div>
        </div>
      </section>

      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h3 className="text-sm font-semibold">Work narrative</h3>
        <p className="mt-2 whitespace-pre-wrap text-sm">{dpr.work_narrative}</p>
      </section>

      {/* ===== Photos ===== */}
      {signedPhotos.length > 0 && (
        <section className="rounded-lg border bg-card p-4 shadow-sm">
          <h3 className="text-sm font-semibold">Photos ({signedPhotos.length})</h3>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {signedPhotos.map((p) => (
              <a
                key={p.id}
                href={p.url ?? "#"}
                target="_blank"
                rel="noreferrer"
                className="space-y-1 rounded-md border bg-background p-2 transition-colors hover:bg-muted/30"
              >
                {p.url ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={p.url}
                    alt={p.caption ?? "DPR photo"}
                    className="aspect-square w-full rounded object-cover"
                  />
                ) : (
                  <div className="flex aspect-square w-full items-center justify-center rounded bg-muted text-[10px] text-muted-foreground">
                    Signed URL failed
                  </div>
                )}
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {p.photoType ?? "photo"}
                </div>
                {p.caption && (
                  <div className="line-clamp-2 text-xs">{p.caption}</div>
                )}
              </a>
            ))}
          </div>
        </section>
      )}

      {/* ===== Manpower ===== */}
      {manpower.length > 0 && (
        <section className="rounded-lg border bg-card p-4 shadow-sm">
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-semibold">
              Manpower ({manpower.length})
            </h3>
            <div className="text-xs text-muted-foreground">
              Total: {totalHeadcount} crew, {totalHours} hrs
            </div>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  <th className="py-1.5 pr-2 text-left font-medium">Sub</th>
                  <th className="py-1.5 pr-2 text-left font-medium">Trade</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Crew</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Reg hrs</th>
                  <th className="py-1.5 pr-2 text-right font-medium">OT hrs</th>
                  <th className="py-1.5 text-left font-medium">Notes</th>
                </tr>
              </thead>
              <tbody>
                {manpower.map((m) => (
                  <tr key={m.id} className="border-b last:border-0">
                    <td className="py-1.5 pr-2">
                      {m.subcontractor_id
                        ? subById.get(m.subcontractor_id) ?? "?"
                        : "-"}
                    </td>
                    <td className="py-1.5 pr-2">{m.trade ?? "-"}</td>
                    <td className="py-1.5 pr-2 text-right">{m.headcount}</td>
                    <td className="py-1.5 pr-2 text-right">{m.regular_hours}</td>
                    <td className="py-1.5 pr-2 text-right">{m.ot_hours}</td>
                    <td className="py-1.5 text-muted-foreground">
                      {m.notes ?? "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ===== Equipment ===== */}
      {equipment.length > 0 && (
        <section className="rounded-lg border bg-card p-4 shadow-sm">
          <h3 className="text-sm font-semibold">Equipment ({equipment.length})</h3>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  <th className="py-1.5 pr-2 text-left font-medium">Equipment</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Qty</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Op hrs</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Idle hrs</th>
                  <th className="py-1.5 pr-2 text-left font-medium">On rent</th>
                  <th className="py-1.5 pr-2 text-left font-medium">Rental</th>
                  <th className="py-1.5 text-left font-medium">Notes</th>
                </tr>
              </thead>
              <tbody>
                {equipment.map((e) => (
                  <tr key={e.id} className="border-b last:border-0">
                    <td className="py-1.5 pr-2 font-medium">{e.equipment_name}</td>
                    <td className="py-1.5 pr-2 text-right">{e.quantity}</td>
                    <td className="py-1.5 pr-2 text-right">
                      {e.operating_hours ?? "-"}
                    </td>
                    <td className="py-1.5 pr-2 text-right">
                      {e.idle_hours ?? "-"}
                    </td>
                    <td className="py-1.5 pr-2">{e.on_rent ? "Yes" : "No"}</td>
                    <td className="py-1.5 pr-2">{e.rental_company ?? "-"}</td>
                    <td className="py-1.5 text-muted-foreground">
                      {e.notes ?? "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ===== Deliveries ===== */}
      {deliveries.length > 0 && (
        <section className="rounded-lg border bg-card p-4 shadow-sm">
          <h3 className="text-sm font-semibold">Deliveries ({deliveries.length})</h3>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  <th className="py-1.5 pr-2 text-left font-medium">Vendor</th>
                  <th className="py-1.5 pr-2 text-left font-medium">Materials</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Qty</th>
                  <th className="py-1.5 pr-2 text-left font-medium">UoM</th>
                  <th className="py-1.5 pr-2 text-left font-medium">PO</th>
                  <th className="py-1.5 text-left font-medium">Notes</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id} className="border-b last:border-0">
                    <td className="py-1.5 pr-2">{d.vendor_name ?? "-"}</td>
                    <td className="py-1.5 pr-2 font-medium">{d.materials}</td>
                    <td className="py-1.5 pr-2 text-right">{d.quantity ?? "-"}</td>
                    <td className="py-1.5 pr-2">{d.unit_of_measure ?? "-"}</td>
                    <td className="py-1.5 pr-2 font-mono">{d.po_number ?? "-"}</td>
                    <td className="py-1.5 text-muted-foreground">
                      {d.notes ?? "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ===== Delays ===== */}
      {delays.length > 0 && (
        <section className="rounded-lg border border-amber-500/40 bg-amber-50/30 p-4 shadow-sm">
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-semibold">Delays ({delays.length})</h3>
            <div className="text-xs text-muted-foreground">
              Total hours lost: {totalDelayHours}
            </div>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  <th className="py-1.5 pr-2 text-left font-medium">Cause</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Hrs lost</th>
                  <th className="py-1.5 pr-2 text-left font-medium">Impacted task</th>
                  <th className="py-1.5 text-left font-medium">Narrative</th>
                </tr>
              </thead>
              <tbody>
                {delays.map((d) => {
                  const task = d.impacted_schedule_task_id
                    ? taskById.get(d.impacted_schedule_task_id)
                    : null;
                  return (
                    <tr key={d.id} className="border-b last:border-0">
                      <td className="py-1.5 pr-2 font-medium capitalize">
                        {d.cause_code}
                      </td>
                      <td className="py-1.5 pr-2 text-right">
                        {d.hours_lost ?? "-"}
                      </td>
                      <td className="py-1.5 pr-2">
                        {task ? (
                          <span>
                            <span className="font-mono text-[10px]">{task.wbs_code}</span>{" "}
                            {task.task_name}
                          </span>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td className="py-1.5 text-muted-foreground">
                        {d.narrative ?? "-"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ===== Safety ===== */}
      {(dpr.safety_incident ||
        dpr.near_miss ||
        dpr.safety_narrative ||
        dpr.toolbox_topic) && (
        <section className="rounded-lg border border-amber-500/40 bg-amber-50/30 p-4 shadow-sm">
          <h3 className="text-sm font-semibold">Safety</h3>
          <div className="mt-2 flex flex-wrap gap-3 text-xs">
            {dpr.safety_incident && (
              <span className="rounded-full bg-destructive/10 px-2 py-0.5 font-medium text-destructive">
                Incident reported
              </span>
            )}
            {dpr.near_miss && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-900">
                Near miss
              </span>
            )}
          </div>
          {dpr.toolbox_topic && (
            <p className="mt-2 text-sm">
              <span className="font-medium">Toolbox talk:</span>{" "}
              {dpr.toolbox_topic}
              {dpr.toolbox_attendees != null
                ? ` (${dpr.toolbox_attendees} attended)`
                : ""}
            </p>
          )}
          {dpr.safety_narrative && (
            <p className="mt-2 whitespace-pre-wrap text-sm">
              {dpr.safety_narrative}
            </p>
          )}
        </section>
      )}

      {/* ===== Schedule task updates ===== */}
      <section className="rounded-lg border bg-card p-4 shadow-sm">
        <h3 className="text-sm font-semibold">
          Proposed schedule task updates ({updates.length})
        </h3>
        {updates.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            This DPR did not propose any task changes.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr className="border-b">
                  <th className="py-1.5 pr-2 text-left font-medium">Task</th>
                  <th className="py-1.5 pr-2 text-left font-medium">Status</th>
                  <th className="py-1.5 pr-2 text-right font-medium">% complete</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Installed qty</th>
                  <th className="py-1.5 text-left font-medium">Notes</th>
                </tr>
              </thead>
              <tbody>
                {updates.map((u) => {
                  const t = u.schedule_task_id ? taskById.get(u.schedule_task_id) : null;
                  return (
                    <tr key={u.id} className="border-b last:border-0">
                      <td className="py-1.5 pr-2">
                        <div className="font-mono text-[10px]">{t?.wbs_code ?? "?"}</div>
                        <div className="font-medium">{t?.task_name ?? "?"}</div>
                      </td>
                      <td className="py-1.5 pr-2">
                        <span className="text-muted-foreground">
                          {u.previous_status ?? "-"}
                        </span>{" "}
                        &rarr;{" "}
                        <span className="font-medium">{u.new_status ?? "-"}</span>
                      </td>
                      <td className="py-1.5 pr-2 text-right">
                        <span className="text-muted-foreground">
                          {u.previous_pct_complete ?? "-"}%
                        </span>{" "}
                        &rarr;{" "}
                        <span className="font-medium">
                          {u.new_pct_complete ?? "-"}%
                        </span>
                      </td>
                      <td className="py-1.5 pr-2 text-right">
                        {u.installed_quantity ?? "-"}
                      </td>
                      <td className="py-1.5 text-muted-foreground">
                        {u.notes ?? "-"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {dpr.review_notes && (
        <section className="rounded-lg border bg-muted/30 p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Review notes
          </h3>
          <p className="mt-2 whitespace-pre-wrap text-sm">{dpr.review_notes}</p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Reviewed {dpr.reviewed_at ? formatDate(dpr.reviewed_at) : ""}
          </p>
        </section>
      )}

      {dpr.status === "submitted" && (
        <DprReviewActions dprId={dpr.id} projectId={params.id} />
      )}
    </div>
  );
}
