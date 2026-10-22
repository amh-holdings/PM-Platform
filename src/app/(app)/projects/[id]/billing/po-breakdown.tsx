import { formatCurrency, formatDate } from "@/lib/format";
import type { BillPoDetail } from "@/lib/bill-po-detail";

// The POs and equipment behind a procurement line, as sub-rows under it.
// Always open: on a procurement line this IS the answer to "what are we
// billing for", not a detail to go looking for.
export function PoBreakdown({ details }: { details: BillPoDetail[] }) {
  if (details.length === 0) return null;
  return (
    <div className="mt-1 space-y-1.5 border-l-2 border-emerald-500/30 pl-2 text-[10px]">
      {details.map((po) => (
        <div key={po.poId}>
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-medium text-foreground">
              {po.label}
              {po.vendor && (
                <span className="font-normal text-muted-foreground"> - {po.vendor}</span>
              )}
            </span>
            <span className="tabular-nums font-medium text-emerald-700">
              {formatCurrency(po.amount)}
            </span>
          </div>
          {po.itemsRecorded ? (
            <ul className="mt-0.5 space-y-0.5">
              {po.items.map((item) => (
                <li
                  key={item.id}
                  className="flex items-baseline justify-between gap-2 pl-2"
                >
                  <span>
                    {item.description}
                    {item.quantity != null && (
                      <span className="text-muted-foreground">
                        {" "}
                        ({item.quantity}
                        {item.units ? ` ${item.units}` : ""})
                      </span>
                    )}
                    <span
                      className={
                        item.deliveredOn ? "text-emerald-700" : "text-amber-700"
                      }
                    >
                      {" "}
                      {item.deliveredOn
                        ? `Delivered ${formatDate(item.deliveredOn)}`
                        : "Not delivered"}
                    </span>
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {formatCurrency(item.share)}
                  </span>
                </li>
              ))}
              {po.otherItemCount > 0 && (
                <li className="pl-2 text-muted-foreground">
                  {po.otherItemCount} other item{po.otherItemCount === 1 ? "" : "s"} on
                  this PO not billed here
                </li>
              )}
            </ul>
          ) : (
            <div className="mt-0.5 pl-2 text-muted-foreground">
              Whole PO, no items ticked. Tick them on the PO&apos;s Add to AFP to
              name the equipment.
            </div>
          )}
          {po.billedEarlier > 0 && (
            <div className="mt-0.5 pl-2 font-medium text-amber-700">
              ⚠ {formatCurrency(po.billedEarlier)} already billed on this PO
              {po.earlierAfps.length
                ? ` (AFP ${po.earlierAfps.join(", ")})`
                : ""}
              {po.poTotal != null && ` of ${formatCurrency(po.poTotal)}`}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
