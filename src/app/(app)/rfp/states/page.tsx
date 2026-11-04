import Link from "next/link";

import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/format";
import { STATE_FIELDS, stateCode, stateProfileGaps } from "@/lib/rfp";
import { rfpClient, type StateProfile } from "@/lib/rfp-db";
import { createClient } from "@/lib/supabase/server";
import { ActionForm } from "../../bd/_components/action-form";
import { Card, Empty, Field, TextArea } from "../../bd/_components/fields";
import { saveStateProfile } from "../actions";
import { Pill } from "../_components/flag-pill";

/**
 * One profile per state. Everything that changes by state is set once here
 * and every bid in that state reads it. Nothing state-specific lives in the
 * runbook itself.
 */
export default async function StateProfilesPage({ searchParams }: { searchParams: { edit?: string } }) {
  const db = rfpClient(createClient());
  const { data } = await db.from("bd_state_profiles").select("*").order("state");
  const profiles = data ?? [];
  const editing = searchParams.edit === "new" ? "new" : stateCode(searchParams.edit);
  const current = editing && editing !== "new" ? profiles.find((p) => p.state === editing) ?? null : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">State profiles</h1>
          <p className="text-sm text-muted-foreground">
            Build the profile before the bid package goes out. Start from the Jurisdictional Permitting Index in
            Notion if the state is there.
          </p>
        </div>
        {!editing && (
          <Link href="/rfp/states?edit=new" className="text-sm font-medium underline-offset-4 hover:underline">
            Add a state
          </Link>
        )}
      </div>

      {editing && (
        <Card title={current ? `Edit ${current.state}` : editing === "new" ? "New state" : `New: ${editing}`}>
          <ProfileForm profile={current} state={editing === "new" ? null : editing} />
          <Link href="/rfp/states" className="text-xs text-muted-foreground hover:text-foreground">
            Cancel
          </Link>
        </Card>
      )}

      {profiles.length ? (
        profiles.map((p) => {
          const gaps = stateProfileGaps(p);
          return (
            <Card
              key={p.id}
              id={p.state}
              title={p.state}
              action={
                <div className="flex items-center gap-3">
                  {gaps.length ? <Pill tone="warn">{gaps.length} required blank</Pill> : <Pill tone="good">Ready</Pill>}
                  <span className="text-xs text-muted-foreground">Verified {formatDate(p.verified_on)}</span>
                  <Link href={`/rfp/states?edit=${p.state}`} className="text-xs text-muted-foreground hover:text-foreground">
                    Edit
                  </Link>
                </div>
              }
            >
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                {STATE_FIELDS.map((f) => (
                  <div key={f.key}>
                    <dt className="text-xs text-muted-foreground">{f.label}</dt>
                    <dd className="whitespace-pre-wrap">{p[f.key] || <span className="text-muted-foreground">-</span>}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          );
        })
      ) : (
        <Empty>No state profiles yet.</Empty>
      )}
    </div>
  );
}

function ProfileForm({ profile, state }: { profile: StateProfile | null; state: string | null }) {
  return (
    <ActionForm action={saveStateProfile} submitLabel="Save profile" className="mb-3 space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="State" htmlFor="state" required hint="Two-letter code">
          <Input id="state" name="state" required maxLength={2} defaultValue={profile?.state ?? state ?? ""} />
        </Field>
        <Field label="Last verified" htmlFor="verified_on" hint="When someone last checked this against the source">
          <Input id="verified_on" name="verified_on" type="date" defaultValue={profile?.verified_on ?? ""} />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {STATE_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} htmlFor={f.key}>
            <TextArea id={f.key} name={f.key} rows={3} defaultValue={profile?.[f.key]} />
          </Field>
        ))}
      </div>
    </ActionForm>
  );
}
