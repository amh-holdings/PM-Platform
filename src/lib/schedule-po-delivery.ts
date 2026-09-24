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
