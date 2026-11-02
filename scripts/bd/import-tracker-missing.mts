/**
 * Add the clients on Luke's weekly tracker that are not in BD yet, with their
 * contacts and touches (2026-11-02). Clients already in BD keep their stage, owner,
 * next step and notes, since Phil loaded those by hand from the 10/30 report; they
 * only gain contacts they are missing and titles left blank. Greenbacker stays its
 * own client. The Conti and EDP merges from 10-28 still stand.
 *
 * Paul Platt and Al Varshoi are skipped: the tracker lists them as live, the report
 * says one bounced and one left. backfill-report-history.mts adds them with status.
 *
 * Safe to re-run: clients match by name or merge alias, contacts by email or name.
 *
 *   npx tsx --env-file=.env.local scripts/bd/import-tracker-missing.mts <tracker.xlsx>          # dry run
 *   npx tsx --env-file=.env.local scripts/bd/import-tracker-missing.mts <tracker.xlsx> --apply
 */

import { readFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";

const APPLY = process.argv.includes("--apply");
const FILE = process.argv.slice(2).find((a) => !a.startsWith("--"));
const PHIL = "9e92de24-8545-467f-b3a8-f68a894e71ad";
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const TOUCH_DAYS = 14;

// alias -> the row it folds into
const MERGES: Record<string, string> = {
  "Conti Solar": "CS Energy",
  "EDP Renewables Distributed Generation": "EDPR NA Distributed Generation",
};
const LEFT_OR_BOUNCED = new Set(["Paul Platt", "Al Varshoi"]);
const SKIP = new Set(["Wind investor / partner inquiries"]);
const COMPANY_TYPE: Record<string, string> = {
  "Dominion Energy": "Utility",
  "Dynamic Energy": "EPC",
};
// Domain typos in the tracker. DSD's is why Mike Slack bounced.
const EMAIL_FIXES: [RegExp, string][] = [
  [/@cvegroup\.cpm$/, "@cvegroup.com"],
  [/@dsdreneawables\.com$/, "@dsdrenewables.com"],
  [/@nautilissolar\.com$/, "@nautilussolar.com"],
];
const CONTACT_OVERRIDES: Record<string, { name?: string; title?: string }> = {
  "dmoretz@amp.energy": { name: "Derek Moretz", title: "VP of Development" },
  "matthew.house@mn8.com": { name: "Matthew House", title: "Sr. Procurement Manager" },
  "lauren@encore.eco": { name: "Lauren Glickman" },
};

const STAGES: Record<string, string> = {
  "not contacted": "not_contacted",
  contacted: "contacted",
  "in conversation": "in_conversation",
  "qualifications sent": "quals_sent",
  "meeting held": "meeting_held",
  "bid / proposal": "bid_proposal",
  "active client": "active_client",
  "not pursuing": "not_pursuing",
};
const STAGE_ORDER = Object.values(STAGES).filter((s) => s !== "not_pursuing");

type Contact = { name: string; title: string | null; email: string | null; notes: string | null };
type Activity = { occurred_on: string; activity_type: string; notes: string };
type Account = {
  name: string;
  tier: "active" | "prospect";
  stage: string;
  owner: string;
  next_step: string | null;
  next_touch_date: string | null;
  contacts: Contact[];
  activities: Activity[];
  notes: string[];
  mergedFrom: string[];
};

// ------------------------------------------------------------- parsing ----

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return iso(new Date(Date.UTC(y, m - 1, d + days)));
}

function cellDate(v: unknown): string | null {
  if (v instanceof Date) return iso(new Date(v.getTime() + 12 * 3600_000)); // dodge TZ rollback
  return null;
}

/** m/d/yy dates in free text. "9/303/26" is a typo for 9/30. Future dates are plans, not touches. */
function textDates(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/(\d{1,2})\/(\d{1,3})\/(\d{2,4})/g)) {
    const mo = Number(m[1]);
    let day = Number(m[2]);
    if (day > 31) day = Number(m[2].slice(0, 2));
    const yr = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    if (mo < 1 || mo > 12 || day < 1 || day > 31) continue;
    const d = `${yr}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (d <= TODAY && !out.includes(d)) out.push(d);
  }
  return out;
}

function activityType(s: string): string {
  if (/\bcall\b|teams/i.test(s)) return "call";
  if (/\bmet\b|meeting|meet up/i.test(s)) return "meeting";
  if (/e-?mail|sent|bounce/i.test(s)) return "email";
  return "other";
}

function parseActivities(update: string, lastTouch: string | null, stageLabel: string) {
  const activities: Activity[] = [];
  const notes: string[] = [];
  const sentences = update
    .replace(/\s+/g, " ")
    .split(/(?<=\.)\s*(?=[A-Z])/)
    .map((s) => s.trim())
    .filter(Boolean);
  const groups = new Map<string, string[]>();
  const undated: string[] = [];
  let current: string | null = null;
  for (const s of sentences) {
    const dates = textDates(s);
    if (dates.length) {
      for (const d of dates) groups.set(d, [...(groups.get(d) ?? []), s]);
      current = dates[dates.length - 1];
    } else if (current) {
      groups.get(current)!.push(s);
    } else {
      undated.push(s);
    }
  }
  if (undated.length) {
    if (lastTouch) groups.set(lastTouch, [...undated, ...(groups.get(lastTouch) ?? [])]);
    else notes.push(undated.join(" "));
  }
  if (lastTouch && !groups.has(lastTouch)) {
    groups.set(lastTouch, [`Last touch on the weekly tracker (stage: ${stageLabel}).`]);
  }
  for (const [d, ss] of groups) {
    const text = ss.join(" ");
    activities.push({ occurred_on: d, activity_type: activityType(text), notes: text });
  }
  return { activities: activities.sort((a, b) => a.occurred_on.localeCompare(b.occurred_on)), notes };
}

function fixEmail(e: string): string {
  let out = e.toLowerCase();
  for (const [re, to] of EMAIL_FIXES) out = out.replace(re, to);
  return out;
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function parseContacts(cell: string): { contacts: Contact[]; notes: string[] } {
  const contacts: Contact[] = [];
  const notes: string[] = [];
  for (const raw of cell.split(/\r?\n|\|/).map((p) => p.trim()).filter(Boolean)) {
    if (/chapter \d+/i.test(raw)) continue; // Pine Gate's status, already in the update
    if (/^general\s+[\d-]+$/i.test(raw)) {
      notes.push(`General line: ${raw.replace(/^general\s+/i, "")}`);
      continue;
    }
    // No hyphen in the local part: the tracker glues names on ("Mike Slack-m.slack@").
    const emailMatch = raw.match(/[\w.+]+@[\w-]+(\.[\w-]+)+/);
    const invalid = /not valid/i.test(raw);
    let email = emailMatch && !invalid ? fixEmail(emailMatch[0]) : null;
    let rest = raw;
    if (emailMatch) rest = rest.slice(0, rest.indexOf(emailMatch[0]));
    rest = rest.replace(/no email on file/i, "").replace(/no contact name found/i, "").replace(/[\s-]+$/, "").trim();
    let name = rest;
    let title: string | null = null;
    const t = rest.match(/^(.*?)\s*\(([^()]*)\)$/);
    if (t) {
      name = t[1].trim();
      title = t[2].trim();
    }
    if (!name && email) {
      const local = email.split("@")[0];
      name = local.includes(".") ? titleCase(local.replace(/\./g, " ")) : "General inbox";
    }
    if (!name) continue;
    const o = email ? CONTACT_OVERRIDES[email] : undefined;
    if (o) {
      name = o.name ?? name;
      title = o.title ?? title;
    }
    contacts.push({
      name,
      title,
      email,
      notes: invalid ? `Tracker: ${raw.slice(raw.indexOf("-") + 1).trim()}` : null,
    });
    if (email && emailMatch && email !== emailMatch[0].toLowerCase()) {
      notes.push(`Fixed email typo: ${emailMatch[0]} -> ${email}`);
    }
  }
  return { contacts, notes };
}

function readTracker(path: string): Account[] {
  const wb = XLSX.read(readFileSync(path), { cellDates: true });
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets["Business Development"], {
    header: 1,
    raw: true,
  });
  const out: Account[] = [];
  let tier: Account["tier"] | null = null;
  for (const r of rows) {
    const name = typeof r[0] === "string" ? r[0].trim() : "";
    if (/^ACTIVE \(/.test(name)) tier = "active";
    else if (/^PROSPECTS \(/.test(name)) tier = "prospect";
    if (!tier || !name || /^(ACTIVE|PROSPECTS) \(/.test(name) || SKIP.has(name)) continue;

    const stageLabel = String(r[3] ?? "").trim();
    const stage = STAGES[stageLabel.toLowerCase()];
    if (!stage) throw new Error(`${name}: unknown stage "${stageLabel}"`);
    const lastTouch = cellDate(r[4]);
    const { activities, notes } = parseActivities(String(r[7] ?? ""), lastTouch, stageLabel);
    const parsed = parseContacts(String(r[1] ?? ""));

    let nextStep = typeof r[5] === "string" && r[5].trim() ? r[5].trim() : null;
    // Prospect rows say what was done ("Made first contact"), not what is next.
    const done = nextStep?.match(/^(made (first contact|email intro)|sent email (to|request))[^.]*\.?\s*/i);
    if (nextStep && done) {
      const extra = nextStep.slice(done[0].length).trim();
      if (extra) notes.push(extra);
      nextStep = "Follow up on intro email";
    }
    let due = cellDate(r[6]);
    if (stage === "not_pursuing") due = null;
    else if (!due) {
      const latest = activities.at(-1)?.occurred_on;
      due = latest ? addDays(latest, TOUCH_DAYS) : TODAY;
    }

    out.push({
      name,
      tier,
      stage,
      owner: String(r[2] ?? "").trim(),
      next_step: nextStep,
      next_touch_date: due,
      contacts: parsed.contacts,
      activities,
      notes: [...parsed.notes, ...notes],
      mergedFrom: [],
    });
  }
  return out;
}

function mergeAccounts(accounts: Account[]): Account[] {
  const byName = new Map(accounts.map((a) => [a.name, a]));
  for (const [alias, primaryName] of Object.entries(MERGES)) {
    const alt = byName.get(alias);
    const primary = byName.get(primaryName);
    if (!alt) continue;
    if (!primary) throw new Error(`Merge target "${primaryName}" not in the tracker`);
    const rank = (s: string) => STAGE_ORDER.indexOf(s);
    if (rank(alt.stage) > rank(primary.stage)) primary.stage = alt.stage;
    if (alt.tier === "active") primary.tier = "active";
    primary.contacts.push(...alt.contacts);
    primary.activities.push(...alt.activities.map((a) => ({ ...a, notes: `[${alias}] ${a.notes}` })));
    primary.notes.push(...alt.notes, `Merged from tracker row "${alias}" (owner ${alt.owner}).`);
    primary.mergedFrom.push(alias);
    byName.delete(alias);
  }
  for (const a of byName.values()) {
    const seen = new Set<string>();
    a.contacts = a.contacts.filter((c) => {
      const k = c.email ?? c.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    a.activities.sort((x, y) => x.occurred_on.localeCompare(y.occurred_on));
  }
  return [...byName.values()];
}

// --------------------------------------------------------------- write ----

const OWNER_NAMES: Record<string, string> = { Phil: "Phil Horwitch", Luke: "Luke Maslonka", Shannon: "Shannon" };

async function main() {
  if (!FILE) throw new Error("Pass the tracker .xlsx path.");
  const accounts = mergeAccounts(readTracker(FILE));
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  const [{ data: existing, error }, { data: owners, error: ownerError }, { data: allContacts }] = await Promise.all([
    db.from("bd_companies").select("id, name"),
    db.from("bd_owners").select("id, name"),
    db.from("bd_contacts").select("id, name, email, title, company_id"),
  ]);
  if (error) throw error;
  if (ownerError) throw ownerError;
  const have = new Set((existing ?? []).map((c) => c.name.toLowerCase()));
  const ownerId = new Map((owners ?? []).map((o) => [o.name, o.id]));

  const missing = accounts.filter(
    (a) => !have.has(a.name.toLowerCase()) && !a.mergedFrom.some((m) => have.has(m.toLowerCase())),
  );
  const skipped = accounts.filter((a) => !missing.includes(a));
  console.log(`${APPLY ? "APPLY" : "DRY RUN"} - ${accounts.length} on the tracker, ${skipped.length} already in BD, ${missing.length} to add\n`);
  console.log("ALREADY IN BD (left alone): " + skipped.map((a) => a.name).join(", ") + "\n");
  console.log("client | tier | stage | owner | next touch | contacts | touches | next step");

  // An email already on a client means this is the same person at a company we
  // hold under another name. Worth a look, so it is reported, never merged.
  const emailOwner = new Map((allContacts ?? []).filter((c) => c.email).map((c) => [c.email!.toLowerCase(), c.company_id]));

  let contactsAdded = 0;
  let touchesAdded = 0;
  for (const a of missing) {
    const fullOwner = OWNER_NAMES[a.owner] ?? a.owner;
    const id = ownerId.get(fullOwner);
    if (!id) throw new Error(`${a.name}: no owner named "${a.owner}"`);
    console.log([a.name, a.tier, a.stage, fullOwner, a.next_touch_date ?? "-", a.contacts.length, a.activities.length, a.next_step ?? "-"].join(" | "));
    for (const c of a.contacts) {
      if (c.email && emailOwner.has(c.email)) console.log(`  WARN ${c.email} is already a contact on another client`);
    }
    if (a.notes.length) console.log(`  notes: ${a.notes.join(" / ").slice(0, 160)}`);
    contactsAdded += a.contacts.length;
    touchesAdded += a.activities.length;
    if (!APPLY) continue;

    const { data, error: e } = await db
      .from("bd_companies")
      .insert({
        name: a.name,
        tier: a.tier,
        relationship_stage: a.stage,
        bd_owner_id: id,
        next_step: a.next_step,
        next_touch_date: a.next_touch_date,
        notes: a.notes.join("\n") || null,
        created_by: PHIL,
        ...(COMPANY_TYPE[a.name] ? { company_type: COMPANY_TYPE[a.name] } : {}),
      })
      .select("id")
      .single();
    if (e) throw new Error(`${a.name}: ${e.message}`);
    if (a.contacts.length) {
      const { error: ce } = await db.from("bd_contacts").insert(a.contacts.map((c) => ({ ...c, company_id: data.id })));
      if (ce) throw new Error(`${a.name} contacts: ${ce.message}`);
    }
    if (a.activities.length) {
      const { error: ae } = await db.from("bd_activities").insert(a.activities.map((x) => ({ ...x, company_id: data.id })));
      if (ae) throw new Error(`${a.name} touches: ${ae.message}`);
    }
  }
  console.log(`\n${missing.length} clients, ${contactsAdded} contacts, ${touchesAdded} touches ${APPLY ? "added" : "would be added"}.`);

  // Clients already in BD: missing contacts and blank titles only.
  const idByName = new Map((existing ?? []).map((c) => [c.name.toLowerCase(), c.id]));
  let moreContacts = 0;
  let titles = 0;
  console.log("\nEXISTING CLIENTS");
  for (const a of skipped) {
    const id = idByName.get(a.name.toLowerCase());
    if (!id) continue;
    const held = (allContacts ?? []).filter((c) => c.company_id === id);
    for (const c of a.contacts) {
      if (LEFT_OR_BOUNCED.has(c.name)) continue;
      const match = held.find(
        (h) => (c.email && h.email?.toLowerCase() === c.email) || h.name.toLowerCase() === c.name.toLowerCase(),
      );
      if (match) {
        if (!match.title && c.title) {
          console.log(`title   ${a.name} | ${match.name} | ${c.title}`);
          titles += 1;
          if (APPLY) {
            const { error: e } = await db.from("bd_contacts").update({ title: c.title }).eq("id", match.id);
            if (e) throw new Error(`${match.name}: ${e.message}`);
          }
        }
        continue;
      }
      console.log(`contact ${a.name} | ${c.name} | ${c.title ?? "-"} | ${c.email ?? "no email"}`);
      moreContacts += 1;
      if (APPLY) {
        const { error: e } = await db.from("bd_contacts").insert({ ...c, company_id: id });
        if (e) throw new Error(`${c.name}: ${e.message}`);
      }
    }
  }
  console.log(`${moreContacts} contacts and ${titles} titles ${APPLY ? "added" : "would be added"} on existing clients.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
