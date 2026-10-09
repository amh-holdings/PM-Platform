import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { OPEN_STAGES, STAGE_LABEL, STAGE_PROBABILITY } from "@/lib/bd";
import type { BdCompany, BdContact, BdOpportunity, BdPerson } from "@/lib/bd-db";
import { Field, Select } from "./fields";

/** The opportunity's own facts. Used by New and by Edit on the detail page. */
export function OpportunityFields({
  companies,
  contacts,
  people,
  opp,
  defaultCompanyId,
  defaultOwnerId,
}: {
  companies: BdCompany[];
  contacts: BdContact[];
  people: BdPerson[];
  opp?: BdOpportunity;
  defaultCompanyId?: string;
  defaultOwnerId?: string | null;
}) {
  const companyById = new Map(companies.map((c) => [c.id, c.name]));
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Project name" htmlFor="name" required className="sm:col-span-2">
        <Input id="name" name="name" required defaultValue={opp?.name} placeholder="Sweet Springs Solar" />
      </Field>
      <Field label="Client" htmlFor="company_id" required>
        <Select
          name="company_id"
          required
          blank="Pick a client"
          defaultValue={opp?.company_id ?? defaultCompanyId}
          options={companies.map((c) => ({ value: c.id, label: c.name }))}
        />
      </Field>
      <Field label="Contact" htmlFor="contact_id">
        <Select
          name="contact_id"
          blank="None"
          defaultValue={opp?.contact_id}
          options={contacts.map((c) => ({
            value: c.id,
            label: `${c.name} (${companyById.get(c.company_id) ?? "?"})`,
          }))}
        />
      </Field>

      <Field label="Stage" htmlFor="stage">
        <Select
          name="stage"
          defaultValue={opp && OPEN_STAGES.includes(opp.stage as never) ? opp.stage : opp ? "submitted" : "lead"}
          options={OPEN_STAGES.map((s) => ({ value: s, label: STAGE_LABEL[s] }))}
        />
      </Field>
      <Field label="Owner" htmlFor="owner_id">
        <Select
          name="owner_id"
          blank="Unassigned"
          defaultValue={opp?.owner_id ?? defaultOwnerId}
          options={people.map((p) => ({ value: p.id, label: p.name }))}
        />
      </Field>
      <Field label="State" htmlFor="state">
        <Input id="state" name="state" defaultValue={opp?.state ?? ""} placeholder="MO" />
      </Field>
      <Field label="County" htmlFor="county">
        <Input id="county" name="county" defaultValue={opp?.county ?? ""} />
      </Field>

      <Field label="Size (MW DC)" htmlFor="size_mw_dc">
        <Input id="size_mw_dc" name="size_mw_dc" inputMode="decimal" defaultValue={opp?.size_mw_dc ?? ""} />
      </Field>
      <Field label="Storage (MWh)" htmlFor="size_mwh" hint="BESS scope, if any">
        <Input id="size_mwh" name="size_mwh" inputMode="decimal" defaultValue={opp?.size_mwh ?? ""} />
      </Field>
      <Field label="Estimated value" htmlFor="est_value" hint="Used until a bid is entered">
        <MoneyInput id="est_value" name="est_value" defaultValue={opp?.est_value ?? null} />
      </Field>
      <Field
        label="Win probability %"
        htmlFor="probability_pct"
        hint={`Blank = stage default (${OPEN_STAGES.map((s) => `${STAGE_LABEL[s]} ${STAGE_PROBABILITY[s]}`).join(", ")})`}
      >
        <Input
          id="probability_pct"
          name="probability_pct"
          inputMode="numeric"
          defaultValue={opp?.probability_pct ?? ""}
        />
      </Field>

      <Field label="Bid due" htmlFor="bid_due_date">
        <Input id="bid_due_date" name="bid_due_date" type="date" defaultValue={opp?.bid_due_date ?? ""} />
      </Field>
      <Field label="Expected decision" htmlFor="expected_decision_date" hint="Past this date, the queue asks for the outcome">
        <Input
          id="expected_decision_date"
          name="expected_decision_date"
          type="date"
          defaultValue={opp?.expected_decision_date ?? ""}
        />
      </Field>
      <Field label="Next follow-up" htmlFor="next_follow_up_date" hint="Blank = set from the stage cadence">
        <Input
          id="next_follow_up_date"
          name="next_follow_up_date"
          type="date"
          defaultValue={opp?.next_follow_up_date ?? ""}
        />
      </Field>
      <Field label="Source" htmlFor="source" hint="RFP portal, referral, LinkedIn...">
        <Input id="source" name="source" defaultValue={opp?.source ?? ""} />
      </Field>
    </div>
  );
}
