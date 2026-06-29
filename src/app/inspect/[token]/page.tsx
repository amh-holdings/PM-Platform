import { createAdminClient } from "@/lib/supabase/admin";
import { isLinkUsable } from "@/lib/inspection-token";
import {
  STATUS_STYLE,
  statusLabel,
  type InspectionStatus,
} from "@/lib/inspection-status";
import { SecureLinkSubmit } from "./inspect-form";

type Params = { token: string };

// No-login scoped secure-link page. The token is the credential; everything is
// validated and scoped server-side via the service role. The sub sees only
// their own scope.
export default async function InspectTokenPage({
  params,
}: {
  params: Params;
}) {
  const admin = createAdminClient();

  const { data: link } = await admin
    .from("inspection_secure_links")
    .select("id, project_id, subcontractor_id, label, active, expires_at")
    .eq("token", params.token)
    .maybeSingle();

  if (!link || !isLinkUsable(link)) {
    return (
      <main className="mx-auto max-w-md p-6">
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          This inspection link is invalid or has expired. Contact your AHC
          contact for a new one.
        </div>
      </main>
    );
  }

  // Scoped to this token's subcontractor only.
  const [{ data: recent }, { data: subRow }, { data: projRow }] =
    await Promise.all([
      admin
        .from("inspections")
        .select("id, title, status, submitted_at")
        .eq("subcontractor_id", link.subcontractor_id)
        .eq("project_id", link.project_id)
        .order("submitted_at", { ascending: false })
        .limit(10),
      admin
        .from("subcontractors")
        .select("company_name")
        .eq("id", link.subcontractor_id)
        .maybeSingle(),
      admin
        .from("projects")
        .select("name")
        .eq("id", link.project_id)
        .maybeSingle(),
    ]);

  const company = subRow?.company_name ?? "Your company";
  const projectName = projRow?.name ?? "Project";

  return (
    <main className="mx-auto max-w-2xl space-y-5 p-4 sm:p-6">
      <header>
        <h1 className="text-lg font-semibold">Field inspection</h1>
        <p className="text-sm text-muted-foreground">
          {projectName} · {company}
          {link.label ? ` · ${link.label}` : ""}
        </p>
      </header>

      <SecureLinkSubmit token={params.token} />

      <section className="rounded-lg border bg-card p-4">
        <h2 className="mb-2 text-sm font-semibold">Your recent submissions</h2>
        {(!recent || recent.length === 0) && (
          <p className="text-xs text-muted-foreground">None yet.</p>
        )}
        <ul className="space-y-1 text-sm">
          {(recent ?? []).map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2">
              <span>{r.title}</span>
              <span
                className={
                  "inline-flex rounded-full border px-2 py-0.5 text-xs font-medium " +
                  STATUS_STYLE[r.status as InspectionStatus].chip
                }
              >
                {statusLabel(r.status as InspectionStatus)}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
