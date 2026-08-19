import Link from "next/link";

import { cn } from "@/lib/utils";
import { periodLabel } from "@/lib/billing-period";

// Which month the AFP bills.
//
// The panel used to be pinned to "current month + next month", which both mixed
// two months into one application and made a closed month unbillable: assembling
// August's AFP on 3 September found August already out of range. AFPs bill in
// arrears, so the default here is the last full month and the PM can step back
// to catch up a month that was missed.

const MONTHS_BACK = 6;
const MONTHS_FORWARD = 1;

export function BillingPeriodSelector({
  projectId,
  selected,
}: {
  projectId: string;
  selected: string;
}) {
  const now = new Date();
  const options: string[] = [];
  for (let i = MONTHS_BACK; i >= -MONTHS_FORWARD; i--) {
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth() - i, 1));
    options.push(
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`,
    );
  }
  // A period reached by URL that falls outside the window still shows up.
  if (!options.includes(selected)) options.push(selected);
  options.sort();

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-xs font-medium text-muted-foreground">
        Billing period
      </span>
      {options.map((p) => (
        <Link
          key={p}
          href={`/projects/${projectId}/billing?period=${p}`}
          className={cn(
            "rounded-md border px-2 py-1 text-xs transition-colors",
            p === selected
              ? "border-emerald-500 bg-emerald-500/10 font-medium text-emerald-700"
              : "border-input text-muted-foreground hover:bg-muted",
          )}
        >
          {periodLabel(p)}
        </Link>
      ))}
    </div>
  );
}
