// Server-only companion to `roles.ts`. Holds the cookie- and DB-backed role
// helpers that must never be pulled into a client bundle. Client components
// import pure helpers (`can`, types) from `./roles`; server components and
// server actions import these from here.

import "server-only";

import { cookies } from "next/headers";
import { notFound } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import {
  VIEW_AS_COOKIE,
  can,
  toEffectiveRole,
  type Capability,
  type EffectiveRole,
} from "@/lib/roles";

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

// Server-side page guard. Use at the top of a page/server component to block
// direct URL access to a view the effective role isn't allowed to see. Tab
// hiding alone is cosmetic - this is the real enforcement. Renders a 404 so we
// don't reveal that the resource exists.
export async function guardCapability(cap: Capability): Promise<void> {
  const { effective } = await getEffectiveRole();
  if (!can(effective, cap)) notFound();
}
