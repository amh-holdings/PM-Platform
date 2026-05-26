"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import {
  deleteSubcontractor,
  toggleSubcontractorActive,
} from "./subs-actions";
import { STATUS_TONE, statusLabel } from "./subs-constants";
import { SubFormDialog, type SubFormValues } from "./sub-form-dialog";

type SubRow = {
  id: string;
  company_name: string;
  trade: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  contract_value: number | null;
  retainage_pct: number | null;
  coi_status: string | null;
  w9_status: string | null;
  payment_terms: string | null;
  active: boolean | null;
};

type Props = {
  projectId: string;
  subs: SubRow[];
};

export function SubList({ projectId, subs }: Props) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  if (subs.length === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
        No subcontractors yet. Add the first one above.
      </div>
    );
  }

  const handleDelete = async (id: string, companyName: string) => {
    if (!confirm(`Remove ${companyName}? This deletes their record from this project.`)) return;
    setPendingId(id);
    setError(null);
    const result = await deleteSubcontractor(id, projectId);
    setPendingId(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    startTransition(() => router.refresh());
  };

  const handleToggleActive = async (id: string, nextActive: boolean) => {
    setPendingId(id);
    setError(null);
    const result = await toggleSubcontractorActive(id, projectId, nextActive);
    setPendingId(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    startTransition(() => router.refresh());
  };

  const totalContractValue = subs
    .filter((s) => s.active !== false)
    .reduce((sum, s) => sum + (s.contract_value ?? 0), 0);

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}
      <div className="overflow-x-auto rounded-lg border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">Company</th>
              <th className="px-4 py-3 font-medium">Trade</th>
              <th className="px-4 py-3 font-medium">Contact</th>
              <th className="px-4 py-3 font-medium">COI</th>
              <th className="px-4 py-3 font-medium">W9</th>
              <th className="px-4 py-3 text-right font-medium">Contract</th>
              <th className="px-4 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {subs.map((s) => (
              <tr
                key={s.id}
                className={cn(
                  "hover:bg-muted/30",
                  s.active === false && "opacity-60",
                )}
              >
                <td className="px-4 py-3">
                  <div className="font-medium">{s.company_name}</div>
                  {s.active === false && (
                    <div className="text-xs text-muted-foreground">Inactive</div>
                  )}
                </td>
                <td className="px-4 py-3 text-muted-foreground">{s.trade ?? "-"}</td>
                <td className="px-4 py-3 text-muted-foreground">
                  {s.contact_name ?? "-"}
                  {s.contact_email && (
                    <div className="text-xs">{s.contact_email}</div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                      STATUS_TONE[s.coi_status ?? "pending"] ?? "bg-muted text-muted-foreground",
                    )}
                  >
                    {statusLabel(s.coi_status)}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                      STATUS_TONE[s.w9_status ?? "pending"] ?? "bg-muted text-muted-foreground",
                    )}
                  >
                    {statusLabel(s.w9_status)}
                  </span>
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                  {formatCurrency(s.contract_value)}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex justify-end gap-1">
                    <SubFormDialog
                      projectId={projectId}
                      initial={subFormFromRow(s)}
                      trigger={
                        <Button variant="ghost" size="sm" disabled={pendingId === s.id}>
                          Edit
                        </Button>
                      }
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleToggleActive(s.id, !(s.active ?? true))}
                      disabled={pendingId === s.id}
                    >
                      {s.active === false ? "Reactivate" : "Deactivate"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(s.id, s.company_name)}
                      disabled={pendingId === s.id}
                    >
                      Delete
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
          {totalContractValue > 0 && (
            <tfoot className="border-t bg-muted/20">
              <tr>
                <td colSpan={5} className="px-4 py-2 text-right text-xs uppercase tracking-wide text-muted-foreground">
                  Active subs total
                </td>
                <td className="px-4 py-2 text-right text-sm font-medium tabular-nums">
                  {formatCurrency(totalContractValue)}
                </td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

function subFormFromRow(s: SubRow): SubFormValues {
  return {
    id: s.id,
    company_name: s.company_name,
    trade: s.trade,
    contact_name: s.contact_name,
    contact_email: s.contact_email,
    contact_phone: s.contact_phone,
    contract_value: s.contract_value,
    retainage_pct: s.retainage_pct,
    coi_status: s.coi_status,
    w9_status: s.w9_status,
    payment_terms: s.payment_terms,
  };
}
