"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { VIEW_AS_COOKIE, toEffectiveRole } from "@/lib/roles";
import { readDbRole } from "@/lib/roles-server";

// Sets the presentational "view as" cookie, then redirects to a landing the
// chosen role can actually see. This ONLY affects which nav/views render; it
// never changes RLS or server-action authorization. It is honored only for a
// true full-access user, so it cannot escalate privileges - a non-Phil caller
// writing the cookie has no effect (getEffectiveRole ignores it), and we also
// refuse to set it here.
//
// The redirect runs server-side (not a client router.refresh) so the switch
// reliably navigates: refresh() does NOT follow the dashboard's own redirect,
// which previously left the stale full-access dashboard on screen after
// switching to Subcontractor.
export async function setViewAs(
  value: "self" | "cm" | "sub",
  projectId: string,
): Promise<void> {
  const actual = toEffectiveRole(await readDbRole());
  if (actual !== "full") return;

  const store = cookies();
  if (value === "self") {
    store.delete(VIEW_AS_COOKIE);
  } else {
    store.set(VIEW_AS_COOKIE, value, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
  }

  // Subs have no dashboard - land them on Field Reports; every other role
  // lands on the project root. redirect() throws, so it must come last.
  const base = `/projects/${projectId}`;
  redirect(value === "sub" ? `${base}/field-reports` : base);
}
