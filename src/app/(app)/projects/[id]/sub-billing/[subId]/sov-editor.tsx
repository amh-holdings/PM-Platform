"use client";

import { useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";

import type { SheetSummary } from "@/lib/schedule-workbook";

import { createSovLine, importSovLines } from "../actions";

type Props = { projectId: string; subcontractorId: string; hasLines: boolean };

const PLACEHOLDER = `1.01\tMobilization\t45,000.00
1.02\tPile installation\t312,500.00
1.03\tTracker assembly\t688,400.00`;

const field = "w-full rounded-md border bg-background px-2 py-1.5 text-sm";

/**
 * A sheet, as tab-separated text.
 *
 * Deliberately converts to the SAME string a paste produces rather than adding
 * a second import path. Every rule the server already applies - header
 * detection, column order, updating an item number in place, ignoring total
 * rows, the skipped-row report - keeps applying, and there is no second parser
 * to drift out of step with the first.
 */
function sheetToTsv(sheet: SheetSummary): string {
  return sheet.rows
    .filter((r) => r.some((c) => c.trim().length > 0))
    .map((r) => r.map((c) => c.replace(/\t/g, " ").trim()).join("\t"))
    .join("\n");
}

export function SovEditor({ projectId, subcontractorId, hasLines }: Props) {
  const [mode, setMode] = useState<"none" | "line" | "paste">(hasLines ? "none" : "paste");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();
  // The textarea is controlled so a file can fill it. Reading a file lands the
  // rows in the same box a paste would, which means what you are about to
  // import is on screen before you press the button rather than after.
  const [text, setText] = useState("");
  const [sheets, setSheets] = useState<SheetSummary[] | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [fileName, setFileName] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const reset = () => {
    setError(null);
    setResult(null);
    setSkipped([]);
  };

  function clearFile() {
    setSheets(null);
    setSheetIndex(0);
    setFileName(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function onFile(file: File | null | undefined) {
    if (!file) return;
    reset();
    setReading(true);
    try {
      // Dynamic, so the spreadsheet parser stays out of this page's bundle
      // until somebody actually picks a file.
      const mod = await import("@/lib/schedule-workbook");
      const parsed = mod.readWorkbook(await file.arrayBuffer());
      const withRows = parsed.filter((sh) => sh.filledRows > 0);
      if (withRows.length === 0) {
        setError(`${file.name} has no rows in any sheet.`);
        clearFile();
        return;
      }
      // Land on the fullest sheet. An SOV workbook usually carries a cover
      // page or a notes tab, and the one with the most rows is the one wanted.
      const best = withRows.reduce((a, b) => (b.filledRows > a.filledRows ? b : a));
      const idx = withRows.indexOf(best);
      setSheets(withRows);
      setSheetIndex(idx);
      setFileName(file.name);
      setText(sheetToTsv(withRows[idx]));
    } catch (e) {
      setError(
        `Could not read ${file.name}: ${e instanceof Error ? e.message : "unknown error"}`,
      );
      clearFile();
    } finally {
      setReading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant={mode === "line" ? "secondary" : "outline"}
          onClick={() => {
            reset();
            setMode((m) => (m === "line" ? "none" : "line"));
          }}
        >
          {mode === "line" ? "Cancel" : "Add a line"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={mode === "paste" ? "secondary" : "outline"}
          onClick={() => {
            reset();
            setMode((m) => (m === "paste" ? "none" : "paste"));
          }}
        >
          {mode === "paste" ? "Cancel" : hasLines ? "Paste more lines" : "Paste the SOV"}
        </Button>
      </div>

      {mode === "line" && (
        <form
          key="line"
          action={(fd) => {
            reset();
            startTransition(async () => {
              const res = await createSovLine(projectId, subcontractorId, fd);
              if (!res.ok) setError(res.error);
              else {
                setResult("Line added.");
                setMode("none");
              }
            });
          }}
          className="space-y-3 rounded-md border bg-card p-4"
        >
          <div className="grid gap-3 md:grid-cols-4">
            <label className="block space-y-1">
              <span className="text-xs font-medium">Item number</span>
              <input name="item_number" required placeholder="1.01" className={field} />
            </label>
            <label className="block space-y-1 md:col-span-2">
              <span className="text-xs font-medium">Description</span>
              <input name="description" required placeholder="As printed on the SOV" className={field} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium">Scheduled value</span>
              <input name="scheduled_value" required inputMode="decimal" placeholder="45,000.00" className={field} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium">Section</span>
              <input name="section_name" placeholder="Optional" className={field} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium">Quantity</span>
              <input name="quantity" inputMode="decimal" placeholder="Unit-price lines only" className={field} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium">Unit</span>
              <input name="unit" placeholder="ea, lf, kW" className={field} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium">Change order ref</span>
              <input name="change_order_ref" placeholder="CO-04" className={field} />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="is_change_order" />
            This line came in on a change order
          </label>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Saving..." : "Add line"}
          </Button>
          <p className="text-xs text-muted-foreground">
            A new line starts unmapped. Map it to schedule tasks or commodities from the
            table below so bills against it can be verified.
          </p>
        </form>
      )}

      {mode === "paste" && (
        <form
          key="paste"
          action={(fd) => {
            reset();
            startTransition(async () => {
              const res = await importSovLines(projectId, subcontractorId, fd);
              if (!res.ok) setError(res.error);
              else {
                const parts = [];
                if (res.imported) parts.push(`${res.imported} line${res.imported === 1 ? "" : "s"} added`);
                if (res.updated) parts.push(`${res.updated} updated`);
                setResult(parts.length > 0 ? `${parts.join(", ")}.` : "Nothing changed.");
                setSkipped(res.skipped ?? []);
                // The box used to empty itself because it was uncontrolled.
                // Now that a file can fill it, leaving the rows sitting there
                // after a successful load invites loading them twice.
                setText("");
                clearFile();
              }
            });
          }}
          className="space-y-3 rounded-md border bg-card p-4"
        >
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              accept=".xlsx,.xlsm,.xls,.csv,.tsv,.txt"
              className="hidden"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={reading}
              onClick={() => fileInput.current?.click()}
            >
              {reading ? "Reading..." : fileName ? "Choose another file" : "Upload a file"}
            </Button>
            {fileName && (
              <>
                <span className="text-xs text-muted-foreground">{fileName}</span>
                {sheets && sheets.length > 1 && (
                  <select
                    value={sheetIndex}
                    onChange={(e) => {
                      const i = Number(e.target.value);
                      setSheetIndex(i);
                      setText(sheetToTsv(sheets[i]));
                    }}
                    className="rounded-md border bg-background px-2 py-1 text-xs"
                    aria-label="Sheet"
                  >
                    {sheets.map((sh, i) => (
                      <option key={sh.name} value={i}>
                        {sh.name} ({sh.filledRows} rows)
                      </option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  onClick={() => {
                    clearFile();
                    setText("");
                  }}
                  className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  Clear
                </button>
              </>
            )}
            <span className="text-xs text-muted-foreground">
              Excel or CSV, or just paste below.
            </span>
          </div>

          <label className="block space-y-1">
            <span className="text-xs font-medium">
              {fileName
                ? "Check the rows before loading - edit anything wrong"
                : "Paste the SOV range straight out of Excel"}
            </span>
            <textarea
              name="paste"
              rows={8}
              required
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={PLACEHOLDER}
              className={`${field} font-mono text-xs`}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Columns: item number, description, scheduled value, then optionally quantity,
            unit and unit cost. A header row is read if there is one, so column order does
            not have to match. Item numbers already on the SOV are updated in place and
            keep their evidence mapping. Total rows are ignored.
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="is_change_order" />
              These are change order lines
            </label>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-xs font-medium">CO ref</span>
              <input name="change_order_ref" placeholder="CO-04" className="rounded-md border bg-background px-2 py-1 text-sm" />
            </label>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Reading..." : "Load these lines"}
          </Button>
        </form>
      )}

      {result && <p className="text-xs font-medium text-emerald-700">{result}</p>}
      {skipped.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
          <p className="text-xs font-medium text-amber-900">
            {skipped.length} row{skipped.length === 1 ? " was" : "s were"} not imported:
          </p>
          <ul className="mt-1 space-y-0.5 text-xs text-amber-900">
            {skipped.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
