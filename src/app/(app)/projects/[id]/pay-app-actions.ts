"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

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
  return { ok: true as const, supabase, userId: user.id };
}

export type CreatePayAppInput = {
  projectId: string;
  appNumber: string;
  periodStart: string;
  periodEnd: string;
  retainagePct: number;
  notes?: string | null;
};

export type CreatePayAppResult =
  | { ok: true; payAppId: string; linesCount: number }
  | { ok: false; error: string };

// Creates a new pay application as a draft, snapshotting the billing
// situation for all billing_lines in this project. For each line:
//   work_completed_previous   = sum of actual_amount in any billing_entry
//                              that already has a pay_application_id set
//   work_completed_this_period = sum of actual_amount in billing_entries
//                              for periods within [period_start, period_end]
//                              that are NOT already on another pay app
//   total_completed_and_stored = above two summed
//   pct_complete              = total_completed / scheduled_value
//   retainage_amount          = this_period * retainagePct/100
//
// Billing entries that contributed to this_period get
// pay_application_id stamped and status='on_pay_app'.
export async function createPayApplication(
  input: CreatePayAppInput,
): Promise<CreatePayAppResult> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  if (!input.appNumber.trim()) return { ok: false, error: "App number is required" };
  if (!input.periodStart || !input.periodEnd)
    return { ok: false, error: "Period start and end required" };

  // Create the draft pay_application row
  const { data: app, error: appErr } = await auth.supabase
    .from("pay_applications")
    .insert({
      project_id: input.projectId,
      app_number: input.appNumber.trim(),
      period_start: input.periodStart,
      period_end: input.periodEnd,
      status: "draft",
      notes: input.notes?.trim() || null,
    })
    .select("id")
    .single();
  if (appErr || !app) {
    return { ok: false, error: appErr?.message ?? "Failed to create pay app" };
  }

  // Pull every billing_line for the project + its entries
  const { data: lines, error: linesErr } = await auth.supabase
    .from("billing_lines")
    .select("id, item_number, description, scheduled_value, sort_order")
    .eq("project_id", input.projectId)
    .order("sort_order", { ascending: true, nullsFirst: false })
    .order("item_number", { ascending: true });
  if (linesErr) return { ok: false, error: linesErr.message };

  const lineIds = (lines ?? []).map((l) => l.id);
  const { data: entries } = await auth.supabase
    .from("billing_entries")
    .select(
      "id, billing_line_id, period_month, actual_amount, planned_amount, pay_application_id",
    )
    .in("billing_line_id", lineIds);

  // Bucket entries per line. The "this period" amount uses actual_amount when
  // set, falling back to planned_amount. That way a freshly promoted forecast
  // (planned only, no actual yet) still rolls into the pay app, but real
  // billed amounts win when both exist.
  type Bucket = {
    previous: number;
    thisPeriodIds: string[];
    thisPeriodAmount: number;
  };
  const buckets = new Map<string, Bucket>();
  for (const l of lines ?? []) {
    buckets.set(l.id, { previous: 0, thisPeriodIds: [], thisPeriodAmount: 0 });
  }
  for (const e of entries ?? []) {
    const b = buckets.get(e.billing_line_id);
    if (!b) continue;
    const actual = Number(e.actual_amount ?? 0);
    const planned = Number(e.planned_amount ?? 0);
    if (e.pay_application_id) {
      b.previous += actual || planned;
      continue;
    }
    if (
      e.period_month >= input.periodStart &&
      e.period_month <= input.periodEnd
    ) {
      const amount = actual > 0 ? actual : planned;
      if (amount > 0) {
        b.thisPeriodIds.push(e.id);
        b.thisPeriodAmount += amount;
      }
    }
  }

  const retPct = Number.isFinite(input.retainagePct) ? input.retainagePct : 10;
  const lineInserts = (lines ?? []).map((l, i) => {
    const b = buckets.get(l.id) ?? {
      previous: 0,
      thisPeriodIds: [],
      thisPeriodAmount: 0,
    };
    const sched = Number(l.scheduled_value ?? 0);
    const completed = b.previous + b.thisPeriodAmount;
    const pct = sched > 0 ? Math.min(100, (completed / sched) * 100) : 0;
    const retainage = b.thisPeriodAmount * (retPct / 100);
    return {
      pay_application_id: app.id,
      billing_line_id: l.id,
      item_number: l.item_number,
      description: l.description,
      scheduled_value: sched,
      work_completed_previous: Math.round(b.previous * 100) / 100,
      work_completed_this_period: Math.round(b.thisPeriodAmount * 100) / 100,
      materials_stored: 0,
      total_completed_and_stored: Math.round(completed * 100) / 100,
      pct_complete: Math.round(pct * 100) / 100,
      balance_to_finish: Math.round((sched - completed) * 100) / 100,
      retainage_amount: Math.round(retainage * 100) / 100,
      sort_order: l.sort_order ?? i,
    };
  });

  if (lineInserts.length > 0) {
    const { error: liErr } = await auth.supabase
      .from("pay_application_lines")
      .insert(lineInserts);
    if (liErr) return { ok: false, error: liErr.message };
  }

  // Compute roll-up totals for the pay_application
  const totalCompleted = lineInserts.reduce(
    (s, l) => s + (l.work_completed_this_period ?? 0),
    0,
  );
  const totalRetainage = lineInserts.reduce(
    (s, l) => s + (l.retainage_amount ?? 0),
    0,
  );
  const previousBillings = lineInserts.reduce(
    (s, l) => s + (l.work_completed_previous ?? 0),
    0,
  );
  const amountDue = totalCompleted - totalRetainage;
  await auth.supabase
    .from("pay_applications")
    .update({
      total_completed: Math.round(totalCompleted * 100) / 100,
      total_retainage: Math.round(totalRetainage * 100) / 100,
      previous_billings: Math.round(previousBillings * 100) / 100,
      amount_due: Math.round(amountDue * 100) / 100,
    })
    .eq("id", app.id);

  // Stamp the billing_entries that were rolled into this pay app, and
  // promote the value used (actual or planned-fallback) into actual_amount
  // so the dashboard's Billing timeline reflects what is being billed.
  const entryById = new Map((entries ?? []).map((e) => [e.id, e]));
  const stampIds: string[] = [];
  buckets.forEach((b) => stampIds.push(...b.thisPeriodIds));
  for (const id of stampIds) {
    const e = entryById.get(id);
    if (!e) continue;
    const actual = Number(e.actual_amount ?? 0);
    const planned = Number(e.planned_amount ?? 0);
    const used = actual > 0 ? actual : planned;
    await auth.supabase
      .from("billing_entries")
      .update({
        pay_application_id: app.id,
        status: "on_pay_app",
        actual_amount: used,
      })
      .eq("id", id);
  }

  revalidatePath(`/projects/${input.projectId}`);
  revalidatePath(`/projects/${input.projectId}/billing`);
  revalidatePath(`/projects/${input.projectId}/pay-apps`);
  return {
    ok: true,
    payAppId: app.id,
    linesCount: lineInserts.length,
  };
}

export async function setPayApplicationStatus(
  payAppId: string,
  projectId: string,
  newStatus: "submitted" | "approved" | "paid",
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const now = new Date().toISOString();
  const patch: {
    status: string;
    submitted_at?: string;
    submitted_by?: string;
    approved_at?: string;
    paid_at?: string;
  } = { status: newStatus };
  if (newStatus === "submitted") {
    patch.submitted_at = now;
    patch.submitted_by = auth.userId;
  } else if (newStatus === "approved") {
    patch.approved_at = now;
  } else if (newStatus === "paid") {
    patch.paid_at = now;
  }

  const { error } = await auth.supabase
    .from("pay_applications")
    .update(patch)
    .eq("id", payAppId);
  if (error) return { ok: false, error: error.message };

  // Cascade entry status
  await auth.supabase
    .from("billing_entries")
    .update({ status: newStatus })
    .eq("pay_application_id", payAppId);

  revalidatePath(`/projects/${projectId}/pay-apps`);
  revalidatePath(`/projects/${projectId}/pay-apps/${payAppId}`);
  revalidatePath(`/projects/${projectId}/billing`);
  return { ok: true };
}

export async function deletePayApplication(
  payAppId: string,
  projectId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  // Unstamp the billing_entries first
  await auth.supabase
    .from("billing_entries")
    .update({ pay_application_id: null, status: "forecast" })
    .eq("pay_application_id", payAppId);

  const { error } = await auth.supabase
    .from("pay_applications")
    .delete()
    .eq("id", payAppId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}/pay-apps`);
  revalidatePath(`/projects/${projectId}/billing`);
  return { ok: true };
}

// One-click flow: take a forecast billing_entries row and immediately wrap it
// in a draft pay_application without making the PM fill out the new-pay-app
// form. Period bounds default to the first and last day of the entry's
// period_month. App number = entry.afp_number if set, else "AFP <count+1>".
// Retainage % comes from projects.retainage_pct_default (defaults to 5).
export async function createPayAppFromForecastEntry(
  formData: FormData,
): Promise<void> {
  const entryId = String(formData.get("entryId") ?? "").trim();
  const projectId = String(formData.get("projectId") ?? "").trim();
  if (!entryId || !projectId) throw new Error("entryId and projectId required");

  const auth = await assertAhcUser();
  if (!auth.ok) throw new Error(auth.error);

  const { data: entry, error: entryErr } = await auth.supabase
    .from("billing_entries")
    .select("id, period_month, afp_number, billing_lines!inner(project_id)")
    .eq("id", entryId)
    .maybeSingle();
  if (entryErr || !entry) throw new Error(entryErr?.message ?? "Entry not found");

  const { data: project } = await auth.supabase
    .from("projects")
    .select("retainage_pct_default")
    .eq("id", projectId)
    .maybeSingle();

  // Compute first + last day of the entry's period_month.
  const [y, m] = entry.period_month.split("-").map(Number);
  const periodStart = `${y}-${String(m).padStart(2, "0")}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const periodEnd = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  // Default app_number if entry doesn't have one.
  let appNumber = entry.afp_number ?? "";
  if (!appNumber.trim()) {
    const { count } = await auth.supabase
      .from("pay_applications")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId);
    appNumber = `AFP ${(count ?? 0) + 1}`;
  }

  const retainagePct = Number(project?.retainage_pct_default ?? 5);

  const result = await createPayApplication({
    projectId,
    appNumber,
    periodStart,
    periodEnd,
    retainagePct,
  });
  if (!result.ok) throw new Error(result.error);

  revalidatePath(`/projects/${projectId}/billing`);
  revalidatePath(`/projects/${projectId}/pay-apps`);
  revalidatePath(`/projects/${projectId}`);
}
