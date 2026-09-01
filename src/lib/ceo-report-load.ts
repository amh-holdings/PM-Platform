// Server-side assembly of the CEO Report.
//
// One query set, one derived object, rendered by both the screen and the print
// sheet - the same rule the weekly report follows. A print sheet that
// re-derives on its own is a report that changes between the page somebody
// approved and the PDF that left the building.
//
// Everything that DECIDES anything lives in `ceo-report.ts` and is pure. This
// module only fetches and hands over.

import { createClient } from "@/lib/supabase/server";
import {
  buildCeoReport,
  selectPhotos,
  type CeoPhoto,
  type CeoProjectRow,
  type CeoReport,
  type CeoTaskRow,
} from "@/lib/ceo-report";

/**
 * How the printed photographs are resized.
 *
 * These are 3-6 MB phone photographs straight off a superintendent's camera.
 * Handing six of them to the print pipeline unresized produced a 113 MB PDF -
 * a file nobody can email.
 *
 * BOTH axes are bounded and `resize: "contain"` is explicit, and that matters
 * more than the numbers do. Passing `{ width }` on its own does NOT preserve
 * the aspect ratio the way it reads: Supabase sets the width and leaves the
 * ORIGINAL height, so a 3264x2448 photograph comes back 600x3264 - a stretched
 * image with almost as many pixels as the source, which is why an apparent
 * "resize to 600px" barely shrank the PDF and left every photo looking
 * wrongly cropped on the page. Bounding a 1000px box instead returns about
 * 100 KB per photograph with the framing intact.
 */
const PHOTO_TRANSFORM = {
  width: 1000,
  height: 1000,
  resize: "contain",
  quality: 72,
} as const;

export type CeoReportView = CeoReport & {
  /** Records that could not be read, so a missing section is visibly missing. */
  unavailable: string[];
};

const TASK_COLS =
  "wbs_code,task_name,parent_wbs_code,phase,status,pct_complete,duration_days,start_date,end_date,baseline_start,baseline_end,is_milestone";

/** The WBS code an inspection title starts with: "5.1.1.6 Basin 1" -> "5.1.1.6". */
function wbsOf(title: string): string | null {
  const m = /^\s*(\d+(?:\.\d+)*)/.exec(title);
  return m ? m[1] : null;
}

export async function loadCeoReport(
  projectId: string,
  asOf: string,
  photoLimit = 3,
): Promise<CeoReportView | null> {
  const supabase = createClient();

  const { data: project } = await supabase
    .from("projects")
    .select(
      "id,name,client,status,contract_value,ntp_date,cod_date,dc_capacity_mw,retainage_pct_default",
    )
    .eq("id", projectId)
    .maybeSingle();

  if (!project) return null;

  const unavailable: string[] = [];

  const tasksRes = await supabase.from("schedule_tasks").select(TASK_COLS).eq("project_id", projectId);
  if (tasksRes.error) unavailable.push("Schedule");
  const tasks = (tasksRes.data ?? []) as unknown as CeoTaskRow[];

  const { photos, candidateCount } = await loadPhotos(
    supabase,
    projectId,
    asOf,
    photoLimit,
    unavailable,
  );

  const report = buildCeoReport({
    asOf,
    project: project as CeoProjectRow,
    tasks,
    photos,
    photoCandidateCount: candidateCount,
  });

  if (unavailable.length > 0) {
    report.checks.unshift({
      id: "records-unavailable",
      label: "Some records could not be read",
      severity: "blocker",
      detail:
        `${unavailable.join(", ")} could not be read for this project. Anything that depends on ` +
        `them is missing from this report rather than wrong, but it IS missing.`,
    });
  }

  return { ...report, unavailable };
}

/**
 * The photographs of the work.
 *
 * Reads the two places photos actually land - inspection photos (bucket
 * `inspection-photos`) and CM daily-log photos (bucket `dpr-photos`) - plus
 * `public.photos`, the table an in-DPR uploader writes to. That third one has
 * never held a row on any project; the weekly report read only it and reported
 * "no photos" every week while the site was being photographed daily. It is
 * still read so the uploader works if it is ever switched on.
 *
 * Both buckets are private, so a row is useless without a signed URL. Those are
 * generated per render and never stored, because they expire.
 */
async function loadPhotos(
  supabase: ReturnType<typeof createClient>,
  projectId: string,
  asOf: string,
  limit: number,
  unavailable: string[],
): Promise<{ photos: CeoPhoto[]; candidateCount: number }> {
  const loose = supabase as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, v: string) => Promise<{ data: unknown[] | null; error: unknown }>;
        in: (col: string, v: string[]) => Promise<{ data: unknown[] | null; error: unknown }>;
      };
    };
  };

  type InspRow = { id: string; title: string | null; decided_at: string | null; submitted_at: string | null; created_at: string | null };
  type LogRow = { id: string; log_date: string };
  type DprRow = { id: string; report_date: string };

  const [inspRes, logRes, dprRes] = await Promise.all([
    loose.from("inspections").select("id,title,decided_at,submitted_at,created_at").eq("project_id", projectId),
    loose.from("cm_daily_logs").select("id,log_date").eq("project_id", projectId),
    loose.from("dprs").select("id,report_date").eq("project_id", projectId),
  ]);

  if (inspRes.error && logRes.error) {
    unavailable.push("Photographs");
    return { photos: [], candidateCount: 0 };
  }

  const inspections = (inspRes.data ?? []) as InspRow[];
  const logs = (logRes.data ?? []) as LogRow[];
  const dprs = (dprRes.data ?? []) as DprRow[];

  const inspMeta = new Map(
    inspections.map((i) => [
      i.id,
      {
        title: i.title ?? "Inspection",
        taskKey: wbsOf(i.title ?? ""),
        day: (i.decided_at ?? i.submitted_at ?? i.created_at ?? "").slice(0, 10),
      },
    ]),
  );
  const logDay = new Map(logs.map((l) => [l.id, l.log_date]));
  const dprDay = new Map(dprs.map((d) => [d.id, d.report_date]));

  const ids = <T extends { id: string }>(rows: T[]) => rows.map((r) => r.id).filter(Boolean);

  const [inspPhotos, cmPhotos, dprPhotos] = await Promise.all([
    inspections.length
      ? loose.from("inspection_photos").select("id,inspection_id,side,caption,storage_path,taken_at,created_at").in("inspection_id", ids(inspections))
      : Promise.resolve({ data: [], error: null }),
    logs.length
      ? loose.from("cm_daily_log_photos").select("id,cm_daily_log_id,caption,storage_path,created_at").in("cm_daily_log_id", ids(logs))
      : Promise.resolve({ data: [], error: null }),
    dprs.length
      ? loose.from("photos").select("id,dpr_id,caption,storage_path,taken_at,created_at").in("dpr_id", ids(dprs))
      : Promise.resolve({ data: [], error: null }),
  ]);

  type Pending = CeoPhoto & { bucket: string; path: string };
  const pending: Pending[] = [];

  for (const p of (inspPhotos.data ?? []) as {
    id: string; inspection_id: string; side: string; caption: string | null;
    storage_path: string; taken_at: string | null; created_at: string | null;
  }[]) {
    const meta = inspMeta.get(p.inspection_id);
    pending.push({
      key: `insp:${p.id}`,
      day: (p.taken_at ?? p.created_at ?? "").slice(0, 10) || meta?.day || "",
      // The side matters: an AHC photo is our own verification, a sub photo is
      // what they submitted for it.
      who: `${meta?.title ?? "Inspection"} (${p.side === "ahc" ? "AHC" : "sub"})`,
      caption: p.caption,
      source: "inspection",
      taskKey: meta?.taskKey ?? null,
      url: null,
      bucket: "inspection-photos",
      path: p.storage_path,
    });
  }

  for (const p of (cmPhotos.data ?? []) as {
    id: string; cm_daily_log_id: string; caption: string | null;
    storage_path: string; created_at: string | null;
  }[]) {
    pending.push({
      key: `cmlog:${p.id}`,
      day: logDay.get(p.cm_daily_log_id) ?? (p.created_at ?? "").slice(0, 10),
      who: "CM daily log",
      caption: p.caption,
      source: "cmlog",
      taskKey: null,
      url: null,
      bucket: "dpr-photos",
      path: p.storage_path,
    });
  }

  for (const p of (dprPhotos.data ?? []) as {
    id: string; dpr_id: string | null; caption: string | null;
    storage_path: string; taken_at: string | null; created_at: string | null;
  }[]) {
    pending.push({
      key: `dpr:${p.id}`,
      day: (p.taken_at ?? p.created_at ?? "").slice(0, 10) || (p.dpr_id ? dprDay.get(p.dpr_id) ?? "" : ""),
      who: "Field report",
      caption: p.caption,
      source: "dpr",
      taskKey: null,
      url: null,
      bucket: "dpr-photos",
      path: p.storage_path,
    });
  }

  // Nothing taken after the as-of date: this report is a statement about a
  // moment, and a photo from after it does not belong in the record of it.
  const inScope = pending.filter((p) => p.day && p.day <= asOf);

  // Choose FIRST, sign second. `createSignedUrls` (plural) is one round trip
  // but takes no transform option, so signing everything would mean serving
  // full-resolution originals. Signing the chosen few one at a time costs six
  // requests and buys the resize that keeps the PDF emailable.
  const chosen = selectPhotos(inScope, limit) as typeof inScope;

  const signed = await Promise.all(
    chosen.map(async (p) => {
      const res = await supabase.storage
        .from(p.bucket)
        .createSignedUrl(p.path, 60 * 60, { transform: { ...PHOTO_TRANSFORM } });
      return {
        key: p.key,
        day: p.day,
        who: p.who,
        caption: p.caption,
        source: p.source,
        taskKey: p.taskKey,
        url: res.data?.signedUrl ?? null,
      };
    }),
  );

  return { photos: signed.filter((p) => p.url), candidateCount: inScope.length };
}
