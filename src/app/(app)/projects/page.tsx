import Link from "next/link";

import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";
import { formatCurrency, formatDate } from "@/lib/format";

export const metadata = {
  title: "Projects - AHC PM Platform",
};

export default async function ProjectsPage() {
  const supabase = createClient();
  const { data: projects, error } = await supabase
    .from("projects")
    .select("id, name, client, status, contract_value, ntp_date, cod_date")
    .order("created_at", { ascending: false });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Projects</h1>
          <p className="text-sm text-muted-foreground">
            {projects?.length ?? 0} {projects?.length === 1 ? "project" : "projects"}
          </p>
        </div>
        <Button asChild>
          <Link href="/projects/new">New project</Link>
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load projects: {error.message}
        </div>
      )}

      {!error && (!projects || projects.length === 0) ? (
        <div className="rounded-lg border border-dashed bg-card p-12 text-center">
          <p className="text-sm font-medium">No projects yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Create your first project to get started.
          </p>
          <Button asChild className="mt-4">
            <Link href="/projects/new">New project</Link>
          </Button>
        </div>
      ) : null}

      {projects && projects.length > 0 && (
        <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Client</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">NTP</th>
                <th className="px-4 py-3 font-medium">COD</th>
                <th className="px-4 py-3 text-right font-medium">Contract</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {projects.map((project) => (
                <tr key={project.id} className="hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <Link href={`/projects/${project.id}`} className="font-medium hover:underline">
                      {project.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{project.client ?? "-"}</td>
                  <td className="px-4 py-3">
                    {project.status ? (
                      <span className="inline-flex items-center rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium text-secondary-foreground">
                        {project.status}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{formatDate(project.ntp_date)}</td>
                  <td className="px-4 py-3 text-muted-foreground">{formatDate(project.cod_date)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {formatCurrency(project.contract_value)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
