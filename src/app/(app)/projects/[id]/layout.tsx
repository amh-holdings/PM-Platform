import Link from "next/link";
import { notFound } from "next/navigation";

import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";
import { can, getEffectiveRole } from "@/lib/roles";

import { ProjectTabs } from "./project-tabs";
import { ViewAsSwitcher } from "./view-as-switcher";

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

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Params;
}) {
  const supabase = createClient();
  const { data: project } = await supabase
    .from("projects")
    .select("id, name, client, status")
    .eq("id", params.id)
    .maybeSingle();

  if (!project) notFound();

  const { effective, actual } = await getEffectiveRole();

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Link
            href="/projects"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            &larr; Projects
          </Link>
          <h1 className="mt-1 text-2xl font-semibold">{project.name}</h1>
          <p className="text-xs text-muted-foreground">
            {project.client ?? "-"}
            {project.status ? ` - ${project.status}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {can(actual, "viewAsToggle") && (
            <ViewAsSwitcher effective={effective} projectId={params.id} />
          )}
          <Button asChild variant="outline" size="sm">
            <Link href={`/projects/${params.id}/edit`}>Edit project</Link>
          </Button>
        </div>
      </div>

      <ProjectTabs projectId={params.id} role={effective} />

      <div>{children}</div>
    </div>
  );
}
