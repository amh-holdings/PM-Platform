/**
 * One-shot (2026-11-02): Luke's 10/30 report went into BD client Notes because
 * the 0078 columns were not live yet. Copy owner, stage, next step and due date
 * out of Notes into those fields. Notes stay as written.
 *
 * Tier: a client with a bid is Active, everything else stays Prospect.
 * A pursued client with no reported due date gets today, so it lands in the queue.
 *
 * Needs 0078 and 0079 for --apply. Safe to re-run.
 *
 *   npx tsx --env-file=.env.local scripts/bd/promote-report-notes.mts           # dry run
 *   npx tsx --env-file=.env.local scripts/bd/promote-report-notes.mts --apply
 */

import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");

const STAGES: Record<string, string> = {
  "Not Contacted": "not_contacted",
  Contacted: "contacted",
  "In Conversation": "in_conversation",
  "Qualifications Sent": "quals_sent",
  "Meeting Held": "meeting_held",
  "Bid / Proposal": "bid_proposal",
  "Active Client": "active_client",
  "Not Pursuing": "not_pursuing",
};

function isoDue(raw: string | undefined): string | null {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
}

function parse(notes: string) {
  const owner = notes.match(/Luke Maslonka/) ? "Luke Maslonka" : null;
  const stageWord = Object.keys(STAGES).find(
    (s) => notes.includes(`Stage: ${s}`) || notes.includes(`10/23/2026: ${s}`),
  );
  const due = notes.match(/Reported due:? (\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/)?.[1];
  const next = notes
    .match(/Next(?: action)?: (.*?)(?= Reported due| Due year| Update:| Source:| Maite is|$)/)?.[1]
    ?.trim()
    .replace(/\.$/, "")
    .replace(/^./, (ch) => ch.toUpperCase());
  return { owner, stage: stageWord ? STAGES[stageWord] : null, due: isoDue(due), next: next ?? null };
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const db = createClient(url, key);

const { data: companies, error } = await db.from("bd_companies").select("id, name, notes").order("name");
if (error) throw error;
const { data: opps } = await db.from("bd_opportunities").select("company_id");
const withBid = new Set((opps ?? []).map((o) => o.company_id));

const today = new Date().toISOString().slice(0, 10);
const owners = new Map<string, string>();
if (APPLY) {
  const { data } = await db.from("bd_owners").select("id, name");
  for (const o of data ?? []) owners.set(o.name, o.id);
}

for (const c of companies ?? []) {
  const p = parse(c.notes ?? "");
  const tier = withBid.has(c.id) ? "active" : "prospect";
  const reported = p.owner !== null;
  const stage = p.stage ?? (withBid.has(c.id) ? "bid_proposal" : "not_contacted");
  const touch = stage === "not_pursuing" ? null : p.due ?? today;
  console.log(
    [c.name, p.owner ?? "(keep)", stage, tier, touch ?? "-", p.next ?? "-"].join(" | "),
  );
  if (!APPLY) continue;
  const patch: Record<string, unknown> = { tier, relationship_stage: stage, next_touch_date: touch };
  if (p.next) patch.next_step = p.next;
  if (reported) {
    const id = owners.get(p.owner!);
    if (!id) throw new Error(`No owner named ${p.owner}; apply 0079 first.`);
    patch.bd_owner_id = id;
  }
  const { error: e } = await db.from("bd_companies").update(patch).eq("id", c.id);
  if (e) throw new Error(`${c.name}: ${e.message}`);
}
console.log(APPLY ? "Applied." : "Dry run. Add --apply to write.");
