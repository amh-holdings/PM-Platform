"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

// Daily commodity production - AHC's deliverable to the owner.
//
// This is NOT subcontractor input. The sub files a Field Report; the CM checks
// it; Phil reads the quantities off those reports and files the owner's daily
// Commodity Tracker. So every write here is gated to the `phil` role, both in
// this action and in RLS (migration 0036).
//
// Values are DAILY, not cumulative - that is what the owner's form asks for.
//
// SAVING IS CONFIRMING (migration 0040)
// An approved Field Report now auto-proposes its day's production, and those
// rows land with confirmed_at = null: visible on the tracker, excluded from
// billing and from the owner push. Saving here is the act that stands behind a
// number, so every cell written from this action is stamped confirmed.

export type ProductionCell = {
  productionDate: string;
  commodityKey: string;
  quantity: number;
};

export type ProductionResult =
  | { ok: true; written: number }
  | { ok: false; error: string };

async function requirePhil() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Not signed in" };
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile || profile.role !== "phil") {
    return {
      ok: false as const,
      error: "Daily production is restricted - only Phil can file it.",
    };
  }
  return { ok: true as const, supabase, userId: user.id };
}

export async function saveDailyProduction(input: {
  projectId: string;
  cells: ProductionCell[];
}): Promise<ProductionResult> {
  const auth = await requirePhil();
  if (!auth.ok) return auth;
  const { supabase, userId } = auth;

  if (!input.cells.length) return { ok: true, written: 0 };

  const { data: commodities, error: commErr } = await supabase
    .from("commodities")
    .select("id, key, label, uom")
    .eq("project_id", input.projectId)
    .eq("active", true);
  if (commErr) return { ok: false, error: commErr.message };
  if (!commodities?.length) {
    return { ok: false, error: "No commodities configured for this project" };
  }
  const byKey = new Map(commodities.map((c) => [c.key, c]));

  // What is already on the tracker for the dates being saved. Needed to keep a
  // row's provenance: a proposal Phil accepts unchanged stays a 'field_report'
  // value linked to the report that produced it, because that is still where
  // the number came from. Only a value he actually changed becomes 'manual'.
  const dates = Array.from(new Set(input.cells.map((c) => c.productionDate)));
  const { data: priorRows } = await supabase
    .from("daily_production")
    .select("commodity_id, production_date, quantity, source, dpr_id")
    .eq("project_id", input.projectId)
    .in("production_date", dates);
  const priorByCell = new Map(
    (priorRows ?? []).map((r) => [`${r.production_date}|${r.commodity_id}`, r]),
  );

  const confirmedAt = new Date().toISOString();
  const rows = [];
  for (const cell of input.cells) {
    const spec = byKey.get(cell.commodityKey);
    if (!spec) return { ok: false, error: `Unknown commodity "${cell.commodityKey}"` };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cell.productionDate)) {
      return { ok: false, error: `Bad date "${cell.productionDate}"` };
    }
    const value = Number(cell.quantity);
    if (!Number.isFinite(value) || value < 0) {
      return { ok: false, error: `${spec.label} must be zero or a positive number` };
    }
    if (spec.uom === "%" && value > 100) {
      return { ok: false, error: `${spec.label} is a daily percent and cannot exceed 100` };
    }
    const prior = priorByCell.get(`${cell.productionDate}|${spec.id}`);
    const unchanged = prior != null && Number(prior.quantity) === value;
    rows.push({
      project_id: input.projectId,
      commodity_id: spec.id,
      production_date: cell.productionDate,
      quantity: value,
      source: unchanged && prior ? prior.source : ("manual" as const),
      // Keep the link to the report the day came from even on an override - it
      // is the substantiation for the date, whoever set the figure.
      dpr_id: prior?.dpr_id ?? null,
      entered_by: userId,
      confirmed_at: confirmedAt,
      confirmed_by: userId,
    });
  }

  // A percent scope cannot pass 100% across everything already on record plus
  // what is being saved now. Checked here rather than per-cell because a single
  // day's figure is always small - it is the running total that goes wrong.
  const pctIds = commodities.filter((c) => c.uom === "%").map((c) => c.id);
  if (pctIds.length) {
    const { data: existing } = await supabase
      .from("daily_production")
      .select("commodity_id, production_date, quantity")
      .eq("project_id", input.projectId)
      .in("commodity_id", pctIds);
    const totals = new Map<string, number>();
    for (const r of existing ?? []) {
      // Rows being overwritten in this save must not be counted twice.
      const superseded = rows.some(
        (n) =>
          n.commodity_id === r.commodity_id &&
          n.production_date === r.production_date,
      );
      if (superseded) continue;
      totals.set(r.commodity_id, (totals.get(r.commodity_id) ?? 0) + Number(r.quantity));
    }
    for (const n of rows) {
      if (!pctIds.includes(n.commodity_id)) continue;
      totals.set(n.commodity_id, (totals.get(n.commodity_id) ?? 0) + n.quantity);
    }
    for (const [commodityId, total] of Array.from(totals.entries())) {
      if (total > 100) {
        const label = commodities.find((c) => c.id === commodityId)?.label ?? "A commodity";
        return {
          ok: false,
          error: `${label} would reach ${total.toFixed(2)}% of scope, which is over 100%.`,
        };
      }
    }
  }

  const { error } = await supabase
    .from("daily_production")
    .upsert(rows, { onConflict: "project_id,production_date,commodity_id" });
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${input.projectId}/reports/commodity-tracker`);
  return { ok: true, written: rows.length };
}
