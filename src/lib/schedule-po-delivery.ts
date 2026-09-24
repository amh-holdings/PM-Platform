// Completing a delivery on the schedule records it on the purchase order.
//
// The same real event was being entered twice. A truck arrives, somebody marks
// the schedule row Complete, and the AFP does not move - because a procurement
// SOV line takes its value from the PO's payment milestones, and the milestone
// that says "on delivery" fires on procurement_orders.actual_delivery_date,
// which nothing on the schedule page touched.
//
// Zarina: "Once I change the procurement items delivered, does it update the
// AFP billing suggestion?" It did not. Now marking the schedule task complete
// writes the delivery date onto the PO it is linked to, and the AFP picks it
// up the same way it would if the date had been typed on the PO page.
//
// The link is procurement_orders.linked_delivery_task_wbs_code, which already
// existed and is set from the PO page. This only reads it.

export type DeliveryLinkPo = {
  id: string;
  po_number?: string | null;
  vendor_name?: string | null;
  linked_delivery_task_wbs_code?: string | null;
  actual_delivery_date?: string | null;
};

export type DeliveryTaskLike = {
  wbs_code: string;
  task_name?: string | null;
  end_date?: string | null;
};

export function poLabel(po: DeliveryLinkPo): string {
  return po.po_number ?? po.vendor_name ?? "a PO";
}

/**
 * What date the equipment actually arrived, as well as it can be known.
 *
 * The task's own finish is the best evidence there is: it is what the schedule
 * says happened, and on a row being closed out late it is nearer the truth
 * than today. A finish still in the future means it arrived early, so today
 * wins. A row with no finish at all falls back to today.
 *
 * Never a guess beyond that. A date that is wrong is corrected on the PO,
 * where the person can see what it affects.
 */
export function deliveryDateForTask(
  task: DeliveryTaskLike,
  todayIso: string,
): string {
  const end = task.end_date;
  if (!end) return todayIso;
  return end < todayIso ? end : todayIso;
}

export type DeliverySyncPlan = {
  /** POs to stamp with a delivery date. */
  updates: { poId: string; label: string; date: string }[];
  /** Already carried a date, so left exactly as it was. */
  alreadyRecorded: string[];
  /** Completed with no PO pointing at them, so nothing to record. */
  unlinked: string[];
};

/**
 * Which POs a set of just-completed schedule tasks should stamp.
 *
 * Three rules, and the second is the one that matters.
 *
 * A PO that already carries an actual delivery date is never overwritten. That
 * date may already be on an issued AFP, and a schedule row closed out weeks
 * later must not quietly move money. Corrections happen on the PO.
 *
 * Nothing is ever cleared. Un-completing a task leaves the delivery date where
 * it is, because retracting it would pull earned value off a line with no
 * warning. Clearing it is a deliberate act on the PO page.
 *
 * A completed task with no PO linked is reported rather than ignored, so the
 * answer to "why did the AFP not move" is on screen instead of a mystery.
 */
export function planDeliverySync(input: {
  completed: DeliveryTaskLike[];
  pos: DeliveryLinkPo[];
  todayIso: string;
}): DeliverySyncPlan {
  const byWbs = new Map<string, DeliveryLinkPo[]>();
  for (const po of input.pos) {
    const code = po.linked_delivery_task_wbs_code;
    if (!code) continue;
    const list = byWbs.get(code) ?? [];
    list.push(po);
    byWbs.set(code, list);
  }

  const plan: DeliverySyncPlan = { updates: [], alreadyRecorded: [], unlinked: [] };
  const seen = new Set<string>();

  for (const task of input.completed) {
    const linked = byWbs.get(task.wbs_code) ?? [];
    if (linked.length === 0) {
      plan.unlinked.push(task.task_name?.trim() || task.wbs_code);
      continue;
    }
    for (const po of linked) {
      if (seen.has(po.id)) continue;
      seen.add(po.id);
      if (po.actual_delivery_date) {
        plan.alreadyRecorded.push(poLabel(po));
        continue;
      }
      plan.updates.push({
        poId: po.id,
        label: poLabel(po),
        date: deliveryDateForTask(task, input.todayIso),
      });
    }
  }
  return plan;
}

/** One line for the save message, or null when there is nothing to say. */
export function describeDeliverySync(plan: DeliverySyncPlan): string | null {
  const parts: string[] = [];
  if (plan.updates.length) {
    parts.push(
      `Delivery recorded on ${plan.updates.map((u) => `${u.label} (${u.date})`).join(", ")} - the AFP will pick it up.`,
    );
  }
  if (plan.alreadyRecorded.length) {
    parts.push(
      `${plan.alreadyRecorded.join(", ")} already had a delivery date, left as it was.`,
    );
  }
  if (plan.unlinked.length) {
    parts.push(
      `${plan.unlinked.join(", ")} has no PO linked, so nothing reached the AFP. Link it from the PO's Schedule delivery task panel.`,
    );
  }
  return parts.length ? parts.join(" ") : null;
}

/**
 * The nudge after a delivery lands: this PO is on site, is it on the AFP?
 *
 * Stamping the delivery date makes the milestone fire, which moves the
 * suggestion on a procurement SOV line. It does nothing at all for a PO billed
 * by a typed figure through Add to AFP, and nothing for one whose SOV line is
 * not procurement-shaped. In both of those the equipment arrives, the schedule
 * goes green, and the money is still waiting on somebody to remember.
 *
 * Zarina: "I want it to be triggered in the Schedule as well if completed, we
 * will know to add that to AFP."
 *
 * So a PO that just went delivered and has nothing staged on the open
 * application gets named. A PO that already has an amount staged is left
 * alone, because the reminder would be noise and noise is how a message like
 * this stops being read.
 */
export function describeAfpFollowUp(input: {
  delivered: readonly { poId: string; label: string }[];
  /** PO ids that already have an amount staged on the open application. */
  stagedPoIds: readonly string[];
  /** YYYY-MM-01 of the application being assembled. */
  periodMonth: string;
}): string | null {
  const staged = new Set(input.stagedPoIds);
  const waiting = input.delivered.filter((d) => !staged.has(d.poId));
  if (waiting.length === 0) return null;

  const names = waiting.map((w) => w.label).join(", ");
  const period = input.periodMonth.slice(0, 7);
  return waiting.length === 1
    ? `${names} is delivered with nothing on the ${period} application - open it and use Add to AFP if it should be billed this period.`
    : `${names} are delivered with nothing on the ${period} application - open each and use Add to AFP if they should be billed this period.`;
}

// ---------------------------------------------------------------------------
// Which POs the picker offers.
//
// Zarina, looking at the picker inside Edit task: "I dont see all POs here."
// Thirteen were listed. The picker was applying a filter the Procurement tab
// does not: a PO whose status reads cancelled was dropped on the floor, with
// nothing on screen to say so. The reasoning was that nothing is arriving from
// a cancelled PO, which is true and is still not the picker's call to make
// silently - a PO cancelled by mistake, or cancelled and reinstated, simply
// disappeared, and the only way to find that out was to read this file.
//
// So the picker now lists every purchase order on the project and says what
// state each one is in. It also says how many there are, because the useful
// check is against the Procurement tab, and a count that matches ends the
// question in a second.
// ---------------------------------------------------------------------------

export type DeliveryLinkPoRow = DeliveryLinkPo & {
  status?: string | null;
};

export type DeliveryLinkChoice = {
  id: string;
  label: string;
  /** Set when this PO already points at some task, so the picker can say so. */
  linkedWbs: string | null;
  actualDelivery: string | null;
  /** Only set when the state is worth saying out loud. */
  note: string | null;
};

export function deliveryLinkLabel(po: DeliveryLinkPoRow): string {
  return [po.po_number, po.vendor_name].filter(Boolean).join(" - ") || "PO";
}

/**
 * The part of a PO's state a picker should say out loud.
 *
 * Active, complete and delivered are the ordinary run of things and get no
 * annotation - marking every row would just be noise. Cancelled is the one
 * that changes whether linking makes sense, so it is named. Anything else is
 * passed through verbatim rather than swallowed, because status is free text
 * on this table and an unrecognised value is information, not a bug.
 */
export function deliveryLinkNote(status: string | null | undefined): string | null {
  const s = (status ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s === "active" || s === "complete" || s === "delivered") return null;
  return s;
}

export type DeliveryLinkChoices = {
  /** Already pointing at this task. */
  linked: DeliveryLinkChoice[];
  /** Everything else on the project, whatever state it is in. */
  available: DeliveryLinkChoice[];
  /** Every PO on the project, so the picker can be checked against Procurement. */
  total: number;
};

/**
 * Split the project's purchase orders into "delivers this task" and "could".
 *
 * Nothing is dropped. A PO linked to a DIFFERENT task still appears as
 * available, carrying the code it currently points at, because moving a link
 * is a legitimate correction and hiding the option would just mean doing it
 * from the other page instead. A cancelled one appears too, labelled.
 */
export function splitDeliveryLinkChoices(input: {
  pos: readonly DeliveryLinkPoRow[];
  wbsCode: string;
}): DeliveryLinkChoices {
  const linked: DeliveryLinkChoice[] = [];
  const available: DeliveryLinkChoice[] = [];

  for (const po of input.pos) {
    const choice: DeliveryLinkChoice = {
      id: po.id,
      label: deliveryLinkLabel(po),
      linkedWbs: po.linked_delivery_task_wbs_code ?? null,
      actualDelivery: po.actual_delivery_date ?? null,
      note: deliveryLinkNote(po.status),
    };
    if (choice.linkedWbs === input.wbsCode) linked.push(choice);
    else available.push(choice);
  }

  return { linked, available, total: linked.length + available.length };
}

/** The line that makes the picker checkable against the Procurement tab. */
export function describeDeliveryLinkCount(total: number): string {
  if (total === 0) return "No purchase orders on this project yet.";
  const count = total === 1 ? "1 purchase order" : `${total} purchase orders`;
  return `${count} on this project, all listed. A different count on Procurement means the rest are on another project.`;
}
