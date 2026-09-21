"use client";

import { useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";

import type { SheetSummary } from "@/lib/schedule-workbook";
import { bestPageIndex } from "@/lib/sov-pdf";
import { sheetToTsv } from "@/lib/sheet-tsv";

import { createSovLine, importSovLines } from "../actions";
import { readSovPdf } from "../pdf-actions";

type Props = { projectId: string; subcontractorId: string; hasLines: boolean };

const PLACEHOLDER = `1.01\tMobilization\t45,000.00
1.02\tPile installation\t312,500.00
1.03\tTracker assembly\t688,400.00`;

const field = "w-full rounded-md border bg-background px-2 py-1.5 text-sm";

/** Base64 adds a third, and the server action takes 6 MB. */
const PDF_MAX_BYTES = 4 * 1024 * 1024;

const FILE_ACCEPT = ".pdf,.xlsx,.xlsm,.xls,.csv,.tsv,.txt";

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
  const [isPdfSource, setIsPdfSource] = useState(false);
  const [replaceExisting, setReplaceExisting] = useState(false);
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
    setIsPdfSource(false);
    if (fileInput.current) fileInput.current.value = "";
  }

  /**
   * A PDF is read on the server, because pdf.js is far too large to ship to
   * the browser for this. The bytes go up as base64 - a server action takes
   * JSON, not multipart - which costs a third in size and is why the limit
   * below is well under the 6 MB the action itself accepts.
   */
  async function readPdfFile(file: File): Promise<SheetSummary[] | null> {
    if (file.size > PDF_MAX_BYTES) {
      setError(
        `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. PDFs up to 4 MB can be read here - ask for the Excel version, or copy the SOV rows and paste them below.`,
      );
      return null;
    }
    // readAsDataURL rather than hand-rolling base64 off an ArrayBuffer: the
    // browser does it natively, at any size, with no argument-limit trap.
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(new Error("the file could not be opened"));
      reader.readAsDataURL(file);
    });
    const comma = dataUrl.indexOf(",");
    if (comma < 0) {
      setError(`Could not read ${file.name}.`);
      return null;
    }
    const res = await readSovPdf(dataUrl.slice(comma + 1));
    if (!res.ok) {
      setError(res.error);
      return null;
    }
    return res.sheets;
  }

  async function onFile(file: File | null | undefined) {
    if (!file) return;
    reset();
    setReading(true);
    try {
      const isPdf =
        file.type === "application/pdf" || /\.pdf$/i.test(file.name);

      let parsed: SheetSummary[];
      if (isPdf) {
        const fromPdf = await readPdfFile(file);
        if (!fromPdf) {
          clearFile();
          return;
        }
        parsed = fromPdf;
      } else {
        // Dynamic, so the spreadsheet parser stays out of this page's bundle
        // until somebody actually picks a file.
        const mod = await import("@/lib/schedule-workbook");
        parsed = mod.readWorkbook(await file.arrayBuffer());
      }

      const withRows = parsed.filter((sh) => sh.filledRows > 0);
      if (withRows.length === 0) {
        setError(
          isPdf
            ? `${file.name} has no rows on any page.`
            : `${file.name} has no rows in any sheet.`,
        );
        clearFile();
        return;
      }
      // Land on the page or sheet most likely to be the SOV. For a PDF that
      // means the one with the most priced lines, not the most text - the
      // front of a subcontract is prose and the SOV is an exhibit behind it.
      // For a workbook the fullest sheet wins, past the cover and notes tabs.
      const idx = isPdf
        ? bestPageIndex(withRows)
        : withRows.indexOf(
            withRows.reduce((a, b) => (b.filledRows > a.filledRows ? b : a)),
          );
      setSheets(withRows);
      setSheetIndex(idx);
      setFileName(file.name);
      setIsPdfSource(isPdf);
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
                if (res.removed) parts.push(`${res.removed} line${res.removed === 1 ? "" : "s"} taken off`);
                if (res.imported) parts.push(`${res.imported} line${res.imported === 1 ? "" : "s"} added`);
                if (res.updated) parts.push(`${res.updated} updated`);
                setResult(parts.length > 0 ? `${parts.join(", ")}.` : "Nothing changed.");
                setSkipped(res.skipped ?? []);
                // The box used to empty itself because it was uncontrolled.
                // Now that a file can fill it, leaving the rows sitting there
                // after a successful load invites loading them twice.
                setText("");
                clearFile();
                setReplaceExisting(false);
              }
            });
          }}
          className="space-y-3 rounded-md border bg-card p-4"
        >
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              accept={FILE_ACCEPT}
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
              PDF, Excel or CSV, or just paste below.
            </span>
          </div>

          <label className="block space-y-1">
            <span className="text-xs font-medium">
              {fileName
                ? "Check the rows before loading - edit anything wrong"
                : "Paste the SOV range straight out of Excel"}
            </span>
            {isPdfSource && (
              <span className="block text-xs text-muted-foreground">
                A PDF has no columns - these were worked out from where the
                text sits on the page. Check the values against the PDF before
                loading, and watch for a description that ran onto two lines.
              </span>
            )}
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
          {/* Only offered when there is something to replace. An import that
              read a sheet wrongly leaves lines whose item numbers are wrong,
              so a second import has nothing to match on and lands alongside
              the first rather than over it. */}
          {hasLines && (
            <label className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
              <input
                type="checkbox"
                name="replace_existing"
                checked={replaceExisting}
                onChange={(e) => setReplaceExisting(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">Replace what is on the SOV now</span>
                <span className="block text-xs">
                  Takes off every line first, so this sheet becomes the whole SOV
                  rather than being added to it. Evidence mapping goes with them.
                  A line that has already been billed against is kept but retired,
                  so past applications still resolve.
                </span>
              </span>
            </label>
          )}
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
