import Link from "next/link";
import { notFound } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

import { ProjectEditForm } from "./project-edit-form";

type Params = { id: string };

export async function generateMetadata({ params }: { params: Params }) {
  const supabase = createClient();
  const { data } = await supabase
    .from("projects")
    .select("name")
    .eq("id", params.id)
    .maybeSingle();
  return {
    title: data ? `Edit ${data.name} - AHC PM Platform` : "Edit project - AHC PM Platform",
  };
}

export default async function ProjectEditPage({ params }: { params: Params }) {
  const supabase = createClient();
  const { data: project } = await supabase
    .from("projects")
    .select("id, name, client, status, contract_value, ntp_date, cod_date, zip_code")
    .eq("id", params.id)
    .maybeSingle();

  if (!project) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/projects/${project.id}`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          &larr; {project.name}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">Edit project</h1>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <ProjectEditForm project={project} />
      </div>
    </div>
  );
}
