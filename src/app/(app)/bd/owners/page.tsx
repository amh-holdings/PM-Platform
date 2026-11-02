import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/server";
import { loadBdOwners } from "@/lib/bd-db";
import { addOwner, updateOwner } from "../actions";
import { ActionForm } from "../_components/action-form";
import { Card, Field } from "../_components/fields";

export default async function BdOwnersPage() {
  const owners = await loadBdOwners(createClient());

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Owners</h1>
        <p className="text-sm text-muted-foreground">
          Anyone can own a client or bid by name. An email is optional; when someone signs in with it, the
          name is theirs.
        </p>
      </div>

      <Card>
        <h2 className="mb-3 text-sm font-semibold">Add an owner</h2>
        <ActionForm action={addOwner} submitLabel="Add owner">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="name" required>
              <Input id="name" name="name" required />
            </Field>
            <Field label="Email" htmlFor="email" hint="Optional">
              <Input id="email" name="email" type="email" />
            </Field>
          </div>
        </ActionForm>
      </Card>

      <Card>
        <h2 className="mb-3 text-sm font-semibold">Current owners</h2>
        <div className="space-y-4">
          {owners.map((o) => (
            <ActionForm key={o.id} action={updateOwner.bind(null, o.id)} submitLabel="Save">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Name" htmlFor={`name-${o.id}`} required>
                  <Input id={`name-${o.id}`} name="name" required defaultValue={o.name} />
                </Field>
                <Field label="Email" htmlFor={`email-${o.id}`} hint={o.email ? undefined : "None"}>
                  <Input id={`email-${o.id}`} name="email" type="email" defaultValue={o.email ?? ""} />
                </Field>
              </div>
            </ActionForm>
          ))}
        </div>
      </Card>
    </div>
  );
}
