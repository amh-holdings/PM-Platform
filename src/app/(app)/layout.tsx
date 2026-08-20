import { CommandPalette } from "@/components/nav/command-palette";
import { SiteNav } from "@/components/site-nav";
import { createClient } from "@/lib/supabase/server";
import { getEffectiveRole } from "@/lib/roles-server";

/**
 * The app shell. It no longer imposes a width - project pages run edge to edge
 * beside the rail and pick their own column width from the nav registry, and
 * portfolio pages wrap themselves. See components/nav/project-main.tsx.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  const { effective } = await getEffectiveRole();

  // Powers the palette's project rows. RLS already limits this to projects the
  // user can open, so there is nothing to filter here.
  const { data: projects } = await supabase
    .from("projects")
    .select("id, name, client, status")
    .order("created_at", { ascending: false });

  return (
    <div className="min-h-screen bg-background">
      <SiteNav />
      {children}
      <CommandPalette role={effective} projects={projects ?? []} />
    </div>
  );
}
