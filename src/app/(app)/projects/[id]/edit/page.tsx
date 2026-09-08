import { notFound } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { coClient } from "@/lib/database.types.co";

import { AutoFillButton } from "../auto-fill-button";
import { ProjectEditForm } from "./project-edit-form";

type Params = { id: string };

export default async function ProjectEditPage({ params }: { params: Params }) {
  const supabase = coClient(createClient());
  const aiEnabled = Boolean(
    process.env.RELAY_URL && process.env.RELAY_SHARED_SECRET,
  );
  const { data: project } = await supabase
    .from("projects")
    .select("id, name, client, status, contract_value, ntp_date, cod_date, zip_code, owner_payment_terms_days, retainage_pct_default, retainage_release_event, original_contract_value, agreement_date, guaranteed_mechanical_completion_date, guaranteed_substantial_completion_date")
    .eq("id", params.id)
    .maybeSingle();

  if (!project) {
    notFound();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Edit project</h2>
        {aiEnabled && (
          <AutoFillButton
            projectId={params.id}
            current={{
              client: project.client,
              contract_value: project.contract_value,
              ntp_date: project.ntp_date,
              cod_date: project.cod_date,
              zip_code: project.zip_code,
            }}
          />
        )}
      </div>
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <ProjectEditForm project={project} />
      </div>
    </div>
  );
}
