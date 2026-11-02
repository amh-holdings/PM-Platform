import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { EQUIPMENT_BASES, EQUIPMENT_LABEL, REVISION_LABEL, REVISION_TYPES } from "@/lib/bd";
import { Field, Select, TextArea } from "./fields";

/** The bid form, shared by Add a bid revision and editing a bid on file. */
export function BidFields({
  idPrefix,
  revisionType,
  submittedOn,
  price,
  marginPct,
  equipmentBasis,
  proposalUrl,
  exclusions,
  notes,
  children,
}: {
  idPrefix: string;
  revisionType: string;
  submittedOn: string;
  price?: number;
  marginPct?: number | null;
  equipmentBasis: string;
  proposalUrl?: string | null;
  exclusions?: string | null;
  notes?: string | null;
  /** Extra fields, placed after Margin %. */
  children?: React.ReactNode;
}) {
  const id = (name: string) => `${idPrefix}_${name}`;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Revision" htmlFor={id("revision_type")}>
        <Select
          name="revision_type"
          defaultValue={revisionType}
          options={REVISION_TYPES.map((r) => ({ value: r, label: REVISION_LABEL[r] }))}
        />
      </Field>
      <Field label="Submitted" htmlFor={id("submitted_on")}>
        <Input id={id("submitted_on")} name="submitted_on" type="date" defaultValue={submittedOn} />
      </Field>
      <Field label="Price" htmlFor={id("price")} required>
        <MoneyInput id={id("price")} name="price" required defaultValue={price} />
      </Field>
      <Field label="Margin %" htmlFor={id("margin_pct")}>
        <Input id={id("margin_pct")} name="margin_pct" inputMode="decimal" defaultValue={marginPct ?? ""} />
      </Field>
      {children}
      <Field label="Equipment basis" htmlFor={id("equipment_basis")} hint="Only compare $/W on the same basis">
        <Select
          name="equipment_basis"
          defaultValue={equipmentBasis}
          options={EQUIPMENT_BASES.map((e) => ({ value: e, label: EQUIPMENT_LABEL[e] }))}
        />
      </Field>
      <Field label="Proposal link" htmlFor={id("proposal_url")} className="sm:col-span-1 lg:col-span-2">
        <Input
          id={id("proposal_url")}
          name="proposal_url"
          placeholder="Google Drive link"
          defaultValue={proposalUrl ?? ""}
        />
      </Field>
      <Field label="Key exclusions" htmlFor={id("exclusions")} className="sm:col-span-2">
        <TextArea name="exclusions" rows={2} placeholder="Interconnection, substation..." defaultValue={exclusions ?? ""} />
      </Field>
      <Field label="Notes" htmlFor={id("notes")} className="sm:col-span-2">
        <TextArea name="notes" rows={2} defaultValue={notes ?? ""} />
      </Field>
    </div>
  );
}
