// Correcting a subcontractor bill's header after it has been entered.
//
// Pyramid application 4 went in with this period's $104,479.06 typed into
// "Total completed to date", so the check against the 19 lines ($414,715.95)
// blocked approval. The only way out was to reject the bill and key all 19
// lines again. Phil: "add a way to edit the bill header".
//
// Lines are not editable here. They are derived from our SOV and the prior
// application, and the header is the sub's own paperwork typed in - the part
// a keying slip lands in. Every change is written onto the bill's notes with
// who made it, so the figure the checks ran against is never silently lost.

export type HeaderEditField = {
  key: string;
  label: string;
  kind: "money" | "number" | "date" | "text" | "bool";
};

/** The header as entered from the sub's G702, in form order. */
export const HEADER_FIELDS: HeaderEditField[] = [
  { key: "invoice_number", label: "Invoice number", kind: "text" },
  { key: "invoice_date", label: "Invoice date", kind: "date" },
  { key: "app_date", label: "Application date", kind: "date" },
  { key: "period_start", label: "Period start", kind: "date" },
  { key: "period_end", label: "Period end", kind: "date" },
  { key: "due_date", label: "Due date", kind: "date" },
  { key: "payment_terms_days", label: "Payment terms (days)", kind: "number" },
  { key: "invoice_total", label: "Invoice total", kind: "money" },
  { key: "billed_previous", label: "Previous applications", kind: "money" },
  { key: "billed_this_period", label: "This period", kind: "money" },
  { key: "billed_to_date", label: "Total completed to date", kind: "money" },
  { key: "retainage_this_period", label: "Retainage this period", kind: "money" },
  { key: "retainage_to_date", label: "Retainage held to date", kind: "money" },
  { key: "amount_due", label: "Amount due", kind: "money" },
  { key: "lien_waiver_received", label: "Lien waiver received", kind: "bool" },
  { key: "lien_waiver_amount", label: "Lien waiver amount", kind: "money" },
  { key: "lien_waiver_through_date", label: "Lien waiver through", kind: "date" },
];

/**
 * The three totals the entry form fills from our own line math when left
 * blank. Blank here means the same thing it meant on entry, so clearing a
 * field is a way back to "the sub's figure agrees with ours".
 */
export const DERIVED_WHEN_BLANK = ["billed_previous", "billed_this_period", "billed_to_date"] as const;

type Value = string | number | boolean | null;

function parseInput(field: HeaderEditField, raw: string | null | undefined): Value {
  if (field.kind === "bool") return raw === "on" || raw === "true";
  const s = (raw ?? "").trim();
  if (!s) return null;
  if (field.kind === "money" || field.kind === "number") {
    const n = Number(s.replace(/[$,\s]/g, ""));
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
  }
  return s;
}

function same(a: Value, b: Value): boolean {
  if (typeof a === "number" || typeof b === "number") {
    if (a == null || b == null) return a == b;
    return Math.abs(Number(a) - Number(b)) < 0.005;
  }
  return (a ?? null) === (b ?? null) || (a === false && b == null) || (a == null && b === false);
}

function show(field: HeaderEditField, v: Value, money: (n: number) => string): string {
  if (v == null || v === "") return "blank";
  if (field.kind === "bool") return v ? "yes" : "no";
  if (field.kind === "money") return money(Number(v));
  return String(v);
}

export type HeaderEditPlan =
  | { ok: false; error: string }
  | {
      ok: true;
      patch: Record<string, Value>;
      /** One line per changed field, for the bill's notes. Empty means no change. */
      changes: string[];
    };

/**
 * Compare what was posted against what is on file and say what changes.
 * Only changed fields go in the patch, so saving an untouched form is a
 * no-op rather than a rewrite.
 */
export function planHeaderEdit(opts: {
  current: Record<string, unknown>;
  input: Record<string, string | null | undefined>;
  derived: { billed_previous: number; billed_this_period: number; billed_to_date: number };
  money: (n: number) => string;
}): HeaderEditPlan {
  const patch: Record<string, Value> = {};
  const changes: string[] = [];
  for (const field of HEADER_FIELDS) {
    let next = parseInput(field, opts.input[field.key]);
    if (next == null && (DERIVED_WHEN_BLANK as readonly string[]).includes(field.key)) {
      next = opts.derived[field.key as (typeof DERIVED_WHEN_BLANK)[number]];
    }
    if (field.key === "period_end" && next == null) {
      return { ok: false, error: "Period end date is required" };
    }
    const prev = (opts.current[field.key] ?? null) as Value;
    const prevNorm = field.kind === "money" || field.kind === "number"
      ? prev == null ? null : Number(prev)
      : prev;
    if (same(prevNorm, next)) continue;
    patch[field.key] = next;
    changes.push(`${field.label}: ${show(field, prevNorm, opts.money)} to ${show(field, next, opts.money)}`);
  }
  return { ok: true, patch, changes };
}

/** The audit line appended to the bill's notes. */
export function headerEditNote(opts: { changes: string[]; who: string; whenIso: string }): string {
  return `Header edited ${opts.whenIso.slice(0, 10)} by ${opts.who}. ${opts.changes.join("; ")}.`;
}

/** A decided bill is on record as decided; its header no longer moves. */
export function canEditHeader(status: string | null | undefined): boolean {
  return !["approved", "rejected", "paid"].includes(status ?? "");
}
