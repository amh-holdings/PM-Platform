import Link from "next/link";

import { createClient } from "@/lib/supabase/server";
import { guardCapability } from "@/lib/roles-server";
import { nextAppNumber } from "@/lib/afp-number";

import { NewPayAppForm } from "./new-pay-app-form";

type Params = { id: string };

export default async function NewPayAppPage({ params }: { params: Params }) {
  await guardCapability("viewPayApps");
  const supabase = createClient();

  const [{ data: project }, { data: lastApp }, defaultAppNumber] =
    await Promise.all([
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
      // Scans pay_applications AND the billing_entries.afp_number history, so
      // a project whose pre-app AFPs live only as free text still gets the
      // right next number. See src/lib/afp-number.ts.
      nextAppNumber(supabase, params.id),
    ]);

  // Default period: the month before the current one (AFPs bill in arrears),
  // or the month following the last app's period_end when one exists.
  const now = new Date();
  const prevMonth = new Date(Date.UTC(now.getFullYear(), now.getMonth() - 1, 1));
  let defaultStart = `${prevMonth.getUTCFullYear()}-${String(prevMonth.getUTCMonth() + 1).padStart(2, "0")}-01`;
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
