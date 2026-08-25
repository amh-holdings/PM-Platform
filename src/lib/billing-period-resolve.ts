import {
  defaultBillingPeriod,
  monthAfter,
  monthsBetween,
} from "./billing-period";

/**
 * Which month the next pay application covers.
 *
 * The calendar cannot answer this. Sweet Springs' AFP 12 covers 1-31 August and
 * was submitted on 20 August, so on 25 August the month worth looking at is
 * September - AFP 13 - even though August is the current month and July is the
 * last closed one. The period to open on is the first month the project has not
 * billed, which is a fact about pay_applications, not about today's date.
 *
 * This rule already existed, inline, on the new-pay-application page. The
 * Billing page used a calendar default instead, so the two pages disagreed
 * about which month was in play. It lives here now and both call it.
 *
 * Rules:
 *   - Drafts do not count as billed. A draft AFP 13 for September must not push
 *     the answer to October; September is still the month being assembled.
 *   - Otherwise: the month after the latest period_end that went out.
 *   - A period more than one month behind the current month is treated as a
 *     dormant project rather than a backlog, and the current month wins. Sweet
 *     Springs really did stop billing between AFP 8 (Nov 2025) and AFP 9 (May
 *     2026); without this, opening the page in April 2026 would have proposed
 *     December 2025. One month behind is a normal catch-up - assembling
 *     August's AFP on 3 September - and is left alone.
 */
export async function resolveBillingPeriod(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  projectId: string,
  today: Date = new Date(),
): Promise<string> {
  const calendar = defaultBillingPeriod(today);

  const { data, error } = await supabase
    .from("pay_applications")
    .select("period_end, status")
    .eq("project_id", projectId)
    .neq("status", "draft")
    .order("period_end", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Never let a failed lookup break the page - the calendar answer is wrong
  // less often than a crash is.
  if (error || !data?.period_end) return calendar;

  const next = monthAfter(data.period_end);
  return monthsBetween(next, calendar) > 1 ? calendar : next;
}
