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
