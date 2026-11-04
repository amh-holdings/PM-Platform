"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { bidFileText } from "@/lib/bid-file-text";
import { createClient } from "@/lib/supabase/server";
import { canWith, grantsFor, toEffectiveRole } from "@/lib/roles";
import { readDbRole } from "@/lib/roles-server";
import {
  BIDDER_KINDS,
  BIDDER_STATUSES,
  DECLINE_REASONS,
  PACKAGES,
  PACKAGE_LABEL,
  REQUIRED_DOCS,
  ROUND_KINDS,
  STATE_FIELDS,
  cleanExtractedLines,
  isAwaitingBid,
  stateCode,
} from "@/lib/rfp";
import { rfpClient } from "@/lib/rfp-db";
import type { BdFormState } from "../bd/form-state";

// Authorization reads the TRUE database role, never the view-as cookie. RLS
// enforces the same thing again underneath (0090: Phil only).
async function requireRfp(): Promise<string | null> {
  const dbRole = await readDbRole();
  return canWith(toEffectiveRole(dbRole), grantsFor(dbRole), "runRfp")
    ? null
    : "You do not have access to the RFP workspace.";
}

async function userId(): Promise<string | null> {
  const {
    data: { user },
  } = await createClient().auth.getUser();
  return user?.id ?? null;
}

function str(fd: FormData, key: string): string | null {
  const v = fd.get(key);
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function oneOf<T extends string>(fd: FormData, key: string, allowed: readonly T[]): T | null {
  const v = str(fd, key);
  return v && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

function money(fd: FormData, key: string): number | null | "invalid" {
  const v = str(fd, key);
  if (v === null) return null;
  const n = Number(v.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : "invalid";
}

function saved(): BdFormState {
  return { saved: Date.now() };
}

function bump(roundId?: string) {
  revalidatePath("/rfp");
  revalidatePath("/rfp/states");
  if (roundId) revalidatePath(`/rfp/${roundId}`);
}

// ------------------------------------------------------------------ rounds ----

export async function createRound(_p: BdFormState, fd: FormData): Promise<BdFormState> {
  const denied = await requireRfp();
  if (denied) return { error: denied };
  const target = str(fd, "target") ?? "";
  const [type, id] = target.split(":");
  if (!id || (type !== "opp" && type !== "project")) return { error: "Pick the opportunity or project this round is for." };
  const kind = oneOf(fd, "kind", ROUND_KINDS) ?? (type === "project" ? "preconstruction" : "new_bid");
  const label = str(fd, "label");
  if (!label) return { error: "Name the round, like R1 or 90% reprice." };
  const rawState = str(fd, "state");
  const state = stateCode(rawState);
  if (rawState && !state) return { error: "State is the two-letter code, like DE or VA." };

  const db = rfpClient(createClient());
  let roundState = state;
  if (!roundState && type === "opp") {
    const { data: opp } = await db.from("bd_opportunities").select("state").eq("id", id).maybeSingle();
    roundState = stateCode(opp?.state);
  }
  const { data, error } = await db
    .from("rfp_rounds")
    .insert({
      opportunity_id: type === "opp" ? id : null,
      project_id: type === "project" ? id : null,
      kind,
      label,
      state: roundState,
      due_date: str(fd, "due_date"),
      notes: str(fd, "notes"),
      created_by: await userId(),
    })
    .select("id")
    .single();
  if (error) return { error: error.message };
  bump();
  redirect(`/rfp/${data.id}`);
}

export async function updateRound(roundId: string, _p: BdFormState, fd: FormData): Promise<BdFormState> {
  const denied = await requireRfp();
  if (denied) return { error: denied };
  const label = str(fd, "label");
  if (!label) return { error: "The round needs a name." };
  const rawState = str(fd, "state");
  const state = stateCode(rawState);
  if (rawState && !state) return { error: "State is the two-letter code, like DE or VA." };
  const { error } = await rfpClient(createClient())
    .from("rfp_rounds")
    .update({
      label,
      kind: oneOf(fd, "kind", ROUND_KINDS) ?? "new_bid",
      state,
      due_date: str(fd, "due_date"),
      status: str(fd, "status") === "closed" ? "closed" : "open",
      notes: str(fd, "notes"),
    })
    .eq("id", roundId);
  if (error) return { error: error.message };
  bump(roundId);
  return saved();
}

export async function deleteRound(roundId: string): Promise<void> {
  if (await requireRfp()) return;
  await rfpClient(createClient()).from("rfp_rounds").delete().eq("id", roundId);
  bump();
  redirect("/rfp");
}

// ---------------------------------------------------------- state profiles ----

export async function saveStateProfile(_p: BdFormState, fd: FormData): Promise<BdFormState> {
  const denied = await requireRfp();
  if (denied) return { error: denied };
  const state = stateCode(str(fd, "state"));
  if (!state) return { error: "State is the two-letter code, like DE or VA." };

  const row: Record<string, string | null> = {};
  for (const f of STATE_FIELDS) row[f.key] = str(fd, f.key);

  const { error } = await rfpClient(createClient())
    .from("bd_state_profiles")
    .upsert({ state, ...row, verified_on: str(fd, "verified_on"), updated_by: await userId() }, { onConflict: "state" });
  if (error) return { error: error.message };
  bump();
  redirect(`/rfp/states#${state}`);
}

// ----------------------------------------------------------------- bidders ----

type BidderFields = {
  firm: string;
  package: string;
  kind: string;
  contact_name: string | null;
  contact_email: string | null;
  status: string;
  invited_on: string | null;
  intent_on: string | null;
  last_contact_on: string | null;
  bid_total: number | null;
  validity_date: string | null;
  wage_basis: string | null;
  bond_treatment: string | null;
  license_verified_on: string | null;
  license_note: string | null;
  decline_reason: string | null;
  notes: string | null;
};

function bidderFields(fd: FormData): BidderFields | { error: string } {
  const firm = str(fd, "firm");
  if (!firm) return { error: "Firm name is required." };
  const pkg = oneOf(fd, "package", PACKAGES);
  if (!pkg) return { error: "Pick the package they were invited to bid." };
  const status = oneOf(fd, "status", BIDDER_STATUSES) ?? "invited";
  const declineReason = oneOf(fd, "decline_reason", DECLINE_REASONS);
  if (status === "declined" && !declineReason) {
    return { error: "Ask why and record it. A decline needs a reason, even if it is \"No reason given\"." };
  }
  const total = money(fd, "bid_total");
  if (total === "invalid" || (typeof total === "number" && total < 0)) return { error: "Bid total must be a dollar amount." };
  const email = str(fd, "contact_email");
  if (email && !email.includes("@")) return { error: "That email does not look right." };
  return {
    firm,
    package: pkg,
    kind: oneOf(fd, "kind", BIDDER_KINDS) ?? "sub",
    contact_name: str(fd, "contact_name"),
    contact_email: email,
    status,
    invited_on: str(fd, "invited_on"),
    intent_on: str(fd, "intent_on"),
    last_contact_on: str(fd, "last_contact_on"),
    bid_total: total,
    validity_date: str(fd, "validity_date"),
    wage_basis: str(fd, "wage_basis"),
    bond_treatment: str(fd, "bond_treatment"),
    license_verified_on: str(fd, "license_verified_on"),
    license_note: str(fd, "license_note"),
    decline_reason: status === "declined" ? declineReason : null,
    notes: str(fd, "notes"),
  };
}

export async function addBidder(roundId: string, _p: BdFormState, fd: FormData): Promise<BdFormState> {
  const denied = await requireRfp();
  if (denied) return { error: denied };
  const fields = bidderFields(fd);
  if ("error" in fields) return fields;
  const db = rfpClient(createClient());
  const { data: round } = await db.from("rfp_rounds").select("opportunity_id").eq("id", roundId).maybeSingle();
  if (!round) return { error: "That round no longer exists." };
  const { error } = await db
    .from("rfp_bidders")
    .insert({ ...fields, round_id: roundId, opportunity_id: round.opportunity_id, created_by: await userId() });
  if (error) return { error: error.message };
  bump(roundId);
  return saved();
}

export async function updateBidder(
  bidderId: string,
  roundId: string,
  _p: BdFormState,
  fd: FormData,
): Promise<BdFormState> {
  const denied = await requireRfp();
  if (denied) return { error: denied };
  const fields = bidderFields(fd);
  if ("error" in fields) return fields;
  const { error } = await rfpClient(createClient()).from("rfp_bidders").update(fields).eq("id", bidderId);
  if (error) return { error: error.message };
  bump(roundId);
  redirect(`/rfp/${roundId}#bidders`);
}

export async function deleteBidder(bidderId: string, roundId: string): Promise<void> {
  if (await requireRfp()) return;
  await rfpClient(createClient()).from("rfp_bidders").delete().eq("id", bidderId);
  bump(roundId);
}

/** One click for the weekly check-in: last contact is today. */
export async function logBidderContact(bidderId: string, roundId: string, today: string): Promise<void> {
  if (await requireRfp()) return;
  const db = rfpClient(createClient());
  const { data: b } = await db.from("rfp_bidders").select("status").eq("id", bidderId).maybeSingle();
  if (!b) return;
  const status = b.status === "at_risk" ? "confirmed" : b.status;
  await db.from("rfp_bidders").update({ last_contact_on: today, status }).eq("id", bidderId);
  bump(roundId);
}

// --------------------------------------------------------------- documents ----

const ALL_DOC_KEYS = Object.values(REQUIRED_DOCS).flatMap((list) => list.map((d) => d.key));

export async function toggleDoc(bidderId: string, roundId: string, docKey: string, have: boolean): Promise<void> {
  if (await requireRfp()) return;
  if (!ALL_DOC_KEYS.includes(docKey)) return;
  const db = rfpClient(createClient());
  if (have) {
    await db.from("rfp_bidder_docs").delete().eq("bidder_id", bidderId).eq("doc_key", docKey);
  } else {
    await db
      .from("rfp_bidder_docs")
      .upsert(
        { bidder_id: bidderId, doc_key: docKey, created_by: await userId() },
        { onConflict: "bidder_id,doc_key", ignoreDuplicates: true },
      );
  }
  bump(roundId);
}

// ------------------------------------------------------------- bid upload ----

/**
 * Reads an uploaded bid, has Claude pull the lines through the relay, and
 * stores them UNCONFIRMED. They count in the leveling only after Phil
 * confirms them. A new upload replaces the bidder's previous lines.
 */
export async function uploadBid(bidderId: string, roundId: string, _p: BdFormState, fd: FormData): Promise<BdFormState> {
  const denied = await requireRfp();
  if (denied) return { error: denied };
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose the bid file to upload." };

  const relayUrl = process.env.RELAY_URL;
  const relaySecret = process.env.RELAY_SHARED_SECRET;
  if (!relayUrl || !relaySecret) {
    return { error: "Bid reading is not configured. RELAY_URL and RELAY_SHARED_SECRET must be set and the Mac Mini relay running." };
  }

  const read = await bidFileText(file.name, new Uint8Array(await file.arrayBuffer()));
  if (!read.ok) return { error: read.error };

  const db = rfpClient(createClient());
  const { data: bidder } = await db.from("rfp_bidders").select("*").eq("id", bidderId).maybeSingle();
  if (!bidder) return { error: "That bidder no longer exists." };
  const { data: round } = await db.from("rfp_rounds").select("*").eq("id", roundId).maybeSingle();

  let data: {
    lines?: unknown;
    printed_total?: unknown;
    wage_basis?: string | null;
    validity?: string | null;
    bond_treatment?: string | null;
    defects?: unknown;
    notes?: string;
    error?: string;
  };
  try {
    const res = await fetch(`${relayUrl}/extract-bid`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${relaySecret}` },
      body: JSON.stringify({
        file_name: file.name,
        text: read.text,
        firm: bidder.firm,
        invited_package: bidder.package,
        packages: PACKAGES.map((p) => ({ key: p, label: PACKAGE_LABEL[p] })),
        context: round ? `${round.label}${round.state ? `, ${round.state}` : ""}` : undefined,
      }),
      signal: AbortSignal.timeout(180_000),
    });
    data = await res.json().catch(() => ({ error: `Relay returned ${res.status}` }));
    if (!res.ok) return { error: data.error ?? `Relay returned ${res.status}` };
  } catch (err) {
    return { error: `Could not reach the relay: ${err instanceof Error ? err.message : "network error"}` };
  }

  const lines = cleanExtractedLines(data.lines, bidder.package);
  if (!lines.length) return { error: "Claude found no priced lines in that file. Check it is the bid, not a cover letter." };
  const printed = typeof data.printed_total === "number" ? data.printed_total : Number(data.printed_total);
  const defects = Array.isArray(data.defects) ? data.defects.filter((d): d is string => typeof d === "string").slice(0, 30) : [];

  await db.from("rfp_bid_lines").delete().eq("bidder_id", bidderId);
  const { error: insertError } = await db
    .from("rfp_bid_lines")
    .insert(lines.map((l, i) => ({ ...l, bidder_id: bidderId, sort_order: i })));
  if (insertError) return { error: insertError.message };

  await db
    .from("rfp_bidders")
    .update({
      source_file_name: file.name,
      printed_total: Number.isFinite(printed) ? printed : null,
      extracted_at: new Date().toISOString(),
      extraction_notes: typeof data.notes === "string" ? data.notes.slice(0, 4000) : null,
      defects,
      lines_confirmed_at: null,
      status: isAwaitingBid(bidder.status) ? "received" : bidder.status,
      wage_basis: bidder.wage_basis ?? data.wage_basis ?? null,
      bond_treatment: bidder.bond_treatment ?? data.bond_treatment ?? null,
      notes: bidder.notes ?? (data.validity ? `Validity as written: ${data.validity}` : null),
    })
    .eq("id", bidderId);

  bump(roundId);
  redirect(`/rfp/${roundId}?lines=${bidderId}#bidder-${bidderId}`);
}

// ------------------------------------------------------------------ lines ----

function lineFields(fd: FormData) {
  const description = str(fd, "description");
  const pkg = oneOf(fd, "package", PACKAGES);
  const amount = money(fd, "amount");
  const quantity = money(fd, "quantity");
  if (!description || !pkg || amount === "invalid" || quantity === "invalid") return null;
  return { description, package: pkg, amount, quantity, unit: str(fd, "unit") };
}

/** Any edit to the lines un-confirms them: a changed bid is checked again. */
async function unconfirm(bidderId: string) {
  await rfpClient(createClient()).from("rfp_bidders").update({ lines_confirmed_at: null }).eq("id", bidderId);
}

export async function addLine(bidderId: string, roundId: string, fd: FormData): Promise<void> {
  if (await requireRfp()) return;
  const fields = lineFields(fd);
  if (!fields) return;
  const db = rfpClient(createClient());
  const { count } = await db.from("rfp_bid_lines").select("id", { count: "exact", head: true }).eq("bidder_id", bidderId);
  await db.from("rfp_bid_lines").insert({ ...fields, bidder_id: bidderId, sort_order: count ?? 0, source_ref: "Added by hand" });
  await unconfirm(bidderId);
  bump(roundId);
}

export async function updateLine(lineId: string, bidderId: string, roundId: string, fd: FormData): Promise<void> {
  if (await requireRfp()) return;
  const fields = lineFields(fd);
  if (!fields) return;
  await rfpClient(createClient()).from("rfp_bid_lines").update(fields).eq("id", lineId);
  await unconfirm(bidderId);
  bump(roundId);
}

export async function deleteLine(lineId: string, bidderId: string, roundId: string): Promise<void> {
  if (await requireRfp()) return;
  await rfpClient(createClient()).from("rfp_bid_lines").delete().eq("id", lineId);
  await unconfirm(bidderId);
  bump(roundId);
}

export async function confirmLines(bidderId: string, roundId: string, confirm: boolean): Promise<void> {
  if (await requireRfp()) return;
  await rfpClient(createClient())
    .from("rfp_bidders")
    .update({ lines_confirmed_at: confirm ? new Date().toISOString() : null })
    .eq("id", bidderId);
  bump(roundId);
  redirect(`/rfp/${roundId}#leveling`);
}

// ---------------------------------------------------- packages and carry ----

async function upsertPackage(roundId: string, pkg: string, patch: { estimate?: number | null; carried_bidder_id?: string | null }) {
  const db = rfpClient(createClient());
  const { data: existing } = await db
    .from("rfp_round_packages")
    .select("id")
    .eq("round_id", roundId)
    .eq("package", pkg)
    .maybeSingle();
  if (existing) await db.from("rfp_round_packages").update(patch).eq("id", existing.id);
  else await db.from("rfp_round_packages").insert({ round_id: roundId, package: pkg, ...patch });
}

export async function setEstimate(roundId: string, pkg: string, fd: FormData): Promise<void> {
  if (await requireRfp()) return;
  if (!(PACKAGES as readonly string[]).includes(pkg)) return;
  const estimate = money(fd, "estimate");
  if (estimate === "invalid") return;
  await upsertPackage(roundId, pkg, { estimate });
  bump(roundId);
}

export async function addPackage(roundId: string, fd: FormData): Promise<void> {
  if (await requireRfp()) return;
  const pkg = oneOf(fd, "package", PACKAGES);
  if (!pkg) return;
  const estimate = money(fd, "estimate");
  await upsertPackage(roundId, pkg, estimate === "invalid" ? {} : { estimate });
  bump(roundId);
}

export async function setCarried(roundId: string, pkg: string, fd: FormData): Promise<void> {
  if (await requireRfp()) return;
  if (!(PACKAGES as readonly string[]).includes(pkg)) return;
  await upsertPackage(roundId, pkg, { carried_bidder_id: str(fd, "bidder_id") });
  bump(roundId);
}

export async function mapCostCode(roundId: string, fd: FormData): Promise<void> {
  if (await requireRfp()) return;
  const pkg = oneOf(fd, "package", PACKAGES);
  const costCodeId = str(fd, "cost_code_id");
  if (!pkg || !costCodeId) return;
  await rfpClient(createClient())
    .from("rfp_round_cost_codes")
    .upsert({ round_id: roundId, package: pkg, cost_code_id: costCodeId }, { onConflict: "round_id,package,cost_code_id", ignoreDuplicates: true });
  bump(roundId);
}

export async function unmapCostCode(mappingId: string, roundId: string): Promise<void> {
  if (await requireRfp()) return;
  await rfpClient(createClient()).from("rfp_round_cost_codes").delete().eq("id", mappingId);
  bump(roundId);
}
