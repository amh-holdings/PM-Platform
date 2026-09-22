"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import type { ParsedGrid } from "@/lib/schedule-edit";
import type { SheetSummary } from "@/lib/schedule-workbook";
import {
  MILESTONE_COLUMN_KEYS,
  PO_COLUMN_KEYS,
  PO_COLUMN_LABELS,
  PO_HEADER_RULE,
  buildPoRows,
  diffProcurement,
  guessPoColumns,
  parsePoGrid,
  planFromPoDiff,
  type DeliveryTask,
  type ExistingOrder,
  type MilestoneValues,
  type PoColumnKey,
} from "@/lib/procurement-import";
import { applyProcurementImport } from "../procurement-actions";

type Props = {
  projectId: string;
  existing: ExistingOrder[];
  tasks: DeliveryTask[];
  trigger: React.ReactNode;
};

type Step = "paste" | "map" | "review";

// The workbook is read in the browser, so nothing leaves the machine until the
// diff is applied. The cap is here because a 40 MB workbook opened on a tablet
// in a site trailer locks the tab, and saying so beats a white screen.
const MAX_FILE_BYTES = 25 * 1024 * 1024;

const SPREADSHEET_RE = /\.(xlsx|xlsm|xls)$/i;
const TEXT_RE = /\.(csv|tsv|txt)$/i;

// Which tab of a workbook to land on.
const PO_SHEET_RE = /procure|purchase|po\b|vendor|equipment|buyout|commit/i;

const SAMPLE = `PO Number\tVendor\tDescription\tPO Total\tOrdered\tExpected Delivery\tMilestone\t%\tMilestone Due\tPaid Date
PO-018\tFTC Solar\tPiles and racking\t412,000.00\t07/03/26\t10/29/26\tDeposit\t30\t07/10/26\t07/12/26
PO-018\t\t\t\t\t\tRelease to ship\t60\t10/01/26\t
PO-018\t\t\t\t\t\tFinal\t10\t11/15/26\t
PO-019\tMaddox\t1500kVA transformer\t96,100.00\t06/26/25\t11/13/26\tDeposit\t50\t07/01/25\t07/03/25`;

const MILESTONE_SET = new Set<PoColumnKey>(MILESTONE_COLUMN_KEYS);

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === "") return "-";
  return String(v);
}

const MONEY_FIELDS = new Set(["total_value", "amount", "paid_amount", "milestone_amount"]);

function fmtField(field: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "-";
  if (MONEY_FIELDS.has(field)) return formatCurrency(Number(v));
  if (field === "pct_of_total") return `${Number(v)}%`;
  return String(v);
}

function milestoneLabel(field: keyof MilestoneValues): string {
  switch (field) {
    case "pct_of_total":
      return "Milestone %";
    case "trigger_event":
      return "Trigger event";
    case "expected_date":
      return "Milestone due";
    case "amount":
      return "Milestone amount";
    case "paid_at":
      return "Paid date";
    case "paid_amount":
      return "Paid amount";
    case "notes":
      return "Milestone notes";
    default:
      return String(field);
  }
}

export function ProcurementImportDialog({ projectId, existing, tasks, trigger }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("paste");
  const [text, setText] = useState("");
  const [sheets, setSheets] = useState<SheetSummary[] | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [fileName, setFileName] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [grid, setGrid] = useState<ParsedGrid | null>(null);
  const [mapping, setMapping] = useState<(PoColumnKey | null)[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [, startTransition] = useTransition();

  const built = useMemo(
    () => (grid ? buildPoRows(grid, mapping) : null),
    [grid, mapping],
  );
  const diff = useMemo(
    () => (built ? diffProcurement(existing, built, mapping, tasks) : null),
    [built, existing, mapping, tasks],
  );

  function clearFile() {
    setSheets(null);
    setSheetIndex(0);
    setFileName(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  function reset() {
    setStep("paste");
    setText("");
    clearFile();
    setGrid(null);
    setMapping([]);
    setError(null);
    setResult(null);
  }

  // The only asynchronous step, and the only place xlsx is pulled in. A
  // dynamic import keeps ~900 KB of spreadsheet parser out of the procurement
  // page for everyone who never opens this dialog.
  async function loadFile(file: File) {
    setError(null);
    setResult(null);

    if (file.size > MAX_FILE_BYTES) {
      setError(
        `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. Export just the procurement rows, or paste them instead.`,
      );
      return;
    }

    // A .csv or .tsv is text. Put it in the box rather than hiding it behind a
    // file name, so what is about to be imported is on screen and editable.
    if (TEXT_RE.test(file.name)) {
      try {
        const body = await file.text();
        clearFile();
        setText(body);
        setFileName(file.name);
      } catch {
        setError(`Could not read ${file.name}.`);
      }
      return;
    }

    if (!SPREADSHEET_RE.test(file.name)) {
      setError(
        `${file.name} is not a spreadsheet. Use .xlsx, .xls, .csv or paste the rows.`,
      );
      return;
    }

    setReading(true);
    try {
      const [buf, mod] = await Promise.all([
        file.arrayBuffer(),
        import("@/lib/schedule-workbook"),
      ]);
      const parsed = mod.readWorkbook(buf);
      const usable = parsed.filter((sh) => sh.filledRows > 0);
      if (!usable.length) {
        setError(`${file.name} has no rows in any sheet.`);
        return;
      }
      setText("");
      setSheets(usable);
      setSheetIndex(mod.defaultSheetIndex(usable, PO_SHEET_RE));
      setFileName(file.name);
    } catch (e) {
      setError(
        `Could not read ${file.name}. ${
          e instanceof Error
            ? e.message
            : "The file may be password protected or not a real workbook."
        }`,
      );
    } finally {
      setReading(false);
    }
  }

  async function doParse() {
    setError(null);

    let g: ParsedGrid;
    if (sheets) {
      const mod = await import("@/lib/schedule-workbook");
      g = mod.gridFromSheet(sheets[sheetIndex], PO_HEADER_RULE);
    } else {
      g = parsePoGrid(text);
    }

    if (!g.rows.length) {
      setError(
        sheets
          ? `Sheet "${sheets[sheetIndex].name}" has no rows below its header.`
          : "Nothing to read. Paste rows copied from Excel, or choose a file.",
      );
      return;
    }
    setGrid(g);
    setMapping(guessPoColumns(g.headers, g.rows));
    setStep("map");
  }

  async function apply() {
    if (!diff) return;
    setSubmitting(true);
    setError(null);
    const res = await applyProcurementImport(projectId, planFromPoDiff(diff));
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const payments = res.milestonesAdded + res.milestonesChanged;
    setResult(
      `${res.added} purchase order${res.added === 1 ? "" : "s"} added, ${res.changed} updated` +
        (payments
          ? `, ${res.milestonesAdded} payment${res.milestonesAdded === 1 ? "" : "s"} added and ${res.milestonesChanged} updated.`
          : "."),
    );
    startTransition(() => router.refresh());
  }

  const rowIssues = built?.rows.filter((r) => r.issues.length) ?? [];
  const milestoneIssues =
    built?.rows.flatMap((r) =>
      r.milestones
        .filter((m) => m.issues.length)
        .map((m) => ({ po: r.poNumber, ...m })),
    ) ?? [];
  const changeCount =
    (diff?.adds.length ?? 0) +
    (diff?.changes.length ?? 0) +
    (diff?.milestoneAdds.length ?? 0) +
    (diff?.milestoneChanges.length ?? 0);
  const addedValue = (diff?.adds ?? []).reduce(
    (s, r) => s + Number(r.values.total_value ?? 0),
    0,
  );

  return (
    <>
      <span onClick={() => setOpen(true)} className="inline-block">
        {trigger}
      </span>
      {!open ? null : (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="my-8 w-full max-w-5xl rounded-lg bg-background p-6 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold">Import purchase orders</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Drop in a procurement log, or paste straight out of Excel.
                  One row per PO, or one row per payment with the PO number
                  repeated - both are read. The file is read here in the
                  browser and nothing is written until you have seen the diff.
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

            <div className="mt-4 flex items-center gap-2 text-xs">
              {(["paste", "map", "review"] as Step[]).map((s, i) => (
                <span key={s} className="flex items-center gap-2">
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 font-medium",
                      step === s
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {i + 1}.{" "}
                    {s === "paste" ? "Paste" : s === "map" ? "Map columns" : "Review"}
                  </span>
                  {i < 2 && <span className="text-muted-foreground">→</span>}
                </span>
              ))}
            </div>

            {/* ---------------------------------------------------- paste -- */}
            {step === "paste" && (
              <div className="mt-4 space-y-4">
                <input
                  ref={fileInput}
                  type="file"
                  accept=".xlsx,.xlsm,.xls,.csv,.tsv,.txt"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void loadFile(f);
                  }}
                />

                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    const f = e.dataTransfer.files?.[0];
                    if (f) void loadFile(f);
                  }}
                  className={cn(
                    "rounded-lg border border-dashed p-4 text-center transition-colors",
                    dragging ? "border-primary bg-primary/5" : "border-input",
                  )}
                >
                  {reading ? (
                    <p className="text-sm text-muted-foreground">
                      Reading {fileName ?? "file"}...
                    </p>
                  ) : sheets ? (
                    <div className="space-y-3 text-left">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm">
                          <span className="font-medium">{fileName}</span>
                          <span className="text-muted-foreground">
                            {" "}
                            - {sheets.length} sheet{sheets.length === 1 ? "" : "s"}
                          </span>
                        </p>
                        <button
                          type="button"
                          onClick={() => {
                            clearFile();
                            setError(null);
                          }}
                          className="text-xs text-muted-foreground underline hover:text-foreground"
                        >
                          Remove
                        </button>
                      </div>
                      {sheets.length > 1 && (
                        <div className="space-y-1">
                          <Label htmlFor="po-sheet">Sheet to import</Label>
                          <select
                            id="po-sheet"
                            value={sheetIndex}
                            onChange={(e) => setSheetIndex(Number(e.target.value))}
                            className="h-9 w-full max-w-sm rounded-md border border-input bg-background px-2 text-sm"
                          >
                            {sheets.map((sh, i) => (
                              <option key={sh.name} value={i}>
                                {sh.name} ({sh.filledRows} row
                                {sh.filledRows === 1 ? "" : "s"})
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                      <SheetPeek sheet={sheets[sheetIndex]} />
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => fileInput.current?.click()}
                      >
                        Choose a spreadsheet
                      </Button>
                      <p className="text-[11px] text-muted-foreground">
                        or drag one here - .xlsx, .xlsm, .xls, .csv. Merged
                        title rows, blank spacer columns and formula results
                        are handled, and a zero written as a dash reads as
                        zero.
                      </p>
                    </div>
                  )}
                </div>

                {!sheets && (
                  <div className="space-y-2">
                    <Label htmlFor="po-paste">
                      {fileName ? `Rows from ${fileName}` : "Pasted rows"}
                    </Label>
                    <textarea
                      id="po-paste"
                      value={text}
                      onChange={(e) => {
                        setText(e.target.value);
                        setFileName(null);
                      }}
                      rows={12}
                      spellCheck={false}
                      placeholder={SAMPLE}
                      className="w-full rounded-md border border-input bg-background p-3 font-mono text-xs"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Include the header row if you have one. Total rows are
                      recognised and skipped rather than imported as POs.
                    </p>
                  </div>
                )}

                {error && <Problem>{error}</Problem>}

                <div className="flex justify-end gap-2 border-t pt-4">
                  <Button variant="ghost" onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    onClick={() => void doParse()}
                    disabled={reading || (!sheets && !text.trim())}
                  >
                    Read rows
                  </Button>
                </div>
              </div>
            )}

            {/* ------------------------------------------------------ map -- */}
            {step === "map" && grid && (
              <div className="mt-4 space-y-4">
                <p className="text-sm text-muted-foreground">
                  {grid.rows.length} row{grid.rows.length === 1 ? "" : "s"},{" "}
                  {mapping.length} column{mapping.length === 1 ? "" : "s"},{" "}
                  {grid.delimiter === "cells"
                    ? `from ${fileName ?? "the workbook"}${
                        sheets && sheets.length > 1 ? ` / ${sheets[sheetIndex].name}` : ""
                      }`
                    : `${grid.delimiter} separated`}
                  {grid.headers ? ", header row detected" : ", no header row detected"}.
                  Set anything you do not want to import to Ignore. Map a
                  milestone column and the rows group by PO number, one payment
                  each.
                </p>

                <div className="overflow-x-auto rounded-lg border">
                  <table className="w-full text-xs">
                    <thead className="border-b bg-muted/40">
                      <tr>
                        {mapping.map((_, i) => (
                          <th key={i} className="min-w-[10rem] p-2 text-left align-top">
                            <div className="truncate font-medium">
                              {grid.headers?.[i] || `Column ${i + 1}`}
                            </div>
                            <select
                              value={mapping[i] ?? ""}
                              onChange={(e) => {
                                const v = (e.target.value || null) as PoColumnKey | null;
                                setMapping((prev) =>
                                  // A field can only come from one column.
                                  // Taking it here releases it wherever it was.
                                  prev.map((m, j) => (j === i ? v : v && m === v ? null : m)),
                                );
                              }}
                              className={cn(
                                "mt-1 h-8 w-full rounded border border-input bg-background px-1 text-xs",
                                mapping[i] &&
                                  MILESTONE_SET.has(mapping[i]!) &&
                                  "border-blue-400 bg-blue-50",
                              )}
                            >
                              <option value="">Ignore</option>
                              <optgroup label="Purchase order">
                                {PO_COLUMN_KEYS.filter((k) => !MILESTONE_SET.has(k)).map(
                                  (k) => (
                                    <option key={k} value={k}>
                                      {PO_COLUMN_LABELS[k]}
                                    </option>
                                  ),
                                )}
                              </optgroup>
                              <optgroup label="Payment milestone">
                                {MILESTONE_COLUMN_KEYS.map((k) => (
                                  <option key={k} value={k}>
                                    {PO_COLUMN_LABELS[k]}
                                  </option>
                                ))}
                              </optgroup>
                            </select>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {grid.rows.slice(0, 5).map((r, ri) => (
                        <tr key={ri}>
                          {mapping.map((m, ci) => (
                            <td
                              key={ci}
                              className={cn(
                                "max-w-[14rem] truncate p-2",
                                !m && "text-muted-foreground/50",
                              )}
                            >
                              {r[ci] || ""}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {!mapping.includes("po_number") && (
                  <Problem>
                    No column is mapped to PO number. Every purchase order is
                    matched on it.
                  </Problem>
                )}
                {!mapping.includes("vendor_name") && (
                  <Note>
                    No vendor column mapped. POs already on the project keep the
                    vendor they have, but a PO that is new cannot be added
                    without one.
                  </Note>
                )}
                {built?.hasMilestones && !mapping.includes("milestone_name") && (
                  <Problem>
                    Milestone columns are mapped but Milestone is not. A payment
                    is matched on its name, so map the column that names each
                    one.
                  </Problem>
                )}

                {built?.notes.map((n) => <Note key={n}>{n}</Note>)}

                <div className="flex justify-end gap-2 border-t pt-4">
                  <Button variant="ghost" onClick={() => setStep("paste")}>
                    Back
                  </Button>
                  <Button
                    onClick={() => setStep("review")}
                    disabled={
                      !mapping.includes("po_number") ||
                      (!!built?.hasMilestones && !mapping.includes("milestone_name"))
                    }
                  >
                    Preview changes
                  </Button>
                </div>
              </div>
            )}

            {/* --------------------------------------------------- review -- */}
            {step === "review" && diff && built && (
              <div className="mt-4 space-y-4">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                  <Tally label="New POs" value={diff.adds.length} tone="emerald" />
                  <Tally label="POs updated" value={diff.changes.length} tone="blue" />
                  <Tally
                    label="New payments"
                    value={
                      diff.milestoneAdds.length +
                      diff.adds.reduce((s, a) => s + a.milestones.length, 0)
                    }
                    tone="emerald"
                  />
                  <Tally label="Unchanged" value={diff.unchangedCount} />
                  <Tally
                    label="Not importable"
                    value={built.rejected.length}
                    tone="destructive"
                  />
                </div>

                {diff.adds.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    New purchase orders commit {formatCurrency(addedValue)}.
                  </p>
                )}

                <Note>
                  Nothing is deleted by an import. A PO or a payment already on
                  the project that is missing from this sheet is left alone -
                  remove either with its own Delete.
                </Note>

                {built.notes.map((n) => <Note key={n}>{n}</Note>)}
                {diff.warnings.map((w) => <Warn key={w}>{w}</Warn>)}
                {diff.blocking.map((b) => <Problem key={b}>{b}</Problem>)}

                {built.rejected.length > 0 && (
                  <details className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
                    <summary className="cursor-pointer font-medium text-destructive">
                      {built.rejected.length} row
                      {built.rejected.length === 1 ? "" : "s"} cannot be imported
                    </summary>
                    <ul className="mt-2 space-y-1">
                      {built.rejected.slice(0, 25).map((r) => (
                        <li key={`${r.rowNumber}-${r.label}`}>
                          Row {r.rowNumber} ({r.label}): {r.reason}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2 text-muted-foreground">
                      Everything else still imports. These are listed rather
                      than dropped quietly - a PO silently lost off a
                      procurement log is cost the forecast never sees.
                    </p>
                  </details>
                )}

                {(rowIssues.length > 0 || milestoneIssues.length > 0) && (
                  <details className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                    <summary className="cursor-pointer font-medium">
                      {rowIssues.length + milestoneIssues.length} row
                      {rowIssues.length + milestoneIssues.length === 1 ? "" : "s"} with
                      values that could not be read
                    </summary>
                    <ul className="mt-2 space-y-1">
                      {rowIssues.slice(0, 25).map((r) => (
                        <li key={`po-${r.rowNumber}`}>
                          Row {r.rowNumber} ({r.poNumber}): {r.issues.join("; ")}
                        </li>
                      ))}
                      {milestoneIssues.slice(0, 25).map((m) => (
                        <li key={`ms-${m.rowNumber}`}>
                          Row {m.rowNumber} ({m.po}, {m.values.milestone_name}):{" "}
                          {m.issues.join("; ")}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2">
                      These rows still import. A value that could not be read is
                      left as it was rather than guessed.
                    </p>
                  </details>
                )}

                {diff.adds.length > 0 && (
                  <Section
                    title={`${diff.adds.length} new purchase order${diff.adds.length === 1 ? "" : "s"}`}
                  >
                    <table className="w-full text-xs">
                      <thead className="bg-muted/40 text-left">
                        <tr>
                          <th className="p-2 font-medium">PO</th>
                          <th className="p-2 font-medium">Vendor</th>
                          <th className="p-2 font-medium">Description</th>
                          <th className="p-2 text-right font-medium">Total</th>
                          <th className="p-2 font-medium">Expected</th>
                          <th className="p-2 text-right font-medium">Payments</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {diff.adds.map((r) => (
                          <tr key={r.poNumber}>
                            <td className="p-2 font-mono">{r.poNumber}</td>
                            <td className="p-2">{fmt(r.values.vendor_name)}</td>
                            <td className="max-w-[16rem] truncate p-2">
                              {fmt(r.values.description)}
                            </td>
                            <td className="p-2 text-right font-mono">
                              {r.values.total_value == null
                                ? "-"
                                : formatCurrency(r.values.total_value)}
                            </td>
                            <td className="p-2">
                              {fmt(r.values.expected_delivery_date)}
                              {r.values.linked_delivery_task_wbs_code && (
                                <span className="ml-1 text-[10px] text-muted-foreground">
                                  from {r.values.linked_delivery_task_wbs_code}
                                </span>
                              )}
                            </td>
                            <td className="p-2 text-right tabular-nums">
                              {r.milestones.length || "-"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Section>
                )}

                {diff.changes.length > 0 && (
                  <Section
                    title={`${diff.changes.length} purchase order${diff.changes.length === 1 ? "" : "s"} updated`}
                  >
                    <table className="w-full text-xs">
                      <thead className="bg-muted/40 text-left">
                        <tr>
                          <th className="p-2 font-medium">PO</th>
                          <th className="p-2 font-medium">Vendor</th>
                          <th className="p-2 font-medium">Field</th>
                          <th className="p-2 font-medium">From</th>
                          <th className="p-2 font-medium">To</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {diff.changes.flatMap((c) =>
                          c.fields.map((f, i) => (
                            <tr key={`${c.existing.id}-${f.field}`}>
                              <td className="p-2 font-mono">
                                {i === 0 ? c.row.poNumber : ""}
                              </td>
                              <td className="max-w-[12rem] truncate p-2">
                                {i === 0 ? c.existing.vendor_name : ""}
                              </td>
                              <td className="p-2">{PO_COLUMN_LABELS[f.field]}</td>
                              <td className="p-2 text-muted-foreground line-through">
                                {fmtField(f.field, f.from)}
                              </td>
                              <td className="p-2 font-medium">
                                {fmtField(f.field, f.to)}
                              </td>
                            </tr>
                          )),
                        )}
                      </tbody>
                    </table>
                  </Section>
                )}

                {diff.milestoneAdds.length > 0 && (
                  <Section
                    title={`${diff.milestoneAdds.length} payment${diff.milestoneAdds.length === 1 ? "" : "s"} added to POs already on the project`}
                  >
                    <table className="w-full text-xs">
                      <thead className="bg-muted/40 text-left">
                        <tr>
                          <th className="p-2 font-medium">PO</th>
                          <th className="p-2 font-medium">Milestone</th>
                          <th className="p-2 font-medium">Due</th>
                          <th className="p-2 text-right font-medium">Amount</th>
                          <th className="p-2 font-medium">Paid</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {diff.milestoneAdds.map((m) => (
                          <tr key={`${m.poNumber}-${m.rowNumber}`}>
                            <td className="p-2 font-mono">{m.poNumber}</td>
                            <td className="p-2">{m.values.milestone_name}</td>
                            <td className="p-2">{fmt(m.values.expected_date)}</td>
                            <td className="p-2 text-right font-mono">
                              {m.values.amount == null
                                ? "-"
                                : formatCurrency(m.values.amount)}
                            </td>
                            <td className="p-2">{fmt(m.values.paid_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Section>
                )}

                {diff.milestoneChanges.length > 0 && (
                  <Section
                    title={`${diff.milestoneChanges.length} payment${diff.milestoneChanges.length === 1 ? "" : "s"} updated`}
                  >
                    <table className="w-full text-xs">
                      <thead className="bg-muted/40 text-left">
                        <tr>
                          <th className="p-2 font-medium">PO</th>
                          <th className="p-2 font-medium">Milestone</th>
                          <th className="p-2 font-medium">Field</th>
                          <th className="p-2 font-medium">From</th>
                          <th className="p-2 font-medium">To</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {diff.milestoneChanges.flatMap((c) =>
                          c.fields.map((f, i) => (
                            <tr key={`${c.id}-${f.field}`}>
                              <td className="p-2 font-mono">{i === 0 ? c.poNumber : ""}</td>
                              <td className="p-2">{i === 0 ? c.name : ""}</td>
                              <td className="p-2">{milestoneLabel(f.field)}</td>
                              <td className="p-2 text-muted-foreground line-through">
                                {fmtField(f.field, f.from)}
                              </td>
                              <td className="p-2 font-medium">
                                {fmtField(f.field, f.to)}
                              </td>
                            </tr>
                          )),
                        )}
                      </tbody>
                    </table>
                  </Section>
                )}

                {error && <Problem>{error}</Problem>}
                {result && (
                  <div className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">
                    {result}
                  </div>
                )}

                <div className="flex justify-end gap-2 border-t pt-4">
                  {result ? (
                    <>
                      <Button variant="ghost" onClick={reset}>
                        Import more
                      </Button>
                      <Button
                        onClick={() => {
                          setOpen(false);
                          reset();
                        }}
                      >
                        Done
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button variant="ghost" onClick={() => setStep("map")}>
                        Back
                      </Button>
                      <Button
                        onClick={() => void apply()}
                        disabled={
                          submitting || diff.blocking.length > 0 || changeCount === 0
                        }
                      >
                        {submitting
                          ? "Applying..."
                          : `Apply ${changeCount} change${changeCount === 1 ? "" : "s"}`}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// The first few cells of the chosen sheet. A workbook has tabs that all look
// plausible from their names, and seeing the actual rows is the fastest way to
// know you picked the right one before spending a mapping pass on it.
function SheetPeek({ sheet }: { sheet: SheetSummary }) {
  const preview = sheet.rows.filter((r) => r.some((c) => c.trim())).slice(0, 4);
  if (!preview.length) {
    return (
      <p className="text-xs text-muted-foreground">
        This sheet is empty. Pick another one.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded border bg-muted/20">
      <table className="text-[11px]">
        <tbody className="divide-y">
          {preview.map((r, ri) => (
            <tr key={ri}>
              {r.slice(0, 8).map((c, ci) => (
                <td key={ci} className="max-w-[12rem] truncate px-2 py-1 font-mono">
                  {c.trim() || <span className="text-muted-foreground/40">-</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details open className="rounded-lg border">
      <summary className="cursor-pointer border-b bg-muted/30 px-3 py-2 text-sm font-medium">
        {title}
      </summary>
      <div className="max-h-72 overflow-auto">{children}</div>
    </details>
  );
}

function Tally({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "emerald" | "blue" | "destructive";
}) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2">
      <div
        className={cn(
          "text-xl font-semibold tabular-nums",
          tone === "emerald" && "text-emerald-700",
          tone === "blue" && "text-blue-700",
          tone === "destructive" && value > 0 && "text-destructive",
        )}
      >
        {value}
      </div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

function Problem({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
      {children}
    </div>
  );
}

function Warn({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
      {children}
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground">
      {children}
    </div>
  );
}
