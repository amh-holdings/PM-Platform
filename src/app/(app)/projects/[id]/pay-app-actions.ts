"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";
import { friendlyAppNumberError, nextAppNumber } from "@/lib/afp-number";
import { canUndoPayApplication } from "@/lib/pay-app-undo";
import { forecastAmountPatch, pairForecastAmounts } from "@/lib/billing-progress";
import { buildPayAppLines, type PayAppEntry } from "@/lib/pay-app-lines";
import { readAmendments } from "@/lib/sov-amendments-db";

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

  // Pull every billing_line for the project + its entries, and the change
  // order allocations that say what each line's scope really is. "*" so
  // retainage_exempt (0071, applied by hand) rides along when it exists and a
  // database without it still issues applications.
  const { data: lines, error: linesErr } = await auth.supabase
    .from("billing_lines")
    .select("*")
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

  // A missing 0054 is tolerated on the billing PAGE, where the worst case is
  // pre-amendment percentages on a screen. It is not tolerated here. Without
  // the allocations, CO-02's $709,976.60 is invisible and the G703 prints
  // Mobilization at $100,000 against $320,762.92 of billing - a document the
  // owner cannot tie out, issued in the contractor's name.
  const { rows: amendments, missing: amendmentsMissing } = await readAmendments(
    auth.supabase,
    input.projectId,
  );
  if (amendmentsMissing) {
    await auth.supabase.from("pay_applications").delete().eq("id", app.id);
    return {
      ok: false,
      error:
        "Change order allocations are unavailable (migration 0054_billing_line_amendments.sql is not applied). " +
        "An application built without them would misstate every contract line a change order raised.",
    };
  }

  const retPct = Number.isFinite(input.retainagePct) ? input.retainagePct : 10;
  const built = buildPayAppLines({
    lines: lines ?? [],
    entries: (entries ?? []) as PayAppEntry[],
    amendments,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    retainagePct: retPct,
    onlyEntryIds: input.onlyEntryIds ?? null,
  });
  if (!built.ok) {
    await auth.supabase.from("pay_applications").delete().eq("id", app.id);
    return { ok: false, error: built.error };
  }

  // The schedule of values has to total the contract. Allocations move scope
  // between lines and never change the sum, so a total that has drifted means
  // a line's value is wrong rather than merely allocated - the failure this
  // whole exercise started from. A dollar of latitude covers the cent-level
  // rounding between a change order's markup and the executed figure.
  const { data: contractRow } = await auth.supabase
    .from("projects")
    .select("contract_value")
    .eq("id", input.projectId)
    .maybeSingle();
  const contractValue = Number(contractRow?.contract_value ?? 0);
  if (contractValue > 0 && Math.abs(built.totals.scheduled_value - contractValue) > 1) {
    await auth.supabase.from("pay_applications").delete().eq("id", app.id);
    return {
      ok: false,
      error:
        `The schedule of values totals ${built.totals.scheduled_value.toFixed(2)} but the contract is ` +
        `${contractValue.toFixed(2)}. Fix the SOV before issuing an application.`,
    };
  }

  const stalePriorForecasts = built.stalePriorForecasts;
  const lineInserts = built.lines.map((l) => ({
    pay_application_id: app.id,
    ...l,
  }));

  if (lineInserts.length > 0) {
    const { error: liErr } = await auth.supabase
      .from("pay_application_lines")
      .insert(lineInserts);
    if (liErr) return { ok: false, error: liErr.message };
  }

  // Roll-up totals come from the builder rather than being re-summed here, so
  // the header and the lines cannot disagree about the same application.
  const rollup = {
    total_completed: built.totals.total_completed,
    total_retainage: built.totals.total_retainage,
    previous_billings: built.totals.previous_billings,
    amount_due: built.totals.amount_due,
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
  for (const id of built.thisPeriodEntryIds) {
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

// Put an AFP's lines back. The counterpart to "Create AFP from selected",
// reachable from the billing page where the mistake is made rather than from a
// screen the reader has no reason to be on.
//
// Draft only - canUndoPayApplication() refuses anything that has gone to the
// owner, and the refusal is returned rather than thrown so the caller can show
// it. See src/lib/pay-app-undo.ts for why the timestamps are checked as well as
// the status.
//
// Entries are restored, never deleted. Rows that this AFP created from schedule
// suggestions come back as ordinary forecast entries carrying the amount that
// was billed, rather than disappearing to be re-suggested. That is deliberate:
// createAfpFromBillThisPeriod UPDATES a pre-existing entry when one is already
// sitting at (billing_line_id, period_month), so after the fact there is no way
// to tell a row it created from a row it edited. Deleting on that guess would
// throw away somebody's forecast. An extra forecast row is visible and
// correctable; a deleted one is neither.
//
// actual_amount is left as stamped. Since migration 0037, v_billing_line_totals
// only counts actual_amount as billed when the row still carries billing
// evidence - a pay_application_id, an afp_number, or a status past forecast -
// so clearing the first two is what makes the line billable again.
export async function undoPayApplication(
  payAppId: string,
  projectId: string,
): Promise<
  | { ok: true; releasedEntries: number; appNumber: string | null }
  | { ok: false; error: string }
> {
  const auth = await assertAhcUser();
  if (!auth.ok) return auth;

  const { data: app, error: appErr } = await auth.supabase
    .from("pay_applications")
    .select("id, app_number, status, submitted_at, approved_at, paid_at, project_id")
    .eq("id", payAppId)
    .eq("project_id", projectId)
    .maybeSingle();
  if (appErr) return { ok: false, error: appErr.message };
  if (!app) return { ok: false, error: "That AFP no longer exists" };

  const check = canUndoPayApplication({
    app_number: app.app_number,
    status: app.status,
    submitted_at: app.submitted_at,
    approved_at: app.approved_at,
    paid_at: app.paid_at,
  });
  if (!check.ok) return { ok: false, error: check.reason };

  const { data: released, error: relErr } = await auth.supabase
    .from("billing_entries")
    .update({ pay_application_id: null, status: "forecast" })
    .eq("pay_application_id", payAppId)
    .select("id");
  if (relErr) return { ok: false, error: relErr.message };

  // pay_application_lines cascade on this delete (migration 0010).
  const { error: delErr } = await auth.supabase
    .from("pay_applications")
    .delete()
    .eq("id", payAppId)
    .eq("project_id", projectId);
  if (delErr) return { ok: false, error: delErr.message };

  revalidatePath(`/projects/${projectId}`, "layout");
  revalidatePath(`/projects/${projectId}/billing`);
  revalidatePath(`/projects/${projectId}/pay-apps`);
  return {
    ok: true,
    releasedEntries: (released ?? []).length,
    appNumber: app.app_number,
  };
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
  const forecastEntryIdsRaw = formData
    .getAll("forecastEntryIds")
    .map((v) => String(v));
  const forecastAmountsRaw = formData.getAll("forecastAmounts").map((v) => Number(v));
  const forecastPairs = pairForecastAmounts(forecastEntryIdsRaw, forecastAmountsRaw);
  const forecastEntryIds = forecastPairs.map((p) => p.id);
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
  if (forecastAmountsRaw.length > 0 && forecastAmountsRaw.length !== forecastEntryIdsRaw.length) {
    throw new Error("Forecast arrays out of sync");
  }

  const auth = await assertAhcUser();
  if (!auth.ok) throw new Error(auth.error);

  // 0. Write back any forecast amount the person changed in the panel. Rows
  //    that were left alone produce no patch and are not touched.
  for (const { id, amount } of forecastPairs) {
    const { data: entry } = await auth.supabase
      .from("billing_entries")
      .select("id, planned_amount, actual_amount")
      .eq("id", id)
      .maybeSingle();
    if (!entry) continue;
    const patch = forecastAmountPatch(entry, amount);
    if (!patch) continue;
    const { error: amtErr } = await auth.supabase
      .from("billing_entries")
      .update(patch)
      .eq("id", id);
    if (amtErr) throw new Error(amtErr.message);
  }

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
