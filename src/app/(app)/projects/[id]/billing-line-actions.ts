"use server";

// Create / edit / delete owner SOV lines, plus the bulk apply behind the
// spreadsheet importer.
//
// Until now billing_lines could only be written by scripts/import-cashflow.mjs
// run from a laptop against db/reference/cash-flow.xlsx, which is why the
// billing tab's empty state used to tell you to go run a script.

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { TablesInsert, TablesUpdate } from "@/lib/database.types";
import type { SovImportPlan } from "@/lib/sov-import";

type Db = SupabaseClient<Database>;

async function assertAhcUser() {
  const supabase = createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) return { ok: false as const, error: "Not signed in" };
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile || !["phil", "zarina", "ahc_super"].includes(profile.role)) {
    return { ok: false as const, error: "Restricted to AHC team members" };
  }
  return { ok: true as const, supabase };
}

function revalidateBilling(projectId: string) {
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/billing`);
  revalidatePath(`/projects/${projectId}/pay-apps`);
}

export type BillingLineResult =
  | { ok: true; id: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

function getStr(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim();
}

// Same tolerance as the importer: a padded currency cell, a parenthesised
// deduct, or a bare number. Unlike the importer this is a typed field, so an
// unreadable value is a validation error rather than a skipped cell.
function parseAmount(
  value: FormDataEntryValue | null,
): number | null | "invalid" {
  if (typeof value !== "string" || !value.trim()) return null;
  const t = value.trim();
  const neg = /^\(.*\)$/.test(t);
  const cleaned = t.replace(/[()$,\s]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return "invalid";
  return neg ? -Math.abs(n) : n;
}

function parseOrder(value: FormDataEntryValue | null): number | null | "invalid" {
  if (typeof value !== "string" || !value.trim()) return null;
  const n = Number(value.trim());
  if (!Number.isFinite(n)) return "invalid";
  return Math.trunc(n);
}

async function itemNumberTaken(
  supabase: Db,
  projectId: string,
  itemNumber: string,
  exceptId?: string,
): Promise<boolean> {
  let q = supabase
    .from("billing_lines")
    .select("id")
    .eq("project_id", projectId)
    .eq("item_number", itemNumber);
  if (exceptId) q = q.neq("id", exceptId);
  const { data } = await q.maybeSingle();
  return Boolean(data);
}

export async function createBillingLine(
  projectId: string,
  formData: FormData,
): Promise<BillingLineResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const itemNumber = getStr(formData.get("item_number"));
  const description = getStr(formData.get("description"));
  if (!itemNumber) {
    return {
      ok: false,
      error: "Item number is required",
      fieldErrors: { item_number: "Required" },
    };
  }
  if (!description) {
    return {
      ok: false,
      error: "Description is required",
      fieldErrors: { description: "Required" },
    };
  }

  const scheduled = parseAmount(formData.get("scheduled_value"));
  if (scheduled === "invalid") {
    return {
      ok: false,
      error: "Scheduled value must be a valid amount",
      fieldErrors: { scheduled_value: "Invalid" },
    };
  }
  const sortOrder = parseOrder(formData.get("sort_order"));
  if (sortOrder === "invalid") {
    return {
      ok: false,
      error: "Sort order must be a whole number",
      fieldErrors: { sort_order: "Invalid" },
    };
  }

  // The table has a unique (project_id, item_number). Checking first turns a
  // raw Postgres 23505 into something that names the line already using it.
  if (await itemNumberTaken(auth.supabase, projectId, itemNumber)) {
    return {
      ok: false,
      error: `Item ${itemNumber} already exists on this project's SOV. Edit that line instead.`,
      fieldErrors: { item_number: "Already used" },
    };
  }

  // A new line with no sort order would sort ahead of every numbered line
  // (nullsFirst: false only helps on the way out). Put it at the end instead.
  let resolvedOrder = sortOrder;
  if (resolvedOrder === null) {
    const { data: last } = await auth.supabase
      .from("billing_lines")
      .select("sort_order")
      .eq("project_id", projectId)
      .order("sort_order", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    resolvedOrder = (Number(last?.sort_order ?? 0) || 0) + 10;
  }

  const insert: TablesInsert<"billing_lines"> = {
    project_id: projectId,
    item_number: itemNumber,
    type: getStr(formData.get("type")),
    description,
    scheduled_value: scheduled,
    sort_order: resolvedOrder,
    notes: getStr(formData.get("notes")),
  };

  const { data, error } = await auth.supabase
    .from("billing_lines")
    .insert(insert)
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };

  revalidateBilling(projectId);
  return { ok: true, id: data.id };
}

export async function updateBillingLine(
  lineId: string,
  projectId: string,
  formData: FormData,
): Promise<BillingLineResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const itemNumber = getStr(formData.get("item_number"));
  const description = getStr(formData.get("description"));
  if (!itemNumber) {
    return {
      ok: false,
      error: "Item number is required",
      fieldErrors: { item_number: "Required" },
    };
  }
  if (!description) {
    return {
      ok: false,
      error: "Description is required",
      fieldErrors: { description: "Required" },
    };
  }

  const scheduled = parseAmount(formData.get("scheduled_value"));
  if (scheduled === "invalid") {
    return {
      ok: false,
      error: "Scheduled value must be a valid amount",
      fieldErrors: { scheduled_value: "Invalid" },
    };
  }
  const sortOrder = parseOrder(formData.get("sort_order"));
  if (sortOrder === "invalid") {
    return {
      ok: false,
      error: "Sort order must be a whole number",
      fieldErrors: { sort_order: "Invalid" },
    };
  }

  if (await itemNumberTaken(auth.supabase, projectId, itemNumber, lineId)) {
    return {
      ok: false,
      error: `Item ${itemNumber} is already used by another line on this SOV.`,
      fieldErrors: { item_number: "Already used" },
    };
  }

  const update: TablesUpdate<"billing_lines"> = {
    item_number: itemNumber,
    type: getStr(formData.get("type")),
    description,
    scheduled_value: scheduled,
    sort_order: sortOrder,
    notes: getStr(formData.get("notes")),
  };

  const { error } = await auth.supabase
    .from("billing_lines")
    .update(update)
    .eq("id", lineId)
    .eq("project_id", projectId);
  if (error) return { ok: false, error: error.message };

  revalidateBilling(projectId);
  return { ok: true, id: lineId };
}

export type DeleteCheck = {
  // Reasons the line must not be deleted at all.
  blockers: string[];
  // Things that go with it if it is deleted.
  cascades: string[];
};

// What deleting this line would take with it, and what forbids it outright.
//
// Two hard stops. A line snapshotted onto a pay application cannot go: the
// G702/G703 that went to the owner has to keep reconciling, and
// pay_application_lines references billing_lines with no cascade, so the
// database would refuse it anyway. A line that has actually been billed cannot
// go either - previous-billed on every later AFP is computed from those
// entries. A CO's own SOV line is a third stop by policy: one CO owns one
// line, so the CO is the place to undo it.
async function checkDeletable(
  supabase: Db,
  lineId: string,
  projectId: string,
): Promise<
  { ok: true; check: DeleteCheck; itemNumber: string } | { ok: false; error: string }
> {
  const { data: line, error: lineErr } = await supabase
    .from("billing_lines")
    .select("id, item_number, change_order_id")
    .eq("id", lineId)
    .eq("project_id", projectId)
    .maybeSingle();
  if (lineErr) return { ok: false, error: lineErr.message };
  if (!line) return { ok: false, error: "That billing line no longer exists." };

  const [{ data: payAppLines }, { data: entries }, { data: allocations }, { data: co }] =
    await Promise.all([
      supabase
        .from("pay_application_lines")
        .select("id, pay_applications!inner(app_number)")
        .eq("billing_line_id", lineId),
      supabase
        .from("billing_entries")
        .select("id, period_month, actual_amount, planned_amount, afp_number, pay_application_id")
        .eq("billing_line_id", lineId),
      supabase
        .from("procurement_order_billing_allocations")
        .select("id")
        .eq("billing_line_id", lineId),
      line.change_order_id
        ? supabase
            .from("change_orders")
            .select("co_number")
            .eq("id", line.change_order_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

  const blockers: string[] = [];
  const cascades: string[] = [];

  const afps = Array.from(
    new Set(
      (payAppLines ?? [])
        .map(
          (p) =>
            (p.pay_applications as unknown as { app_number: string | null } | null)
              ?.app_number,
        )
        .filter((n): n is string => Boolean(n)),
    ),
  );
  if ((payAppLines ?? []).length > 0) {
    blockers.push(
      afps.length
        ? `It is on pay application ${afps.join(", ")}. A submitted AFP has to keep reconciling.`
        : "It is snapshotted onto a pay application, which has to keep reconciling.",
    );
  }

  const billed = (entries ?? []).filter(
    (e) =>
      Number(e.actual_amount ?? 0) !== 0 || e.afp_number || e.pay_application_id,
  );
  if (billed.length > 0) {
    const total = billed.reduce((s, e) => s + Number(e.actual_amount ?? 0), 0);
    blockers.push(
      `${billed.length} billed month${billed.length === 1 ? "" : "s"} sit against it${
        total ? ` (${total.toLocaleString("en-US", { style: "currency", currency: "USD" })})` : ""
      }. Previous-billed on every later AFP is computed from those.`,
    );
  }

  if (line.change_order_id) {
    const coNumber =
      (co as unknown as { co_number: string } | null)?.co_number ?? "a change order";
    blockers.push(
      `It is the SOV line for ${coNumber}. Void or revise the change order instead - one CO owns one line.`,
    );
  }

  const forecastOnly = (entries ?? []).length - billed.length;
  if (forecastOnly > 0) {
    cascades.push(
      `${forecastOnly} forecast month${forecastOnly === 1 ? "" : "s"} on this line will be deleted with it.`,
    );
  }
  if ((allocations ?? []).length > 0) {
    cascades.push(
      `${allocations!.length} purchase-order allocation${
        allocations!.length === 1 ? "" : "s"
      } pointing at this line will be deleted.`,
    );
  }

  return { ok: true, check: { blockers, cascades }, itemNumber: line.item_number };
}

export async function inspectBillingLineDelete(
  lineId: string,
  projectId: string,
): Promise<
  { ok: true; check: DeleteCheck; itemNumber: string } | { ok: false; error: string }
> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;
  return checkDeletable(auth.supabase, lineId, projectId);
}

export async function deleteBillingLine(
  lineId: string,
  projectId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  // Re-checked here, not trusted from the client. The dialog shows the same
  // answer, but the decision has to be made on the server.
  const inspected = await checkDeletable(auth.supabase, lineId, projectId);
  if (!inspected.ok) return inspected;
  if (inspected.check.blockers.length > 0) {
    return {
      ok: false,
      error: `Item ${inspected.itemNumber} cannot be deleted. ${inspected.check.blockers.join(" ")}`,
    };
  }

  const { error } = await auth.supabase
    .from("billing_lines")
    .delete()
    .eq("id", lineId)
    .eq("project_id", projectId);
  if (error) return { ok: false, error: error.message };

  revalidateBilling(projectId);
  return { ok: true };
}

export type SovImportResult =
  | { ok: true; added: number; changed: number }
  | { ok: false; error: string };

export async function applySovImport(
  projectId: string,
  plan: SovImportPlan,
): Promise<SovImportResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  if (!plan.adds.length && !plan.changes.length) {
    return { ok: true, added: 0, changed: 0 };
  }

  // Re-validated server side. The client built this plan from a diff, but the
  // client is not the authority on what the SOV currently looks like.
  const { data: current, error: currentErr } = await auth.supabase
    .from("billing_lines")
    .select("id, item_number")
    .eq("project_id", projectId);
  if (currentErr) return { ok: false, error: currentErr.message };

  const idByItem = new Map((current ?? []).map((l) => [l.item_number, l.id]));
  const idsHere = new Set((current ?? []).map((l) => l.id));

  for (const c of plan.changes) {
    if (!idsHere.has(c.id)) {
      return {
        ok: false,
        error:
          "The SOV changed while this import was open. Close the dialog and read the rows again.",
      };
    }
  }
  for (const a of plan.adds) {
    if (!a.item_number.trim()) {
      return { ok: false, error: "An imported row has no item number." };
    }
    if (!a.description.trim()) {
      return {
        ok: false,
        error: `Item ${a.item_number} is new and has no description.`,
      };
    }
    if (idByItem.has(a.item_number)) {
      return {
        ok: false,
        error: `Item ${a.item_number} was created by someone else while this import was open. Close the dialog and read the rows again.`,
      };
    }
  }

  let added = 0;
  if (plan.adds.length) {
    const rows: TablesInsert<"billing_lines">[] = plan.adds.map((a) => ({
      project_id: projectId,
      item_number: a.item_number,
      type: a.type,
      description: a.description,
      scheduled_value: a.scheduled_value,
      sort_order: a.sort_order,
      notes: a.notes,
    }));
    const CHUNK = 200;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error } = await auth.supabase
        .from("billing_lines")
        .insert(rows.slice(i, i + CHUNK));
      if (error) return { ok: false, error: `Adding lines: ${error.message}` };
      added += Math.min(CHUNK, rows.length - i);
    }
  }

  let changed = 0;
  for (const c of plan.changes) {
    const { error } = await auth.supabase
      .from("billing_lines")
      .update(c.patch as TablesUpdate<"billing_lines">)
      .eq("id", c.id)
      .eq("project_id", projectId);
    if (error) return { ok: false, error: `Updating lines: ${error.message}` };
    changed += 1;
  }

  revalidateBilling(projectId);
  return { ok: true, added, changed };
}
