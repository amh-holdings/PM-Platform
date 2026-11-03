import { guardCapability } from "@/lib/roles-server";
import { createClient } from "@/lib/supabase/server";
import {
  nextRfiNumber,
  projectRfiPrefix,
  sortRfis,
  summarise,
  toRfiRow,
} from "@/lib/rfi-log";

import { DOCUMENT_BUCKET } from "../documents-constants";
import type { RfiAttachment } from "../rfi-attachments";
import { RfiLog } from "../rfi-log-view";

type Params = { id: string };

const COLS =
  "id, rfi_number, subject, question, discipline, wbs_code, subcontractor_id, raised_by, eor_firm, eor_contact, received_at, sent_to_eor_at, date_answered, closed_at, date_needed, date_issued, response, cost_impact, schedule_impact, reference_doc, suggested_answer, location, priority";

export default async function ProjectRfisPage({ params }: { params: Params }) {
  await guardCapability("viewRfis");

  const supabase = createClient();

  // 0084 is applied by hand like every migration here, so a database without
  // it loses the page rather than the whole project.
  const res = await supabase
    .from("rfis")
    .select(COLS)
    .eq("project_id", params.id);

  if (res.error) {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        Apply migration 0084 to use the RFI log. ({res.error.message})
      </div>
    );
  }

  const { data: subs } = await supabase
    .from("subcontractors")
    .select("id, company_name")
    .eq("project_id", params.id)
    .neq("active", false)
    .order("company_name", { ascending: true });

  const { data: project } = await supabase
    .from("projects")
    .select("name")
    .eq("id", params.id)
    .maybeSingle();

  // Attachments. 0085 separately, for the same reason: the log keeps working
  // without it, minus the photos.
  const docs = await supabase
    .from("project_documents")
    .select("id, rfi_id, file_name, category, mime_type, size_bytes, storage_path")
    .eq("project_id", params.id)
    .not("rfi_id", "is", null);

  const attachmentsEnabled = !docs.error;
  const attachments: Record<string, RfiAttachment[]> = {};

  if (!docs.error && docs.data && docs.data.length > 0) {
    // One round trip for every signature rather than one each.
    const paths = docs.data.map((d) => d.storage_path);
    const { data: signed } = await supabase.storage
      .from(DOCUMENT_BUCKET)
      .createSignedUrls(paths, 3600);

    const urlByPath = new Map<string, string>();
    (signed ?? []).forEach((s, i) => {
      if (s.signedUrl) urlByPath.set(paths[i], s.signedUrl);
    });

    for (const d of docs.data) {
      if (!d.rfi_id) continue;
      (attachments[d.rfi_id] ??= []).push({
        id: d.id,
        fileName: d.file_name,
        category: d.category,
        mimeType: d.mime_type,
        sizeBytes: d.size_bytes,
        url: urlByPath.get(d.storage_path) ?? null,
      });
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const rows = (res.data ?? []).map(toRfiRow);

  return (
    <RfiLog
      projectId={params.id}
      rfis={sortRfis(rows, today)}
      summary={summarise(rows, today)}
      subs={subs ?? []}
      today={today}
      // The same call the insert makes, so what the form shows is what gets
      // written. Two different rules here would show RFI-001 and save
      // SUS-RFI-001, and the number on the screen is the one people write
      // down before they hit save.
      suggestedNumber={nextRfiNumber(
        rows.map((r) => r.rfi_number).filter(Boolean),
        projectRfiPrefix(project?.name),
      )}
      attachments={attachments}
      attachmentsEnabled={attachmentsEnabled}
    />
  );
}
