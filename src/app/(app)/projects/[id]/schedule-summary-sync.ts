import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { summaryStatusChanges } from "@/lib/schedule-summary-status";

/**
 * Bring every summary row's status back in line with the work underneath it.
 *
 * Called after anything that writes a schedule_tasks status, and after
 * anything that changes the shape of the outline - an indent moves a task to a
 * different parent, and a delete can empty one out.
 *
 * Done here rather than in a database trigger because a trigger needs a
 * migration applied, and six of those are already waiting. This runs the
 * moment the deploy lands. It is idempotent and reads the whole project each
 * time, which at 200 rows is one small select and, in the ordinary case where
 * nothing is out of line, zero writes.
 *
 * Deliberately only touches status. A summary's percent is rolled at read time
 * by buildProgress and is not stored, and nothing here should start storing it.
 */
export async function syncSummaryStatuses(
  supabase: SupabaseClient,
  projectId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("schedule_tasks")
    .select("id, wbs_code, status")
    .eq("project_id", projectId);
  if (error || !data) return 0;

  const rows = data as { id: string; wbs_code: string; status: string | null }[];
  const changes = summaryStatusChanges(rows);
  if (!changes.length) return 0;

  const idByCode = new Map(rows.map((r) => [r.wbs_code, r.id]));
  let written = 0;
  for (const change of changes) {
    const id = idByCode.get(change.wbs_code);
    if (!id) continue;
    const { error: writeError } = await supabase
      .from("schedule_tasks")
      .update({ status: change.to })
      .eq("id", id)
      .eq("project_id", projectId);
    // A failure here is not worth failing the caller's save over - the leaf
    // write it follows already landed, and the next save re-runs this. The
    // grid rolls summaries up on screen regardless of what is stored.
    if (!writeError) written++;
  }
  return written;
}
