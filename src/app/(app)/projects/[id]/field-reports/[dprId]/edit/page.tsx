import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { canReview } from "@/lib/inspection-status";
import { formatDate } from "@/lib/format";
import { parseFieldReportDraft, draftStoragePaths } from "@/lib/field-report-draft";

import { DprForm } from "../../../dprs/new/dpr-form";
import { DPR_PHOTO_BUCKET } from "../../../dprs/new/dpr-photo-uploader";
import { loadFieldReportFormData } from "../../form-data";

type Params = { id: string; dprId: string };

// Reopen a saved draft. The sub starts a report, saves it, walks away, and
// comes back to the same form with everything still in it.
//
// The checks here are for the UI's sake - they decide what to show and where to
// send you. The real gate is assertOwnedDraft() inside saveFieldReportDraft and
// submitFieldReport, which re-checks status and ownership on every write with
// the admin client. Nothing is trusted from this page.
export default async function EditFieldReportPage({ params }: { params: Params }) {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) notFound();

  const [{ data: report }, { data: profile }] = await Promise.all([
    supabase
      .from("dprs")
      .select("id, project_id, status, subcontractor_id, report_date, draft_payload")
      .eq("id", params.dprId)
      .eq("project_id", params.id)
      .maybeSingle(),
    supabase
      .from("profiles")
      .select("role, subcontractor_id")
      .eq("id", user.id)
      .maybeSingle(),
  ]);

  if (!report) notFound();

  // Filed reports are read-only. Send anyone who lands here to the record
  // rather than showing an editor that would be rejected on save.
  if (report.status !== "draft") {
    redirect(`/projects/${params.id}/field-reports/${report.id}`);
  }

  const isAhc = canReview(profile?.role ?? "");
  const ownsIt =
    profile?.subcontractor_id != null &&
    profile.subcontractor_id === report.subcontractor_id;
  if (!isAhc && !ownsIt) notFound();

  const draft = parseFieldReportDraft(report.draft_payload);

  // A draft row whose payload is missing or from an older build cannot be
  // rehydrated. Say so plainly instead of opening a blank form that would
  // silently overwrite whatever is in the row.
  if (!draft) {
    return (
      <div className="space-y-4">
        <Link
          href={`/projects/${params.id}/field-reports`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          &larr; Field Reports
        </Link>
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          <p className="font-medium">This draft cannot be reopened.</p>
          <p className="mt-1">
            It was saved by an older version of the form. Start a new report for{" "}
            {formatDate(report.report_date)} and this draft will be replaced.
          </p>
        </div>
      </div>
    );
  }

  const data = await loadFieldReportFormData(params.id);
  if (data.error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        {data.error}
      </div>
    );
  }

  // Photo previews in a saved draft are blob: URLs that died with the browser
  // session that made them, so re-sign every stored path here.
  const paths = draftStoragePaths(draft);
  const { data: signed } = paths.length
    ? await supabase.storage.from(DPR_PHOTO_BUCKET).createSignedUrls(paths, 3600)
    : { data: [] };
  const draftPhotoUrls: Record<string, string> = {};
  for (const row of signed ?? []) {
    if (row.signedUrl && !row.error) draftPhotoUrls[row.path ?? ""] = row.signedUrl;
  }

  return (
    <div className="space-y-4">
      <div>
        <Link
          href={`/projects/${params.id}/field-reports`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          &larr; Field Reports
        </Link>
        <h2 className="mt-1 text-lg font-semibold">
          Daily Field Report - {formatDate(report.report_date)}
        </h2>
        <p className="text-xs text-muted-foreground">
          Picking up the draft you saved. Nothing here is filed until you submit,
          and you can keep saving as many times as you need.
        </p>
      </div>

      <DprForm
        projectId={params.id}
        tasks={data.tasks}
        subs={data.subs}
        procurementOrders={data.procurementOrders}
        variant="fieldReport"
        initialDraft={draft}
        draftDprId={report.id}
        draftPhotoUrls={draftPhotoUrls}
      />
    </div>
  );
}
