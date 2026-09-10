import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";

import { DOCUMENT_BUCKET } from "./documents-constants";
import { SubFormDialog } from "./sub-form-dialog";
import { SubList } from "./sub-list";
import type { SubContractDoc } from "./sub-contract-dialog";

type Props = {
  projectId: string;
};

export async function SubcontractorsSection({ projectId }: Props) {
  const supabase = createClient();
  const { data: subs, error } = await supabase
    .from("subcontractors")
    .select(
      "id, company_name, trade, contact_name, contact_email, contact_phone, contract_value, retainage_pct, coi_status, w9_status, payment_terms, payment_terms_days, active",
    )
    .eq("project_id", projectId)
    .order("active", { ascending: false })
    .order("company_name", { ascending: true });

  // document_id is asked for in a second query, not folded into the one above,
  // because migrations here are applied by hand: if 0048 has not landed yet a
  // combined select would fail and take the whole roster down with it. On
  // failure the column simply stays hidden and the page is what it was before.
  const linkRes = await supabase
    .from("subcontractors")
    .select("id, document_id")
    .eq("project_id", projectId);
  const contractsEnabled = !linkRes.error;

  const docIdBySub = new Map<string, string>();
  for (const row of linkRes.data ?? []) {
    if (row.document_id) docIdBySub.set(row.id, row.document_id);
  }

  const docIds = Array.from(new Set(docIdBySub.values()));
  const { data: docs } = docIds.length
    ? await supabase
        .from("project_documents")
        .select("id, file_name, size_bytes, storage_path, uploaded_at")
        .in("id", docIds)
    : { data: null };

  // The bucket is private, so hand the client short-lived signed links.
  const paths = (docs ?? []).map((d) => d.storage_path);
  const signed =
    paths.length > 0
      ? await supabase.storage.from(DOCUMENT_BUCKET).createSignedUrls(paths, 3600)
      : { data: null };
  const urlByPath = new Map<string, string>();
  (signed.data ?? []).forEach((s, i) => {
    if (s.signedUrl) urlByPath.set(paths[i], s.signedUrl);
  });

  const docById = new Map<string, SubContractDoc>(
    (docs ?? []).map((d) => [
      d.id,
      {
        id: d.id,
        file_name: d.file_name,
        size_bytes: d.size_bytes,
        uploaded_at: d.uploaded_at,
        signedUrl: urlByPath.get(d.storage_path) ?? null,
      },
    ]),
  );

  const rows = (subs ?? []).map((s) => {
    const docId = docIdBySub.get(s.id);
    return {
      ...s,
      contract_doc: docId ? docById.get(docId) ?? null : null,
    };
  });

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Subcontractors</h2>
          <p className="text-xs text-muted-foreground">
            Roster of subs on this project. Tracks
            {contractsEnabled ? " the executed subcontract," : ""} contract
            value, COI, and W9 compliance.
          </p>
        </div>
        <SubFormDialog
          projectId={projectId}
          trigger={<Button>Add subcontractor</Button>}
        />
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          Failed to load subcontractors: {error.message}
        </div>
      ) : (
        <SubList
          projectId={projectId}
          subs={rows}
          contractsEnabled={contractsEnabled}
        />
      )}
    </section>
  );
}
