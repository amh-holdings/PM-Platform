import Link from "next/link";

import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";
import { loadBdPeople } from "@/lib/bd-db";
import { createCompany } from "../../actions";
import { ActionForm } from "../../_components/action-form";
import { Card } from "../../_components/fields";
import { CompanyFields } from "../../_components/company-fields";

export default async function NewClientPage() {
  const supabase = createClient();
  const [
    {
      data: { user },
    },
    people,
  ] = await Promise.all([supabase.auth.getUser(), loadBdPeople(supabase)]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">New client</h1>
          <p className="text-sm text-muted-foreground">Add contacts on the next page.</p>
        </div>
        <Button variant="ghost" asChild>
          <Link href="/bd/clients">Cancel</Link>
        </Button>
      </div>
      <Card>
        <ActionForm action={createCompany} submitLabel="Create client">
          <CompanyFields people={people} defaultOwnerId={user?.id} />
        </ActionForm>
      </Card>
    </div>
  );
}
