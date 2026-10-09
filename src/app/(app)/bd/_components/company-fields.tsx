import { Input } from "@/components/ui/input";
import { COMPANY_TYPES } from "@/lib/bd";
import type { BdCompany, BdPerson } from "@/lib/bd-db";
import { Field, Select, TextArea } from "./fields";

export function CompanyFields({
  company,
  people,
  defaultOwnerId,
}: {
  company?: BdCompany;
  people: BdPerson[];
  defaultOwnerId?: string | null;
}) {
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
      <Field label="Relationship owner" htmlFor="owner_id">
        <Select
          name="owner_id"
          blank="Unassigned"
          defaultValue={company?.owner_id ?? defaultOwnerId}
          options={people.map((p) => ({ value: p.id, label: p.name }))}
        />
      </Field>
      <Field label="HQ state" htmlFor="state">
        <Input id="state" name="state" defaultValue={company?.state ?? ""} />
      </Field>
      <Field label="Website" htmlFor="website" className="lg:col-span-3">
        <Input id="website" name="website" defaultValue={company?.website ?? ""} />
      </Field>
      <Field label="Notes" htmlFor="notes" className="sm:col-span-2 lg:col-span-4">
        <TextArea name="notes" defaultValue={company?.notes} />
      </Field>
    </div>
  );
}
