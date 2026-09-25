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
  /**
   * The PO line this milestone pays for. Null means the whole order, which is
   * every milestone written before migration 0062.
   */
  procurement_order_line_id?: string | null;
};

/**
 * One item on the PO, and the schedule row it lands on.
 *
 * Zarina: "there are POs that has multiple deliveries on it. And each item
 * inside a PO can be linked to a line in the schedule." FTC Solar delivers
 * piles and racking on different dates against different schedule rows, so one
 * link for the whole PO put the second shipment on the first one's date.
 */
export type PoForecastLine = {
  id?: string | null;
  line_no?: number | null;
  description?: string | null;
  linked_delivery_task_wbs_code?: string | null;
};

export type PoForecastOrder = {
  id?: string | null;
  po_number?: string | null;
  vendor_name?: string | null;
  linked_delivery_task_wbs_code?: string | null;
  actual_delivery_date?: string | null;
  payment_terms_summary?: string | null;
  /** When the PO was signed. What a PO release milestone fires on. */
  signed_at?: string | null;
  /** When the PO was raised. The planned stand-in before it is signed. */
  ordered_date?: string | null;
};

export type DeliveryTaskDate = {
  wbs_code: string;
  task_name?: string | null;
  end_date?: string | null;
};

export type MilestoneDateSource =
  | "paid"        // already paid, the paid date stands
  | "arrived"     // an actual delivery date, on the line or the PO
  | "schedule"    // a linked delivery task's planned finish
  | "last_line"   // no link of its own, so the last of the PO's items
  | "signed"      // the PO's signing date, for a milestone that fires on it
  | "ordered"     // the PO's ordered date, before it has been signed
  | "typed"       // the expected_date somebody entered
  | "none";       // no date anywhere, so this money is not in the curve

export type MilestoneDate = {
  /** The date the forecast should bucket this milestone on, if there is one. */
  date: string | null;
  source: MilestoneDateSource;
  /** The delivery task the date came from, when it came from one. */
  viaWbs: string | null;
  /** The PO line the date came from, when a line supplied it. */
  viaLine: { id: string | null; label: string } | null;
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

/**
 * A milestone that fires when the PO is signed.
 *
 * Zarina: "Can you add option for net 30 after PO, or is it a hidden
 * understand that if set trigger to PO release, then it will be automatically
 * net 30?"
 *
 * Neither, until now. The trigger says WHEN money is earned and the PO's
 * payment terms say how long after that it is paid. They are two different
 * facts in two different fields, which is right. What was missing is that
 * only delivery triggers ever got their two halves put together: a PO release
 * milestone fell through to whatever date somebody typed, so the Net 30 on
 * the PO did nothing and the deposit sat outside the cash forecast entirely.
 *
 * The wording matches milestoneTriggered in progress.ts, which has decided
 * for months that these fire on signing. That rule is what earns the money on
 * the billing side; this is the same rule deciding when it is paid.
 */
export function isSigningTrigger(m: PoForecastMilestone): boolean {
  const t = (m.trigger_event ?? m.milestone_name ?? "").toLowerCase();
  if (/commission/.test(t) || /deliver/.test(t)) return false;
  return /signed|po release|deposit|down|mob/.test(t);
}

/** The month a date falls in, as YYYY-MM. Null in, null out. */
function monthOf(iso: string | null): string | null {
  return iso ? iso.slice(0, 7) : null;
}

/** "Line 3 Racking" when both are known, else whichever there is. */
export function lineLabel(line: PoForecastLine): string {
  const no = line.line_no != null ? `Line ${line.line_no}` : null;
  const desc = line.description?.trim() || null;
  if (no && desc) return `${no} ${desc}`;
  return no ?? desc ?? "an item";
}

export function forecastMilestoneDate(input: {
  milestone: PoForecastMilestone;
  po: PoForecastOrder;
  /** The task named by the PO's linked_delivery_task_wbs_code, if found. */
  deliveryTask?: DeliveryTaskDate | null;
  /** The PO's line items, when migration 0062 has run and any are linked. */
  lines?: readonly PoForecastLine[];
  /** Resolves any WBS code to its schedule row. */
  taskOf?: (wbs: string) => DeliveryTaskDate | null | undefined;
}): MilestoneDate {
  const { milestone, po, deliveryTask } = input;
  const typed = milestone.expected_date ?? null;
  const lines = input.lines ?? [];
  const none = { viaWbs: null, viaLine: null, termsDays: 0, supersedes: null } as const;

  if (milestone.paid_at) {
    return { date: milestone.paid_at, source: "paid", ...none };
  }

  const termsDays = netTermsDays(po.payment_terms_summary);
  const moved = (date: string) =>
    typed && monthOf(typed) !== monthOf(date) ? typed : null;

  // A milestone that fires on signing. The signed date is a fact and beats
  // the typed guess the same way a delivery date does. Before it is signed
  // the typed date is somebody's judgement about when that will happen, so
  // it wins over the ordered date, which is only a stand-in.
  if (isSigningTrigger(milestone)) {
    if (po.signed_at) {
      const date = addDaysIso(po.signed_at.slice(0, 10), termsDays);
      return { date, source: "signed", viaWbs: null, viaLine: null, termsDays, supersedes: moved(date) };
    }
    if (typed) return { date: typed, source: "typed", ...none };
    if (po.ordered_date) {
      const date = addDaysIso(po.ordered_date.slice(0, 10), termsDays);
      return { date, source: "ordered", viaWbs: null, viaLine: null, termsDays, supersedes: null };
    }
    return { date: null, source: "none", ...none };
  }

  if (!isDeliveryTrigger(milestone)) {
    return { date: typed, source: typed ? "typed" : "none", ...none };
  }

  const taskFor = (wbs: string | null | undefined): DeliveryTaskDate | null => {
    if (!wbs) return null;
    if (input.taskOf) return input.taskOf(wbs) ?? null;
    // Without a resolver the only task in hand is the PO-level one.
    return deliveryTask?.wbs_code === wbs ? deliveryTask : null;
  };

  // 1. The item this milestone pays for. A PO that pays per delivery says so
  //    on the milestone, and that item's own dates beat everything the order
  //    says about itself.
  const own = milestone.procurement_order_line_id
    ? lines.find((l) => l.id === milestone.procurement_order_line_id)
    : undefined;

  // An item has no arrival date of its own, deliberately. Zarina: "If the
  // delivery date in the schedule is different on when it actually arrives,
  // I will just adjust schedule and not here." A second place to record the
  // same fact is a second place for it to be wrong, and she has been clear
  // that the schedule wins. So an item follows its schedule row and nothing
  // else. The ORDER still carries one, for a PO with no item links at all.
  if (own) {
    const task = taskFor(own.linked_delivery_task_wbs_code);
    if (task?.end_date) {
      const date = addDaysIso(task.end_date, termsDays);
      return {
        date,
        source: "schedule",
        viaWbs: task.wbs_code,
        viaLine: { id: own.id ?? null, label: lineLabel(own) },
        termsDays,
        supersedes: moved(date),
      };
    }
  }

  // 2. The whole order has arrived, or is linked as one delivery. Unchanged
  //    from before 0062, and still right for a PO that comes on one truck.
  if (po.actual_delivery_date) {
    const date = addDaysIso(po.actual_delivery_date, termsDays);
    return { date, source: "arrived", viaWbs: null, viaLine: null, termsDays, supersedes: moved(date) };
  }

  const poTask = po.linked_delivery_task_wbs_code ? (deliveryTask?.end_date ?? null) : null;
  if (poTask) {
    const date = addDaysIso(poTask, termsDays);
    return {
      date,
      source: "schedule",
      viaWbs: deliveryTask?.wbs_code ?? po.linked_delivery_task_wbs_code ?? null,
      viaLine: null,
      termsDays,
      supersedes: moved(date),
    };
  }

  // 3. No link of its own and none on the order, but the items are linked.
  //    A milestone that covers the whole PO is not earned until the last item
  //    lands, so it takes the latest of them. Taking the first would pay for
  //    equipment that is still on a truck.
  const dated = lines
    .map((l) => {
      const task = taskFor(l.linked_delivery_task_wbs_code);
      const end = task?.end_date ?? null;
      return end ? { line: l, wbs: task?.wbs_code ?? null, end } : null;
    })
    .filter((x): x is { line: PoForecastLine; wbs: string | null; end: string } => x !== null);

  if (dated.length > 0) {
    const last = dated.reduce((a, b) => (b.end > a.end ? b : a));
    const date = addDaysIso(last.end, termsDays);
    return {
      date,
      source: "last_line",
      viaWbs: last.wbs,
      viaLine: { id: last.line.id ?? null, label: lineLabel(last.line) },
      termsDays,
      supersedes: moved(date),
    };
  }

  return { date: typed, source: typed ? "typed" : "none", ...none };
}

/**
 * Whether the schedule, not the typed date, is what this milestone runs on.
 *
 * "For the delivery schedule, the source of truth should always be the
 * schedule." When this is true the PO page shows the derived date AS the
 * Expected value and demotes the typed one, rather than printing the typed
 * date in the column and the real one in small grey text underneath. Two
 * dates on one row, with the stale one as the headline, is not a source of
 * truth - it is a choice the reader has to make.
 */
export function scheduleDrivesDate(at: MilestoneDate): boolean {
  return (
    at.source === "schedule" ||
    at.source === "arrived" ||
    at.source === "last_line" ||
    // The signing date is a recorded fact about this PO, the same as an
    // arrival date. The ordered date only ever fills a blank, so nothing is
    // being demoted when it does.
    at.source === "signed" ||
    at.source === "ordered"
  );
}

/** One line for the PO page, under the typed date. */
export function describeMilestoneDate(
  at: MilestoneDate,
  taskName?: string | null,
): string | null {
  const terms = at.termsDays > 0 ? ` plus Net ${at.termsDays}` : "";
  const termsDays = at.termsDays;
  // Which item, when the PO has more than one delivery and this milestone
  // rides on a particular one. Silent on a single-delivery PO.
  const item = at.viaLine ? `, for ${at.viaLine.label}` : "";

  switch (at.source) {
    case "paid":
      return null; // the Paid column already says it
    case "arrived":
      return at.termsDays > 0
        ? `Forecast ${at.date}, delivered${item} plus Net ${at.termsDays}`
        : `Forecast ${at.date}, the recorded delivery date${item}`;
    case "schedule": {
      const via = taskName ? `${at.viaWbs} ${taskName}` : (at.viaWbs ?? "the delivery task");
      return `Forecast ${at.date}, follows ${via}${terms}${item}`;
    }
    case "last_line": {
      // A milestone covering the whole PO is not earned until the last item
      // lands, so say which one it is waiting on.
      const via = at.viaWbs ? `${at.viaWbs}` : "the last delivery";
      return `Forecast ${at.date}, the last item to land${item ? ` (${at.viaLine?.label})` : ""}, follows ${via}${terms}`;
    }
    case "signed":
      return termsDays > 0
        ? `Forecast ${at.date}, PO signed${terms}`
        : `Forecast ${at.date}, the date the PO was signed`;
    case "ordered": {
      // Said plainly, because this one is a stand-in. The money is in the
      // curve on a guess about when the PO gets signed.
      const when = termsDays > 0 ? ` and paid Net ${at.termsDays}` : "";
      return `Forecast ${at.date}, the PO is not signed yet, so this assumes it is signed on the date it was raised${when}`;
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
