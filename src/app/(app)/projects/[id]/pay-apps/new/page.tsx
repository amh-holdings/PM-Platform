import Link from "next/link";

import { createClient } from "@/lib/supabase/server";

import { NewPayAppForm } from "./new-pay-app-form";

type Params = { id: string };

export default async function NewPayAppPage({ params }: { params: Params }) {
  const supabase = createClient();

  const [{ data: project }, { data: lastApp }] = await Promise.all([
    supabase
      .from("projects")
      .select("retainage_pct_default")
      .eq("id", params.id)
      .maybeSingle(),
    supabase
      .from("pay_applications")
      .select("app_number, period_end")
      .eq("project_id", params.id)
      .order("period_end", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  // Default app number: incremented from last app_number if it ends in a digit
  let defaultAppNumber = "1";
  if (lastApp?.app_number) {
    const m = lastApp.app_number.match(/^(.*?)(\d+)$/);
    if (m) {
      defaultAppNumber = `${m[1]}${Number(m[2]) + 1}`;
    } else {
      defaultAppNumber = `${lastApp.app_number}+1`;
    }
  }

  // Default period: the calendar month following the last app's period_end,
  // or the current month if no prior app exists.
  const now = new Date();
  let defaultStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  if (lastApp?.period_end) {
    const [y, m] = lastApp.period_end.split("-").map(Number);
    const next = new Date(Date.UTC(y, m, 1));
    defaultStart = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-01`;
  }
  const [sy, sm] = defaultStart.split("-").map(Number);
  const lastDay = new Date(Date.UTC(sy, sm, 0)).getUTCDate();
  const defaultEnd = `${sy}-${String(sm).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  return (
    <div className="space-y-4">
      <div>
        <Link
          href={`/projects/${params.id}/pay-apps`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          &larr; Pay applications
        </Link>
        <h2 className="mt-1 text-lg font-semibold">New pay application</h2>
        <p className="text-xs text-muted-foreground">
          Creates a draft AFP. Pulls every billing entry in the period that
          isn&apos;t already on another pay app and snapshots the SOV as
          pay_application_lines.
        </p>
      </div>

      <NewPayAppForm
        projectId={params.id}
        defaultAppNumber={defaultAppNumber}
        defaultStart={defaultStart}
        defaultEnd={defaultEnd}
        defaultRetainagePct={Number(project?.retainage_pct_default ?? 10)}
      />
    </div>
  );
}
