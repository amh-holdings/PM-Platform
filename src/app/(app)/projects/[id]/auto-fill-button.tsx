"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  applyProjectFields,
  extractProjectDetails,
  type ExtractedProjectFields,
} from "./extract-actions";

type CurrentValues = {
  client: string | null;
  contract_value: number | null;
  ntp_date: string | null;
  cod_date: string | null;
  zip_code: string | null;
};

type Props = {
  projectId: string;
  current: CurrentValues;
};

type ApplicableField = {
  key: keyof CurrentValues;
  label: string;
  format: (v: string | number | null) => string;
};

const APPLICABLE_FIELDS: ApplicableField[] = [
  { key: "client", label: "Client", format: (v) => (v == null ? "-" : String(v)) },
  {
    key: "contract_value",
    label: "Contract value",
    format: (v) =>
      v == null
        ? "-"
        : new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: "USD",
            maximumFractionDigits: 0,
          }).format(Number(v)),
  },
  { key: "ntp_date", label: "NTP date", format: (v) => (v == null ? "-" : String(v)) },
  { key: "cod_date", label: "COD date", format: (v) => (v == null ? "-" : String(v)) },
  { key: "zip_code", label: "Zip code", format: (v) => (v == null ? "-" : String(v)) },
];

const READONLY_FIELDS: { label: string; getValue: (f: ExtractedProjectFields) => string }[] = [
  {
    label: "LD rate ($/MWDC/day)",
    getValue: (f) => (f.ld_rate_per_mwdc_per_day == null ? "-" : `$${f.ld_rate_per_mwdc_per_day}`),
  },
  {
    label: "Retainage",
    getValue: (f) => (f.retainage_pct == null ? "-" : `${f.retainage_pct}%`),
  },
  {
    label: "LD cap",
    getValue: (f) => (f.ld_cap_pct == null ? "-" : `${f.ld_cap_pct}% of contract`),
  },
];

export function AutoFillButton({ projectId, current }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [extracted, setExtracted] = useState<ExtractedProjectFields | null>(null);
  const [sources, setSources] = useState<string[]>([]);
  const [selected, setSelected] = useState<Record<keyof CurrentValues, boolean>>({
    client: true,
    contract_value: true,
    ntp_date: true,
    cod_date: true,
    zip_code: true,
  });
  const [, startTransition] = useTransition();

  const runExtraction = async () => {
    setLoading(true);
    setError(null);
    setExtracted(null);
    setOpen(true);
    const result = await extractProjectDetails(projectId);
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setExtracted(result.fields);
    setSources(result.source_documents);
  };

  const applySelected = async () => {
    if (!extracted) return;
    setLoading(true);
    setError(null);
    const update: {
      client?: string | null;
      contract_value?: number | null;
      ntp_date?: string | null;
      cod_date?: string | null;
      zip_code?: string | null;
    } = {};
    if (selected.client) update.client = extracted.client;
    if (selected.contract_value) update.contract_value = extracted.contract_value;
    if (selected.ntp_date) update.ntp_date = extracted.ntp_date;
    if (selected.cod_date) update.cod_date = extracted.cod_date;
    if (selected.zip_code) update.zip_code = extracted.zip_code;
    const result = await applyProjectFields(projectId, update);
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOpen(false);
    setExtracted(null);
    startTransition(() => router.refresh());
  };

  return (
    <>
      <Button variant="outline" onClick={runExtraction} disabled={loading}>
        {loading ? "Extracting..." : "Auto-fill from prime contract"}
      </Button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-background p-6 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold">Auto-fill from prime contract</h3>
                <p className="text-xs text-muted-foreground">
                  Claude read the prime contract and suggested values. Uncheck any you don&apos;t
                  want applied.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                Close
              </button>
            </div>

            {loading && !extracted && (
              <div className="my-8 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-current" />
                Reading the contract...
              </div>
            )}

            {error && (
              <div className="my-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            )}

            {extracted && (
              <div className="mt-4 space-y-4">
                {sources.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Source: {sources.join(", ")}
                  </p>
                )}

                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Apply to project fields
                  </p>
                  <div className="overflow-hidden rounded-md border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <tr>
                          <th className="w-10 px-3 py-2"></th>
                          <th className="px-3 py-2 font-medium">Field</th>
                          <th className="px-3 py-2 font-medium">Current</th>
                          <th className="px-3 py-2 font-medium">Suggested</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {APPLICABLE_FIELDS.map((f) => {
                          const currentVal = current[f.key];
                          const newVal = extracted[f.key];
                          const same =
                            currentVal == null
                              ? newVal == null
                              : String(currentVal) === String(newVal);
                          return (
                            <tr key={f.key}>
                              <td className="px-3 py-2">
                                <input
                                  type="checkbox"
                                  checked={selected[f.key]}
                                  onChange={(e) =>
                                    setSelected((prev) => ({ ...prev, [f.key]: e.target.checked }))
                                  }
                                />
                              </td>
                              <td className="px-3 py-2 font-medium">{f.label}</td>
                              <td className="px-3 py-2 text-muted-foreground">
                                {f.format(currentVal)}
                              </td>
                              <td
                                className={cn(
                                  "px-3 py-2 tabular-nums",
                                  newVal == null && "text-muted-foreground",
                                  !same && newVal != null && "font-medium",
                                )}
                              >
                                {f.format(newVal as string | number | null)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Also extracted (not stored on the project row yet)
                  </p>
                  <div className="overflow-hidden rounded-md border bg-muted/20">
                    <table className="w-full text-sm">
                      <tbody className="divide-y">
                        {READONLY_FIELDS.map((f) => (
                          <tr key={f.label}>
                            <td className="px-3 py-2 font-medium">{f.label}</td>
                            <td className="px-3 py-2 tabular-nums text-muted-foreground">
                              {f.getValue(extracted)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    These values stay accessible to the chat. Tell me when you want
                    structured columns for them.
                  </p>
                </div>

                {extracted.notes && (
                  <div className="rounded-md border bg-card p-3 text-xs">
                    <p className="font-medium uppercase tracking-wide text-muted-foreground">
                      Claude&apos;s notes
                    </p>
                    <p className="mt-1 text-sm">{extracted.notes}</p>
                  </div>
                )}

                <div className="flex justify-end gap-2 border-t pt-4">
                  <Button variant="ghost" onClick={() => setOpen(false)} disabled={loading}>
                    Cancel
                  </Button>
                  <Button onClick={applySelected} disabled={loading}>
                    {loading ? "Applying..." : "Apply selected"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
