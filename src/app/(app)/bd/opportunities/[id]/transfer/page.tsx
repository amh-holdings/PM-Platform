import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { createClient } from "@/lib/supabase/server";
import { latestBidByOpp } from "@/lib/bd";
import { bdClient } from "@/lib/bd-db";
import { guardCapability } from "@/lib/roles-server";
import { transferToProject } from "../../../actions";
import { ActionForm } from "../../../_components/action-form";
import { Card, Field } from "../../../_components/fields";

/**
 * Won job -> PM project. Opens straight after a win is recorded (Phil asked to
 * be prompted), and from the Transfer button any time after. Everything is
 * pre-filled from the opportunity and editable before the project exists.
 */
export default async function TransferPage({ params }: { params: { id: string } }) {
  await guardCapability("transferBdToProject");
  const db = bdClient(createClient());
  const { data: opp } = await db.from("bd_opportunities").select("*").eq("id", params.id).maybeSingle();
  if (!opp) notFound();
  if (opp.project_id) redirect(`/projects/${opp.project_id}`);

  const [{ data: company }, { data: bids }] = await Promise.all([
    db.from("bd_companies").select("name").eq("id", opp.company_id).maybeSingle(),
    db.from("bd_bids").select("*").eq("opportunity_id", opp.id),
  ]);
  const latest = latestBidByOpp((bids ?? []).map((b) => ({ ...b, price: Number(b.price) }))).get(opp.id);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Won: set up the project?</h1>
          <p className="text-sm text-muted-foreground">
            Creates {opp.name} in AHC PM, linked back to this opportunity. Check the contract value
            against the executed contract before saving.
          </p>
        </div>
        <Button variant="ghost" asChild>
          <Link href={`/bd/opportunities/${opp.id}`}>Not now</Link>
        </Button>
      </div>
      <Card>
        <ActionForm action={transferToProject.bind(null, opp.id)} submitLabel="Create project">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Project name" htmlFor="name" required className="sm:col-span-2">
              <Input id="name" name="name" required defaultValue={opp.name} />
            </Field>
            <Field label="Client / Developer" htmlFor="client">
              <Input id="client" name="client" defaultValue={company?.name ?? ""} />
            </Field>
            <Field label="Contract value" htmlFor="contract_value" hint="Pre-filled from the bid of record">
              <MoneyInput id="contract_value" name="contract_value" defaultValue={latest?.price ?? null} />
            </Field>
            <Field label="Size (MW DC)" htmlFor="dc_capacity_mw">
              <Input
                id="dc_capacity_mw"
                name="dc_capacity_mw"
                inputMode="decimal"
                defaultValue={opp.size_mw_dc ?? ""}
              />
            </Field>
            <Field label="Zip code" htmlFor="zip_code">
              <Input id="zip_code" name="zip_code" />
            </Field>
            <Field label="NTP date" htmlFor="ntp_date">
              <Input id="ntp_date" name="ntp_date" type="date" />
            </Field>
            <Field label="COD date" htmlFor="cod_date">
              <Input id="cod_date" name="cod_date" type="date" />
            </Field>
          </div>
        </ActionForm>
      </Card>
    </div>
  );
}
