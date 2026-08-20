// Server-side resolver for the "awaiting you" numbers the nav renders.
//
// Every query below runs through the ordinary cookie-bound client, so RLS
// applies exactly as it does on the page itself - a count can never reveal the
// existence of rows the user could not open. Counts are additionally gated on
// the same capability that gates the destination, so we do not issue queries
// for sections this role cannot see.
//
// Sections without a defensible "needs attention" number are deliberately
// absent. A badge that means nothing is worse than no badge.

import "server-only";

import { createClient } from "@/lib/supabase/server";
import { subBillingClient } from "@/lib/sub-billing-db";
import { can, type EffectiveRole } from "@/lib/roles";
import type { NavCounts } from "@/lib/nav";

async function countOf(promise: PromiseLike<{ count: number | null }>): Promise<number> {
  try {
    const { count } = await promise;
    return count ?? 0;
  } catch {
    // A count is decoration on top of navigation. If one query fails the nav
    // still has to render, so swallow and report zero rather than throw.
    return 0;
  }
}

export async function getNavCounts(
  projectId: string,
  role: EffectiveRole,
): Promise<NavCounts> {
  const supabase = createClient();
  const jobs: Promise<[string, number]>[] = [];

  // Field reports awaiting review. Only meaningful to a reviewer - a sub's own
  // submitted report is not waiting on the sub.
  if (can(role, "viewFieldReports") && can(role, "viewAllReports")) {
    jobs.push(
      countOf(
        supabase
          .from("dprs")
          .select("id", { count: "exact", head: true })
          .eq("project_id", projectId)
          .eq("status", "submitted"),
      ).then((n) => ["field-reports", n]),
    );
  }

  // Sub bills sitting in the verification pipeline. Same three statuses the
  // Sub billing page itself treats as open.
  if (can(role, "verifySubBilling")) {
    const db = subBillingClient();
    jobs.push(
      countOf(
        db
          .from("sub_pay_apps")
          .select("id", { count: "exact", head: true })
          .eq("project_id", projectId)
          .in("status", ["received", "under_review", "cm_recommended"]),
      ).then((n) => ["sub-billing", n]),
    );
  }

  // Pay applications submitted to the owner and not yet approved or paid.
  if (can(role, "viewPayApps")) {
    jobs.push(
      countOf(
        supabase
          .from("pay_applications")
          .select("id", { count: "exact", head: true })
          .eq("project_id", projectId)
          .eq("status", "submitted"),
      ).then((n) => ["pay-apps", n]),
    );
  }

  // Change orders submitted and awaiting a decision.
  if (can(role, "viewChangeOrders")) {
    jobs.push(
      countOf(
        supabase
          .from("change_orders")
          .select("id", { count: "exact", head: true })
          .eq("project_id", projectId)
          .eq("status", "submitted"),
      ).then((n) => ["change-orders", n]),
    );
  }

  const settled = await Promise.all(jobs);
  const counts: NavCounts = {};
  for (const [key, n] of settled) {
    if (n > 0) counts[key] = n;
  }
  return counts;
}
