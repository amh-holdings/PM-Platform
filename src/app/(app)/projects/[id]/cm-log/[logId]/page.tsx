import Link from "next/link";
import { notFound } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { guardCapability } from "@/lib/roles-server";
import { formatDate } from "@/lib/format";

const CM_LOG_PHOTO_BUCKET = "dpr-photos";

type Params = { id: string; logId: string };

export default async function CmLogDetailPage({
  params,
}: {
  params: Params;
}) {
  await guardCapability("viewAllReports");
  const supabase = createClient();

  const { data: log } = await supabase
    .from("cm_daily_logs")
    .select(
      "id, log_date, weather_conditions, temp_high, temp_low, site_conditions, progress_summary, safety_notes",
    )
    .eq("id", params.logId)
    .eq("project_id", params.id)
    .maybeSingle();

  if (!log) notFound();

  // Sign short-lived URLs for the private photo bucket so the browser can
  // render them (same approach as the field-report detail page).
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
  const photos = (photoRows ?? [])
    .map((r) => ({
      url: urlByPath.get(r.storage_path),
      caption: r.caption,
    }))
    .filter((p): p is { url: string; caption: string | null } => Boolean(p.url));

  const temp =
    log.temp_high != null || log.temp_low != null
      ? `${log.temp_high ?? "-"}° / ${log.temp_low ?? "-"}°`
      : "-";

  return (
    <div className="space-y-5">
      <div>
        <Link
          href={`/projects/${params.id}/cm-log`}
          className="text-xs text-muted-foreground hover:underline"
        >
          &larr; My Daily Log
        </Link>
        <h2 className="mt-1 text-lg font-semibold">
          {formatDate(log.log_date)}
        </h2>
        <p className="text-xs text-muted-foreground">Construction Manager daily log</p>
      </div>

      <div className="rounded-lg border bg-card p-4 text-sm">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Weather">{log.weather_conditions ?? "-"}</Field>
          <Field label="High / Low">{temp}</Field>
        </div>
        {log.site_conditions && (
          <Block label="Site conditions">{log.site_conditions}</Block>
        )}
        {log.progress_summary && (
          <Block label="Progress summary">{log.progress_summary}</Block>
        )}
        {log.safety_notes && (
          <Block label="Safety notes">{log.safety_notes}</Block>
        )}
      </div>

      {photos.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">Photos ({photos.length})</h3>
          <div className="flex flex-wrap gap-2">
            {photos.map((p, i) => (
              <a
                key={`${p.url}-${i}`}
                href={p.url}
                target="_blank"
                rel="noopener noreferrer"
                title={p.caption ?? "Open full size"}
                className="block h-28 w-28 overflow-hidden rounded-md border bg-muted"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={p.url}
                  alt={p.caption ?? "CM log photo"}
                  className="h-full w-full object-cover"
                />
              </a>
            ))}
          </div>
        </div>
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

function Block({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 whitespace-pre-wrap">{children}</p>
    </div>
  );
}
