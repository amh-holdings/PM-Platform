"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { canWith, grantsFor, toEffectiveRole } from "@/lib/roles";
import { readDbRole } from "@/lib/roles-server";
import {
  ALL_STEP_KEYS,
  BIDDER_KINDS,
  BIDDER_STATUSES,
  DECLINE_REASONS,
  PACKAGES,
  REQUIRED_DOCS,
  STATE_FIELDS,
  stateCode,
} from "@/lib/rfp";
import { rfpClient } from "@/lib/rfp-db";
import type { BdFormState } from "../bd/form-state";

// Authorization reads the TRUE database role, never the view-as cookie. RLS
// enforces the same thing again underneath (0088).
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
  return Number.isFinite(n) && n >= 0 ? n : "invalid";
}

function saved(): BdFormState {
  return { saved: Date.now() };
}

function bump(oppId?: string) {
  revalidatePath("/rfp");
  revalidatePath("/rfp/states");
  if (oppId) revalidatePath(`/rfp/${oppId}`);
}

// ---------------------------------------------------------- runbook steps ----

export async function toggleStep(oppId: string, stepKey: string, done: boolean): Promise<void> {
  if (await requireRfp()) return;
  if (!ALL_STEP_KEYS.includes(stepKey)) return;
  const db = rfpClient(createClient());
  if (done) {
    await db.from("rfp_step_checks").delete().eq("opportunity_id", oppId).eq("step_key", stepKey);
  } else {
    await db
      .from("rfp_step_checks")
      .upsert(
        { opportunity_id: oppId, step_key: stepKey, checked_by: await userId() },
        { onConflict: "opportunity_id,step_key", ignoreDuplicates: true },
      );
  }
  bump(oppId);
}

// ---------------------------------------------------------- state profiles ----

export async function saveStateProfile(_p: BdFormState, fd: FormData): Promise<BdFormState> {
  const denied = await requireRfp();
  if (denied) return { error: denied };
  const state = stateCode(str(fd, "state"));
  if (!state) return { error: "State is the two-letter code, like DE or VA." };

  const row: Record<string, string | null> = {};
  for (const f of STATE_FIELDS) row[f.key] = str(fd, f.key);
  const verified = str(fd, "verified_on");

  const db = rfpClient(createClient());
  const { error } = await db
    .from("bd_state_profiles")
    .upsert({ state, ...row, verified_on: verified, updated_by: await userId() }, { onConflict: "state" });
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
  if (!pkg) return { error: "Pick the package they are bidding." };
  const status = oneOf(fd, "status", BIDDER_STATUSES) ?? "invited";
  const declineReason = oneOf(fd, "decline_reason", DECLINE_REASONS);
  if (status === "declined" && !declineReason) {
    return { error: "Ask why and record it. A decline needs a reason, even if it is \"No reason given\"." };
  }
  const total = money(fd, "bid_total");
  if (total === "invalid") return { error: "Bid total must be a dollar amount." };
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

export async function addBidder(oppId: string, _p: BdFormState, fd: FormData): Promise<BdFormState> {
  const denied = await requireRfp();
  if (denied) return { error: denied };
  const fields = bidderFields(fd);
  if ("error" in fields) return fields;
  const db = rfpClient(createClient());
  const { error } = await db
    .from("rfp_bidders")
    .insert({ ...fields, opportunity_id: oppId, created_by: await userId() });
  if (error) return { error: error.message };
  bump(oppId);
  return saved();
}

export async function updateBidder(
  bidderId: string,
  oppId: string,
  _p: BdFormState,
  fd: FormData,
): Promise<BdFormState> {
  const denied = await requireRfp();
  if (denied) return { error: denied };
  const fields = bidderFields(fd);
  if ("error" in fields) return fields;
  const db = rfpClient(createClient());
  const { error } = await db.from("rfp_bidders").update(fields).eq("id", bidderId);
  if (error) return { error: error.message };
  bump(oppId);
  redirect(`/rfp/${oppId}#bidders`);
}

export async function deleteBidder(bidderId: string, oppId: string): Promise<void> {
  if (await requireRfp()) return;
  await rfpClient(createClient()).from("rfp_bidders").delete().eq("id", bidderId);
  bump(oppId);
}

/** One click for the weekly check-in: last contact is today. */
export async function logBidderContact(bidderId: string, oppId: string, today: string): Promise<void> {
  if (await requireRfp()) return;
  const db = rfpClient(createClient());
  const { data: b } = await db.from("rfp_bidders").select("status").eq("id", bidderId).maybeSingle();
  if (!b) return;
  // A check-in that got an answer clears at risk back to the last live state.
  const status = b.status === "at_risk" ? "confirmed" : b.status;
  await db.from("rfp_bidders").update({ last_contact_on: today, status }).eq("id", bidderId);
  bump(oppId);
}

// --------------------------------------------------------------- documents ----

const ALL_DOC_KEYS = Object.values(REQUIRED_DOCS).flatMap((list) => list.map((d) => d.key));

export async function toggleDoc(bidderId: string, oppId: string, docKey: string, have: boolean): Promise<void> {
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
  bump(oppId);
}
