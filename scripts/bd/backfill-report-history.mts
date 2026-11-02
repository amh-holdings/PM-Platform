/**
 * One-shot (2026-11-02): four clients showed "Never" for last touch although
 * Luke's 10/30 report dates a touch for them, and two people the report says
 * are unreachable were only named in Notes. Adds the touches and contact rows.
 * Type is Other where the report does not say how the touch happened.
 *
 * Needs migration 0080. Safe to re-run.
 *
 *   npx tsx --env-file=.env.local scripts/bd/backfill-report-history.mts           # dry run
 *   npx tsx --env-file=.env.local scripts/bd/backfill-report-history.mts --apply
 */

import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const SOURCE = "From Luke's 10/30 report";

const TOUCHES = [
  { client: "Concord New Energy", on: "2026-10-09", type: "other", notes: `Nathan Stumpff expressed RE+ meeting interest. ${SOURCE}.` },
  { client: "Leeward Renewable Energy", on: "2026-10-07", type: "email", notes: `Email to Paul Platt bounced. ${SOURCE}.` },
  { client: "Summit Ridge Energy", on: "2026-07-08", type: "other", notes: `Last communication before it stopped. ${SOURCE}.` },
  { client: "Greenbacker Renewable Energy", on: "2026-10-01", type: "email", notes: `Intro and SOQ sent. ${SOURCE}.` },
];

const INACTIVE_CONTACTS = [
  { client: "Leeward Renewable Energy", name: "Paul Platt", email: "paul.platt@leewardenergy.com", status: "bounced", notes: `Address undeliverable, 10/7. ${SOURCE}.` },
  { client: "Engie", name: "Al Varshoi", email: "alireza.varshoi@engie.com", status: "left", notes: `Left Engie; Maite Robyn is the contact now. ${SOURCE}.` },
];

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const { data: companies, error } = await db.from("bd_companies").select("id, name");
if (error) throw error;
const idOf = new Map((companies ?? []).map((c) => [c.name, c.id]));
function companyId(name: string): string {
  const id = idOf.get(name);
  if (!id) throw new Error(`No client named ${name}`);
  return id;
}

for (const t of TOUCHES) {
  const company_id = companyId(t.client);
  const { data: existing } = await db
    .from("bd_activities")
    .select("id")
    .eq("company_id", company_id)
    .eq("occurred_on", t.on)
    .eq("notes", t.notes);
  if (existing?.length) {
    console.log(`have    ${t.client} ${t.on}`);
    continue;
  }
  console.log(`touch   ${t.client} ${t.on} ${t.type}`);
  if (APPLY) {
    const { error: e } = await db.from("bd_activities").insert({
      company_id,
      activity_type: t.type,
      occurred_on: t.on,
      notes: t.notes,
    });
    if (e) throw new Error(`${t.client}: ${e.message}`);
  }
}

for (const c of INACTIVE_CONTACTS) {
  const company_id = companyId(c.client);
  const { data: existing } = await db
    .from("bd_contacts")
    .select("id")
    .eq("company_id", company_id)
    .eq("name", c.name);
  if (existing?.length) {
    console.log(`have    ${c.client} ${c.name}`);
    continue;
  }
  console.log(`contact ${c.client} ${c.name} (${c.status})`);
  if (APPLY) {
    const { error: e } = await db.from("bd_contacts").insert({
      company_id,
      name: c.name,
      email: c.email,
      status: c.status,
      notes: c.notes,
    });
    if (e) throw new Error(`${c.name}: ${e.message}`);
  }
}
console.log(APPLY ? "Applied." : "Dry run. Add --apply to write.");
