import Link from "next/link";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { guardCapability } from "@/lib/roles-server";

import { CmLogForm } from "./cm-log-form";

type Params = { id: string };

export default async function NewCmLogPage({ params }: { params: Params }) {
  // CM Daily Log is CM/Phil-only, same gate as the Review Board.
  await guardCapability("viewAllReports");

  const today = new Date().toISOString().slice(0, 10);

  // One log per project per day. If today's log already exists, resume it
  // instead of failing the unique constraint: a draft opens in the editor, a
  // finalized one opens in the detail view (where it can be reopened).
  const supabase = createClient();
  const { data: existing } = await supabase
    .from("cm_daily_logs")
    .select("id, status")
    .eq("project_id", params.id)
    .eq("log_date", today)
    .maybeSingle();
  if (existing) {
    redirect(
      existing.status === "final"
        ? `/projects/${params.id}/cm-log/${existing.id}`
        : `/projects/${params.id}/cm-log/${existing.id}/edit`,
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <Link
          href={`/projects/${params.id}/cm-log`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          &larr; My Daily Log
        </Link>
        <h2 className="mt-1 text-lg font-semibold">New CM Daily Log</h2>
        <p className="text-xs text-muted-foreground">
          Your own record of the day: site conditions, overall progress, safety,
          and photos. This stands on its own - it is not part of the sub review
          cycle.
        </p>
      </div>

      <CmLogForm projectId={params.id} defaultDate={today} />
    </div>
  );
}
