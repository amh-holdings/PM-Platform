import { cn } from "@/lib/utils";
import {
  complianceSummary,
  describeState,
  worstState,
  type ComplianceRow,
  type ComplianceState,
} from "@/lib/sub-compliance";

export type SubCompliance = {
  subId: string;
  companyName: string;
  rows: ComplianceRow[];
};

type Props = {
  subs: SubCompliance[];
  /** False until migration 0083 lands, so the panel explains itself. */
  enabled: boolean;
};

// Weight as well as colour. A red cell on a page somebody prints or reads in
// sunlight has to survive losing its colour.
const TONE: Record<ComplianceState, string> = {
  ok: "bg-emerald-100 text-emerald-900",
  expiring: "bg-amber-100 text-amber-900",
  undated: "bg-amber-100 text-amber-900 font-semibold",
  expired: "bg-destructive/15 text-destructive font-semibold",
  missing: "bg-destructive/15 text-destructive font-semibold",
};

const SHORT: Record<ComplianceState, string> = {
  ok: "On file",
  expiring: "Expiring",
  undated: "No date",
  expired: "Expired",
  missing: "Missing",
};

export function SubCompliancePanel({ subs, enabled }: Props) {
  if (!enabled) {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        Apply migration 0083 to track COI, W-9 and subcontract status per sub.
        Until then the roster below is unchanged.
      </div>
    );
  }
  if (subs.length === 0) return null;

  const summary = complianceSummary(subs.map((s) => worstState(s.rows)));
  const columns = subs[0].rows;

  return (
    <details open className="overflow-hidden rounded-lg border bg-card shadow-sm">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 border-b bg-muted/30 px-4 py-3 text-sm [&::-webkit-details-marker]:hidden">
        <span className="font-medium">Compliance</span>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-xs font-medium",
            summary.attention > 0
              ? "bg-destructive/15 text-destructive"
              : "bg-emerald-100 text-emerald-900",
          )}
        >
          {summary.attention > 0
            ? `${summary.attention} of ${summary.total} need attention`
            : `All ${summary.total} clear`}
        </span>
      </summary>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr className="border-b">
              <th className="px-4 py-2 font-medium">Subcontractor</th>
              {columns.map((c) => (
                <th key={c.category} className="px-4 py-2 font-medium">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {subs.map((sub) => (
              <tr key={sub.subId} className="hover:bg-muted/30">
                <td className="px-4 py-2.5 font-medium">{sub.companyName}</td>
                {sub.rows.map((row) => (
                  <td key={row.category} className="px-4 py-2.5">
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-2 py-0.5 text-xs",
                        TONE[row.state],
                      )}
                      // The badge is short so the table stays readable; the
                      // detail that makes it actionable is one hover away.
                      title={describeState(row)}
                    >
                      {SHORT[row.state]}
                    </span>
                    {(row.state === "expiring" || row.state === "expired") && (
                      <span className="ml-2 text-[11px] text-muted-foreground">
                        {describeState(row)}
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
        Read from the documents attached to each sub, not from a status
        somebody has to remember to change. Attach a file on the Documents page
        and set its expiry there.
      </p>
    </details>
  );
}
