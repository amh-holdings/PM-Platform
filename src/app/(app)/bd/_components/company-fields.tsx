import { Input } from "@/components/ui/input";
import {
  ACCOUNT_STAGES,
  ACCOUNT_STAGE_LABEL,
  ACCOUNT_TIERS,
  ACCOUNT_TIER_LABEL,
  COMPANY_TYPES,
} from "@/lib/bd";
import type { BdCompany, BdOwner } from "@/lib/bd-db";
import { Field, Select, TextArea } from "./fields";

export function CompanyFields({
  company,
  owners,
  defaultOwnerId,
}: {
  company?: BdCompany;
  owners: BdOwner[];
  defaultOwnerId?: string | null;
}) {
  const owner = company ? company.bd_owner_id : defaultOwnerId;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Client name" htmlFor="name" required className="sm:col-span-2">
        <Input id="name" name="name" required defaultValue={company?.name} placeholder="Dimension Energy" />
      </Field>
      <Field label="Type" htmlFor="company_type">
        <Select
          name="company_type"
          defaultValue={company?.company_type ?? "Developer"}
          options={COMPANY_TYPES.map((t) => ({ value: t, label: t }))}
        />
      </Field>
      <Field label="Relationship owner" htmlFor="bd_owner_id">
        <Select
          name="bd_owner_id"
          blank="Unassigned"
          defaultValue={owner}
          options={owners.map((o) => ({ value: o.id, label: o.name }))}
        />
      </Field>
      <Field label="Stage" htmlFor="relationship_stage">
        <Select
          name="relationship_stage"
          defaultValue={company?.relationship_stage ?? "not_contacted"}
          options={ACCOUNT_STAGES.map((s) => ({ value: s, label: ACCOUNT_STAGE_LABEL[s] }))}
        />
      </Field>
      <Field label="Tier" htmlFor="tier">
        <Select
          name="tier"
          defaultValue={company?.tier ?? "prospect"}
          options={ACCOUNT_TIERS.map((t) => ({ value: t, label: ACCOUNT_TIER_LABEL[t] }))}
        />
      </Field>
      <Field label="Next step" htmlFor="next_step" className="sm:col-span-2" hint="One action, starting with a verb.">
        <Input id="next_step" name="next_step" defaultValue={company?.next_step ?? ""} />
      </Field>
      <Field label="Next touch" htmlFor="next_touch_date" hint="Defaults to two weeks out.">
        <Input id="next_touch_date" name="next_touch_date" type="date" defaultValue={company?.next_touch_date ?? ""} />
      </Field>
      <Field label="HQ state" htmlFor="state">
        <Input id="state" name="state" defaultValue={company?.state ?? ""} />
      </Field>
      <Field label="Website" htmlFor="website" className="sm:col-span-2">
        <Input id="website" name="website" defaultValue={company?.website ?? ""} />
      </Field>
      <Field label="Notes" htmlFor="notes" className="sm:col-span-2 lg:col-span-4">
        <TextArea name="notes" defaultValue={company?.notes} />
      </Field>
    </div>
  );
}
