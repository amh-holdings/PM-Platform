// Effective-role veneer. The database keeps its 7-value `user_role` enum and
// all RLS runs on those DB roles. For the UI, we collapse to three roles that
// match how the business actually works today:
//
//   full  -> Phil. Sees everything; can preview other roles via "view as".
//   cm    -> Construction Manager (the AHC reviewer: ahc_super / zarina).
//   sub   -> Subcontractor (sub_pm / sub_foreman). Files field reports only.
//
// This is a presentation/capability layer ONLY. It never changes RLS or
// server-action authorization - those still read the true DB role. The
// view-as cookie is honored only for a true `full` user, so it can only ever
// DE-SCOPE the view, never escalate privileges.

import { cookies } from "next/headers";

import { createClient } from "@/lib/supabase/server";

export type EffectiveRole = "full" | "cm" | "sub";

export const VIEW_AS_COOKIE = "fr_view_as";

// Collapse a raw DB role to an effective role.
export function toEffectiveRole(dbRole: string | null | undefined): EffectiveRole {
  if (dbRole === "phil") return "full";
  if (dbRole === "ahc_super" || dbRole === "zarina") return "cm";
  if (dbRole === "sub_pm" || dbRole === "sub_foreman") return "sub";
  // owner / counsel / unknown: most-restricted view (RLS still governs data).
  return "sub";
}

export const ROLE_LABEL: Record<EffectiveRole, string> = {
  full: "Full access",
  cm: "Construction Manager",
  sub: "Subcontractor",
};

// ---- Capability matrix: the one place features ask "can this role do X". ----
export type Capability =
  | "viewAllReports" // see every sub's field reports, not just own
  | "submitFieldReport" // file a daily field report
  | "reviewPins" // open/verify sub work pins
  | "decidePins" // approve/reject (also gated server-side by the approver rule)
  | "addCmChecks" // drop CM own-check pins
  | "viewFinancials" // billing / pay-apps / change-orders / costs
  | "viewAsToggle"; // the Phil-only "view as" switcher

const MATRIX: Record<EffectiveRole, Set<Capability>> = {
  full: new Set<Capability>([
    "viewAllReports",
    "submitFieldReport",
    "reviewPins",
    "decidePins",
    "addCmChecks",
    "viewFinancials",
    "viewAsToggle",
  ]),
  cm: new Set<Capability>([
    "viewAllReports",
    "submitFieldReport",
    "reviewPins",
    "decidePins",
    "addCmChecks",
    "viewFinancials",
  ]),
  sub: new Set<Capability>(["submitFieldReport"]),
};

export function can(role: EffectiveRole, cap: Capability): boolean {
  return MATRIX[role].has(cap);
}

// Read the current user's true DB role (server-side).
export async function readDbRole(): Promise<string> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return "";
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  return profile?.role ?? "";
}

// The role the UI should render for. For a true `full` user we honor the
// view-as cookie (preview mode); everyone else always gets their real role.
export async function getEffectiveRole(): Promise<{
  effective: EffectiveRole;
  actual: EffectiveRole;
}> {
  const actual = toEffectiveRole(await readDbRole());
  if (actual !== "full") return { effective: actual, actual };
  const viewAs = cookies().get(VIEW_AS_COOKIE)?.value;
  if (viewAs === "cm" || viewAs === "sub") {
    return { effective: viewAs, actual };
  }
  return { effective: "full", actual };
}
