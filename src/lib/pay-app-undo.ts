// Undoing an AFP created by mistake.
//
// Pure functions, no database. "Create AFP from selected" stamps every chosen
// billing_entry with a pay_application_id and status 'on_pay_app', which is
// exactly why the rows leave the Bill this period panel. Clicking it by
// accident therefore looks like the month's billing vanished, and the only way
// back was the delete button on the pay app detail page - a different screen,
// with no indication from the billing page that it was where to go.
//
// The guard below is the whole point of this module. An AFP that has been sent
// to the owner is not a mistake to undo, it is a document someone is acting on,
// and quietly pulling its lines back would put the app out of step with what
// the owner is holding. So: a draft can be undone, anything that has gone out
// cannot, and the refusal says which of those it is.

export type PayApplicationState = {
  app_number: string | null;
  status: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  paid_at: string | null;
};

export type UndoCheck = { ok: true } | { ok: false; reason: string };

/** Statuses that mean the AFP has left the building. */
const ISSUED_STATUSES = new Set(["submitted", "approved", "paid"]);

function label(app: PayApplicationState): string {
  return app.app_number ? `AFP ${app.app_number}` : "This AFP";
}

/**
 * Whether an AFP can be pulled back apart.
 *
 * Draft only. A missing status is treated as draft because that is the column
 * default, and a null there means "never moved on", not "unknown".
 *
 * The timestamps are checked as well as the status. They are set by the status
 * transitions and are the harder evidence of the two: a status can be edited
 * back to draft, a submitted_at is a record that it went out.
 */
export function canUndoPayApplication(app: PayApplicationState): UndoCheck {
  if (app.paid_at) {
    return {
      ok: false,
      reason: `${label(app)} has been paid. Undoing it would pull back lines the owner has already settled.`,
    };
  }
  if (app.approved_at) {
    return {
      ok: false,
      reason: `${label(app)} has been approved by the owner. Issue a revision rather than undoing it.`,
    };
  }
  if (app.submitted_at) {
    return {
      ok: false,
      reason: `${label(app)} was submitted to the owner. Retract it on the pay app page first, then undo.`,
    };
  }

  const status = (app.status ?? "draft").trim() || "draft";
  if (ISSUED_STATUSES.has(status)) {
    return {
      ok: false,
      reason: `${label(app)} is marked ${status}. Only a draft AFP can be undone.`,
    };
  }
  if (status !== "draft") {
    return {
      ok: false,
      reason: `${label(app)} is marked ${status}, not draft. Only a draft AFP can be undone.`,
    };
  }

  return { ok: true };
}

/**
 * What the billing page says in place of the misleading empty state.
 *
 * "Nothing to bill: no forecast entries queued up, no schedule progress
 * detected" was being shown for a month whose every line was sitting on an AFP
 * created ninety seconds earlier. Both sentences are an empty panel; only one
 * of them sends the reader to the right place.
 */
export function billedElsewhereMessage(input: {
  periodLabel: string;
  appNumber: string | null;
  lineCount: number;
  amount: number;
  formatAmount: (n: number) => string;
}): string {
  const app = input.appNumber ? `AFP ${input.appNumber}` : "a draft AFP";
  const lines = `${input.lineCount} line${input.lineCount === 1 ? "" : "s"}`;
  return `${input.periodLabel} is already on ${app} - ${lines}, ${input.formatAmount(input.amount)}.`;
}
