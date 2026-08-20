"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { friendlyAppNumberError, nextAppNumber } from "@/lib/afp-number";

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
  // Optional explicit entry filter. If set, only these billing_entries are
  // rolled into the new pay app (period_start/end still bound it, but the
  // filter further restricts which rows in that range get stamped). Useful
  // when the PM wants to select specific items from the Next AFP panel.
  onlyEntryIds?: string[];
};

/**
 * A billing_entries row in a month BEFORE the application's period that still
 * carries only a planned amount and no billing evidence. Either it was billed
 * on an earlier AFP and never reconciled (so actual_amount needs backfilling),
 * or it was forecast and never billed (so it should be moved or deleted).
 * Either way it is excluded from previous billings and surfaced for review.
 */
export type StalePriorForecast = {
  itemNumber: string;
  periodMonth: string;
  plannedAmount: number;
  status: string;
};

export type CreatePayAppResult =
  | {
      ok: true;
      payAppId: string;
      linesCount: number;
      stalePriorForecasts: StalePriorForecast[];
    }
  | { ok: false; error: string };

// Creates a new pay application as a draft, snapshotting the billing
// situation for all billing_lines in this project. For each line:
//   work_completed_previous   = sum of the effective amount of every entry
//                              billed BEFORE this application (see below)
//   work_completed_this_period = sum of actual_amount in billing_entries
//                              for periods within [period_start, period_end]
//                              that are NOT already on another pay app
//   total_completed_and_stored = above two summed
//   pct_complete              = total_completed / scheduled_value
//   retainage_amount          = this_period * retainagePct/100
//
// Billing entries that contributed to this_period get
// pay_application_id stamped and status='on_pay_app'.
//
// PREVIOUS BILLINGS. This used to mean "entry carries a pay_application_id",
// which silently reported $0 on Sweet Springs: AFP 1-8 were loaded by
// scripts/import-collections.mjs as paid billing_entries carrying only the
// free-text afp_number, and predate the pay_applications table entirely. An
// entry now counts as previous when it is not being billed on THIS app and
// either (a) it is stamped onto some other pay application, or (b) its
// period_month falls before this application's period. Condition (b) is what
// lets pre-pay_applications history land in G703 column D, and the two are
// OR'd rather than summed so an entry that satisfies both is counted once.
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
    const friendly = friendlyAppNumberError(appErr?.message, input.appNumber.trim());
    return {
      ok: false,
      error: friendly ?? appErr?.message ?? "Failed to create pay app",
    };
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
      "id, billing_line_id, period_month, actual_amount, planned_amount, pay_application_id, status, afp_number",
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
  const filterSet =
    input.onlyEntryIds && input.onlyEntryIds.length > 0
      ? new Set(input.onlyEntryIds)
      : null;

  // A prior-month row counts as previously billed only when something shows it
  // actually went out: a pay_application_id, an afp_number, or a status past
  // 'forecast'.
  //
  // A non-zero actual_amount is NOT proof on its own. scripts/import-cashflow*
  // loaded the owner cash-flow spreadsheet into actual_amount for months that
  // were only ever projections - Sweet Springs carries $160,381 / $80,000 /
  // $40,000 on 2026-06 with status 'forecast' and no AFP, for civil work that
  // had not happened (the first field report on the job is dated 2026-08-04).
  // Treating those as previous billings would report $120,000 of civil already
  // paid and suppress the first legitimate civil billing.
  const BILLED_STATUSES = new Set([
    "on_pay_app",
    "submitted",
    "approved",
    "paid",
  ]);
  const hasBillingEvidence = (e: {
    pay_application_id?: string | null;
    afp_number?: string | null;
    status?: string | null;
  }) =>
    !!e.pay_application_id ||
    !!e.afp_number ||
    BILLED_STATUSES.has(e.status ?? "");
  const stalePriorForecasts: StalePriorForecast[] = [];
  const lineById = new Map((lines ?? []).map((l) => [l.id, l]));

  for (const e of entries ?? []) {
    const b = buckets.get(e.billing_line_id);
    if (!b) continue;
    const actual = Number(e.actual_amount ?? 0);
    const planned = Number(e.planned_amount ?? 0);

    const inWindow =
      e.period_month >= input.periodStart && e.period_month <= input.periodEnd;
    const selectedForThisApp =
      inWindow && !e.pay_application_id && (!filterSet || filterSet.has(e.id));

    if (selectedForThisApp) {
      const amount = actual > 0 ? actual : planned;
      if (amount > 0) {
        b.thisPeriodIds.push(e.id);
        b.thisPeriodAmount += amount;
      }
      continue;
    }

    // Not on this app. Previously billed if stamped onto another pay
    // application, or if it sits in a month before this application's period.
    const isPrior =
      !!e.pay_application_id || e.period_month < input.periodStart;
    if (!isPrior) continue;

    const amount = actual > 0 ? actual : planned;
    if (amount <= 0) continue;
    if (hasBillingEvidence(e)) {
      b.previous += amount;
    } else {
      stalePriorForecasts.push({
        itemNumber: lineById.get(e.billing_line_id)?.item_number ?? "",
        periodMonth: e.period_month,
        plannedAmount: amount,
        status: e.status ?? "forecast",
      });
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
  const rollup = {
    total_completed: Math.round(totalCompleted * 100) / 100,
    total_retainage: Math.round(totalRetainage * 100) / 100,
    previous_billings: Math.round(previousBillings * 100) / 100,
    amount_due: Math.round(amountDue * 100) / 100,
  };

  // The rate is stored on the application, not just applied and discarded, so
  // the G702 can print "Retainage {pct}% of completed work" and reprint the
  // same figure later even if projects.retainage_pct_default has since changed.
  // retainage_pct arrives in migration 0037, which Phil applies by hand - fall
  // back to the rest of the roll-up if the column is not there yet rather than
  // failing the whole application.
  // Cast: src/lib/database.types.ts is generated and has not been regenerated
  // since 0037 added retainage_pct. A green build does not prove the live
  // schema, which is why the fallback below exists rather than the cast alone.
  const { error: rollupErr } = await auth.supabase
    .from("pay_applications")
    .update({ ...rollup, retainage_pct: retPct } as never)
    .eq("id", app.id);
  if (rollupErr) {
    await auth.supabase
      .from("pay_applications")
      .update(rollup)
      .eq("id", app.id);
  }

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

  revalidatePath(`/projects/${input.projectId}`, "layout");
  revalidatePath(`/projects/${input.projectId}/billing`);
  revalidatePath(`/projects/${input.projectId}/pay-apps`);
  return {
    ok: true,
    payAppId: app.id,
    linesCount: lineInserts.length,
    stalePriorForecasts,
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

// Unified "Bill this period" flow: the PM checks a mix of (a) existing
// forecast billing_entries and (b) schedule-based suggestions in one panel,
// then clicks Create AFP. For suggestions, we first create the billing_entries
// row at the requested period+amount, then stamp it onto the new pay app
// just like a normal forecast. For forecasts, we just stamp.
export async function createAfpFromBillThisPeriod(
  formData: FormData,
): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "").trim();
  const appNumberInput = String(formData.get("appNumber") ?? "").trim();
  // Parallel arrays - forecast entry IDs and suggestion details. The order
  // within each array is preserved by FormData.getAll().
  const forecastEntryIds = formData
    .getAll("forecastEntryIds")
    .map((v) => String(v))
    .filter((v) => v.length > 0);
  const suggLineIds = formData
    .getAll("suggestionLineIds")
    .map((v) => String(v))
    .filter((v) => v.length > 0);
  const suggAmounts = formData
    .getAll("suggestionAmounts")
    .map((v) => Number(v));
  const suggPeriods = formData
    .getAll("suggestionPeriods")
    .map((v) => String(v));

  if (!projectId) throw new Error("projectId required");
  if (forecastEntryIds.length === 0 && suggLineIds.length === 0) {
    throw new Error("Select at least one row to bill");
  }
  if (
    suggLineIds.length !== suggAmounts.length ||
    suggLineIds.length !== suggPeriods.length
  ) {
    throw new Error("Suggestion arrays out of sync");
  }

  const auth = await assertAhcUser();
  if (!auth.ok) throw new Error(auth.error);

  // 1. Create billing_entries rows for the suggestions (so we can wrap them
  //    just like any other forecast entry).
  const newEntryIds: string[] = [];
  for (let i = 0; i < suggLineIds.length; i++) {
    const billingLineId = suggLineIds[i];
    const periodMonth = suggPeriods[i];
    const amount = suggAmounts[i];
    if (amount <= 0 || !billingLineId || !periodMonth) continue;

    // Upsert: if a row already exists at (billing_line_id, period_month),
    // we updated planned_amount; otherwise insert.
    const { data: existing } = await auth.supabase
      .from("billing_entries")
      .select("id, planned_amount")
      .eq("billing_line_id", billingLineId)
      .eq("period_month", periodMonth)
      .maybeSingle();

    let entryId: string;
    if (existing) {
      // Bump planned_amount to whatever the user submitted.
      const { error: upErr } = await auth.supabase
        .from("billing_entries")
        .update({
          planned_amount: amount,
          status: "suggested",
          notes: "From Bill this period (schedule-driven)",
        })
        .eq("id", existing.id);
      if (upErr) throw new Error(upErr.message);
      entryId = existing.id;
    } else {
      const { data: inserted, error: insErr } = await auth.supabase
        .from("billing_entries")
        .insert({
          billing_line_id: billingLineId,
          period_month: periodMonth,
          planned_amount: amount,
          actual_amount: 0,
          status: "suggested",
          notes: "From Bill this period (schedule-driven)",
        })
        .select("id")
        .single();
      if (insErr || !inserted) throw new Error(insErr?.message ?? "Insert failed");
      entryId = inserted.id;
    }
    newEntryIds.push(entryId);
  }

  // 2. All entries to stamp = forecasts the user picked + newly created suggestion entries.
  const allEntryIds = [...forecastEntryIds, ...newEntryIds];

  // 3. Fetch them to compute period bounds.
  const { data: selectedEntries, error: selErr } = await auth.supabase
    .from("billing_entries")
    .select("id, period_month, afp_number, billing_lines!inner(project_id)")
    .in("id", allEntryIds);
  if (selErr || !selectedEntries || selectedEntries.length === 0) {
    throw new Error(selErr?.message ?? "No selected entries found");
  }

  const months = selectedEntries.map((e) => e.period_month).sort();
  const startMonth = months[0];
  const endMonth = months[months.length - 1];
  const [sy, sm] = startMonth.split("-").map(Number);
  const [ey, em] = endMonth.split("-").map(Number);
  const periodStart = `${sy}-${String(sm).padStart(2, "0")}-01`;
  const lastDay = new Date(Date.UTC(ey, em, 0)).getUTCDate();
  const periodEnd = `${ey}-${String(em).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  // 4. App number: form input, or first forecast's afp_number, or next in the
  //    project's real sequence (which spans both numbering sources).
  let appNumber = appNumberInput;
  if (!appNumber) {
    const firstWithAfp = selectedEntries.find((e) => e.afp_number);
    if (firstWithAfp) appNumber = firstWithAfp.afp_number ?? "";
  }
  if (!appNumber) {
    appNumber = await nextAppNumber(auth.supabase, projectId);
  }

  const { data: project } = await auth.supabase
    .from("projects")
    .select("retainage_pct_default")
    .eq("id", projectId)
    .maybeSingle();
  const retainagePct = Number(project?.retainage_pct_default ?? 5);

  const result = await createPayApplication({
    projectId,
    appNumber,
    periodStart,
    periodEnd,
    retainagePct,
    onlyEntryIds: allEntryIds,
  });
  if (!result.ok) throw new Error(result.error);

  revalidatePath(`/projects/${projectId}/billing`);
  revalidatePath(`/projects/${projectId}/pay-apps`);
  revalidatePath(`/projects/${projectId}`, "layout");
}

// Multi-select flow: PM checks one or more forecast entries in the Next AFP
// panel, enters an AFP number, clicks Create. We wrap exactly those entries
// in a single pay_application - no chance of grabbing more than was checked,
// no manual period entry. Period bounds derived from the entries themselves.
export async function createPayAppFromSelectedEntries(
  formData: FormData,
): Promise<void> {
  const projectId = String(formData.get("projectId") ?? "").trim();
  const appNumberInput = String(formData.get("appNumber") ?? "").trim();
  const entryIds = formData
    .getAll("entryIds")
    .map((v) => String(v))
    .filter((v) => v.length > 0);

  if (!projectId) throw new Error("projectId required");
  if (entryIds.length === 0) throw new Error("Select at least one entry");

  const auth = await assertAhcUser();
  if (!auth.ok) throw new Error(auth.error);

  const { data: selected, error: selErr } = await auth.supabase
    .from("billing_entries")
    .select("id, period_month, afp_number, billing_lines!inner(project_id)")
    .in("id", entryIds);
  if (selErr || !selected || selected.length === 0) {
    throw new Error(selErr?.message ?? "No selected entries found");
  }

  // Period spans the earliest to latest of the selected entries' months.
  const months = selected.map((e) => e.period_month).sort();
  const startMonth = months[0];
  const endMonth = months[months.length - 1];
  const [sy, sm] = startMonth.split("-").map(Number);
  const [ey, em] = endMonth.split("-").map(Number);
  const periodStart = `${sy}-${String(sm).padStart(2, "0")}-01`;
  const lastDay = new Date(Date.UTC(ey, em, 0)).getUTCDate();
  const periodEnd = `${ey}-${String(em).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  // App number: use form input if provided, else first selected entry's
  // afp_number, else next sequential.
  let appNumber = appNumberInput;
  if (!appNumber) appNumber = selected[0].afp_number ?? "";
  if (!appNumber) {
    appNumber = await nextAppNumber(auth.supabase, projectId);
  }

  const { data: project } = await auth.supabase
    .from("projects")
    .select("retainage_pct_default")
    .eq("id", projectId)
    .maybeSingle();
  const retainagePct = Number(project?.retainage_pct_default ?? 5);

  const result = await createPayApplication({
    projectId,
    appNumber,
    periodStart,
    periodEnd,
    retainagePct,
    onlyEntryIds: entryIds,
  });
  if (!result.ok) throw new Error(result.error);

  revalidatePath(`/projects/${projectId}/billing`);
  revalidatePath(`/projects/${projectId}/pay-apps`);
  revalidatePath(`/projects/${projectId}`, "layout");
}
