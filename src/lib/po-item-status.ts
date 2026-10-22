// Where each item on a PO stands, read off the schedule row it lands on.
//
// Phil: "since the po is linked to the schedule why not add a status for each
// item to the PO". Each item already points at a delivery row (migration
// 0062), and an item left unlinked follows the whole-order row. That row's
// status is the item's status. Nothing is stored on the item itself, on
// purpose - Zarina: "If the delivery date in the schedule is different on when
// it actually arrives, I will just adjust schedule and not here." One fact,
// one place, and the schedule row is it.

export type ItemDeliveryTask = {
  wbsCode: string;
  status: string | null;
  pctComplete: number | null;
  endDate: string | null;
};

export type PoItemStatus =
  | { kind: "delivered"; label: string }
  | { kind: "late"; label: string }
  | { kind: "due"; label: string }
  | { kind: "unlinked"; label: string };

function shortDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const name = names[(m ?? 0) - 1];
  return name && d && y ? `${name} ${d}, ${y}` : iso;
}

/**
 * Delivered when the row is Complete or at 100%, the same test the schedule
 * engine uses for a finished task. Otherwise late once its finish has passed,
 * and due until then. No row at all says so rather than guessing.
 */
export function poItemStatus(
  task: ItemDeliveryTask | null,
  todayIso: string,
): PoItemStatus {
  if (!task) return { kind: "unlinked", label: "No schedule row" };
  const done =
    (task.status ?? "").trim() === "Complete" || Number(task.pctComplete ?? 0) >= 100;
  if (done) {
    return {
      kind: "delivered",
      label: task.endDate ? `Delivered ${shortDate(task.endDate)}` : "Delivered",
    };
  }
  if (task.endDate && task.endDate.slice(0, 10) < todayIso) {
    return { kind: "late", label: `Late, planned ${shortDate(task.endDate)}` };
  }
  return {
    kind: "due",
    label: task.endDate ? `Due ${shortDate(task.endDate)}` : "Not delivered",
  };
}

export const PO_ITEM_STATUS_TONE: Record<PoItemStatus["kind"], string> = {
  delivered: "bg-emerald-100 text-emerald-900",
  late: "bg-amber-100 text-amber-900",
  due: "bg-muted text-muted-foreground",
  unlinked: "bg-muted text-muted-foreground",
};
