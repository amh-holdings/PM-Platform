import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

// Service-role client. Bypasses RLS, so it is SERVER-ONLY and must never be
// imported into a client component. Used exclusively for the scoped
// secure-link path, where there is no authenticated session: the token is
// validated in code first, then all writes are constrained to that token's
// project_id + subcontractor_id. Never use this to widen access beyond the
// validated token scope.
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "Service role not configured (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)",
    );
  }
  return createSupabaseClient<Database>(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// The message the person on site sees when the key is missing. Naming the
// variable is deliberate: this is an operator problem, not something they can
// fix by retrying, and they need something concrete to send to AHC.
export const ADMIN_CLIENT_UNCONFIGURED =
  "This server is missing its service-role credentials, so the change could not be saved. Nothing you entered was lost. Send this to AHC: SUPABASE_SERVICE_ROLE_KEY is not set on the deployment.";

export type AdminClientResult =
  | { ok: true; admin: ReturnType<typeof createAdminClient> }
  | { ok: false; error: string };

// The same client as a returned result instead of a throw. Every server action
// here answers { ok: false, error }, and a throw escapes that contract: the
// action 500s and the browser shows Next's blank "Application error ... digest"
// page, which tells the sub nothing and takes a log dive to decode. Use this at
// every action call site; createAdminClient stays for the places where a throw
// is genuinely the right answer.
export function adminClientOrError(): AdminClientResult {
  try {
    return { ok: true, admin: createAdminClient() };
  } catch {
    return { ok: false, error: ADMIN_CLIENT_UNCONFIGURED };
  }
}
