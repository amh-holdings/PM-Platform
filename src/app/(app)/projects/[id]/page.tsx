import Link from "next/link";
import { notFound } from "next/navigation";

import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";
import { formatCurrency, formatDate } from "@/lib/format";

import { AutoFillButton } from "./auto-fill-button";
import { CostCodesSection } from "./cost-section";
import { DocumentsSection } from "./documents-section";
import { ProjectChat } from "./project-chat";
import { SubcontractorsSection } from "./subs-section";
import { WbsSection } from "./wbs-section";

type Params = { id: string };

export async function generateMetadata({ params }: { params: Params }) {
  const supabase = createClient();
  const { data } = await supabase
    .from("projects")
    .select("name")
    .eq("id", params.id)
    .maybeSingle();
  return {
    title: data ? `${data.name} - AHC PM Platform` : "Project - AHC PM Platform",
  };
}

export default async function ProjectDetailPage({ params }: { params: Params }) {
  const supabase = createClient();
  const aiEnabled = Boolean(
    process.env.RELAY_URL && process.env.RELAY_SHARED_SECRET,
  );
  const { data: project, error } = await supabase
    .from("projects")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();

  if (error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
        Failed to load project: {error.message}
      </div>
    );
  }

  if (!project) {
    notFound();
  }

  const fields: { label: string; value: React.ReactNode }[] = [
    { label: "Client", value: project.client ?? "-" },
    {
      label: "Status",
      value: project.status ? (
        <span className="inline-flex items-center rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium">
          {project.status}
        </span>
      ) : (
        "-"
      ),
    },
    { label: "Contract value", value: formatCurrency(project.contract_value) },
    { label: "NTP date", value: formatDate(project.ntp_date) },
    { label: "COD date", value: formatDate(project.cod_date) },
    { label: "Zip code", value: project.zip_code ?? "-" },
    { label: "Created", value: formatDate(project.created_at) },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Link
            href="/projects"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            &larr; Projects
          </Link>
          <h1 className="mt-1 text-2xl font-semibold">{project.name}</h1>
        </div>
        <div className="flex items-center gap-2">
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
          <Button asChild variant="outline">
            <Link href={`/projects/${params.id}/edit`}>Edit</Link>
          </Button>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          {fields.map((field) => (
            <div key={field.label} className="space-y-1">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                {field.label}
              </dt>
              <dd className="text-sm">{field.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {aiEnabled && <ProjectChat projectId={params.id} />}

      <SubcontractorsSection projectId={params.id} />

      <WbsSection projectId={params.id} aiEnabled={aiEnabled} />

      <CostCodesSection projectId={params.id} />

      <DocumentsSection projectId={params.id} />

      <div className="rounded-lg border border-dashed bg-card p-6 text-sm text-muted-foreground">
        Schedule, DPRs, RFIs, submittals, photos coming next.
      </div>
    </div>
  );
}
