import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Button } from "@/components/ui/button";
import { MobileNav } from "@/components/nav/mobile-nav";
import { ProjectMain } from "@/components/nav/project-main";
import { ProjectRail, RAIL_COOKIE } from "@/components/nav/project-rail";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/roles";
import { getNavCounts } from "@/lib/nav-counts";
import { getEffectiveRole } from "@/lib/roles-server";

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
  const { effective, actual } = await getEffectiveRole();

  const [{ data: project }, { data: projects }, counts] = await Promise.all([
    supabase
      .from("projects")
      .select("id, name, client, status")
      .eq("id", params.id)
      .maybeSingle(),
    supabase
      .from("projects")
      .select("id, name, client, status")
      .order("created_at", { ascending: false }),
    getNavCounts(params.id, effective),
  ]);

  if (!project) notFound();

  const collapsed = cookies().get(RAIL_COOKIE)?.value === "collapsed";

  return (
    <div className="flex">
      <ProjectRail
        projectId={params.id}
        role={effective}
        counts={counts}
        projects={projects ?? []}
        defaultCollapsed={collapsed}
      />

      <ProjectMain
        projectId={params.id}
        actions={
          <>
            {can(actual, "viewAsToggle") && (
              <ViewAsSwitcher effective={effective} projectId={params.id} />
            )}
            <Button asChild variant="outline" size="sm">
              <Link href={`/projects/${params.id}/edit`}>Edit project</Link>
            </Button>
          </>
        }
      >
        {children}
      </ProjectMain>

      <MobileNav projectId={params.id} role={effective} counts={counts} />
    </div>
  );
}
