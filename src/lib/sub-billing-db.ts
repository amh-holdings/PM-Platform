import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { SubBillingClient } from "@/lib/sub-billing.types";

// Same cookie-bound server client as everywhere else, re-typed so the four
// sub-billing tables from migration 0038 are visible. See sub-billing.types.ts
// for why they are declared there rather than in the generated types file.
export function subBillingClient(): SubBillingClient {
  return createClient() as unknown as SubBillingClient;
}
