import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import {
  BIDDER_KINDS,
  BIDDER_KIND_LABEL,
  BIDDER_STATUSES,
  BIDDER_STATUS_LABEL,
  DECLINE_REASONS,
  DECLINE_REASON_LABEL,
  PACKAGES,
  PACKAGE_LABEL,
} from "@/lib/rfp";
import type { RfpBidder } from "@/lib/rfp-db";
import { Field, Select, TextArea } from "../../bd/_components/fields";

/** The bidder form, shared by Add a bidder and editing one on the tracker. */
export function BidderFields({
  idPrefix,
  bidder,
  today,
}: {
  idPrefix: string;
  bidder?: RfpBidder;
  today: string;
}) {
  const id = (name: string) => `${idPrefix}_${name}`;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Firm" htmlFor={id("firm")} required>
          <Input id={id("firm")} name="firm" required defaultValue={bidder?.firm ?? ""} />
        </Field>
        <Field label="Package" htmlFor={id("package")} required>
          <Select
            id={id("package")}
            name="package"
            required
            blank="Pick one"
            defaultValue={bidder?.package}
            options={PACKAGES.map((p) => ({ value: p, label: PACKAGE_LABEL[p] }))}
          />
        </Field>
        <Field label="Type" htmlFor={id("kind")} hint="Suppliers get the quote checklist">
          <Select
            id={id("kind")}
            name="kind"
            defaultValue={bidder?.kind ?? "sub"}
            options={BIDDER_KINDS.map((k) => ({ value: k, label: BIDDER_KIND_LABEL[k] }))}
          />
        </Field>
        <Field label="Status" htmlFor={id("status")}>
          <Select
            id={id("status")}
            name="status"
            defaultValue={bidder?.status ?? "invited"}
            options={BIDDER_STATUSES.map((s) => ({ value: s, label: BIDDER_STATUS_LABEL[s] }))}
          />
        </Field>
        <Field label="Contact" htmlFor={id("contact_name")}>
          <Input id={id("contact_name")} name="contact_name" defaultValue={bidder?.contact_name ?? ""} />
        </Field>
        <Field label="Contact email" htmlFor={id("contact_email")}>
          <Input id={id("contact_email")} name="contact_email" type="email" defaultValue={bidder?.contact_email ?? ""} />
        </Field>
        <Field label="Invited" htmlFor={id("invited_on")}>
          <Input id={id("invited_on")} name="invited_on" type="date" defaultValue={bidder?.invited_on ?? (bidder ? "" : today)} />
        </Field>
        <Field label="Intent confirmed" htmlFor={id("intent_on")} hint="Ask within 3 business days">
          <Input id={id("intent_on")} name="intent_on" type="date" defaultValue={bidder?.intent_on ?? ""} />
        </Field>
        <Field label="Last contact" htmlFor={id("last_contact_on")} hint="14 days silent = at risk">
          <Input id={id("last_contact_on")} name="last_contact_on" type="date" defaultValue={bidder?.last_contact_on ?? ""} />
        </Field>
        <Field label="Bid total" htmlFor={id("bid_total")}>
          <MoneyInput id={id("bid_total")} name="bid_total" defaultValue={bidder?.bid_total ?? undefined} />
        </Field>
        <Field label="Valid until" htmlFor={id("validity_date")} hint="120 days minimum">
          <Input id={id("validity_date")} name="validity_date" type="date" defaultValue={bidder?.validity_date ?? ""} />
        </Field>
        <Field label="Wage basis" htmlFor={id("wage_basis")} hint="Determination number they priced">
          <Input id={id("wage_basis")} name="wage_basis" defaultValue={bidder?.wage_basis ?? ""} />
        </Field>
        <Field label="Bond" htmlFor={id("bond_treatment")} hint="Included, % adder, or none. Surety and rating">
          <Input id={id("bond_treatment")} name="bond_treatment" defaultValue={bidder?.bond_treatment ?? ""} />
        </Field>
        <Field label="State license verified" htmlFor={id("license_verified_on")} hint="Every time, even known subs">
          <Input
            id={id("license_verified_on")}
            name="license_verified_on"
            type="date"
            defaultValue={bidder?.license_verified_on ?? ""}
          />
        </Field>
        <Field label="License number / source" htmlFor={id("license_note")}>
          <Input id={id("license_note")} name="license_note" defaultValue={bidder?.license_note ?? ""} />
        </Field>
        <Field label="Decline reason" htmlFor={id("decline_reason")} hint="Required when declined">
          <Select
            id={id("decline_reason")}
            name="decline_reason"
            blank="-"
            defaultValue={bidder?.decline_reason}
            options={DECLINE_REASONS.map((r) => ({ value: r, label: DECLINE_REASON_LABEL[r] }))}
          />
        </Field>
      </div>
      <Field label="Notes" htmlFor={id("notes")}>
        <TextArea id={id("notes")} name="notes" rows={2} defaultValue={bidder?.notes} />
      </Field>
    </div>
  );
}
