import { createClient } from "@/lib/supabase/server";
import { can, toEffectiveRole, type Capability } from "@/lib/roles";

/**
 * Server-side capability gate for the subcontractor billing actions.
 *
 * The tab/UI hiding is cosmetic; this is the enforcement. Always re-reads the
 * true DB role, never the view-as cookie.
 *
 * It lives here rather than inside the actions file so a second actions file
 * can reuse it. A duplicated auth gate is a gate that eventually stops
 * matching the one it was copied from.
 */
export async function requireCapability(cap: Capability) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Not signed in" };
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  const role = toEffectiveRole(profile?.role);
  if (!can(role, cap)) {
    return { ok: false as const, error: "You do not have access to this action" };
  }
  return { ok: true as const, userId: user.id, role };
}
