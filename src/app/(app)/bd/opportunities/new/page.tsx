import Link from "next/link";

import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";
import { bdClient, loadBdPeople } from "@/lib/bd-db";
import { createOpportunity } from "../../actions";
import { ActionForm } from "../../_components/action-form";
import { Card, TextLink } from "../../_components/fields";
import { OpportunityFields } from "../../_components/opportunity-fields";

export default async function NewOpportunityPage({
  searchParams,
}: {
  searchParams: { company?: string };
}) {
  const supabase = createClient();
  const db = bdClient(supabase);
  const [
    {
      data: { user },
    },
    companies,
    contacts,
    people,
  ] = await Promise.all([
    supabase.auth.getUser(),
    db.from("bd_companies").select("*").order("name"),
    db.from("bd_contacts").select("*").order("name"),
    loadBdPeople(supabase),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">New opportunity</h1>
          <p className="text-sm text-muted-foreground">
            Name and client are required. Client not listed?{" "}
            <TextLink href="/bd/clients/new">Add the client first</TextLink>.
          </p>
        </div>
        <Button variant="ghost" asChild>
          <Link href="/bd/pipeline">Cancel</Link>
        </Button>
      </div>
      <Card>
        <ActionForm action={createOpportunity} submitLabel="Create opportunity">
          <OpportunityFields
            companies={companies.data ?? []}
            contacts={contacts.data ?? []}
            people={people}
            defaultCompanyId={searchParams.company}
            defaultOwnerId={user?.id}
          />
        </ActionForm>
      </Card>
    </div>
  );
}
