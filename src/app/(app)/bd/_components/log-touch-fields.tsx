import { Input } from "@/components/ui/input";
import { ACTIVITY_LABEL, ACTIVITY_TYPES, todayIso } from "@/lib/bd";
import type { BdContact } from "@/lib/bd-db";
import { Field, Select, TextArea } from "./fields";

/**
 * Log a touch. With an open opportunity it also asks for the next follow-up
 * date (pre-filled from the stage cadence) - that is what keeps the queue honest.
 */
export function LogTouchFields({
  companyId,
  opportunityId,
  contacts,
  suggestedNext,
}: {
  companyId: string;
  opportunityId?: string;
  contacts: BdContact[];
  /** Present when the touch is on an open opportunity. */
  suggestedNext?: string;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <input type="hidden" name="company_id" value={companyId} />
      {opportunityId && <input type="hidden" name="opportunity_id" value={opportunityId} />}
      <Field label="Type" htmlFor="activity_type">
        <Select
          name="activity_type"
          defaultValue="call"
          options={ACTIVITY_TYPES.map((t) => ({ value: t, label: ACTIVITY_LABEL[t] }))}
        />
      </Field>
      <Field label="Date" htmlFor="occurred_on">
        <Input id="occurred_on" name="occurred_on" type="date" defaultValue={todayIso()} />
      </Field>
      <Field label="With" htmlFor="contact_id">
        <Select
          name="contact_id"
          blank="-"
          options={contacts.map((c) => ({ value: c.id, label: c.name }))}
        />
      </Field>
      {suggestedNext ? (
        <Field label="Next follow-up" htmlFor="next_follow_up_date" required>
          <Input
            id="next_follow_up_date"
            name="next_follow_up_date"
            type="date"
            required
            defaultValue={suggestedNext}
          />
        </Field>
      ) : (
        <div />
      )}
      <Field label="Notes" htmlFor="notes" className="sm:col-span-2 lg:col-span-4">
        <TextArea name="notes" rows={2} placeholder="What was said, what happens next" />
      </Field>
    </div>
  );
}
