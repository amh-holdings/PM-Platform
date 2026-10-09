"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { bdClient } from "@/lib/bd-db";
import {
  ACTIVITY_TYPES,
  BD_STAGES,
  COMPANY_TYPES,
  EQUIPMENT_BASES,
  FIRST_FOLLOW_UP_AFTER_BID_DAYS,
  FOLLOW_UP_DAYS,
  LOSS_REASONS,
  REVISION_LABEL,
  REVISION_TYPES,
  addDays,
  isOpenStage,
  todayIso,
  type BdStage,
} from "@/lib/bd";
import { formatCurrency } from "@/lib/format";
import { can, toEffectiveRole } from "@/lib/roles";
import { readDbRole } from "@/lib/roles-server";
import type { BdFormState } from "./form-state";

// Authorization reads the TRUE database role, never the view-as cookie. RLS
// enforces the same thing again underneath (0074).
async function requireBd(): Promise<string | null> {
  const role = toEffectiveRole(await readDbRole());
  return can(role, "viewBD") ? null : "You do not have access to business development.";
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

function num(fd: FormData, key: string): number | null | "invalid" {
  const v = str(fd, key);
  if (v === null) return null;
  const n = Number(v.replace(/[$,\s%]/g, ""));
  return Number.isFinite(n) ? n : "invalid";
}

function oneOf<T extends string>(fd: FormData, key: string, allowed: readonly T[]): T | null {
  const v = str(fd, key);
  return v && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

function saved(): BdFormState {
  return { saved: Date.now() };
}

function bump(...paths: string[]) {
  for (const p of ["/bd", "/bd/pipeline", "/bd/clients", "/bd/dashboard", ...paths]) {
    revalidatePath(p);
  }
}

// ------------------------------------------------------------- clients ----

function companyFields(fd: FormData) {
  return {
    name: str(fd, "name"),
    company_type: oneOf(fd, "company_type", COMPANY_TYPES) ?? "Developer",
    state: str(fd, "state"),
    website: str(fd, "website"),
    owner_id: str(fd, "owner_id"),
    notes: str(fd, "notes"),
  };
}

function duplicateName(message: string): boolean {
  return message.includes("bd_companies_name_key");
}

export async function createCompany(_p: BdFormState, fd: FormData): Promise<BdFormState> {
  const denied = await requireBd();
  if (denied) return { error: denied };
  const fields = companyFields(fd);
  if (!fields.name) return { error: "Client name is required." };

  const { data, error } = await bdClient(createClient())
    .from("bd_companies")
    .insert({ ...fields, name: fields.name, created_by: await userId() })
    .select("id")
    .single();
  if (error) {
    return { error: duplicateName(error.message) ? "A client with that name already exists." : error.message };
  }
  bump();
  redirect(`/bd/clients/${data.id}`);
}

export async function updateCompany(
  companyId: string,
  _p: BdFormState,
  fd: FormData,
): Promise<BdFormState> {
  const denied = await requireBd();
  if (denied) return { error: denied };
  const fields = companyFields(fd);
  if (!fields.name) return { error: "Client name is required." };

  const { error } = await bdClient(createClient())
    .from("bd_companies")
    .update({ ...fields, name: fields.name })
    .eq("id", companyId);
  if (error) {
    return { error: duplicateName(error.message) ? "A client with that name already exists." : error.message };
  }
  bump(`/bd/clients/${companyId}`);
  return saved();
}

export async function addContact(
  companyId: string,
  _p: BdFormState,
  fd: FormData,
): Promise<BdFormState> {
  const denied = await requireBd();
  if (denied) return { error: denied };
  const name = str(fd, "name");
  if (!name) return { error: "Contact name is required." };

  const { error } = await bdClient(createClient()).from("bd_contacts").insert({
    company_id: companyId,
    name,
    title: str(fd, "title"),
    email: str(fd, "email"),
    phone: str(fd, "phone"),
    is_decision_maker: fd.get("is_decision_maker") === "on",
  });
  if (error) return { error: error.message };
  bump(`/bd/clients/${companyId}`);
  return saved();
}

export async function removeContact(contactId: string, companyId: string): Promise<void> {
  if (await requireBd()) return;
  await bdClient(createClient()).from("bd_contacts").delete().eq("id", contactId);
  bump(`/bd/clients/${companyId}`);
}

// ------------------------------------------------------- opportunities ----

type OppFields = {
  company_id: string | null;
  contact_id: string | null;
  name: string | null;
  state: string | null;
  county: string | null;
  size_mw_dc: number | null;
  size_mwh: number | null;
  stage: BdStage;
  owner_id: string | null;
  source: string | null;
  est_value: number | null;
  probability_pct: number | null;
  bid_due_date: string | null;
  expected_decision_date: string | null;
  next_follow_up_date: string | null;
};

function oppFields(fd: FormData, fallbackStage: BdStage): OppFields | { error: string } {
  const mw = num(fd, "size_mw_dc");
  const mwh = num(fd, "size_mwh");
  const est = num(fd, "est_value");
  const prob = num(fd, "probability_pct");
  if (mw === "invalid" || mwh === "invalid") return { error: "Size must be a number." };
  if (est === "invalid") return { error: "Estimated value must be a dollar amount." };
  if (prob === "invalid" || (prob !== null && (prob < 0 || prob > 100))) {
    return { error: "Probability is a percent from 0 to 100." };
  }
  const stage = oneOf(fd, "stage", BD_STAGES) ?? fallbackStage;
  let next = str(fd, "next_follow_up_date");
  // The database insists an open job has a follow-up date. Rather than bounce
  // the form, default it from the stage cadence.
  if (isOpenStage(stage) && !next) next = addDays(todayIso(), FOLLOW_UP_DAYS[stage]);
  return {
    company_id: str(fd, "company_id"),
    contact_id: str(fd, "contact_id"),
    name: str(fd, "name"),
    state: str(fd, "state"),
    county: str(fd, "county"),
    size_mw_dc: mw,
    size_mwh: mwh,
    stage,
    owner_id: str(fd, "owner_id"),
    source: str(fd, "source"),
    est_value: est,
    probability_pct: prob,
    bid_due_date: str(fd, "bid_due_date"),
    expected_decision_date: str(fd, "expected_decision_date"),
    next_follow_up_date: next,
  };
}

export async function createOpportunity(_p: BdFormState, fd: FormData): Promise<BdFormState> {
  const denied = await requireBd();
  if (denied) return { error: denied };
  const fields = oppFields(fd, "lead");
  if ("error" in fields) return fields;
  if (!fields.name) return { error: "Project name is required." };
  if (!fields.company_id) return { error: "Pick the client." };
  if (!isOpenStage(fields.stage)) {
    return { error: "A new opportunity starts open. Record the outcome after it is created." };
  }

  const me = await userId();
  const { data, error } = await bdClient(createClient())
    .from("bd_opportunities")
    .insert({
      ...fields,
      company_id: fields.company_id,
      name: fields.name,
      owner_id: fields.owner_id ?? me,
      created_by: me,
    })
    .select("id")
    .single();
  if (error) return { error: error.message };
  bump(`/bd/clients/${fields.company_id}`);
  redirect(`/bd/opportunities/${data.id}`);
}

export async function updateOpportunity(
  oppId: string,
  _p: BdFormState,
  fd: FormData,
): Promise<BdFormState> {
  const denied = await requireBd();
  if (denied) return { error: denied };
  const fields = oppFields(fd, "lead");
  if ("error" in fields) return fields;
  if (!fields.name) return { error: "Project name is required." };
  if (!fields.company_id) return { error: "Pick the client." };
  if (!isOpenStage(fields.stage)) {
    return { error: "Use Record outcome to close an opportunity, so the result and reason are captured." };
  }

  // Editing an open job back from a closed one reopens it: clear the outcome.
  const { error } = await bdClient(createClient())
    .from("bd_opportunities")
    .update({
      ...fields,
      company_id: fields.company_id,
      name: fields.name,
      outcome_date: null,
      loss_reason: null,
      winner: null,
      winning_price: null,
    })
    .eq("id", oppId);
  if (error) return { error: error.message };
  bump(`/bd/opportunities/${oppId}`, `/bd/clients/${fields.company_id}`);
  return saved();
}

export async function recordOutcome(
  oppId: string,
  _p: BdFormState,
  fd: FormData,
): Promise<BdFormState> {
  const denied = await requireBd();
  if (denied) return { error: denied };
  const outcome = oneOf(fd, "outcome", ["won", "lost", "no_bid", "dead"] as const);
  if (!outcome) return { error: "Pick the outcome." };
  const lossReason = oneOf(fd, "loss_reason", LOSS_REASONS);
  if (outcome === "lost" && !lossReason) return { error: "A loss needs a reason. Pick Unknown if they never said." };
  const winningPrice = num(fd, "winning_price");
  if (winningPrice === "invalid") return { error: "Winning price must be a dollar amount." };

  const db = bdClient(createClient());
  const { data: opp, error } = await db
    .from("bd_opportunities")
    .update({
      stage: outcome,
      outcome_date: str(fd, "outcome_date") ?? todayIso(),
      loss_reason: outcome === "lost" ? lossReason : null,
      winner: outcome === "lost" ? str(fd, "winner") : null,
      winning_price: outcome === "lost" && typeof winningPrice === "number" ? winningPrice : null,
      outcome_notes: str(fd, "outcome_notes"),
    })
    .eq("id", oppId)
    .select("company_id, project_id")
    .single();
  if (error) return { error: error.message };
  bump(`/bd/opportunities/${oppId}`, `/bd/clients/${opp.company_id}`);

  // Phil asked to be prompted for the transfer the moment a job is won.
  const role = toEffectiveRole(await readDbRole());
  if (outcome === "won" && !opp.project_id && can(role, "transferBdToProject")) {
    redirect(`/bd/opportunities/${oppId}/transfer`);
  }
  return saved();
}

export async function deleteOpportunity(oppId: string): Promise<void> {
  if (await requireBd()) return;
  await bdClient(createClient()).from("bd_opportunities").delete().eq("id", oppId);
  bump();
  redirect("/bd/pipeline");
}

// ---------------------------------------------------------------- bids ----

export async function addBid(oppId: string, _p: BdFormState, fd: FormData): Promise<BdFormState> {
  const denied = await requireBd();
  if (denied) return { error: denied };
  const price = num(fd, "price");
  if (price === null || price === "invalid" || price < 0) return { error: "Enter the bid price." };
  const margin = num(fd, "margin_pct");
  if (margin === "invalid") return { error: "Margin must be a percent." };
  const submittedOn = str(fd, "submitted_on") ?? todayIso();
  const revision = oneOf(fd, "revision_type", REVISION_TYPES) ?? "final";

  const db = bdClient(createClient());
  const { data: opp, error: oppError } = await db
    .from("bd_opportunities")
    .select("company_id, stage")
    .eq("id", oppId)
    .single();
  if (oppError) return { error: oppError.message };

  const me = await userId();
  const { error } = await db.from("bd_bids").insert({
    opportunity_id: oppId,
    revision_type: revision,
    submitted_on: submittedOn,
    price,
    margin_pct: margin,
    equipment_basis: oneOf(fd, "equipment_basis", EQUIPMENT_BASES) ?? "epc_furnished",
    exclusions: str(fd, "exclusions"),
    proposal_url: str(fd, "proposal_url"),
    notes: str(fd, "notes"),
    created_by: me,
  });
  if (error) return { error: error.message };

  // A bid moves the job forward and starts the follow-up clock: first touch
  // 7 days after it goes in. A BAFO request means we were shortlisted.
  if (isOpenStage(opp.stage)) {
    const stage: BdStage =
      revision === "bafo" ? "shortlist" : opp.stage === "shortlist" ? "shortlist" : "submitted";
    await db
      .from("bd_opportunities")
      .update({ stage, next_follow_up_date: addDays(submittedOn, FIRST_FOLLOW_UP_AFTER_BID_DAYS) })
      .eq("id", oppId);
  }
  // Sending a price is a touch with the client.
  await db.from("bd_activities").insert({
    company_id: opp.company_id,
    opportunity_id: oppId,
    activity_type: "email",
    occurred_on: submittedOn,
    notes: `${REVISION_LABEL[revision]} bid submitted: ${formatCurrency(price)}`,
    logged_by: me,
  });

  bump(`/bd/opportunities/${oppId}`, `/bd/clients/${opp.company_id}`);
  return saved();
}

export async function deleteBid(bidId: string, oppId: string): Promise<void> {
  if (await requireBd()) return;
  await bdClient(createClient()).from("bd_bids").delete().eq("id", bidId);
  bump(`/bd/opportunities/${oppId}`);
}

// ---------------------------------------------------------- follow-ups ----

export async function logActivity(_p: BdFormState, fd: FormData): Promise<BdFormState> {
  const denied = await requireBd();
  if (denied) return { error: denied };
  const companyId = str(fd, "company_id");
  if (!companyId) return { error: "Missing client." };
  const oppId = str(fd, "opportunity_id");
  const next = str(fd, "next_follow_up_date");

  const db = bdClient(createClient());
  if (oppId) {
    const { data: opp } = await db.from("bd_opportunities").select("stage").eq("id", oppId).single();
    if (opp && isOpenStage(opp.stage) && !next) {
      return { error: "Set the next follow-up date. Every open bid needs one." };
    }
  }

  const { error } = await db.from("bd_activities").insert({
    company_id: companyId,
    opportunity_id: oppId,
    contact_id: str(fd, "contact_id"),
    activity_type: oneOf(fd, "activity_type", ACTIVITY_TYPES) ?? "call",
    occurred_on: str(fd, "occurred_on") ?? todayIso(),
    notes: str(fd, "notes"),
    logged_by: await userId(),
  });
  if (error) return { error: error.message };

  if (oppId && next) {
    const { error: upErr } = await db
      .from("bd_opportunities")
      .update({ next_follow_up_date: next })
      .eq("id", oppId);
    if (upErr) return { error: upErr.message };
  }
  bump(`/bd/clients/${companyId}`, ...(oppId ? [`/bd/opportunities/${oppId}`] : []));
  return saved();
}

// ------------------------------------------------------------ transfer ----

/**
 * Won job -> PM project. Phil only: it creates the contract record the whole
 * construction side runs on, and bd cannot read projects at all.
 */
export async function transferToProject(
  oppId: string,
  _p: BdFormState,
  fd: FormData,
): Promise<BdFormState> {
  const role = toEffectiveRole(await readDbRole());
  if (!can(role, "transferBdToProject")) return { error: "Only Phil can create the project." };
  const name = str(fd, "name");
  if (!name) return { error: "Project name is required." };
  const contract = num(fd, "contract_value");
  if (contract === "invalid") return { error: "Contract value must be a dollar amount." };
  const mw = num(fd, "dc_capacity_mw");
  if (mw === "invalid") return { error: "Size must be a number." };

  const supabase = createClient();
  const { data: opp } = await bdClient(supabase)
    .from("bd_opportunities")
    .select("project_id")
    .eq("id", oppId)
    .single();
  if (opp?.project_id) redirect(`/projects/${opp.project_id}`);

  const { data: project, error } = await supabase
    .from("projects")
    .insert({
      name,
      client: str(fd, "client"),
      status: "Planning",
      contract_value: contract,
      ntp_date: str(fd, "ntp_date"),
      cod_date: str(fd, "cod_date"),
      zip_code: str(fd, "zip_code"),
      ...(mw !== null ? { dc_capacity_mw: mw } : {}),
    })
    .select("id")
    .single();
  if (error) return { error: error.message };

  const { error: linkErr } = await bdClient(supabase)
    .from("bd_opportunities")
    .update({ project_id: project.id })
    .eq("id", oppId);
  if (linkErr) return { error: `Project created, but linking it back failed: ${linkErr.message}` };

  bump(`/bd/opportunities/${oppId}`, "/projects", "/");
  redirect(`/projects/${project.id}`);
}
