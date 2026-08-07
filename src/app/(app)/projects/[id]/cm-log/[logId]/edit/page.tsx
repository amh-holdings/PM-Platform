import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { guardCapability } from "@/lib/roles-server";
import { formatDate } from "@/lib/format";

import { CmLogForm, type ExistingCmPhoto } from "../../new/cm-log-form";

const CM_LOG_PHOTO_BUCKET = "dpr-photos";

type Params = { id: string; logId: string };

export default async function EditCmLogPage({ params }: { params: Params }) {
  await guardCapability("viewAllReports");
  const supabase = createClient();

  const { data: log } = await supabase
    .from("cm_daily_logs")
    .select(
      "id, status, log_date, weather_conditions, temp_high, temp_low, site_conditions, progress_summary, safety_notes",
    )
    .eq("id", params.logId)
    .eq("project_id", params.id)
    .maybeSingle();

  if (!log) notFound();

  // A finalized log is locked; send the CM to the detail view to reopen it.
  if (log.status === "final") {
    redirect(`/projects/${params.id}/cm-log/${log.id}`);
  }

  const { data: photoRows } = await supabase
    .from("cm_daily_log_photos")
    .select("id, storage_path, caption")
    .eq("cm_daily_log_id", log.id)
    .order("created_at");

  const paths = (photoRows ?? []).map((r) => r.storage_path);
  const { data: signed } = paths.length
    ? await supabase.storage
        .from(CM_LOG_PHOTO_BUCKET)
        .createSignedUrls(paths, 3600)
    : { data: [] };
  const urlByPath = new Map(
    (signed ?? [])
      .filter((s) => s.signedUrl && !s.error)
      .map((s) => [s.path, s.signedUrl]),
  );
  const photos: ExistingCmPhoto[] = (photoRows ?? [])
    .map((r) => ({
      id: r.id,
      storagePath: r.storage_path,
      caption: r.caption ?? "",
      url: urlByPath.get(r.storage_path) ?? "",
    }))
    .filter((p) => p.url);

  return (
    <div className="space-y-4">
      <div>
        <Link
          href={`/projects/${params.id}/cm-log/${log.id}`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          &larr; Back to log
        </Link>
        <h2 className="mt-1 text-lg font-semibold">
          Edit daily log - {formatDate(log.log_date)}
        </h2>
        <p className="text-xs text-muted-foreground">
          Add notes and photos through the day. Save to keep the draft; finalize
          when it&apos;s the final record.
        </p>
      </div>

      <CmLogForm
        projectId={params.id}
        defaultDate={log.log_date}
        initial={{
          logId: log.id,
          logDate: log.log_date,
          weather: log.weather_conditions ?? "",
          tempHigh: log.temp_high != null ? String(log.temp_high) : "",
          tempLow: log.temp_low != null ? String(log.temp_low) : "",
          siteConditions: log.site_conditions ?? "",
          progress: log.progress_summary ?? "",
          safety: log.safety_notes ?? "",
          photos,
        }}
      />
    </div>
  );
}
