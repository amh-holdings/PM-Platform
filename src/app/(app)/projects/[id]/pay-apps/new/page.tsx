import Link from "next/link";

import { createClient } from "@/lib/supabase/server";
import { guardCapability } from "@/lib/roles-server";
import { nextAppNumber } from "@/lib/afp-number";
import { periodEndOf } from "@/lib/billing-period";
import { resolveBillingPeriod } from "@/lib/billing-period-resolve";

import { NewPayAppForm } from "./new-pay-app-form";

type Params = { id: string };

export default async function NewPayAppPage({ params }: { params: Params }) {
  await guardCapability("viewPayApps");
  const supabase = createClient();

  // Default period: the month the next AFP covers. That rule used to live here
  // inline while the Billing page used a calendar default, so the two pages
  // disagreed about which month was in play. Both call the same resolver now,
  // which also ignores drafts and refuses to propose a period out of a dormant
  // stretch. See src/lib/billing-period-resolve.ts.
  const [{ data: project }, defaultAppNumber, defaultStart] = await Promise.all([
    supabase
      .from("projects")
      .select("retainage_pct_default")
      .eq("id", params.id)
      .maybeSingle(),
    // Scans pay_applications AND the billing_entries.afp_number history, so
    // a project whose pre-app AFPs live only as free text still gets the
    // right next number. See src/lib/afp-number.ts.
    nextAppNumber(supabase, params.id),
    resolveBillingPeriod(supabase, params.id),
  ]);
  const defaultEnd = periodEndOf(defaultStart);

  return (
    <div className="space-y-4">
      <div>
        <Link
          href={`/projects/${params.id}/pay-apps`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          &larr; Pay applications
        </Link>
        <h2 className="mt-1 text-lg font-semibold">New pay application</h2>
        <p className="text-xs text-muted-foreground">
          Creates a draft AFP. Pulls every billing entry in the period that
          isn&apos;t already on another pay app and snapshots the SOV as
          pay_application_lines.
        </p>
      </div>

      <NewPayAppForm
        projectId={params.id}
        defaultAppNumber={defaultAppNumber}
        defaultStart={defaultStart}
        defaultEnd={defaultEnd}
        defaultRetainagePct={Number(project?.retainage_pct_default ?? 10)}
      />
    </div>
  );
}
