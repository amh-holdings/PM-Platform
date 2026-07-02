"use server";

import { cookies } from "next/headers";

import { VIEW_AS_COOKIE, readDbRole, toEffectiveRole } from "@/lib/roles";

// Sets the presentational "view as" cookie. This ONLY affects which nav/views
// render; it never changes RLS or server-action authorization. It is honored
// only for a true full-access user, so it cannot escalate privileges - a
// non-Phil caller writing the cookie has no effect (getEffectiveRole ignores
// it), and we also refuse to set it here.
export async function setViewAs(
  value: "self" | "cm" | "sub",
): Promise<{ ok: boolean }> {
  const actual = toEffectiveRole(await readDbRole());
  if (actual !== "full") return { ok: false };

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
  return { ok: true };
}
