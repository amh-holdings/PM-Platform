// What is on file for a subcontractor, and whether it is still good.
//
// The subcontractors table has carried coi_status and w9_status since the
// roster was built. Both are set by hand on the sub form and both read
// "pending" on nearly every sub, which is what a status field does when
// nothing forces it to agree with reality. Nobody goes back to flip it when
// the certificate arrives, and nothing flips it back when the certificate
// expires.
//
// So the documents answer instead. A row is compliant when a document of that
// category is attached to that sub and has not expired. That cannot drift,
// because there is nothing to remember.

import type { DocumentCategory } from "@/app/(app)/projects/[id]/documents-constants";

/** Days before expiry that a row starts asking for attention. */
export const EXPIRY_WARNING_DAYS = 30;

export type ComplianceItem = {
  category: DocumentCategory;
  label: string;
  /** A COI lapses. A W-9 does not. */
  expires: boolean;
};

/**
 * What a sub has to have on file.
 *
 * Bond and lien waiver are deliberately absent: neither is wanted from every
 * sub on every job, and a checklist that is red for everybody is a checklist
 * people stop reading.
 */
export const COMPLIANCE_ITEMS: readonly ComplianceItem[] = [
  { category: "coi", label: "COI", expires: true },
  { category: "w9", label: "W-9", expires: false },
  { category: "subcontract", label: "Subcontract", expires: false },
];

export type ComplianceDoc = {
  id: string;
  file_name: string;
  category: DocumentCategory;
  subcontractor_id: string | null;
  valid_until: string | null;
  uploaded_at?: string | null;
};

/**
 * ok        on file, and either does not expire or expires beyond the window
 * expiring  on file, lapses within EXPIRY_WARNING_DAYS
 * expired   on file, already lapsed
 * undated   on file, expires by nature, but nobody recorded when
 * missing   nothing attached
 *
 * `undated` is its own state rather than being folded into ok. An undated COI
 * is a file somebody is trusting without knowing whether it is still valid,
 * and calling that green rebuilds the drift this is meant to remove.
 */
export type ComplianceState =
  | "ok"
  | "expiring"
  | "expired"
  | "undated"
  | "missing";

export type ComplianceRow = {
  category: DocumentCategory;
  label: string;
  state: ComplianceState;
  document: ComplianceDoc | null;
  validUntil: string | null;
  /** Working it out once here, so the view does not do date maths. */
  daysLeft: number | null;
};

/** Whole days from `from` to `to`, negative once `to` is in the past. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/**
 * The newest document of each category attached to this sub.
 *
 * Newest by expiry where there is one, because a renewal is the point: last
 * year's certificate and this year's are both on file and the current one is
 * the one that counts. Falls back to upload order when neither has a date.
 */
export function latestForCategory(
  docs: readonly ComplianceDoc[],
  subId: string,
  category: DocumentCategory,
): ComplianceDoc | null {
  const mine = docs.filter(
    (d) => d.subcontractor_id === subId && d.category === category,
  );
  if (mine.length === 0) return null;
  return mine.reduce((best, d) => {
    if (d.valid_until && best.valid_until) {
      return d.valid_until > best.valid_until ? d : best;
    }
    if (d.valid_until) return d;
    if (best.valid_until) return best;
    return (d.uploaded_at ?? "") > (best.uploaded_at ?? "") ? d : best;
  });
}

export function complianceFor(
  subId: string,
  docs: readonly ComplianceDoc[],
  today: string,
  items: readonly ComplianceItem[] = COMPLIANCE_ITEMS,
): ComplianceRow[] {
  return items.map((item) => {
    const document = latestForCategory(docs, subId, item.category);
    if (!document) {
      return {
        category: item.category,
        label: item.label,
        state: "missing" as const,
        document: null,
        validUntil: null,
        daysLeft: null,
      };
    }

    if (!item.expires) {
      return {
        category: item.category,
        label: item.label,
        state: "ok" as const,
        document,
        validUntil: null,
        daysLeft: null,
      };
    }

    if (!document.valid_until) {
      return {
        category: item.category,
        label: item.label,
        state: "undated" as const,
        document,
        validUntil: null,
        daysLeft: null,
      };
    }

    const daysLeft = daysBetween(today, document.valid_until);
    // Expiry is end of day: a certificate good "until 2 November" is good ON
    // 2 November. Off by one here means refusing to pay a sub whose paperwork
    // is fine.
    const state: ComplianceState =
      daysLeft < 0 ? "expired" : daysLeft <= EXPIRY_WARNING_DAYS ? "expiring" : "ok";
    return {
      category: item.category,
      label: item.label,
      state,
      document,
      validUntil: document.valid_until,
      daysLeft,
    };
  });
}

/** Worst first: what the sub's single badge says. */
const SEVERITY: Record<ComplianceState, number> = {
  missing: 4,
  expired: 3,
  undated: 2,
  expiring: 1,
  ok: 0,
};

export function worstState(rows: readonly ComplianceRow[]): ComplianceState {
  if (rows.length === 0) return "ok";
  return rows.reduce<ComplianceState>(
    (worst, r) => (SEVERITY[r.state] > SEVERITY[worst] ? r.state : worst),
    "ok",
  );
}

export function describeState(row: ComplianceRow): string {
  switch (row.state) {
    case "missing":
      return "Not on file";
    case "expired":
      return `Expired ${Math.abs(row.daysLeft ?? 0)}d ago`;
    case "expiring":
      return row.daysLeft === 0
        ? "Expires today"
        : `Expires in ${row.daysLeft}d`;
    case "undated":
      return "On file, no expiry recorded";
    case "ok":
      return row.validUntil ? `Good to ${row.validUntil}` : "On file";
  }
}

/** One line for the top of the panel. */
export function complianceSummary(
  states: readonly ComplianceState[],
): { clear: number; attention: number; total: number } {
  const total = states.length;
  const clear = states.filter((s) => s === "ok").length;
  return { clear, attention: total - clear, total };
}
