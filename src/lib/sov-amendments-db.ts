import { coClient } from "@/lib/database.types.co";
import type { AmendmentRow } from "@/lib/sov-amendments";

/**
 * Reads the amendment allocations for a project, tolerating the table not
 * being there yet.
 *
 * Migrations on this project are applied by hand in the Supabase SQL editor,
 * so code reaches production before 0054 does. A billing page that throws
 * because a table is missing would be a far worse bug than the one this
 * feature fixes, and with no rows the roll-up is the identity function - every
 * page behaves exactly as it did before.
 *
 * `missing` is returned rather than swallowed so a page can say "needs
 * migration 0054" instead of silently showing pre-0054 numbers forever.
 */
export async function readAmendments(
  supabase: unknown,
  projectId: string,
): Promise<{ rows: AmendmentRow[]; missing: boolean }> {
  const { data, error } = await coClient(supabase)
    .from("billing_line_amendments")
    .select("amendment_line_id, base_line_id, amount")
    .eq("project_id", projectId)
    .limit(5000);

  if (error) {
    // 42P01 is Postgres' "relation does not exist"; PGRST205 is PostgREST
    // failing to find it in its schema cache, which is what actually comes
    // back over the wire before the migration is applied.
    if (error.code === "42P01" || error.code === "PGRST205") {
      return { rows: [], missing: true };
    }
    throw new Error(`Reading SOV amendments: ${error.message}`);
  }
  return { rows: (data ?? []) as AmendmentRow[], missing: false };
}

export function amendmentMigrationHint(message: string): string {
  return /billing_line_amendments/.test(message)
    ? "Linking a change order to a contract line needs migration 0054_billing_line_amendments.sql applied in Supabase first."
    : message;
}
