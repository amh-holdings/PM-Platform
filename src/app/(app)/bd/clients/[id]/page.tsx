import Link from "next/link";
import { notFound } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/server";
import {
  ACTIVITY_LABEL,
  STAGE_LABEL,
  formatPct,
  isOpenStage,
  latestBidByOpp,
  winRate,
  type BdStage,
} from "@/lib/bd";
import { bdClient, loadBdPeople } from "@/lib/bd-db";
import { oppLite } from "@/lib/bd-load";
import { formatCurrency, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { addContact, logActivity, removeContact, updateCompany } from "../../actions";
import { ActionForm } from "../../_components/action-form";
import { CompanyFields } from "../../_components/company-fields";
import { Card, Empty, Field, StagePill, TextLink, tdClass, thClass } from "../../_components/fields";
import { LogTouchFields } from "../../_components/log-touch-fields";

export default async function ClientPage({ params }: { params: { id: string } }) {
  const supabase = createClient();
  const db = bdClient(supabase);
  const { data: company } = await db.from("bd_companies").select("*").eq("id", params.id).maybeSingle();
  if (!company) notFound();

  const [contacts, opps, activities, people] = await Promise.all([
    db.from("bd_contacts").select("*").eq("company_id", company.id).order("name"),
    db.from("bd_opportunities").select("*").eq("company_id", company.id).order("updated_at", { ascending: false }),
    db
      .from("bd_activities")
      .select("*")
      .eq("company_id", company.id)
      .order("occurred_on", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(50),
    loadBdPeople(supabase),
  ]);
  const oppRows = opps.data ?? [];
  const { data: bids } = oppRows.length
    ? await db.from("bd_bids").select("*").in("opportunity_id", oppRows.map((o) => o.id))
    : { data: [] };
  const latest = latestBidByOpp((bids ?? []).map((b) => ({ ...b, price: Number(b.price) })));
  const wr = winRate(oppRows.map(oppLite), latest);
  const personName = new Map(people.map((p) => [p.id, p.name]));
  const contactName = new Map((contacts.data ?? []).map((c) => [c.id, c.name]));
  const oppName = new Map(oppRows.map((o) => [o.id, o.name]));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{company.name}</h1>
          <p className="text-sm text-muted-foreground">
            {company.company_type}
            {company.state && ` - ${company.state}`}
            {company.owner_id && ` - Owner: ${personName.get(company.owner_id) ?? "-"}`}
            {company.website && (
              <>
                {" - "}
                <a
                  href={company.website.startsWith("http") ? company.website : `https://${company.website}`}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  {company.website}
                </a>
              </>
            )}
          </p>
          {company.notes && <p className="mt-2 max-w-2xl whitespace-pre-wrap text-sm">{company.notes}</p>}
        </div>
        <Button asChild size="sm">
          <Link href={`/bd/opportunities/new?company=${company.id}`}>New opportunity</Link>
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Open opportunities" value={String(oppRows.filter((o) => isOpenStage(o.stage)).length)} />
        <Stat label="Won / Lost" value={`${wr.won} / ${wr.lost}`} />
        <Stat label="Win rate (count)" value={formatPct(wr.rateCount)} />
        <Stat label="Win rate ($)" value={formatPct(wr.rateDollars)} />
      </div>

      <Card title={`Opportunities (${oppRows.length})`}>
        {oppRows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className={thClass}>Opportunity</th>
                  <th className={thClass}>Stage</th>
                  <th className={cn(thClass, "text-right")}>Latest bid</th>
                  <th className={thClass}>Follow up / decided</th>
                </tr>
              </thead>
              <tbody>
                {oppRows.map((o) => (
                  <tr key={o.id} className="border-b last:border-0">
                    <td className={tdClass}>
                      <TextLink href={`/bd/opportunities/${o.id}`}>{o.name}</TextLink>
                    </td>
                    <td className={tdClass}>
                      <StagePill stage={o.stage} label={STAGE_LABEL[o.stage as BdStage] ?? o.stage} />
                    </td>
                    <td className={cn(tdClass, "text-right tabular-nums")}>
                      {latest.get(o.id) ? formatCurrency(latest.get(o.id)!.price) : "-"}
                    </td>
                    <td className={cn(tdClass, "whitespace-nowrap")}>
                      {formatDate(isOpenStage(o.stage) ? o.next_follow_up_date : o.outcome_date)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No opportunities with this client yet.</Empty>
        )}
      </Card>

      <Card title={`Contacts (${contacts.data?.length ?? 0})`}>
        {contacts.data?.length ? (
          <div className="mb-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className={thClass}>Name</th>
                  <th className={thClass}>Title</th>
                  <th className={thClass}>Email</th>
                  <th className={thClass}>Phone</th>
                  <th className={thClass} />
                </tr>
              </thead>
              <tbody>
                {contacts.data.map((c) => (
                  <tr key={c.id} className="border-b last:border-0">
                    <td className={tdClass}>
                      {c.name}
                      {c.is_decision_maker && (
                        <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">Decision-maker</span>
                      )}
                    </td>
                    <td className={tdClass}>{c.title ?? "-"}</td>
                    <td className={tdClass}>
                      {c.email ? (
                        <a href={`mailto:${c.email}`} className="underline">
                          {c.email}
                        </a>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className={tdClass}>{c.phone ?? "-"}</td>
                    <td className={cn(tdClass, "text-right")}>
                      <form action={removeContact.bind(null, c.id, company.id)}>
                        <button type="submit" className="text-xs text-muted-foreground hover:text-destructive">
                          Remove
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="mb-5">
            <Empty>No contacts yet.</Empty>
          </div>
        )}
        <details className="rounded-md border p-4" open={!contacts.data?.length}>
          <summary className="cursor-pointer text-sm font-medium">Add a contact</summary>
          <ActionForm action={addContact.bind(null, company.id)} submitLabel="Add contact" className="mt-4 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Name" htmlFor="contact-name" required>
                <Input id="contact-name" name="name" required />
              </Field>
              <Field label="Title" htmlFor="title">
                <Input id="title" name="title" />
              </Field>
              <Field label="Email" htmlFor="email">
                <Input id="email" name="email" type="email" />
              </Field>
              <Field label="Phone" htmlFor="phone">
                <Input id="phone" name="phone" />
              </Field>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="is_decision_maker" /> Decision-maker
              </label>
            </div>
          </ActionForm>
        </details>
      </Card>

      <Card title="Log a touch" id="log">
        <p className="mb-3 text-xs text-muted-foreground">
          For a relationship touch with no particular bid. To follow up on a bid, log it on the
          opportunity so its next follow-up date moves.
        </p>
        <ActionForm action={logActivity} submitLabel="Log touch">
          <LogTouchFields companyId={company.id} contacts={contacts.data ?? []} />
        </ActionForm>
      </Card>

      <Card title="History">
        {activities.data?.length ? (
          <ul className="space-y-3 text-sm">
            {activities.data.map((a) => (
              <li key={a.id} className="flex gap-3 border-b pb-3 last:border-0 last:pb-0">
                <span className="w-24 shrink-0 text-muted-foreground">{formatDate(a.occurred_on)}</span>
                <div>
                  <span className="font-medium">
                    {ACTIVITY_LABEL[a.activity_type as keyof typeof ACTIVITY_LABEL] ?? a.activity_type}
                  </span>
                  {a.contact_id && <span className="text-muted-foreground"> with {contactName.get(a.contact_id)}</span>}
                  {a.opportunity_id && (
                    <span className="text-muted-foreground">
                      {" "}
                      on <TextLink href={`/bd/opportunities/${a.opportunity_id}`}>{oppName.get(a.opportunity_id) ?? "opportunity"}</TextLink>
                    </span>
                  )}
                  {a.logged_by && <span className="text-muted-foreground"> - {personName.get(a.logged_by) ?? ""}</span>}
                  {a.notes && <p className="mt-0.5 whitespace-pre-wrap">{a.notes}</p>}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No touches logged yet.</Empty>
        )}
      </Card>

      <details className="rounded-lg border bg-card p-5 shadow-sm">
        <summary className="cursor-pointer text-base font-semibold">Edit client</summary>
        <ActionForm action={updateCompany.bind(null, company.id)} submitLabel="Save" className="mt-4 space-y-4">
          <CompanyFields company={company} people={people} />
        </ActionForm>
      </details>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
