import { guardCapability } from "@/lib/roles-server";
import { createClient } from "@/lib/supabase/server";
import { nextRfiNumber, sortRfis, summarise, toRfiRow } from "@/lib/rfi-log";

import { RfiLog } from "../rfi-log-view";

type Params = { id: string };

const COLS =
  "id, rfi_number, subject, question, discipline, wbs_code, subcontractor_id, raised_by, eor_firm, eor_contact, received_at, sent_to_eor_at, date_answered, closed_at, date_needed, date_issued, response, cost_impact, schedule_impact";

export default async function ProjectRfisPage({ params }: { params: Params }) {
  await guardCapability("viewRfis");

  const supabase = createClient();

  // 0084 is applied by hand like every migration here, so a database without
  // it loses the page rather than the whole project.
  const res = await supabase
    .from("rfis")
    .select(COLS)
    .eq("project_id", params.id);

  if (res.error) {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        Apply migration 0084 to use the RFI log. ({res.error.message})
      </div>
    );
  }

  const { data: subs } = await supabase
    .from("subcontractors")
    .select("id, company_name")
    .eq("project_id", params.id)
    .neq("active", false)
    .order("company_name", { ascending: true });

  const today = new Date().toISOString().slice(0, 10);
  const rows = (res.data ?? []).map(toRfiRow);

  return (
    <RfiLog
      projectId={params.id}
      rfis={sortRfis(rows, today)}
      summary={summarise(rows, today)}
      subs={subs ?? []}
      today={today}
      suggestedNumber={nextRfiNumber(rows.map((r) => r.rfi_number).filter(Boolean))}
    />
  );
}
