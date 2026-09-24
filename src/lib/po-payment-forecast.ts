// What date a PO payment milestone should land on in the cash forecast.
//
// The gap this closes: sub costs move when the schedule moves, because a sub
// SOV line is forecast at its milestone task's planned finish and that finish
// is read fresh every time. Vendor costs did not. A PO payment milestone
// carried expected_date, a date somebody typed once, and nothing in the app
// ever connected it back to the delivery task the PO is linked to. Push a
// delivery two weeks right and the AFP moved, the sub cash moved, and the
// vendor cash sat exactly where it was.
//
// Zarina, after linking the POs and re-dating the schedule: "Is the cashflow
// up to date and calling from scheduled deliveries and construction tasks?"
// Construction tasks yes, scheduled deliveries no. Now both.
//
// The link is procurement_orders.linked_delivery_task_wbs_code, the same one
// the delivery sync already reads. Nothing here writes to the database. The
// date is derived at read time, which is what makes it follow the schedule
// instead of needing a re-sync.
//
// Three rules, and the middle one is the one that matters.
//
// A paid milestone is never re-dated. paid_at is money that has left the
// bank on a day that actually happened.
//
// An unpaid milestone that pays ON DELIVERY takes the delivery date, and
// the schedule beats the typed date. That is the whole point: the typed date
// was a guess made when the PO was entered and the schedule is the current
// plan. An arrival that has already happened beats both, because
// actual_delivery_date is a fact.
//
// Everything else keeps the typed date. A deposit fires on signing and a
// commissioning payment fires on a task this PO does not point at, so moving
// either one to the delivery date would be inventing a number.

export type PoForecastMilestone = {
  id?: string | null;
  milestone_name?: string | null;
  trigger_event?: string | null;
  expected_date?: string | null;
  paid_at?: string | null;
};

export type PoForecastOrder = {
  id?: string | null;
  po_number?: string | null;
  vendor_name?: string | null;
  linked_delivery_task_wbs_code?: string | null;
  actual_delivery_date?: string | null;
  payment_terms_summary?: string | null;
};

export type DeliveryTaskDate = {
  wbs_code: string;
  task_name?: string | null;
  end_date?: string | null;
};

export type MilestoneDateSource =
  | "paid"       // already paid, the paid date stands
  | "arrived"    // the PO carries an actual delivery date
  | "schedule"   // the linked delivery task's planned finish
  | "typed"      // the expected_date somebody entered
  | "none";      // no date anywhere, so this money is not in the curve

export type MilestoneDate = {
  /** The date the forecast should bucket this milestone on, if there is one. */
  date: string | null;
  source: MilestoneDateSource;
  /** The delivery task the date came from, when it came from one. */
  viaWbs: string | null;
  /** Net terms applied on top of the delivery date, in days. */
  termsDays: number;
  /**
   * The typed expected_date this replaced, when the derived date lands in a
   * different month. Same-month moves are not worth telling anyone about.
   */
  supersedes: string | null;
};

/**
 * Numbers out of "Net 30", "NET45 days", "net 60 from invoice".
 *
 * The whole run of digits is read, not the first three of them, so "Net 3000"
 * is refused as nonsense rather than quietly becoming Net 300 and pushing the
 * payment most of a year out. The word boundary keeps it off "Internet".
 */
export function netTermsDays(summary: string | null | undefined): number {
  const m = /\bnet\s*(\d+)/i.exec(summary ?? "");
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 && n <= 365 ? n : 0;
}

export function addDaysIso(iso: string, days: number): string {
  if (!iso) return iso;
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d + days));
  return at.toISOString().slice(0, 10);
}

/**
 * Whether this milestone is the one that fires when the truck arrives.
 *
 * Reads trigger_event and falls back to the milestone name, and checks
 * commissioning first, exactly the way milestoneTriggered does in progress.ts.
 * A row that earns on "commissioning and delivery sign-off" is a
 * commissioning row in the AFP, so it has to be one here too - two modules
 * disagreeing about what a milestone means is worse than either rule.
 */
export function isDeliveryTrigger(m: PoForecastMilestone): boolean {
  const t = (m.trigger_event ?? m.milestone_name ?? "").toLowerCase();
  if (/commission/.test(t)) return false;
  return /deliver/.test(t);
}

/** The month a date falls in, as YYYY-MM. Null in, null out. */
function monthOf(iso: string | null): string | null {
  return iso ? iso.slice(0, 7) : null;
}

export function forecastMilestoneDate(input: {
  milestone: PoForecastMilestone;
  po: PoForecastOrder;
  /** The task named by the PO's linked_delivery_task_wbs_code, if found. */
  deliveryTask?: DeliveryTaskDate | null;
}): MilestoneDate {
  const { milestone, po, deliveryTask } = input;
  const typed = milestone.expected_date ?? null;

  if (milestone.paid_at) {
    return {
      date: milestone.paid_at,
      source: "paid",
      viaWbs: null,
      termsDays: 0,
      supersedes: null,
    };
  }

  if (!isDeliveryTrigger(milestone)) {
    return {
      date: typed,
      source: typed ? "typed" : "none",
      viaWbs: null,
      termsDays: 0,
      supersedes: null,
    };
  }

  const termsDays = netTermsDays(po.payment_terms_summary);

  // It is already here. Nothing the schedule plans can be truer than that.
  if (po.actual_delivery_date) {
    const date = addDaysIso(po.actual_delivery_date, termsDays);
    return {
      date,
      source: "arrived",
      viaWbs: null,
      termsDays,
      supersedes: typed && monthOf(typed) !== monthOf(date) ? typed : null,
    };
  }

  const planned = po.linked_delivery_task_wbs_code ? (deliveryTask?.end_date ?? null) : null;
  if (planned) {
    const date = addDaysIso(planned, termsDays);
    return {
      date,
      source: "schedule",
      viaWbs: deliveryTask?.wbs_code ?? po.linked_delivery_task_wbs_code ?? null,
      termsDays,
      supersedes: typed && monthOf(typed) !== monthOf(date) ? typed : null,
    };
  }

  return {
    date: typed,
    source: typed ? "typed" : "none",
    viaWbs: null,
    termsDays: 0,
    supersedes: null,
  };
}

/** One line for the PO page, under the typed date. */
export function describeMilestoneDate(
  at: MilestoneDate,
  taskName?: string | null,
): string | null {
  switch (at.source) {
    case "paid":
      return null; // the Paid column already says it
    case "arrived":
      return at.termsDays > 0
        ? `Forecast ${at.date}, delivered plus Net ${at.termsDays}`
        : `Forecast ${at.date}, the recorded delivery date`;
    case "schedule": {
      const via = taskName ? `${at.viaWbs} ${taskName}` : (at.viaWbs ?? "the delivery task");
      return at.termsDays > 0
        ? `Forecast ${at.date}, follows ${via} plus Net ${at.termsDays}`
        : `Forecast ${at.date}, follows ${via}`;
    }
    case "typed":
      return null; // the date is already on screen
    case "none":
      return "No date, so this money is not in the cash forecast";
  }
}

/**
 * The line the dashboard shows when the schedule has moved a PO's payment
 * off the date somebody typed. Said out loud rather than applied quietly,
 * because a number moving on its own with no explanation is how people stop
 * trusting a forecast.
 */
export function describeScheduleMove(input: {
  poLabel: string;
  milestoneName: string;
  at: MilestoneDate;
  taskName?: string | null;
}): string {
  const { poLabel, milestoneName, at } = input;
  const via = at.viaWbs
    ? input.taskName
      ? `${at.viaWbs} ${input.taskName}`
      : at.viaWbs
    : "the recorded delivery";
  const tail = at.termsDays > 0 ? ` plus Net ${at.termsDays}` : "";
  return `${poLabel} ${milestoneName}: ${at.supersedes} on the PO, forecast ${at.date} from ${via}${tail}`;
}

/** Plural-safe heading for the group of schedule-driven POs. */
export function describeScheduleMoveCount(n: number): string {
  if (n === 1) return "1 vendor payment takes its date from the schedule";
  return `${n} vendor payments take their dates from the schedule`;
}

/**
 * Every milestone on one PO, dated. Convenience for pages that render the
 * whole schedule rather than one row.
 */
export function forecastPoDates(input: {
  po: PoForecastOrder;
  milestones: readonly PoForecastMilestone[];
  deliveryTask?: DeliveryTaskDate | null;
}): MilestoneDate[] {
  return input.milestones.map((milestone) =>
    forecastMilestoneDate({
      milestone,
      po: input.po,
      deliveryTask: input.deliveryTask,
    }),
  );
}

/** The soonest unpaid payment on a PO, on forecast dates rather than typed ones. */
export function nextDueDate(input: {
  po: PoForecastOrder;
  milestones: readonly PoForecastMilestone[];
  deliveryTask?: DeliveryTaskDate | null;
}): string | null {
  let soonest: string | null = null;
  for (const milestone of input.milestones) {
    if (milestone.paid_at) continue;
    const at = forecastMilestoneDate({
      milestone,
      po: input.po,
      deliveryTask: input.deliveryTask,
    });
    if (!at.date) continue;
    if (!soonest || at.date < soonest) soonest = at.date;
  }
  return soonest;
}
