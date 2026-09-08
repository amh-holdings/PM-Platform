/**
 * Everything the change order detail page needs, in one round of queries.
 *
 * Kept out of the page component because the AFP and the CO list want the same
 * roll-ups, and because the Exhibit H figures depend on the OTHER change
 * orders on the project - a detail that is easy to get wrong if each caller
 * re-derives it.
 */

import { coClient } from "@/lib/database.types.co";
import {
  deriveExhibitH,
  priceBuildup,
  type Buildup,
  type CostCategory,
  type CostLine,
  type ExhibitH,
} from "@/lib/change-order-pricing";

export type CoAttachment = {
  id: string;
  costLineId: string | null;
  kind: string;
  fileName: string;
  storagePath: string;
  mimeType: string | null;
  sizeBytes: number | null;
  description: string | null;
  uploadedAt: string | null;
  /** Populated by the page; a short-lived signed link into the private bucket. */
  signedUrl?: string | null;
};

export type CoEvent = {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  note: string | null;
  actorName: string | null;
  createdAt: string | null;
};

export type ChangeOrderDetail = {
  id: string;
  projectId: string;
  coNumber: string;
  description: string | null;
  reason: string | null;
  status: string;
  coValue: number;
  costAmount: number | null;
  profitPct: number | null;
  bondPct: number | null;
  taxPct: number | null;
  dateOfChangeOrder: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  internalReviewAt: string | null;
  voidedAt: string | null;
  scheduleImpactDays: number | null;
  mechCompletionDeltaDays: number | null;
  substCompletionDeltaDays: number | null;
  exhibitEImpact: string | null;
  capacityRatioImpact: string | null;
  designBasisImpact: string | null;
  otherImpacts: string | null;
  notes: string | null;
  billingLineId: string | null;
};

export type ChangeOrderPageData = {
  co: ChangeOrderDetail;
  buildup: Buildup;
  exhibitH: ExhibitH;
  attachments: CoAttachment[];
  events: CoEvent[];
  /**
   * True when the CO's stored co_value has drifted from the buildup. Happens
   * on COs created before the buildup existed, or if a line is edited outside
   * the app. The page offers a one-click resync.
   */
  totalsOutOfSync: boolean;
};

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function loadChangeOrder(
  supabase: unknown,
  coId: string,
): Promise<ChangeOrderPageData | null> {
  const db = coClient(supabase);

  const { data: coRow } = await db
    .from("change_orders")
    .select("*")
    .eq("id", coId)
    .maybeSingle();
  if (!coRow) return null;

  const projectId = coRow.project_id;

  const [{ data: projectRow }, { data: lineRows }, { data: attachRows }, { data: eventRows }, { data: priorRows }] =
    await Promise.all([
      db
        .from("projects")
        .select(
          "name, client, contract_value, original_contract_value, agreement_date, guaranteed_mechanical_completion_date, guaranteed_substantial_completion_date, contractor_legal_name",
        )
        .eq("id", projectId)
        .maybeSingle(),
      db
        .from("change_order_cost_lines")
        .select("*")
        .eq("change_order_id", coId)
        .order("sort_order", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: true }),
      db
        .from("change_order_attachments")
        .select("*")
        .eq("change_order_id", coId)
        .order("uploaded_at", { ascending: true }),
      db
        .from("change_order_events")
        .select("*, profiles:actor_id(full_name)")
        .eq("change_order_id", coId)
        .order("created_at", { ascending: false }),
      db
        .from("change_orders")
        .select("id, co_number, co_value, status")
        .eq("project_id", projectId)
        .neq("id", coId),
    ]);

  const lines: CostLine[] = (lineRows ?? []).map((l) => ({
    id: l.id,
    sortOrder: l.sort_order,
    category: (l.category ?? "other") as CostCategory,
    description: l.description,
    vendorName: l.vendor_name,
    quantity: num(l.quantity, 0),
    unit: l.unit,
    unitCost: num(l.unit_cost, 0),
    markupPct: numOrNull(l.markup_pct),
    costCodeId: l.cost_code_id,
    notes: l.notes,
  }));

  const buildup = priceBuildup({
    lines,
    defaultMarkupPct: numOrNull(coRow.profit_pct),
    bondPct: numOrNull(coRow.bond_pct),
    taxPct: numOrNull(coRow.tax_pct),
  });

  const co: ChangeOrderDetail = {
    id: coRow.id,
    projectId,
    coNumber: coRow.co_number,
    description: coRow.description,
    reason: coRow.reason,
    status: coRow.status ?? "draft",
    coValue: num(coRow.co_value, 0),
    costAmount: numOrNull(coRow.cost_amount),
    profitPct: numOrNull(coRow.profit_pct),
    bondPct: numOrNull(coRow.bond_pct),
    taxPct: numOrNull(coRow.tax_pct),
    dateOfChangeOrder: coRow.date_of_change_order,
    submittedAt: coRow.submitted_at,
    approvedAt: coRow.approved_at,
    rejectedAt: coRow.rejected_at,
    internalReviewAt: coRow.internal_review_at,
    voidedAt: coRow.voided_at,
    scheduleImpactDays: coRow.schedule_impact_days,
    mechCompletionDeltaDays: coRow.mech_completion_delta_days,
    substCompletionDeltaDays: coRow.subst_completion_delta_days,
    exhibitEImpact: coRow.exhibit_e_impact,
    capacityRatioImpact: coRow.capacity_ratio_impact,
    designBasisImpact: coRow.design_basis_impact,
    otherImpacts: coRow.other_impacts,
    notes: coRow.notes,
    billingLineId: coRow.billing_line_id,
  };

  // Exhibit H line 4 reports what the owner is actually being asked for. Once
  // there is a buildup, that is the buildup total - the stored co_value can
  // lag by one save. With no lines at all, fall back to the stored value so a
  // legacy lump-sum CO still fills the form out.
  const billableForForm = lines.length > 0 ? buildup.billable : co.coValue;

  const exhibitH = deriveExhibitH(
    {
      name: projectRow?.name ?? "",
      client: projectRow?.client ?? null,
      contractorLegalName: projectRow?.contractor_legal_name ?? null,
      agreementDate: projectRow?.agreement_date ?? null,
      originalContractValue: numOrNull(projectRow?.original_contract_value),
      contractValue: numOrNull(projectRow?.contract_value),
      guaranteedMechanicalCompletionDate:
        projectRow?.guaranteed_mechanical_completion_date ?? null,
      guaranteedSubstantialCompletionDate:
        projectRow?.guaranteed_substantial_completion_date ?? null,
    },
    {
      coNumber: co.coNumber,
      dateOfChangeOrder: co.dateOfChangeOrder,
      billable: billableForForm,
      mechCompletionDeltaDays: co.mechCompletionDeltaDays,
      substCompletionDeltaDays: co.substCompletionDeltaDays,
    },
    (priorRows ?? []).map((p) => ({
      id: p.id,
      coNumber: p.co_number,
      coValue: num(p.co_value, 0),
      status: p.status ?? "draft",
    })),
  );

  const attachments: CoAttachment[] = (attachRows ?? []).map((a) => ({
    id: a.id,
    costLineId: a.cost_line_id,
    kind: a.kind ?? "other",
    fileName: a.file_name,
    storagePath: a.storage_path,
    mimeType: a.mime_type,
    sizeBytes: a.size_bytes,
    description: a.description,
    uploadedAt: a.uploaded_at,
  }));

  const events: CoEvent[] = (eventRows ?? []).map((e) => {
    const prof = (e as { profiles?: { full_name?: string | null } | null }).profiles;
    return {
      id: e.id,
      fromStatus: e.from_status,
      toStatus: e.to_status,
      note: e.note,
      actorName: prof?.full_name ?? null,
      createdAt: e.created_at,
    };
  });

  return {
    co,
    buildup,
    exhibitH,
    attachments,
    events,
    totalsOutOfSync:
      lines.length > 0 && Math.abs(buildup.billable - co.coValue) > 0.01,
  };
}
